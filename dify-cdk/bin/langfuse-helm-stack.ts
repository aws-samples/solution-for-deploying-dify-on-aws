import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';

interface LangfuseHelmStackProps extends cdk.StackProps {
  cluster: eks.Cluster;
  dbEndpoint: string;
  dbPort: string;
}

export class LangfuseHelmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LangfuseHelmStackProps) {
    super(scope, id, props);

    const dbPassword = this.node.tryGetContext('dbPassword');
    if (!dbPassword) {
      throw new Error("Context variable 'dbPassword' is missing");
    }

    const nextAuthSecret = this.node.tryGetContext('nextAuthSecret');
    if (!nextAuthSecret) {
      throw new Error("Context variable 'nextAuthSecret' is missing");
    }

    const salt = this.node.tryGetContext('salt');
    if (!salt) {
      throw new Error("Context variable 'salt' is missing");
    }

    // 创建命名空间
    const ns = new eks.KubernetesManifest(this, "langfuse-ns", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "langfuse" }
      }],
      overwrite: true
    });

    const dbSecret = new eks.KubernetesManifest(this, "langfuse-db-secret", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "langfuse-db-secret", namespace: "langfuse" },
        type: "Opaque",
        data: { password: Buffer.from(dbPassword).toString('base64') }
      }],
      overwrite: true
    });
    dbSecret.node.addDependency(ns);

    const authSecret = new eks.KubernetesManifest(this, "langfuse-auth-secret", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "langfuse-auth-secret", namespace: "langfuse" },
        type: "Opaque",
        stringData: {
          nextauth_secret: nextAuthSecret,
          salt: salt
        }
      }],
      overwrite: true
    });
    authSecret.node.addDependency(ns);

    // Langfuse Helm configuration
    const langfuseHelm = new eks.HelmChart(this, 'LangfuseHelmChart', {
      cluster: props.cluster,
      chart: 'langfuse',
      repository: 'https://langfuse.github.io/langfuse-k8s',
      release: 'langfuse',
      namespace: 'langfuse',
      values: {
        replicaCount: 2,
        clickhouse: {
          enabled: true,
          auth: {
            username: "default",
            password: "clickhouse"  // 这里建议使用从 context 获取的密码
          },
          shards: 1,
          replicas: 1,
          resources: {
            requests: {
              memory: "2Gi",
              cpu: "1000m"
            },
            limits: {
              memory: "3Gi",
              cpu: "1500m"
            }
          }
        },
        minio: {
          enabled: true,
          auth: {
            rootUser: "minio",
            rootPassword: "minio123"  // 这里建议使用从 context 获取的密码
          }
        },
        langfuse: {
          port: 3000,
          nodeEnv: 'production',
          next: {
            healthcheckBasePath: ""
          },
          nextauth: {
            url: "${props.cluster.clusterEndpoint}",  // 使用集群端点作为基础URL
            secret: nextAuthSecret
          },
          salt: salt,
          telemetryEnabled: false,
          nextPublicSignUpDisabled: true,
          enableExperimentalFeatures: false,
          additionalEnv: [
            { 
              name: 'DATABASE_URL', 
              value: `postgresql://postgres:${dbPassword}@${props.dbEndpoint}:${props.dbPort}/postgres?schema=public` 
            },
            {
              name: 'CLICKHOUSE_URL',
              value: 'clickhouse://langfuse-clickhouse:9000'
            },
            {
              name: 'CLICKHOUSE_USER',
              value: 'default'
            },
            {
              name: 'CLICKHOUSE_PASSWORD',
              value: 'clickhouse'  // 这里建议使用从 context 获取的密码
            }
          ],
          extraContainers: [],
          container: {
            livenessProbe: {
              initialDelaySeconds: 60,
              periodSeconds: 15,
              timeoutSeconds: 10,
              failureThreshold: 3
            },
            readinessProbe: {
              initialDelaySeconds: 60,
              periodSeconds: 15,
              timeoutSeconds: 10,
              failureThreshold: 3
            }
          }
        },
        // 数据库配置
        postgresql: {
          deploy: false,
          host: props.dbEndpoint,
          auth: {
            username: "postgres",
            password: dbPassword,
            database: "postgres"
          }
        },
        // 添加资源限制和请求
        resources: {
          requests: {
            cpu: '100m',
            memory: '512Mi'
          },
          limits: {
            cpu: '500m',
            memory: '1024Mi'
          }
        },
        // Ingress 配置
        ingress: {
          enabled: true,
          className: 'alb',
          annotations: {
            'kubernetes.io/ingress.class': 'alb',
            'alb.ingress.kubernetes.io/scheme': 'internet-facing',
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}]',
            'alb.ingress.kubernetes.io/healthcheck-path': '/api/public/health',
            'alb.ingress.kubernetes.io/healthcheck-interval-seconds': '15',
            'alb.ingress.kubernetes.io/healthcheck-timeout-seconds': '10'
          },
          hosts: [{
            host: '',
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { serviceName: 'langfuse', servicePort: 3000 }
              }
            ]
          }]
        },
        // 添加 Pod 反亲和性，避免单点故障
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              {
                weight: 100,
                podAffinityTerm: {
                  labelSelector: {
                    matchExpressions: [
                      {
                        key: 'app.kubernetes.io/name',
                        operator: 'In',
                        values: ['langfuse']
                      }
                    ]
                  },
                  topologyKey: 'kubernetes.io/hostname'
                }
              }
            ]
          }
        },
        // 添加 Pod 干扰预算
        podDisruptionBudget: {
          minAvailable: 1
        },
        // 添加自动伸缩配置
        autoscaling: {
          enabled: true,
          minReplicas: 1,
          maxReplicas: 3,
          targetCPUUtilizationPercentage: 80,
          targetMemoryUtilizationPercentage: 80
        }
      }
    });
  }
}
