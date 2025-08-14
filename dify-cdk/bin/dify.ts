#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DifyHelmStack } from './dify-helm-stack';
import { S3Stack } from '../lib/S3/s3-stack';
import { VPCStack } from '../lib/VPC/vpc-stack';
import { RDSStack } from '../lib/RDS/rds-stack';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { RedisClusterStack } from '../lib/redis/redis-stack';
import { OpenSearchStack } from '../lib/AOS/aos-stack';
import { EKSStack } from '../lib/EKS/eks-stack';
import { DifyCloudFrontStack } from '../lib/cloudfront/dify-cloudfront';
import { loadConfig } from '../src/config';

const app = new cdk.App();

// 配置驱动的部署架构
try {
  // 1. 加载配置
  const config = loadConfig();
  console.log('✅ 配置加载成功');
  console.log(`📍 部署区域类型: ${config.isChinaRegion ? '中国区域' : '海外区域'}`);
  console.log(`🏗️ VPC模式: ${config.network.useExistingVpc ? '使用现有VPC' : '创建新VPC'}`);
  console.log(`⚙️ EKS模式: ${config.cluster.useExistingCluster ? '使用现有EKS' : '创建新EKS'}`);

  // 设置部署环境（区域和账号）
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-2'
  };
  
  console.log(`🌍 部署区域: ${env.region}`);
  console.log(`📦 AWS账号: ${env.account || '将使用当前AWS凭证的账号'}`);

  // 2. VPC - 支持现有或新建
  const vpcStack = new VPCStack(app, 'DifyVPCStack', { 
    config,
    env 
  });
  const privateSubnets = vpcStack.vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS});

  // 3. 基础设施层 - 全部配置驱动
  const s3Stack = new S3Stack(app, 'DifyS3Stack', { 
    config,
    env 
  });

  const rdsStack = new RDSStack(app, 'DifyRDSStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    env
  });

  const redisClusterStack = new RedisClusterStack(app, 'DifyRedisStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    env
  });

  const openSearchStack = new OpenSearchStack(app, 'DifyOpenSearchStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    domainName: 'dify-aos',
    env
  });

  // 4. EKS - 支持现有或新建
  const eksStack = new EKSStack(app, 'DifyEKSStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    env
  });

  // 5. 应用层 - 配置驱动的Helm部署
  const difyHelmStack = new DifyHelmStack(app, 'DifyStack', {
    config,
    cluster: eksStack.cluster,
    vpc: vpcStack.vpc,
    clusterSecurityGroup: eksStack.clusterSecurityGroup,
    albSecurityGroupId: eksStack.albSecurityGroup.securityGroup.securityGroupId, // 从EKSStack传递ALB安全组

    // 数据库连接通过输出值传递
    dbEndpoint: rdsStack.dbEndpoint,
    dbPort: rdsStack.dbPort,
    dbSecretArn: rdsStack.dbSecret.secretArn, // RDS密码Secret ARN

    // S3存储桶名称
    s3BucketName: s3Stack.bucket.bucketName,

    // Redis连接信息通过输出值传递
    redisEndpoint: cdk.Fn.importValue('RedisPrimaryEndpoint'),
    redisPort: cdk.Fn.importValue('RedisPort'),

    // OpenSearch连接信息
    openSearchEndpoint: config.openSearch.enabled ?
      cdk.Fn.importValue('OpenSearchDomainEndpoint') :
      '', // 如果未启用OpenSearch，传递空字符串
    openSearchSecretArn: config.openSearch.enabled && openSearchStack.openSearchSecret ?
      openSearchStack.openSearchSecret.secretArn :
      undefined, // OpenSearch密码Secret ARN
      
    crossRegionReferences: true, // 启用跨区域引用（为CloudFront）
    env
  });

  // 6. CloudFront CDN（可选）
  let cloudFrontStack: DifyCloudFrontStack | undefined;
  if (config.domain.cloudfront?.enabled) {
    console.log('🌐 配置CloudFront CDN...');
    console.log('⚠️ 注意: ALB将由Ingress Controller创建，需要在部署后手动获取DNS名称');
    
    // 纯Ingress模式：ALB由Ingress Controller创建
    // CloudFront需要在获取ALB DNS后部署
    cloudFrontStack = new DifyCloudFrontStack(app, 'DifyCloudFrontStack', {
      config,
      // albDnsName将通过参数或自定义资源获取
      albDnsName: '', // 将在部署时通过参数提供
      albSecurityGroup: eksStack.albSecurityGroup.securityGroup,
      crossRegionReferences: true, // 启用跨区域引用
      env: {
        ...env,
        region: 'us-east-1' // CloudFront 证书必须在 us-east-1
      }
    });
    
    // CloudFront需要在Helm部署后创建
    cloudFrontStack.addDependency(difyHelmStack);
    
    console.log('✅ CloudFront CDN配置准备完成');
    console.log('📝 部署提示: 请在DifyStack部署完成后，使用以下命令获取ALB DNS:');
    console.log('   kubectl get ingress -n dify -o jsonpath="{.items[0].status.loadBalancer.ingress[0].hostname}"');
    console.log('   然后使用参数部署CloudFront: cdk deploy DifyCloudFrontStack -c albDnsName=<ALB_DNS>');
  }

  // 7. 设置依赖关系
  difyHelmStack.addDependency(eksStack);
  difyHelmStack.addDependency(rdsStack);
  difyHelmStack.addDependency(redisClusterStack);
  difyHelmStack.addDependency(s3Stack);
  if (config.openSearch.enabled) {
    difyHelmStack.addDependency(openSearchStack);
  }

  console.log('🚀 所有Stack配置完成，准备部署...');

} catch (error) {
  console.error('❌ 配置加载失败:', error);
  console.error('💡 请确保运行 "npm run config" 生成配置文件');
  process.exit(1);
}
