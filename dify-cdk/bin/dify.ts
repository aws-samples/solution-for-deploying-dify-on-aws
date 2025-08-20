#!/usr/bin/env node
/**
 * 简化的 Dify 部署入口
 * 
 * 使用整合的 Stack，包含 ALB + CloudFront + Helm
 * 主要改进：
 * 1. 单 Stack 部署，无需跨区域引用
 * 2. 使用 ConfigMap 管理环境变量
 * 3. 自动配置前端 URL
 * 4. 一键部署所有组件
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DifyHelmStack } from '../lib/helm/dify-helm';
import { S3Stack } from '../lib/S3/s3-stack';
import { VPCStack } from '../lib/VPC/vpc-stack';
import { RDSStack } from '../lib/RDS/rds-stack';
import { RedisClusterStack } from '../lib/redis/redis-stack';
import { OpenSearchStack } from '../lib/AOS/aos-stack';
import { EKSStack } from '../lib/EKS/eks-stack';
import { loadConfig } from '../src/config';

const app = new cdk.App();

// 配置驱动的部署架构
try {
  // 1. 加载配置
  const config = loadConfig();
  console.log('✅ 配置加载成功');
  console.log('🚀 简化架构部署模式 - ALB + CloudFront 在同一 Stack');
  console.log(`📍 部署区域类型: ${config.isChinaRegion ? '中国区域' : '海外区域'}`);
  console.log(`🏗️ VPC模式: ${config.network.useExistingVpc ? '使用现有VPC' : '创建新VPC'}`);
  console.log(`⚙️ EKS模式: ${config.cluster.useExistingCluster ? '使用现有EKS' : '创建新EKS'}`);
  console.log(`🌐 CloudFront: ${config.domain.cloudfront?.enabled ? '启用' : '禁用'}`);

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
  const privateSubnets = vpcStack.vpc.selectSubnets({
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
  });

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

  // 4. EKS 集群
  const eksStack = new EKSStack(app, 'DifyEKSStack', {
    config,
    vpc: vpcStack.vpc,
    subnets: privateSubnets,
    env
  });

  // 5. 整合的 Dify Stack（包含 ALB + CloudFront + Helm）
  console.log('📦 配置整合的 Dify Stack...');
  const difyStack = new DifyHelmStack(app, 'DifyStack', {
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

  // 6. 设置依赖关系
  difyStack.addDependency(eksStack);
  difyStack.addDependency(rdsStack);
  difyStack.addDependency(redisClusterStack);
  difyStack.addDependency(s3Stack);
  if (config.openSearch.enabled) {
    difyStack.addDependency(openSearchStack);
  }

  // 7. 输出部署信息
  console.log('🚀 所有 Stack 配置完成，准备部署...');
  console.log('');
  console.log('');

} catch (error) {
  console.error('❌ 配置加载失败:', error);
  console.error('💡 请确保运行 "npm run config" 生成配置文件');
  process.exit(1);
}