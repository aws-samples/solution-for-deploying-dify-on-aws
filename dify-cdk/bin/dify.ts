#!/usr/bin/env node
/**
 * Dify with TargetGroupBinding Mode
 *
 * 这个部署脚本实现了：
 * 1. 使用 TargetGroupBinding 模式部署 Dify
 * 2. ALB 在 DifyStack 内部创建，DNS 固定
 * 3. 自动注册 Pods 到 Target Groups
 * 4. 支持可选的 CloudFront CDN 集成
 */

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
  console.log('🚀 使用 TargetGroupBinding 模式部署 Dify');
  console.log(`📍 部署区域类型: ${config.isChinaRegion ? '中国区域' : '海外区域'}`);
  console.log(`🏗️ VPC模式: ${config.network.useExistingVpc ? '使用现有VPC' : '创建新VPC'}`);
  console.log(`⚙️ EKS模式: ${config.cluster.useExistingCluster ? '使用现有EKS' : '创建新EKS'}`);

  // 从 context 或环境变量获取配置
  const useTargetGroupBinding = app.node.tryGetContext('useTargetGroupBinding') === 'true' || 
                               process.env.USE_TARGET_GROUP_BINDING === 'true';
  const deployCloudFront = app.node.tryGetContext('deployCloudFront') === 'true' || 
                          process.env.DEPLOY_CLOUDFRONT === 'true';

  console.log(`📦 TargetGroupBinding: ${useTargetGroupBinding ? '启用' : '禁用'}`);
  console.log(`🌐 CloudFront: ${deployCloudFront ? '启用' : '禁用'}`);

  // 设置部署环境（区域和账号）
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'ap-southeast-1'
  };
  
  console.log(`🌍 部署区域: ${env.region}`);
  console.log(`📦 AWS账号: ${env.account || '将使用当前AWS凭证的账号'}`);

  // 2. VPC - 支持现有或新建
  const vpcStack = new VPCStack(app, 'DifyVPCStack', { 
    config,
    env 
  });
  const privateSubnets = vpcStack.vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS});

  // 3. 基础设施层
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

  // 4. EKS
  const eksStack = new EKSStack(app, 'DifyEKSStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    env
  });

  // 5. 应用层 - Helm 部署
  // DifyHelmStack 会在内部创建 ALB 和 Target Groups
  console.log('📝 部署 Dify 应用 (TargetGroupBinding 模式)');
  
  const difyHelmStack = new DifyHelmStack(app, 'DifyStack', {
    config,
    cluster: eksStack.cluster,
    vpc: vpcStack.vpc,
    clusterSecurityGroup: eksStack.clusterSecurityGroup,
    albSecurityGroupId: eksStack.albSecurityGroup.securityGroup.securityGroupId,

    // 数据库连接
    dbEndpoint: rdsStack.dbEndpoint,
    dbPort: rdsStack.dbPort,
    dbSecretArn: rdsStack.dbSecret.secretArn,

    // S3存储桶
    s3BucketName: s3Stack.bucket.bucketName,

    // Redis连接
    redisEndpoint: cdk.Fn.importValue('RedisPrimaryEndpoint'),
    redisPort: cdk.Fn.importValue('RedisPort'),

    // OpenSearch连接
    openSearchEndpoint: config.openSearch.enabled ?
      cdk.Fn.importValue('OpenSearchDomainEndpoint') :
      '',
    openSearchSecretArn: config.openSearch.enabled && openSearchStack.openSearchSecret ?
      openSearchStack.openSearchSecret.secretArn :
      undefined,
      
    crossRegionReferences: true,
    env
  });

  // 6. CloudFront CDN（可选）
  if (deployCloudFront) {
    console.log('🌐 CloudFront CDN 配置说明:');
    console.log('   1. 先部署 DifyStack 创建 ALB');
    console.log('   2. 获取 ALB DNS 后部署 CloudFrontStack');
    console.log('   3. 更新 Dify 配置使用 CloudFront 域名');
  }

  // 7. 设置依赖关系
  difyHelmStack.addDependency(eksStack);
  difyHelmStack.addDependency(rdsStack);
  difyHelmStack.addDependency(redisClusterStack);
  difyHelmStack.addDependency(s3Stack);
  if (config.openSearch.enabled) {
    difyHelmStack.addDependency(openSearchStack);
  }

  // 8. 输出部署信息
  console.log('🚀 所有 Stack 配置完成，准备部署...');
  console.log('');
  console.log('📋 部署步骤:');
  console.log('1. 部署基础设施: cdk deploy DifyVPCStack DifyS3Stack DifyRDSStack DifyRedisStack DifyOpenSearchStack');
  console.log('2. 部署 EKS 集群: cdk deploy DifyEKSStack');
  console.log('3. 部署 Dify 应用 (含 ALB): cdk deploy DifyStack');
  
  if (deployCloudFront) {
    console.log('4. 部署 CloudFront: cdk deploy DifyCloudFrontStack --parameters ALBDnsName=<从 DifyStack 输出获取>');
  }
  
  console.log('');
  console.log('✨ 优势:');
  console.log('   - ALB 在 DifyStack 内部创建，DNS 固定');
  console.log('   - 使用 TargetGroupBinding 自动管理 Pod 注册');
  console.log('   - 无需手动更新 DNS 配置');
  
  console.log('');
  console.log('🔧 或者使用自动化脚本:');
  console.log('   ./deploy.sh --region ' + env.region + (deployCloudFront ? ' --with-cloudfront' : ''));

} catch (error) {
  console.error('❌ 配置加载失败:', error);
  console.error('💡 请确保运行 "npm run config" 生成配置文件');
  process.exit(1);
}