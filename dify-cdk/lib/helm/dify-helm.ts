/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as crypto from 'crypto';
import { Aws, Duration, CfnJson } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

// GCR Registry for China region - Updated to match dify-cdk-cn implementation
const GCR_REGISTRY = '048912060910.dkr.ecr.cn-northwest-1.amazonaws.com.cn/dockerhub/';

export interface DifyHelmConstructProps {
  readonly config: SystemConfig;

  readonly vpc: IVpc;
  readonly cluster: eks.ICluster;
  readonly helmDeployRole?: IRole; // Make optional for existing clusters

  // ALB Security Group ID for Ingress - Required for pure Ingress mode
  readonly albSecurityGroupId: string;

  // RDS
  readonly dbEndpoint: string;
  readonly dbPort: string;
  readonly dbSecretArn: string; // RDS密码Secret ARN
  readonly dbPassword?: string; // RDS密码（可选，用于覆盖默认值）

  // S3
  readonly s3BucketName: string;

  // Redis
  readonly redisEndpoint: string;
  readonly redisPort: string;

  // OpenSearch
  readonly openSearchEndpoint: string;
  readonly openSearchSecretArn?: string; // OpenSearch密码Secret ARN
}

export class DifyHelmConstruct extends Construct {

  constructor(scope: Construct, id: string, props: DifyHelmConstructProps) {
    super(scope, id);

    const namespace = 'dify';
    
    // Create namespace
    const ns = new eks.KubernetesManifest(this, 'dify-ns', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: namespace },
      }],
    });

    // Create IAM role for Dify Service Account with IRSA
    // Use CfnJson to handle dynamic OIDC issuer token
    const conditions = new CfnJson(this, 'ConditionJson', {
      value: {
        [`${props.cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: `system:serviceaccount:${namespace}:dify`,
        [`${props.cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
      },
    });

    const difyServiceAccountRole = new iam.Role(this, 'DifyServiceAccountRole', {
      assumedBy: new iam.FederatedPrincipal(
        props.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          'StringEquals': conditions,
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'IAM role for Dify application Service Account with IRSA',
    });

    // Add S3 permissions to the role
    difyServiceAccountRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
        's3:GetBucketLocation',
        's3:GetBucketVersioning',
        's3:PutBucketVersioning',
        's3:GetObjectVersion',
        's3:DeleteObjectVersion',
      ],
      resources: [
        `arn:aws:s3:::${props.s3BucketName}`,
        `arn:aws:s3:::${props.s3BucketName}/*`,
      ],
    }));

    console.log(`✅ 创建了Dify Service Account IAM角色: ${difyServiceAccountRole.roleArn}`);

    // Generate secret key
    const secretKey = crypto.randomBytes(42).toString('base64');
    
    // Get passwords from config
    const dbPassword = props.dbPassword || props.config.postgresSQL.dbCredentialPassword || 'Dify.Postgres.2024!';
    const opensearchPassword = props.config.openSearch.masterUserPassword || 'OpenSearch.Admin.2024!';
    
    // Image registry for China region
    const imageRegistry = props.config.isChinaRegion ? GCR_REGISTRY : '';
    
    // S3 domain based on region
    const s3Domain = props.config.isChinaRegion ? 'amazonaws.com.cn' : 'amazonaws.com';
    
    // Get Dify version
    const difyVersion = props.config.dify.version ;

    // Dify Helm configuration - simplified like the old version
    const difyHelmChart = new eks.HelmChart(this, 'DifyHelmChart', {
      cluster: props.cluster,
      chart: 'dify',
      repository: 'https://douban.github.io/charts/',
      release: 'dify',
      namespace,
      timeout: Duration.minutes(15),
      createNamespace: false,
      values: {
        global: {
          host: '', // Will be populated by Ingress
          port: '80',
          enableTLS: false,
          image: { tag: difyVersion },
          edition: 'SELF_HOSTED',
          storageType: 's3',
          extraEnvs: [],
          extraBackendEnvs: [
            { name: 'SECRET_KEY', value: secretKey },
            { name: 'LOG_LEVEL', value: 'INFO' },
            
            // RDS Postgres
            { name: 'DB_USERNAME', value: props.config.postgresSQL.dbCredentialUsername || 'postgres' },
            { name: 'DB_PASSWORD', value: dbPassword },
            { name: 'DB_HOST', value: props.dbEndpoint },
            { name: 'DB_PORT', value: props.dbPort },
            { name: 'DB_DATABASE', value: props.config.postgresSQL.dbName || 'dify' },
            
            // OpenSearch (if enabled)
            ...(props.config.openSearch.enabled ? [
              { name: 'VECTOR_STORE', value: 'opensearch' },
              { name: 'OPENSEARCH_HOST', value: props.openSearchEndpoint },
              { name: 'OPENSEARCH_PORT', value: '443' },
              { name: 'OPENSEARCH_USER', value: props.config.openSearch.masterUserName || 'admin' },
              { name: 'OPENSEARCH_PASSWORD', value: opensearchPassword },
              { name: 'OPENSEARCH_SECURE', value: 'true' },
            ] : []),
            
            // Redis
            { name: 'REDIS_HOST', value: props.redisEndpoint },
            { name: 'REDIS_PORT', value: props.redisPort },
            { name: 'REDIS_DB', value: '0' },
            { name: 'REDIS_USERNAME', value: '' },
            { name: 'REDIS_PASSWORD', value: '' },
            { name: 'REDIS_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            
            // CELERY_BROKER
            { name: 'CELERY_BROKER_URL', value: `redis://:@${props.redisEndpoint}:${props.redisPort}/1` },
            { name: 'BROKER_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            
            // S3
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${Aws.REGION}.${s3Domain}` },
            { name: 'S3_BUCKET_NAME', value: props.s3BucketName },
            { name: 'S3_REGION', value: Aws.REGION },
            { name: 'S3_USE_AWS_MANAGED_IAM', value: 'true' },
          ],
          labels: []
        },

        ingress: {
          enabled: true,
          className: 'alb',
          annotations: {
            'kubernetes.io/ingress.class': 'alb',
            'alb.ingress.kubernetes.io/scheme': 'internet-facing',
            'alb.ingress.kubernetes.io/target-type': 'ip',
            'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}]',
            'alb.ingress.kubernetes.io/security-groups': props.albSecurityGroupId,
          },
        },

        serviceAccount: {
          create: true, // 让Helm创建ServiceAccount
          annotations: {
            'eks.amazonaws.com/role-arn': difyServiceAccountRole.roleArn,
          },
          name: 'dify',
        },

        frontend: {
          replicaCount: 1,
          image: {
            repository: `${imageRegistry}langgenius/dify-web`,
            pullPolicy: 'IfNotPresent',
            tag: '',
          },
          envs: [],
          imagePullSecrets: [],
          podAnnotations: {},
          podSecurityContext: {},
          securityContext: {},
          service: {
            type: 'ClusterIP',
            port: 80,
          },
          containerPort: 3000,
          resources: {},
          autoscaling: {
            enabled: false,
            minReplicas: 1,
            maxReplicas: 100,
            targetCPUUtilizationPercentage: 80,
          },
          livenessProbe: {
            httpGet: {
              path: '/apps',
              port: 'http',
              httpHeaders: [{ name: 'accept-language', value: 'en' }],
            },
            initialDelaySeconds: 3,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2,
          },
          readinessProbe: {
            httpGet: {
              path: '/apps',
              port: 'http',
              httpHeaders: [{ name: 'accept-language', value: 'en' }],
            },
            initialDelaySeconds: 3,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2,
          },
        },

        api: {
          replicaCount: 1,
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
            pullPolicy: 'IfNotPresent',
            tag: '',
          },
          envs: [
            { name: 'CODE_MAX_NUMBER', value: '9223372036854775807' },
            { name: 'CODE_MIN_NUMBER', value: '-9223372036854775808' },
            { name: 'CODE_MAX_STRING_LENGTH', value: '80000' },
            { name: 'TEMPLATE_TRANSFORM_MAX_LENGTH', value: '80000' },
            { name: 'CODE_MAX_STRING_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_OBJECT_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_NUMBER_ARRAY_LENGTH', value: '1000' },
          ],
          podAnnotations: {},
          podSecurityContext: {},
          securityContext: {},
          service: {
            type: 'ClusterIP',
            port: 80,
          },
          containerPort: 5001,
          resources: {
            limits: { cpu: '2', memory: '2Gi' },
            requests: { cpu: '1', memory: '1Gi' },
          },
          livenessProbe: {
            httpGet: {
              path: '/health',
              port: 'http',
            },
            initialDelaySeconds: 30,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2,
          },
          readinessProbe: {
            httpGet: {
              path: '/health',
              port: 'http',
            },
            initialDelaySeconds: 10,
            timeoutSeconds: 5,
            periodSeconds: 5,
            successThreshold: 1,
            failureThreshold: 10,
          },
        },

        worker: {
          replicaCount: 1,
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
            pullPolicy: 'IfNotPresent',
            tag: '',
          },
          podAnnotations: {},
          podSecurityContext: {},
          securityContext: {},
          resources: {},
          autoscaling: {
            enabled: false,
            minReplicas: 1,
            maxReplicas: 100,
            targetCPUUtilizationPercentage: 80,
          },
          livenessProbe: {},
          readinessProbe: {},
        },

        sandbox: {
          replicaCount: 1,
          apiKey: 'dify-sandbox',
          apiKeySecret: '',
          image: {
            repository: `${imageRegistry}langgenius/dify-sandbox`,
            pullPolicy: 'IfNotPresent',
            tag: 'latest',
          },
          config: {
            python_requirements: '',
          },
          envs: [
            { name: 'GIN_MODE', value: 'release' },
            { name: 'WORKER_TIMEOUT', value: '15' },
          ],
          service: {
            type: 'ClusterIP',
            port: 80,
          },
          containerPort: 8194,
          resources: {},
          readinessProbe: {
            tcpSocket: {
              port: 'http',
            },
            initialDelaySeconds: 1,
            timeoutSeconds: 5,
            periodSeconds: 5,
            successThreshold: 1,
            failureThreshold: 10,
          },
          livenessProbe: {
            tcpSocket: {
              port: 'http',
            },
            initialDelaySeconds: 30,
            timeoutSeconds: 5,
            periodSeconds: 30,
            successThreshold: 1,
            failureThreshold: 2,
          },
        },

        redis: {
          embedded: false,
        },

        postgresql: {
          embedded: false,
        },

        minio: {
          embedded: false,
        },
      },
    });

    // Add dependencies
    difyHelmChart.node.addDependency(ns);

    // 纯Ingress模式 - ALB完全由AWS Load Balancer Controller管理
    console.log('📝 使用纯Ingress模式，ALB将由AWS Load Balancer Controller自动管理');
    console.log(`📝 已配置安全组: ${props.albSecurityGroupId}`);
    console.log('📝 ALB将在Helm部署完成后自动创建');
  }
}