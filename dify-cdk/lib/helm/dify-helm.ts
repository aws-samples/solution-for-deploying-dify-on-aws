/**
 *  Dify Helm 部署构造器 - 整合版
 *  
 *  整合了以下功能：
 *  1. 支持 TargetGroupBinding
 *  2. 整合 ALB 和 CloudFront 配置
 *  3. 支持数据库自动迁移
 *  4. 优化的 Helm values 配置
 *  5. 支持中国区域特殊配置
 */

import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import { Aws, Duration, CfnJson, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IRole } from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';
import { DatabaseMigrationConstruct } from '../database/db-migration-construct';
import { DifyALBConstruct } from '../alb/dify-alb-construct';

// GCR Registry for China region
const GCR_REGISTRY = '048912060910.dkr.ecr.cn-northwest-1.amazonaws.com.cn/dockerhub/';

/**
 * Dify Helm 构造器属性
 */
export interface DifyHelmConstructProps {
  readonly config: SystemConfig;
  readonly vpc: IVpc;
  readonly cluster: eks.ICluster;
  readonly helmDeployRole?: IRole;
  
  // 部署模式选择
  readonly enableCloudFront?: boolean;
  
  // ALB 配置 (默认 TargetGroupBinding 模式)
  readonly alb?: {
    readonly apiTargetGroupArn: string;
    readonly frontendTargetGroupArn: string;
    readonly dnsName: string;
    readonly cloudFrontDomain?: string;
  };
  
  // ALB Security Group ID (Ingress 模式)
  readonly albSecurityGroupId?: string;
  
  // RDS
  readonly dbEndpoint: string;
  readonly dbPort: string;
  readonly dbSecretArn?: string;
  readonly dbPassword?: string;
  
  // S3
  readonly s3BucketName: string;
  
  // Redis
  readonly redisEndpoint: string;
  readonly redisPort: string;
  
  // OpenSearch
  readonly openSearchEndpoint?: string;
  readonly openSearchSecretArn?: string;
}

/**
 * Dify Helm Stack - 整合版
 * 可作为独立 Stack 或 Construct 使用
 */
export class DifyHelmStack extends cdk.Stack {
  public readonly distributionDomainName?: string;
  public readonly albDnsName?: string;
  public readonly distributionId?: string;

  constructor(scope: Construct, id: string, props: DifyHelmStackProps) {
    super(scope, id, props);

    console.log('🚀 部署 Dify Helm Stack (整合版)');

    // 创建 ALB（默认 TargetGroupBinding 模式始终需要）
    console.log('🔧 创建 ALB 和 Target Groups (TargetGroupBinding 模式)...');
    const difyAlb = new DifyALBConstruct(this, 'DifyALB', {
      vpc: props.vpc,
      config: props.config,
      albSecurityGroupId: props.albSecurityGroupId,
    });
    
    const albDnsName = difyAlb.albDnsName;
    this.albDnsName = albDnsName;
    
    // 创建 CloudFront（如果启用）
    let cloudFrontDomain: string | undefined;
    if (props.config.domain.cloudfront?.enabled && albDnsName) {
      console.log('🌐 创建 CloudFront Distribution...');
      const distribution = this.createCloudFront(albDnsName, props.config);
      cloudFrontDomain = distribution.distributionDomainName;
      this.distributionDomainName = cloudFrontDomain;
      this.distributionId = distribution.distributionId;
    }
    
    // 构建 ALB 配置（包含可选的 CloudFront 域名）
    const albConfig: DifyHelmConstructProps['alb'] = {
      apiTargetGroupArn: difyAlb.apiTargetGroup.targetGroupArn,
      frontendTargetGroupArn: difyAlb.frontendTargetGroup.targetGroupArn,
      dnsName: albDnsName,
      ...(cloudFrontDomain && { cloudFrontDomain }),
    };

    // 部署 Helm Chart
    const helmConstruct = new DifyHelmConstruct(this, 'DifyHelm', {
      config: props.config,
      vpc: props.vpc,
      cluster: props.cluster,
      helmDeployRole: undefined,
      alb: albConfig,
      // 默认使用 TargetGroupBinding，不需要传递参数
      albSecurityGroupId: props.albSecurityGroupId,
      dbEndpoint: props.dbEndpoint,
      dbPort: props.dbPort,
      dbSecretArn: props.dbSecretArn,
      dbPassword: props.dbPassword,
      s3BucketName: props.s3BucketName,
      redisEndpoint: props.redisEndpoint,
      redisPort: props.redisPort,
      openSearchEndpoint: props.openSearchEndpoint,
      openSearchSecretArn: props.openSearchSecretArn,
    });

    // 创建输出
    this.createOutputs(albDnsName, cloudFrontDomain);
  }

  /**
   * 创建 CloudFront Distribution
   */
  private createCloudFront(
    albDnsName: string, 
    config: SystemConfig
  ): cloudfront.Distribution {
    
    // 创建原点
    const origin = new origins.HttpOrigin(albDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      connectionAttempts: 3,
      connectionTimeout: Duration.seconds(10),
      readTimeout: Duration.seconds(30),
      keepaliveTimeout: Duration.seconds(5),
      customHeaders: {
        'X-CloudFront-Secret': 'dify-cloudfront-secret',
      },
    });

    // 创建缓存策略
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: `${this.stackName}-api-cache`,
      comment: 'Cache policy for API endpoints',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'Authorization',
        'Content-Type',
        'X-App-Code'
      ),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    });

    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      cachePolicyName: `${this.stackName}-static-cache`,
      comment: 'Cache policy for static assets',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: `${this.stackName}-default-cache`,
      comment: 'Default cache policy',
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // 创建响应头策略
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      responseHeadersPolicyName: `${this.stackName}-response-headers`,
      comment: 'Response headers for Dify',
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { 
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true 
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(63072000),
          includeSubdomains: true,
          override: true
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true
        },
      },
    });

    // 创建 CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      
      comment: `CloudFront distribution for Dify application`,
      
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: defaultCachePolicy,
        responseHeadersPolicy,
        compress: true,
      },
      
      additionalBehaviors: {
        '/api/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
        '/v1/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
        '/console/api/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
        '/files/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
        '/static/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
        '/_next/static/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
          responseHeadersPolicy,
          compress: true,
        },
      },
      
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    return distribution;
  }

  /**
   * 创建 Stack 输出
   */
  private createOutputs(
    albDnsName?: string,
    cloudFrontDomain?: string
  ): void {
    
    if (albDnsName) {
      new cdk.CfnOutput(this, 'ALBDnsName', {
        value: albDnsName,
        description: 'Application Load Balancer DNS Name',
        exportName: `${this.stackName}-ALBDnsName`,
      });
    }

    if (cloudFrontDomain) {
      new cdk.CfnOutput(this, 'CloudFrontDomain', {
        value: `https://${cloudFrontDomain}`,
        description: 'CloudFront Distribution Domain',
        exportName: `${this.stackName}-CloudFrontDomain`,
      });

      if (this.distributionId) {
        new cdk.CfnOutput(this, 'DistributionId', {
          value: this.distributionId,
          description: 'CloudFront Distribution ID',
          exportName: `${this.stackName}-DistributionId`,
        });
      }
    }

    const accessUrl = cloudFrontDomain 
      ? `https://${cloudFrontDomain}`
      : albDnsName ? `http://${albDnsName}` : 'Not Available';
      
    new cdk.CfnOutput(this, 'AccessURL', {
      value: accessUrl,
      description: 'URL to access Dify application',
      exportName: `${this.stackName}-AccessURL`,
    });

    console.log('✅ Stack 输出配置完成');
    console.log(`📍 访问地址: ${accessUrl}`);
  }
}

/**
 * DifyHelmStack 属性
 */
export interface DifyHelmStackProps extends cdk.StackProps {
  readonly config: SystemConfig;
  readonly cluster: eks.ICluster;
  readonly vpc: ec2.IVpc;
  readonly clusterSecurityGroup?: ec2.ISecurityGroup;
  readonly albSecurityGroupId?: string;
  
  // 不再需要这些选项，始终创建 ALB 和使用 TargetGroupBinding
  
  // Database
  readonly dbEndpoint: string;
  readonly dbPort: string;
  readonly dbSecretArn?: string;
  readonly dbPassword?: string;
  
  // S3
  readonly s3BucketName: string;
  
  // Redis
  readonly redisEndpoint: string;
  readonly redisPort: string;
  
  // OpenSearch (optional)
  readonly openSearchEndpoint?: string;
  readonly openSearchSecretArn?: string;
}

/**
 * Dify Helm 部署构造器
 */
export class DifyHelmConstruct extends Construct {
  
  constructor(scope: Construct, id: string, props: DifyHelmConstructProps) {
    super(scope, id);
    
    const namespace = 'dify';
    
    console.log('🚀 部署 Dify Helm Chart');
    console.log('🔧 部署模式: TargetGroupBinding (默认)');
    
    // 创建 namespace
    const ns = new eks.KubernetesManifest(this, 'Namespace', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: namespace },
      }],
    });
    
    // 创建 IAM role for Service Account (IRSA)
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
    
    // 添加 S3 权限
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
    
    console.log(`✅ 创建了 Dify Service Account IAM 角色: ${difyServiceAccountRole.roleArn}`);
    
    // 生成密钥
    const secretKey = crypto.randomBytes(42).toString('base64');
    
    // 获取配置
    const dbPassword = props.dbPassword || 
                      props.config.postgresSQL.dbCredentialPassword || 
                      'Dify.Postgres.2024!';
    const opensearchPassword = props.config.openSearch.masterUserPassword || 
                              'OpenSearch.Admin.2024!';
    
    // 镜像仓库前缀
    const imageRegistry = props.config.isChinaRegion ? GCR_REGISTRY : '';
    
    // S3 域名
    const s3Domain = props.config.isChinaRegion ? 'amazonaws.com.cn' : 'amazonaws.com';
    
    // Dify 版本
    const difyVersion = props.config.dify.version || '1.1.0';
    
    // 确定访问 URL
    const baseUrl = props.alb?.cloudFrontDomain
      ? `https://${props.alb.cloudFrontDomain}`
      : props.alb?.dnsName 
        ? `http://${props.alb.dnsName}`
        : 'http://localhost';
    
    // 创建数据库迁移（如果启用）
    if (props.config.dify.dbMigration?.enabled) {
      this.createDatabaseMigration(
        props,
        namespace,
        dbPassword,
        ns
      );
    }
    
    // 部署 Helm Chart（优化配置）
    const helmChart = new eks.HelmChart(this, 'HelmChart', {
      cluster: props.cluster,
      chart: 'dify',
      repository: 'https://douban.github.io/charts/',
      release: 'dify',
      namespace,
      timeout: Duration.minutes(15),
      createNamespace: false,
      wait: false, // 优化：不等待完成，避免返回大量数据
      values: {
        global: {
          host: props.alb?.cloudFrontDomain || props.alb?.dnsName || 'localhost',
          port: props.alb?.cloudFrontDomain ? '443' : '80',
          enableTLS: !!props.alb?.cloudFrontDomain,
          image: { tag: difyVersion },
          edition: 'SELF_HOSTED',
          storageType: 's3',
          // 优化后的环境变量配置 - 只保留真正通用的配置（15个以内）
          extraBackendEnvs: [
            // 核心配置 (2个)
            { name: 'SECRET_KEY', value: secretKey },
            { name: 'LOG_LEVEL', value: 'INFO' },
            
            // Database (5个)
            { name: 'DB_USERNAME', value: props.config.postgresSQL.dbCredentialUsername || 'postgres' },
            { name: 'DB_PASSWORD', value: dbPassword },
            { name: 'DB_HOST', value: props.dbEndpoint },
            { name: 'DB_PORT', value: props.dbPort },
            { name: 'DB_DATABASE', value: props.config.postgresSQL.dbName || 'dify' },
            
            // Redis (3个)
            { name: 'REDIS_HOST', value: props.redisEndpoint },
            { name: 'REDIS_PORT', value: props.redisPort },
            { name: 'CELERY_BROKER_URL', value: `redis://:@${props.redisEndpoint}:${props.redisPort}/1` },
            
            // S3 (4个)
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${Aws.REGION}.${s3Domain}` },
            { name: 'S3_BUCKET_NAME', value: props.s3BucketName },
            { name: 'S3_REGION', value: Aws.REGION },
            { name: 'S3_USE_AWS_MANAGED_IAM', value: 'true' },
          ],
        },
        
        // Service Account 配置
        serviceAccount: {
          create: true,
          annotations: {
            'eks.amazonaws.com/role-arn': difyServiceAccountRole.roleArn,
          },
          name: 'dify',
        },
        
        // 前端配置
        frontend: {
          image: {
            repository: `${imageRegistry}langgenius/dify-web`,
          },
          service: {
            type: 'NodePort',  // TargetGroupBinding 需要 NodePort
            port: 80,
          },
          envs: [
            { name: 'CONSOLE_API_URL', value: baseUrl },
            { name: 'CONSOLE_WEB_URL', value: baseUrl },
            { name: 'SERVICE_API_URL', value: baseUrl },
            { name: 'APP_API_URL', value: baseUrl },
            { name: 'APP_WEB_URL', value: baseUrl },
            { name: 'MARKETPLACE_API_URL', value: 'https://marketplace.dify.ai' },
            { name: 'MARKETPLACE_URL', value: 'https://marketplace.dify.ai' },
            { name: 'NEXT_TELEMETRY_DISABLED', value: '1' },
            { name: 'EDITION', value: 'SELF_HOSTED' },
            { name: 'DEPLOY_ENV', value: 'PRODUCTION' },
            { name: 'ENABLE_WORKFLOW', value: 'true' },
            { name: 'ENABLE_TOOLS', value: 'true' },
            { name: 'ENABLE_DATASET', value: 'true' },
            { name: 'ENABLE_EXPLORE', value: 'true' },
          ],
        },
        
        // API 配置
        api: {
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
          },
          service: {
            type: 'NodePort',  // TargetGroupBinding 需要 NodePort
            port: 80,
          },
          resources: {
            limits: { cpu: '2', memory: '2Gi' },
            requests: { cpu: '1', memory: '1Gi' },
          },
          envs: [
            // API需要的额外配置
            { name: 'EDITION', value: 'SELF_HOSTED' },
            { name: 'DEPLOY_ENV', value: 'PRODUCTION' },
            { name: 'MIGRATION_ENABLED', value: 'true' },
            { name: 'STORAGE_TYPE', value: 's3' },
            { name: 'CONSOLE_CORS_ALLOW_ORIGINS', value: '*' },
            { name: 'WEB_API_CORS_ALLOW_ORIGINS', value: '*' },
            
            // Redis SSL配置（API需要）
            { name: 'REDIS_DB', value: '0' },
            { name: 'REDIS_USERNAME', value: '' },
            { name: 'REDIS_PASSWORD', value: '' },
            { name: 'REDIS_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            { name: 'BROKER_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            
            // Database URL（API需要）
            { name: 'SQLALCHEMY_DATABASE_URI', value: `postgresql://${props.config.postgresSQL.dbCredentialUsername || 'postgres'}:${dbPassword}@${props.dbEndpoint}:${props.dbPort}/${props.config.postgresSQL.dbName || 'dify'}` },
            
            // OpenSearch（如果启用）
            ...(props.config.openSearch.enabled && props.openSearchEndpoint ? [
              { name: 'VECTOR_STORE', value: 'opensearch' },
              { name: 'OPENSEARCH_HOST', value: props.openSearchEndpoint },
              { name: 'OPENSEARCH_PORT', value: '443' },
              { name: 'OPENSEARCH_USER', value: props.config.openSearch.masterUserName || 'admin' },
              { name: 'OPENSEARCH_PASSWORD', value: opensearchPassword },
              { name: 'OPENSEARCH_SECURE', value: 'true' },
            ] : [
              { name: 'VECTOR_STORE', value: 'weaviate' },
            ]),
            
            // Sandbox配置（API特定）
            { name: 'CODE_EXECUTION_ENDPOINT', value: 'http://dify-sandbox:80' },
            { name: 'CODE_EXECUTION_API_KEY', value: 'dify-sandbox' },
            { name: 'CODE_EXECUTION_MODE', value: 'api' },
            
            // 代码执行限制（API特定）
            { name: 'CODE_MAX_NUMBER', value: '9223372036854775807' },
            { name: 'CODE_MIN_NUMBER', value: '-9223372036854775808' },
            { name: 'CODE_MAX_STRING_LENGTH', value: '80000' },
            { name: 'TEMPLATE_TRANSFORM_MAX_LENGTH', value: '80000' },
            { name: 'CODE_MAX_STRING_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_OBJECT_ARRAY_LENGTH', value: '30' },
            { name: 'CODE_MAX_NUMBER_ARRAY_LENGTH', value: '1000' },
            { name: 'CODE_MAX_DEPTH', value: '5' },
            
            // Plugin Daemon连接（仅API需要）
            { name: 'PLUGIN_DAEMON_URL', value: 'http://dify-plugin-daemon:5002' },
            { name: 'MARKETPLACE_API_URL', value: 'https://marketplace.dify.ai' },
            { name: 'PLUGIN_DAEMON_KEY', value: props.config.dify.pluginDaemon?.serverKey || 'lYkiYYT6owG+71oLerGzA7GXCgOT++6ovaezWAjpCjf+Sjc3ZtU+qUEi' },
            { name: 'PLUGIN_DIFY_INNER_API_KEY', value: props.config.dify.pluginDaemon?.difyInnerApiKey || 'QaHbTe77CtuXmsfyhR7+vRjI/+XbV1AaFy691iy+kGDv2Jvy0/eAh8Y1' },
            { name: 'INNER_API_KEY_FOR_PLUGIN', value: props.config.dify.pluginDaemon?.difyInnerApiKey || 'QaHbTe77CtuXmsfyhR7+vRjI/+XbV1AaFy691iy+kGDv2Jvy0/eAh8Y1' },
            { name: 'PLUGIN_DIFY_INNER_API_URL', value: 'http://dify-api-svc:80' },
            
            // 网络配置（API特定）
            { name: 'SSRF_PROXY_HTTP_URL', value: '' },
            { name: 'SSRF_PROXY_HTTPS_URL', value: '' },
            
            // API监控和性能配置
            { name: 'API_COMPRESSION_ENABLED', value: 'true' },
            { name: 'SENTRY_DSN', value: '' },
            { name: 'SENTRY_TRACES_SAMPLE_RATE', value: '1.0' },
            { name: 'SENTRY_PROFILES_SAMPLE_RATE', value: '1.0' },
            
            // 工作流限制（API特定）
            { name: 'WORKFLOW_MAX_EXECUTION_TIME', value: '1200' },
            { name: 'WORKFLOW_CALL_MAX_DEPTH', value: '5' },
            { name: 'WORKFLOW_CONCURRENT_LIMIT', value: '10' },
            
            // 模型配置（API特定）
            { name: 'DEFAULT_LLM_PROVIDER', value: '' },
            { name: 'HOSTED_AZURE_OPENAI_ENABLED', value: 'false' },
            { name: 'HOSTED_ANTHROPIC_ENABLED', value: 'false' },
            { name: 'CHECK_UPDATE_URL', value: '' },
          ],
        },
        
        // Worker 配置
        worker: {
          image: {
            repository: `${imageRegistry}langgenius/dify-api`,
          },
          envs: [
            // Worker需要的额外配置（不需要Plugin Daemon和API特定配置）
            { name: 'EDITION', value: 'SELF_HOSTED' },
            { name: 'DEPLOY_ENV', value: 'PRODUCTION' },
            { name: 'STORAGE_TYPE', value: 's3' },
            
            // Redis SSL配置（Worker需要）
            { name: 'REDIS_DB', value: '0' },
            { name: 'REDIS_USERNAME', value: '' },
            { name: 'REDIS_PASSWORD', value: '' },
            { name: 'REDIS_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            { name: 'BROKER_USE_SSL', value: props.config.isChinaRegion ? 'true' : 'false' },
            
            // Database URL（Worker需要）
            { name: 'SQLALCHEMY_DATABASE_URI', value: `postgresql://${props.config.postgresSQL.dbCredentialUsername || 'postgres'}:${dbPassword}@${props.dbEndpoint}:${props.dbPort}/${props.config.postgresSQL.dbName || 'dify'}` },
            
            // OpenSearch（如果启用）
            ...(props.config.openSearch.enabled && props.openSearchEndpoint ? [
              { name: 'VECTOR_STORE', value: 'opensearch' },
              { name: 'OPENSEARCH_HOST', value: props.openSearchEndpoint },
              { name: 'OPENSEARCH_PORT', value: '443' },
              { name: 'OPENSEARCH_USER', value: props.config.openSearch.masterUserName || 'admin' },
              { name: 'OPENSEARCH_PASSWORD', value: opensearchPassword },
              { name: 'OPENSEARCH_SECURE', value: 'true' },
            ] : [
              { name: 'VECTOR_STORE', value: 'weaviate' },
            ]),
            
            // Worker不需要以下配置：
            // - Plugin Daemon配置
            // - Sandbox配置
            // - API监控配置
            // - 代码执行限制
          ],
        },
        
        // Sandbox 配置
        sandbox: {
          image: {
            repository: `${imageRegistry}langgenius/dify-sandbox`,
            tag: '0.2.10',
          },
          service: {
            type: 'NodePort',  // TargetGroupBinding 需要 NodePort
            port: 80,
          },
        },
        
        // Plugin Daemon 配置（默认启用）
        pluginDaemon: {
          enabled: true,
          image: {
            repository: `${imageRegistry}langgenius/dify-plugin-daemon`,
          },
          envs: [
            // Plugin Daemon特定配置
            { name: 'DB_DATABASE', value: 'dify_plugin' },
            { name: 'SERVER_PORT', value: '5002' },
            { name: 'MAX_PLUGIN_PACKAGE_SIZE', value: '52428800' },
            { name: 'PPROF_ENABLED', value: 'false' },
            { name: 'FORCE_VERIFYING_SIGNATURE', value: 'true' },
            { name: 'PLUGIN_REMOTE_INSTALLING_HOST', value: '0.0.0.0' },
            { name: 'PLUGIN_REMOTE_INSTALLING_PORT', value: '5003' },
            
            // Plugin Daemon密钥配置
            { name: 'SERVER_KEY', value: props.config.dify.pluginDaemon?.serverKey || 'lYkiYYT6owG+71oLerGzA7GXCgOT++6ovaezWAjpCjf+Sjc3ZtU+qUEi' },
            { name: 'DIFY_INNER_API_KEY', value: props.config.dify.pluginDaemon?.difyInnerApiKey || 'QaHbTe77CtuXmsfyhR7+vRjI/+XbV1AaFy691iy+kGDv2Jvy0/eAh8Y1' },
            { name: 'DIFY_INNER_API_URL', value: 'http://dify-api-svc:80' },
            
            // 数据库连接配置（Plugin Daemon需要独立的数据库）
            { name: 'DB_USERNAME', value: props.config.postgresSQL.dbCredentialUsername || 'postgres' },
            { name: 'DB_PASSWORD', value: dbPassword },
            { name: 'DB_HOST', value: props.dbEndpoint },
            { name: 'DB_PORT', value: props.dbPort },
          ],
        },
        
        // 禁用内嵌组件
        redis: { embedded: false },
        postgresql: { embedded: false },
        minio: { embedded: false },
      },
    });
    
    // 确保 Helm Chart 在 namespace 之后部署
    helmChart.node.addDependency(ns);
    
    // 创建 TargetGroupBinding（默认使用）
    if (props.alb) {
      this.createTargetGroupBindings(
        props.cluster,
        props.vpc,
        namespace,
        props.alb,
        helmChart
      );
    }
    
    console.log('✅ Dify Helm 部署配置完成');
    console.log(`📍 访问 URL: ${baseUrl}`);
  }
  
  /**
   * 创建数据库迁移
   */
  private createDatabaseMigration(
    props: DifyHelmConstructProps,
    namespace: string,
    dbPassword: string,
    ns: eks.KubernetesManifest
  ): void {
    console.log('🔄 配置数据库自动迁移...');
    
    // 创建数据库密码 Secret
    const dbSecretName = 'dify-db-credentials';
    const dbSecretManifest = new eks.KubernetesManifest(this, 'DbSecret', {
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
    
    // 确保 Secret 在 namespace 之后创建
    dbSecretManifest.node.addDependency(ns);
    
    const imageRegistry = props.config.isChinaRegion ? GCR_REGISTRY : '';
    
    // 创建数据库迁移构造器
    const dbMigration = new DatabaseMigrationConstruct(this, 'DbMigration', {
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
      difyVersion: props.config.dify.version || '1.1.0',
      imageRegistry,
    });
    
    // 确保迁移在 Secret 之后创建
    dbMigration.node.addDependency(dbSecretManifest);
    
    console.log('✅ 数据库迁移配置完成');
  }
  
  /**
   * 创建 TargetGroupBinding 资源
   */
  private createTargetGroupBindings(
    cluster: eks.ICluster,
    vpc: IVpc,
    namespace: string,
    alb: {
      apiTargetGroupArn: string;
      frontendTargetGroupArn: string;
      dnsName: string;
      cloudFrontDomain?: string;
    },
    helmChart: eks.HelmChart
  ): void {
    console.log('📝 创建 TargetGroupBinding 资源...');
    
    // API TargetGroupBinding
    const apiTgb = new eks.KubernetesManifest(this, 'ApiTGB', {
      cluster,
      manifest: [{
        apiVersion: 'elbv2.k8s.aws/v1beta1',
        kind: 'TargetGroupBinding',
        metadata: {
          name: 'dify-api-tgb',
          namespace,
        },
        spec: {
          networking: {
            ingress: [{
              from: [{
                ipBlock: {
                  cidr: vpc.vpcCidrBlock,
                },
              }],
              ports: [{
                protocol: 'TCP',
              }],
            }],
          },
          serviceRef: {
            name: 'dify-api-svc',
            port: 80,
          },
          targetGroupARN: alb.apiTargetGroupArn,
        },
      }],
    });
    
    // Frontend TargetGroupBinding
    const frontendTgb = new eks.KubernetesManifest(this, 'FrontendTGB', {
      cluster,
      manifest: [{
        apiVersion: 'elbv2.k8s.aws/v1beta1',
        kind: 'TargetGroupBinding',
        metadata: {
          name: 'dify-frontend-tgb',
          namespace,
        },
        spec: {
          networking: {
            ingress: [{
              from: [{
                ipBlock: {
                  cidr: vpc.vpcCidrBlock,
                },
              }],
              ports: [{
                protocol: 'TCP',
              }],
            }],
          },
          serviceRef: {
            name: 'dify-frontend',
            port: 80,
          },
          targetGroupARN: alb.frontendTargetGroupArn,
        },
      }],
    });
    
    // 确保在 Helm Chart 之后创建
    apiTgb.node.addDependency(helmChart);
    frontendTgb.node.addDependency(helmChart);
    
    console.log('✅ TargetGroupBinding 资源配置完成');
    console.log(`📝 ALB DNS: ${alb.dnsName}`);
    if (alb.cloudFrontDomain) {
      console.log(`🌐 CloudFront Domain: ${alb.cloudFrontDomain}`);
    }
  }
}

// 导出便捷的类型别名
export { DifyHelmConstruct as DifyHelm };
export { DifyHelmStack as DifyStack };