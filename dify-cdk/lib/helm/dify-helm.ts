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
import { DatabaseMigrationConstruct } from '../database/db-migration-construct';

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
    const difyVersion = props.config.dify.version || '1.7.2';

    // 创建数据库迁移（如果启用）
    let dbMigration: DatabaseMigrationConstruct | undefined;
    if (props.config.dify.dbMigration?.enabled) {
      console.log('🔄 启用数据库自动迁移...');
      
      // 创建数据库密码Secret
      const dbSecretName = 'dify-db-credentials';
      const dbSecretManifest = new eks.KubernetesManifest(this, 'db-secret', {
        cluster: props.cluster,
        manifest: [{
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: dbSecretName,
            namespace,
          },
          type: 'Opaque',
          stringData: {
            'password': dbPassword,
            'username': props.config.postgresSQL.dbCredentialUsername || 'postgres',
          },
        }],
      });
      
      // 确保Secret在namespace之后创建
      dbSecretManifest.node.addDependency(ns);
      
      // 创建数据库迁移构造器
      dbMigration = new DatabaseMigrationConstruct(this, 'DbMigration', {
        config: props.config,
        cluster: props.cluster,
        namespace,
        database: {
          endpoint: props.dbEndpoint,
          port: props.dbPort,
          username: props.config.postgresSQL.dbCredentialUsername || 'postgres',
          secretName: dbSecretName,
          dbName: props.config.postgresSQL.dbName || 'dify',
        },
        serviceAccountName: 'dify',
        difyVersion: difyVersion,
        imageRegistry,
      });
      
      // 确保迁移在Secret之后创建
      dbMigration.node.addDependency(dbSecretManifest);
      
      console.log('✅ 数据库迁移配置完成');
    }

    // Dify Helm configuration - minimized
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
          extraBackendEnvs: [
            { name: 'SECRET_KEY', value: secretKey },
            { name: 'LOG_LEVEL', value: 'INFO' },
            
            // Database
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
            { name: 'CELERY_BROKER_URL', value: `redis://:@${props.redisEndpoint}:${props.redisPort}/1` },
            { name: 'BROKER_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            
            // S3
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${Aws.REGION}.${s3Domain}` },
            { name: 'S3_BUCKET_NAME', value: props.s3BucketName },
            { name: 'S3_REGION', value: Aws.REGION },
            { name: 'S3_USE_AWS_MANAGED_IAM', value: 'true' },
          ],
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
          create: true,
          annotations: {
            'eks.amazonaws.com/role-arn': difyServiceAccountRole.roleArn,
          },
          name: 'dify',
        },

        frontend: {
          image: {
            repository: `${imageRegistry}langgenius/dify-web`,
          },
        },

        api: {
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
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
          resources: {
            limits: { cpu: '2', memory: '2Gi' },
            requests: { cpu: '1', memory: '1Gi' },
          },
        },

        worker: {
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
          },
        },

        sandbox: {
          image: {
            repository: `${imageRegistry}langgenius/dify-sandbox`,
            tag: 'latest',
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
    
    // 如果启用了数据库迁移，确保Helm Chart在迁移之后部署
    if (dbMigration) {
      difyHelmChart.node.addDependency(dbMigration);
    }

    // 纯Ingress模式 - ALB完全由AWS Load Balancer Controller管理
    console.log('📝 使用纯Ingress模式，ALB将由AWS Load Balancer Controller自动管理');
    console.log(`📝 已配置安全组: ${props.albSecurityGroupId}`);
    console.log('📝 ALB将在Helm部署完成后自动创建');
  }
}