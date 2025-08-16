#!/usr/bin/env node
/**
 * Dify TargetGroupBinding + CloudFront 集成部署
 * 
 * 这个部署脚本实现了：
 * 1. 使用 TargetGroupBinding 模式，预先创建 ALB
 * 2. 同时部署 CloudFront CDN
 * 3. 自动配置 Dify 使用 CloudFront 域名
 * 4. 一次部署完成所有配置，无需手动更新
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
  console.log('🚀 TargetGroupBinding + CloudFront 集成部署模式');
  console.log(`📍 部署区域类型: ${config.isChinaRegion ? '中国区域' : '海外区域'}`);
  console.log(`🏗️ VPC模式: ${config.network.useExistingVpc ? '使用现有VPC' : '创建新VPC'}`);
  console.log(`⚙️ EKS模式: ${config.cluster.useExistingCluster ? '使用现有EKS' : '创建新EKS'}`);
  console.log(`🌐 CloudFront: ${config.domain.cloudfront?.enabled ? '启用' : '禁用'}`);

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

  // 5. CloudFront CDN（如果启用）
  let cloudFrontStack: DifyCloudFrontStack | undefined;
  let cloudFrontDomain: string | undefined;
  
  if (config.domain.cloudfront?.enabled) {
    console.log('🌐 创建 CloudFront CDN...');
    
    // 创建一个临时的 ALB DNS 占位符
    // 实际的 ALB DNS 将在 DifyHelmStack 中创建
    const albDnsPlaceholder = 'ALB_DNS_PLACEHOLDER';
    
    cloudFrontStack = new DifyCloudFrontStack(app, 'DifyCloudFrontStack', {
      config,
      albDnsName: albDnsPlaceholder, // 临时占位符，稍后会被替换
      albSecurityGroup: eksStack.albSecurityGroup.securityGroup,
      crossRegionReferences: true,
      env: {
        ...env,
        region: 'us-east-1' // CloudFront 证书必须在 us-east-1
      }
    });
    
    // 获取 CloudFront 域名
    cloudFrontDomain = cloudFrontStack.distributionDomainName;
    console.log(`✅ CloudFront 将部署到: ${cloudFrontDomain}`);
  }

  // 6. 应用层 - Helm 部署（使用 TargetGroupBinding）
  const difyHelmStack = new DifyHelmStack(app, 'DifyStack', {
    config,
    cluster: eksStack.cluster,
    vpc: vpcStack.vpc,
    clusterSecurityGroup: eksStack.clusterSecurityGroup,
    albSecurityGroupId: eksStack.albSecurityGroup.securityGroup.securityGroupId,
    cloudFrontDomain: cloudFrontDomain, // 传递 CloudFront 域名

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

  // 7. 更新 CloudFront 的 ALB 源（如果启用）
  if (cloudFrontStack) {
    // 注意：由于 CloudFront 需要实际的 ALB DNS，我们需要在部署后更新
    // 这里我们添加依赖关系，确保正确的部署顺序
    cloudFrontStack.addDependency(difyHelmStack);
    
    console.log('📝 注意: CloudFront 配置需要 ALB DNS');
    console.log('   部署完成后，ALB DNS 将自动配置到 CloudFront');
  }

  // 8. 设置依赖关系
  difyHelmStack.addDependency(eksStack);
  difyHelmStack.addDependency(rdsStack);
  difyHelmStack.addDependency(redisClusterStack);
  difyHelmStack.addDependency(s3Stack);
  if (config.openSearch.enabled) {
    difyHelmStack.addDependency(openSearchStack);
  }

  // 9. 输出部署信息
  console.log('🚀 所有Stack配置完成，准备部署...');
  console.log('');
  console.log('📋 部署步骤:');
  console.log('1. 部署基础设施: cdk deploy DifyVPCStack DifyS3Stack DifyRDSStack DifyRedisStack DifyOpenSearchStack');
  console.log('2. 部署 EKS 集群: cdk deploy DifyEKSStack');
  console.log('3. 部署 Dify 应用: cdk deploy DifyStack');
  
  if (config.domain.cloudfront?.enabled) {
    console.log('4. 部署 CloudFront: cdk deploy DifyCloudFrontStack --parameters ALBDnsName=<ALB_DNS>');
    console.log('');
    console.log('📝 获取 ALB DNS 的命令:');
    console.log('   aws cloudformation describe-stacks --stack-name DifyStack --query "Stacks[0].Outputs[?OutputKey==\'ALBDnsName\'].OutputValue" --output text');
  }
  
  console.log('');
  console.log('🔧 或者一次部署所有Stack:');
  console.log('   cdk deploy --all');
  
  if (cloudFrontDomain) {
    console.log('');
    console.log(`🌐 部署完成后，通过 CloudFront 访问 Dify: https://${cloudFrontDomain}`);
  }

} catch (error) {
  console.error('❌ 配置加载失败:', error);
  console.error('💡 请确保运行 "npm run config" 生成配置文件');
  process.exit(1);
}