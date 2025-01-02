import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';

interface DifyHelmStackProps extends cdk.StackProps {
  cluster: eks.Cluster;

  // RDS
  dbEndpoint: string;
  dbPort: string;

  // S3
  s3BucketName: string;

  // Redis
  redisEndpoint: string;
  redisPort: string;

  // OpenSearch
  openSearchEndpoint: string;
}

export class DifyHelmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DifyHelmStackProps) {
    super(scope, id, props);

    const dbPassword = this.node.tryGetContext('dbPassword');
    if (!dbPassword) {
      throw new Error("Context variable 'dbPassword' is missing");
    }

    const opensearchPassword = this.node.tryGetContext('opensearchPassword');
    if (!opensearchPassword) {
      throw new Error("Context variable 'opensearchPassword' is missing");
    }

    const S3AccessKey = this.node.tryGetContext('S3AccessKey');
    if (!S3AccessKey) {
      throw new Error("Context variable 'S3AccessKey' is missing");
    }

    const S3SecretKey = this.node.tryGetContext('S3SecretKey');
    if (!S3SecretKey) {
      throw new Error("Context variable 'S3SecretKey' is missing");
    }

    const difySecretKey = this.node.tryGetContext('difySecretKey');
    if (!difySecretKey) {
      throw new Error("Context variable 'difySecretKey' is missing");
    }

    const ns = new eks.KubernetesManifest(this, "dify-ns", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "dify" }
      }],
      overwrite: true
    });

    const dbSecret = new eks.KubernetesManifest(this, "dify-db-secret", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "dify-db-secret", namespace: "dify" },
        type: "Opaque",
        data: { password: Buffer.from(dbPassword).toString('base64') }
      }],
      overwrite: true
    });
    dbSecret.node.addDependency(ns);

    const osSecret = new eks.KubernetesManifest(this, "dify-os-secret", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "dify-os-secret", namespace: "dify" },
        type: "Opaque",
        data: { opensearch_password: Buffer.from(opensearchPassword).toString('base64') }
      }],
      overwrite: true
    });
    osSecret.node.addDependency(ns);

    const s3Secret = new eks.KubernetesManifest(this, "dify-s3", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "dify-s3", namespace: "dify" },
        type: "Opaque",
        data: {
          access_key: Buffer.from(S3AccessKey).toString('base64'),
          secret_key: Buffer.from(S3SecretKey).toString('base64')
        }
      }],
      overwrite: true
    });
    s3Secret.node.addDependency(ns);

    const difyKey = new eks.KubernetesManifest(this, "dify-space", {
      cluster: props.cluster,
      manifest: [{
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "dify-space", namespace: "dify" },
        type: "Opaque",
        data: { difysecretkey: Buffer.from(difySecretKey).toString('base64') }
      }],
      overwrite: true
    });
    difyKey.node.addDependency(ns);

    // Dify Helm configuration
    const difyHelm = new eks.HelmChart(this, 'DifyHelmChart', {
      cluster: props.cluster,
      chart: 'dify',
      repository: 'https://douban.github.io/charts/',
      release: 'dify',
      namespace: 'dify',
      values: {
        global: {
          host: '',
          port: '',
          enableTLS: false,
          image: { tag: '0.14.2' },
          edition: 'SELF_HOSTED',
          storageType: 's3',
          extraEnvs: [],
          extraBackendEnvs: [
            { name: 'SECRET_KEY', valueFrom: { secretKeyRef: { name: 'dify-space', key: 'difysecretkey' } } },
            { name: 'LOG_LEVEL', value: 'DEBUG' },

            // RDS Postgres
            { name: 'DB_USERNAME', value: 'postgres' },
            { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'dify-db-secret', key: 'password' } } },
            { name: 'DB_HOST', value: props.dbEndpoint },
            { name: 'DB_PORT', value: props.dbPort },
            { name: 'DB_DATABASE', value: 'dify' },

            // OpenSearch
            { name: 'VECTOR_STORE', value: 'opensearch' },
            { name: 'OPENSEARCH_HOST', value: props.openSearchEndpoint },
            { name: 'OPENSEARCH_PORT', value: '443' },
            { name: 'OPENSEARCH_USER', value: 'admin' },
            { name: 'OPENSEARCH_PASSWORD', valueFrom: { secretKeyRef: { name: 'dify-os-secret', key: 'opensearch_password' } } },
            { name: 'OPENSEARCH_SECURE', value: 'true' },

            // Redis
            { name: 'REDIS_HOST', value: props.redisEndpoint },
            { name: 'REDIS_PORT', value: props.redisPort },
            { name: 'REDIS_DB', value: '0' },
            { name: 'REDIS_USE_SSL', value: 'true' },

            // CELERY_BROKER
            { name: 'CELERY_BROKER_URL', value: `redis://:@${props.redisEndpoint}:${props.redisPort}/1` },
            { name: 'BROKER_USE_SSL', value: 'true' },

            // S3
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${this.region}.amazonaws.com` },
            { name: 'S3_BUCKET_NAME', value: props.s3BucketName },
            { name: 'S3_ACCESS_KEY', valueFrom: { secretKeyRef: { name: 'dify-s3', key: 'access_key' } } },
            { name: 'S3_SECRET_KEY', valueFrom: { secretKeyRef: { name: 'dify-s3', key: 'secret_key' } } },
            { name: 'S3_REGION', value: this.region }
          ]
        },

        ingress: {
          enabled: true,
          className: 'alb',
          annotations: {
            'kubernetes.io/ingress.class': 'alb',
            'alb.ingress.kubernetes.io/scheme': 'internet-facing',
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}]'
          },
          hosts: [{
            host: '',
            paths: [
              {
                path: '/api',
                pathType: 'Prefix',
                backend: {
                  serviceName: 'dify-api-svc',
                  servicePort: 80
                },
                annotations: {
                  'alb.ingress.kubernetes.io/healthcheck-path': '/health',
                  'alb.ingress.kubernetes.io/healthcheck-port': '80'
                }
              },
              {
                path: '/v1',
                pathType: 'Prefix',
                backend: {
                  serviceName: 'dify-api-svc',
                  servicePort: 80
                },
                annotations: {
                  'alb.ingress.kubernetes.io/healthcheck-path': '/health',
                  'alb.ingress.kubernetes.io/healthcheck-port': '80'
                }
              },
              {
                path: '/console/api',
                pathType: 'Prefix',
                backend: {
                  serviceName: 'dify-api-svc',
                  servicePort: 80
                },
                annotations: {
                  'alb.ingress.kubernetes.io/healthcheck-path': '/health',
                  'alb.ingress.kubernetes.io/healthcheck-port': '80'
                }
              },
              {
                path: '/files',
                pathType: 'Prefix',
                backend: {
                  serviceName: 'dify-api-svc',
                  servicePort: 80
                },
                annotations: {
                  'alb.ingress.kubernetes.io/healthcheck-path': '/health',
                  'alb.ingress.kubernetes.io/healthcheck-port': '80'
                }
              },
              {
                path: '/',
                pathType: 'Prefix',
                backend: { serviceName: 'dify-frontend', servicePort: 80 },
                annotations: {
                  'alb.ingress.kubernetes.io/healthcheck-path': '/apps',
                  'alb.ingress.kubernetes.io/healthcheck-port': '80'
                }
              }
            ]
          }]
        },

        serviceAccount: {
          create: true,
          annotations: {},
          name: ''
        },

        frontend: {
          replicaCount: 2,
          image: {
            repository: 'langgenius/dify-web',
            pullPolicy: 'IfNotPresent',
            tag: ''
          },
          envs: [
          ],
          imagePullSecrets: [], 
          podAnnotations: {},
          podSecurityContext: {

          },
          securityContext: {
            
          },
          service: {
            type: 'ClusterIP',
            port: 80 
          },

          containerPort: 3000, 
          resources: {
            limits: { cpu: '256m', memory: '512Mi' },
            requests: { cpu: '128m', memory: '256Mi' }
          },
          autoscaling: {
            enabled: true,
            minReplicas: 2,
            maxReplicas: 100,
            targetCPUUtilizationPercentage: 80
          },

          livenessProbe: {
            httpGet: {
              path: '/apps',
              port: 'http',
              httpHeaders: [{ name: 'accept-language', value: 'en' }]
            },
            initialDelaySeconds: 3,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2
          },

          readinessProbe: {
            httpGet: {
              path: '/apps',
              port: 'http',
              httpHeaders: [{ name: 'accept-language', value: 'en' }]
            },
            initialDelaySeconds: 3,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2
          }
        },

        api: {
          replicaCount: 2,
          image: {
            repository: 'langgenius/dify-api',
            pullPolicy: 'IfNotPresent',
            tag: ''
          },
          envs: [
            { name: 'CODE_MAX_NUMBER', value: '9223372036854775807' },
            { name: 'CODE_MIN_NUMBER', value: '-9223372036854775808' },
            { name: 'CODE_MAX_STRING_LENGTH', value: '80000' },
            { name: 'TEMPLATE_TRANSFORM_MAX_LENGTH', value: '80000' },
            { name: 'CODE_MAX_STRING_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_OBJECT_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_NUMBER_ARRAY_LENGTH', value: '1000' }
          ],
          podAnnotations: {},
          podSecurityContext: {},
          securityContext: {},

          service: {
            type: 'ClusterIP',
            port: 80 
          },

          containerPort: 5001, 

          resources: {
            limits: { cpu: '1024m', memory: '2048Mi' },
            requests: { cpu: '512m', memory: '1024Mi' }
          },
          autoscaling: {
            enabled: true,
            minReplicas: 2,
            maxReplicas: 100,
            targetCPUUtilizationPercentage: 60
          },

          livenessProbe: {
            httpGet: {
              path: '/health',
              port: 'http'
            },
            initialDelaySeconds: 360,
            timeoutSeconds: 10,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 5
          },

          readinessProbe: {
            httpGet: {
              path: '/health',
              port: 'http'
            },
            initialDelaySeconds: 120,
            timeoutSeconds: 10,
            periodSeconds: 5,
            successThreshold: 1,
            failureThreshold: 30       // 给予充足的启动时间
          }
        },

        worker: {
          replicaCount: 2,
          image: {
            repository: 'langgenius/dify-api',
            pullPolicy: 'IfNotPresent',
            tag: ''
          },
          podAnnotations: {},
          podSecurityContext: {},
          securityContext: {},

          resources: {
            limits: { cpu: '256m', memory: '1024Mi' },
            requests: { cpu: '128m', memory: '512Mi' }
          },
          autoscaling: {
            enabled: true,
            minReplicas: 2,
            maxReplicas: 10,  // 降低最大副本数
            targetCPUUtilizationPercentage: 80,
            behavior: {  // 添加扩缩容行为控制
              scaleUp: {
                stabilizationWindowSeconds: 300,  // 5分钟的稳定窗口
                policies: [
                  {
                    type: 'Pods',
                    value: 2,  // 每次最多增加2个pod
                    periodSeconds: 60
                  }
                ]
              },
              scaleDown: {
                stabilizationWindowSeconds: 300,
                policies: [
                  {
                    type: 'Pods',
                    value: 1,  // 每次最多减少1个pod
                    periodSeconds: 60
                  }
                ]
              }
            }
          },

          livenessProbe: {
            
          },
          readinessProbe: {
            
          }
        },

        sandbox: {
          replicaCount: 2,
          apiKey: 'dify-sandbox', 
          apiKeySecret: '', 
          image: {
            repository: 'langgenius/dify-sandbox',
            pullPolicy: 'IfNotPresent',
            tag: '' 
          },
          config: {
            python_requirements: '' 
          },
          envs: [
            { name: 'GIN_MODE', value: 'release' },
            { name: 'WORKER_TIMEOUT', value: '15' }
          ],
          service: {
            type: 'ClusterIP',
            port: 80 
          },
          containerPort: 8194, 

          resources: {
            limits: { cpu: '1024m', memory: '2048Mi' },
            requests: { cpu: '512m', memory: '1024Mi' }
          },
          autoscaling: {
            enabled: true,
            minReplicas: 2,
            maxReplicas: 100,
            targetCPUUtilizationPercentage: 60
          },

          readinessProbe: {
            tcpSocket: {
              port: 'http'
            },
            initialDelaySeconds: 1,
            timeoutSeconds: 5,
            periodSeconds: 5,
            successThreshold: 1,
            failureThreshold: 10
          },
          livenessProbe: {
            tcpSocket: {
              port: 'http'
            },
            initialDelaySeconds: 30,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2
          }
        },

        redis: {
          embedded: false, 
        },

        postgresql:{
          embedded: false,
        },

        minio:{
          embedded: false,
        },
      }
    });
  }
}
