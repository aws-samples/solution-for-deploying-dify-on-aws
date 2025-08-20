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
// 内联整合这些构造器，不再需要外部导入

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
    // 使用内联 ALB 创建逻辑，替代已删除的 DifyALBConstruct
    const difyAlb = this.createALB(props.vpc, props.config, props.albSecurityGroupId);
    
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

    // 使用预定义的Origin Request Policy - 确保所有Cookie转发到后端
    const apiOriginRequestPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    // 对于默认路径也使用相同的策略
    const defaultOriginRequestPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    // 使用AWS预定义的缓存策略 - 为API请求优化
    const apiCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED; // 完全禁用缓存，确保每次都请求源站

    // 使用AWS预定义的缓存策略来简化配置
    const staticCachePolicy = cloudfront.CachePolicy.CACHING_OPTIMIZED;

    // 默认路径也禁用缓存，确保认证请求始终传递到后端
    const defaultCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

    // 创建响应头策略 - 添加区域标识避免全球资源命名冲突
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      responseHeadersPolicyName: `${this.stackName}-${Aws.REGION}-response-headers`,
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
      // 移除 defaultRootObject，因为 Dify 不是静态网站
      // defaultRootObject: 'index.html',
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
        originRequestPolicy: defaultOriginRequestPolicy, // 添加Origin Request Policy
        responseHeadersPolicy,
        compress: true,
      },
      
      additionalBehaviors: {
        '/api/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy, // 关键：添加Origin Request Policy
          responseHeadersPolicy,
          compress: true,
        },
        '/v1/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy, // 关键：添加Origin Request Policy
          responseHeadersPolicy,
          compress: true,
        },
        '/console/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: defaultCachePolicy,
          originRequestPolicy: defaultOriginRequestPolicy, // 关键：添加Origin Request Policy
          responseHeadersPolicy,
          compress: true,
        },
        '/app/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: defaultCachePolicy,
          originRequestPolicy: defaultOriginRequestPolicy, // 关键：添加Origin Request Policy
          responseHeadersPolicy,
          compress: true,
        },
        '/files/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy, // 关键：添加Origin Request Policy
          responseHeadersPolicy,
          compress: true,
        },
        '/_next/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
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
      },
      
      // 移除错误响应配置，让 404 正常传递到应用
      // Dify 应用自己会处理路由
      errorResponses: [],
    });

    return distribution;
  }

  /**
   * 创建 ALB 及其 Target Groups
   * 内联实现，替代已删除的 DifyALBConstruct
   */
  private createALB(
    vpc: ec2.IVpc,
    config: SystemConfig,
    albSecurityGroupId?: string
  ): {
    apiTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
    frontendTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
    albDnsName: string;
    applicationLoadBalancer: cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer;
    listener: cdk.aws_elasticloadbalancingv2.ApplicationListener;
  } {
    // 导入必要的模块
    const { ApplicationLoadBalancer, ApplicationTargetGroup, ApplicationProtocol,
            ListenerAction, ApplicationListenerRule, ListenerCondition,
            TargetType } = cdk.aws_elasticloadbalancingv2;

    // 创建或使用现有的安全组
    let albSecurityGroup: ec2.ISecurityGroup;
    if (albSecurityGroupId) {
      albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'ExistingSG',
        albSecurityGroupId
      );
    } else {
      const newSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
        vpc: vpc,
        allowAllOutbound: true,
        description: 'Security group for Dify ALB',
      });
      
      // 添加入站规则
      newSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'Allow HTTP traffic'
      );
      
      albSecurityGroup = newSecurityGroup;
    }

    // 创建 ALB
    const applicationLoadBalancer = new ApplicationLoadBalancer(this, 'DifyALB', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup as ec2.SecurityGroup,
    });

    // 创建监听器
    const listener = applicationLoadBalancer.addListener('Listener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // 创建 API Target Group
    const apiTargetGroup = new ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc: vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${this.stackName}-api-tg`,
      healthCheck: {
        enabled: true,
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // 创建 Frontend Target Group
    const frontendTargetGroup = new ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      vpc: vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${this.stackName}-frontend-tg`,
      healthCheck: {
        enabled: true,
        path: '/apps',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // 配置路由规则 - Console API
    new ApplicationListenerRule(this, 'ConsoleApiRule', {
      listener: listener,
      priority: 1,
      conditions: [
        ListenerCondition.pathPatterns(['/console/api', '/console/api/*'])
      ],
      action: ListenerAction.forward([apiTargetGroup]),
    });

    // 配置路由规则 - API
    new ApplicationListenerRule(this, 'ApiRule', {
      listener: listener,
      priority: 2,
      conditions: [
        ListenerCondition.pathPatterns(['/api', '/api/*'])
      ],
      action: ListenerAction.forward([apiTargetGroup]),
    });

    // 配置路由规则 - V1 API
    new ApplicationListenerRule(this, 'V1Rule', {
      listener: listener,
      priority: 3,
      conditions: [
        ListenerCondition.pathPatterns(['/v1', '/v1/*'])
      ],
      action: ListenerAction.forward([apiTargetGroup]),
    });

    // 配置路由规则 - Files
    new ApplicationListenerRule(this, 'FilesRule', {
      listener: listener,
      priority: 4,
      conditions: [
        ListenerCondition.pathPatterns(['/files', '/files/*'])
      ],
      action: ListenerAction.forward([apiTargetGroup]),
    });

    // 配置路由规则 - Frontend (默认规则)
    new ApplicationListenerRule(this, 'FrontendRule', {
      listener: listener,
      priority: 5,
      conditions: [
        ListenerCondition.pathPatterns(['/*'])
      ],
      action: ListenerAction.forward([frontendTargetGroup]),
    });

    const albDnsName = applicationLoadBalancer.loadBalancerDnsName;
    
    return {
      apiTargetGroup,
      frontendTargetGroup,
      albDnsName,
      applicationLoadBalancer,
      listener
    };
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
            
            // CloudFront/Cookie配置 (4个) - 关键：解决401问题
            { name: 'SESSION_COOKIE_SECURE', value: props.alb?.cloudFrontDomain ? 'true' : 'false' },
            { name: 'SESSION_COOKIE_SAMESITE', value: 'Lax' }, // 改为Lax以支持CloudFront
            { name: 'SESSION_COOKIE_HTTPONLY', value: 'true' },
            { name: 'WEB_API_CORS_ALLOW_ORIGINS', value: '*' }, // 允许跨域
            
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
            
            // S3 (2个) - 减少到2个以腾出空间
            { name: 'S3_BUCKET_NAME', value: props.s3BucketName },
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
            
            // 增强的CORS和Cookie配置 - 解决401问题
            { name: 'CONSOLE_CORS_ALLOW_ORIGINS', value: props.alb?.cloudFrontDomain ? `https://${props.alb.cloudFrontDomain},http://${props.alb.dnsName}` : '*' },
            { name: 'WEB_API_CORS_ALLOW_ORIGINS', value: props.alb?.cloudFrontDomain ? `https://${props.alb.cloudFrontDomain},http://${props.alb.dnsName}` : '*' },
            // SESSION COOKIE配置 - 这些是解决401问题的关键
            { name: 'SESSION_COOKIE_SECURE', value: props.alb?.cloudFrontDomain ? 'true' : 'false' },
            { name: 'SESSION_COOKIE_SAMESITE', value: 'Lax' }, // 改为Lax以支持CloudFront
            { name: 'SESSION_COOKIE_HTTPONLY', value: 'true' },
            { name: 'PERMANENT_SESSION_LIFETIME', value: '86400' }, // 24小时session超时
            
            // 添加CSRF保护配置
            { name: 'WTF_CSRF_ENABLED', value: 'false' }, // 临时禁用CSRF以排查问题
            { name: 'WTF_CSRF_CHECK_DEFAULT', value: 'false' },
            
            // S3完整配置（API需要）
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${Aws.REGION}.${s3Domain}` },
            { name: 'S3_REGION', value: Aws.REGION },
            
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
            
            // Cookie配置（Worker也需要）- 这些也是解决401问题的关键
            { name: 'SESSION_COOKIE_SECURE', value: props.alb?.cloudFrontDomain ? 'true' : 'false' },
            { name: 'SESSION_COOKIE_SAMESITE', value: 'Lax' }, // Lax设置关键
            { name: 'SESSION_COOKIE_HTTPONLY', value: 'true' }, // 添加HTTPONLY设置
            { name: 'PERMANENT_SESSION_LIFETIME', value: '86400' }, // 添加session超时
            { name: 'WEB_API_CORS_ALLOW_ORIGINS', value: props.alb?.cloudFrontDomain ? `https://${props.alb.cloudFrontDomain},http://${props.alb.dnsName}` : '*' },
            { name: 'CONSOLE_CORS_ALLOW_ORIGINS', value: props.alb?.cloudFrontDomain ? `https://${props.alb.cloudFrontDomain},http://${props.alb.dnsName}` : '*' },
            
            // S3配置（Worker需要）
            { name: 'S3_ENDPOINT', value: `https://${props.s3BucketName}.s3.${Aws.REGION}.${s3Domain}` },
            { name: 'S3_REGION', value: Aws.REGION },
            
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
    
    // 内联创建数据库迁移任务，替代已删除的 DatabaseMigrationConstruct
    const jobName = `dify-db-migration-${Date.now()}`;
    
    // 创建迁移Job
    const dbMigrationJob = new eks.KubernetesManifest(this, 'DbMigrationJob', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace: namespace,
          labels: {
            'app': 'dify',
            'component': 'db-migration',
          },
          annotations: {
            'helm.sh/hook': 'pre-install,pre-upgrade',
            'helm.sh/hook-weight': '-10',
            'helm.sh/hook-delete-policy': 'before-hook-creation,hook-succeeded',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: 'dify',
              restartPolicy: 'OnFailure',
              initContainers: [{
                name: 'wait-for-db',
                image: 'postgres:16-alpine',
                command: ['/bin/sh', '-c'],
                args: [`
                  until pg_isready -h ${props.dbEndpoint} -p ${props.dbPort} -U ${props.config.postgresSQL.dbCredentialUsername || 'postgres'}; do
                    echo "Waiting for database..."
                    sleep 5
                  done
                  echo "Database is ready!"
                `],
                env: [{
                  name: 'PGPASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: dbSecretName,
                      key: 'password',
                    },
                  },
                }],
              }],
              containers: [{
                name: 'migration',
                image: `${imageRegistry}langgenius/dify-api:${props.config.dify.version || '1.1.0'}`,
                command: ['/bin/bash', '-c'],
                args: [`
                  set -e
                  echo "Starting database migration..."
                  cd /app/api
                  source .venv/bin/activate
                  flask db upgrade
                  echo "Database migration completed!"
                `],
                env: [
                  { name: 'DB_USERNAME', value: props.config.postgresSQL.dbCredentialUsername || 'postgres' },
                  { name: 'DB_HOST', value: props.dbEndpoint },
                  { name: 'DB_PORT', value: props.dbPort },
                  { name: 'DB_DATABASE', value: props.config.postgresSQL.dbName || 'dify' },
                  {
                    name: 'DB_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: dbSecretName,
                        key: 'password',
                      },
                    },
                  },
                  { name: 'MIGRATION_ENABLED', value: 'false' },
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                ],
                resources: {
                  limits: { cpu: '1', memory: '2Gi' },
                  requests: { cpu: '500m', memory: '1Gi' },
                },
              }],
            },
          },
          backoffLimit: 3,
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 86400,
        },
      }],
    });
    
    // 确保迁移在 Secret 之后创建
    dbMigrationJob.node.addDependency(dbSecretManifest);
    
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