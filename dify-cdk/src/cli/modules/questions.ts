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

import { SystemConfig } from '../../config/types';
import {
  EC2_INSTANCE_MAP,
  EC2_INSTANCE_GCR_MAP,
  RDS_INSTANCE_MAP,
  REDIS_NODE_MAP,
  OPENSEARCH_INSTANCE_MAP,
  DIFY_VERSIONS
} from '../../config/constants';
import { isValidVpcId, isValidDomainName, isValidHostedZoneId, isValidCertificateArn, isValidEksClusterName } from './validators';

/**
 * 获取配置问题列表
 */
export function getQuestions(existingConfig?: SystemConfig): any[] {
  const questions = [
    // 基础配置
    {
      type: 'select',
      name: 'configMode',
      message: '选择配置模式:',
      choices: [
        { name: '🚀 快速配置 (推荐新用户，使用默认设置)', value: 'quick' },
        { name: '⚙️  高级配置 (自定义所有选项)', value: 'advanced' }
      ],
      initial: 'quick'
    },
    
    // 区域选择
    {
      type: 'confirm',
      name: 'isChinaRegion',
      message: '是否部署在中国区域？',
      initial: existingConfig?.isChinaRegion ?? false,
      hint: '选择 "否" 将部署在海外区域'
    },
    
    // Dify 版本选择
    {
      type: 'select',
      name: 'difyVersion',
      message: '选择 Dify 版本:',
      choices: DIFY_VERSIONS.slice(-10).reverse().map(version => ({
        name: version,
        value: version
      })),
      initial: existingConfig?.dify?.version ?? '1.4.2',
      hint: '建议选择最新稳定版本'
    },
    
    // 网络配置
    {
      type: 'confirm',
      name: 'useExistingVpc',
      message: '是否使用现有的 VPC？',
      initial: existingConfig?.network?.vpcId ? true : false,
      hint: '选择 "否" 将创建新的 VPC'
    }
  ];
  
  return questions;
}

/**
 * 获取详细配置问题（基于基础答案）
 */
export function getDetailedQuestions(baseAnswers: any, existingConfig?: SystemConfig): any[] {
  const questions: any[] = [];

  // VPC ID 输入（仅在使用现有 VPC 时显示）
  if (baseAnswers.useExistingVpc) {
    questions.push({
      type: 'input',
      name: 'vpcId',
      message: '请输入现有 VPC ID (vpc-xxxxxxxxx):',
      initial: existingConfig?.network?.vpcId || '',
      validate(value: string) {
        if (!value) return '请输入有效的 VPC ID';
        return isValidVpcId(value) ? true : '请输入正确格式的 VPC ID (vpc-xxxxxxxxx)';
      }
    });
  }

  // 高级配置选项
  if (baseAnswers.configMode === 'advanced') {
    // EKS 集群配置
    questions.push({
      type: 'input',
      name: 'eksClusterName',
      message: '自定义 EKS 集群名称:',
      initial: existingConfig?.cluster?.eksClusterName || 'dify-eks',
      validate(value: string) {
        if (!value) return '集群名称不能为空';
        return isValidEksClusterName(value) ? true : '集群名称只能包含字母、数字和连字符，不能以连字符开头或结尾';
      }
    });
    
    // 节点实例类型选择
    const instanceMap = baseAnswers.isChinaRegion ? EC2_INSTANCE_GCR_MAP : EC2_INSTANCE_MAP;
    questions.push({
      type: 'select',
      name: 'eksNodeInstanceType',
      message: '选择 EKS 节点实例类型:',
      choices: Object.entries(instanceMap).map(([key, value]) => ({
        name: `${value} (${key})`,
        value: value
      })),
      initial: existingConfig?.cluster?.managedNodeGroups?.app?.instanceType ?? instanceMap['large']
    });
    
    // 节点数量配置
    questions.push({
      type: 'numeral',
      name: 'nodeCount',
      message: '设置期望的节点数量:',
      initial: existingConfig?.cluster?.managedNodeGroups?.app?.desiredSize ?? 3,
      min: 1,
      max: 20,
      hint: '生产环境建议至少3个节点以确保高可用性'
    });
    
    // RDS 实例类型
    questions.push({
      type: 'select',
      name: 'rdsInstanceType',
      message: '选择 PostgreSQL 实例类型:',
      choices: Object.entries(RDS_INSTANCE_MAP).map(([key, value]) => ({
        name: `${value} (${key})`,
        value: value
      })),
      initial: existingConfig?.postgresSQL?.instanceType ?? RDS_INSTANCE_MAP['large']
    });
    
    // Redis 节点类型
    questions.push({
      type: 'select',
      name: 'redisNodeType',
      message: '选择 Redis 节点类型:',
      choices: Object.entries(REDIS_NODE_MAP).map(([key, value]) => ({
        name: `${value} (${key.replace('m', ' GB')})`,
        value: value
      })),
      initial: existingConfig?.redis?.nodeType ?? REDIS_NODE_MAP['large']
    });
    
    // OpenSearch 配置
    questions.push({
      type: 'confirm',
      name: 'enableOpenSearch',
      message: '是否启用 OpenSearch 搜索服务？',
      initial: existingConfig?.openSearch?.enabled ?? true,
      hint: 'OpenSearch 用于向量搜索和文档检索功能'
    });
    
    
    // CloudFront 配置（非中国区域）
    if (!baseAnswers.isChinaRegion) {
      questions.push({
        type: 'confirm',
        name: 'useCloudfront',
        message: '是否使用 CloudFront CDN？',
        initial: existingConfig?.domain?.useCloudfront ?? false,
        hint: 'CloudFront 可以提供更好的全球访问速度和缓存'
      });
    }
    
    // 自定义域名配置
    questions.push({
      type: 'confirm',
      name: 'customDomain',
      message: '是否配置自定义域名？',
      initial: existingConfig?.domain?.domainName ? true : false,
      hint: '需要拥有 Route 53 托管域名'
    });
    
    // 数据库密码配置（必需）
    questions.push({
      type: 'password',
      name: 'dbPassword',
      message: '请设置数据库密码 (PostgreSQL):',
      validate(value: string) {
        if (!value) return '数据库密码不能为空';
        if (value.length < 8) return '密码长度至少8位';
        if (!/[A-Z]/.test(value)) return '密码必须包含大写字母';
        if (!/[a-z]/.test(value)) return '密码必须包含小写字母';
        if (!/\d/.test(value)) return '密码必须包含数字';
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(value)) return '密码必须包含特殊字符';
        return true;
      }
    });

    // OpenSearch密码配置（必需）
    questions.push({
      type: 'password',
      name: 'openSearchPassword',
      message: '请设置 OpenSearch 管理员密码:',
      validate(value: string) {
        if (!value) return 'OpenSearch 密码不能为空';
        if (value.length < 8) return '密码长度至少8位';
        if (!/[A-Z]/.test(value)) return '密码必须包含大写字母';
        if (!/[a-z]/.test(value)) return '密码必须包含小写字母';
        if (!/\d/.test(value)) return '密码必须包含数字';
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(value)) return '密码必须包含特殊字符';
        return true;
      }
    });
    
    // 数据保留配置
    questions.push({
      type: 'confirm',
      name: 'retainData',
      message: '是否在销毁资源时保留数据？',
      initial: existingConfig?.s3?.removeWhenDestroyed === false,
      hint: '选择 "是" 可以防止意外删除重要数据，但需要手动清理'
    });
  }
  
  return questions;
}

/**
 * 获取条件性问题（基于之前的答案）
 */
export function getConditionalQuestions(answers: any, existingConfig?: SystemConfig): any[] {
  const questions: any[] = [];
  
  // OpenSearch 实例类型（仅在启用时显示）
  if (answers.enableOpenSearch) {
    questions.push({
      type: 'select',
      name: 'openSearchInstanceType',
      message: '选择 OpenSearch 实例类型:',
      choices: Object.entries(OPENSEARCH_INSTANCE_MAP).map(([key, value]) => ({
        name: `${value} (${key})`,
        value: value
      })),
      initial: existingConfig?.openSearch?.capacity?.dataNodeInstanceType ?? OPENSEARCH_INSTANCE_MAP['small']
    });
  }
  
  // 域名相关问题（仅在启用自定义域名时显示）
  if (answers.customDomain) {
    questions.push(
      {
        type: 'input',
        name: 'domainName',
        message: '请输入域名 (例: dify.example.com):',
        initial: existingConfig?.domain?.domainName || '',
        validate(value: string) {
          if (!value) return '请输入有效的域名';
          return isValidDomainName(value) ? true : '请输入正确格式的域名';
        }
      },
      {
        type: 'input',
        name: 'hostedZoneId',
        message: '请输入 Route 53 Hosted Zone ID:',
        initial: existingConfig?.domain?.hostedZoneId || '',
        validate(value: string) {
          if (!value) return '请输入有效的 Hosted Zone ID';
          return isValidHostedZoneId(value) ? true : '请输入正确格式的 Hosted Zone ID (Z开头)';
        }
      },
      {
        type: 'input',
        name: 'certificateArn',
        message: '请输入 ACM 证书 ARN (可选):',
        initial: existingConfig?.domain?.acmCertificateArn || '',
        validate(value: string) {
          if (!value) return true; // 可选字段
          return isValidCertificateArn(value) ? true : '请输入正确格式的 ACM 证书 ARN';
        }
      }
    );
  }
  
  
  return questions;
}