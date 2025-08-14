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

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 验证 VPC ID 格式
 */
export function isValidVpcId(vpcId: string): boolean {
  return /^vpc-[0-9a-f]{8,17}$/i.test(vpcId);
}

/**
 * 验证密码强度
 */
export function isStrongPassword(password: string): boolean {
  // 至少8位，包含大小写字母、数字和特殊字符
  const minLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
  
  return minLength && hasUpper && hasLower && hasNumber && hasSpecial;
}

/**
 * 验证域名格式
 */
export function isValidDomainName(domain: string): boolean {
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
  return domainRegex.test(domain);
}

/**
 * 验证 Hosted Zone ID 格式
 */
export function isValidHostedZoneId(hostedZoneId: string): boolean {
  return /^Z[A-Z0-9]{8,32}$/i.test(hostedZoneId);
}

/**
 * 验证 ACM 证书 ARN 格式
 */
export function isValidCertificateArn(arn: string): boolean {
  return /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[a-f0-9-]{36}$/.test(arn);
}

/**
 * 验证 EKS 集群名称
 */
export function isValidEksClusterName(name: string): boolean {
  // EKS 集群名称只能包含字母、数字和连字符，长度1-100
  return /^[a-zA-Z0-9-]{1,100}$/.test(name) && !name.startsWith('-') && !name.endsWith('-');
}

/**
 * 验证节点数量配置
 */
export function validateNodeCount(desiredSize: number, minSize: number, maxSize: number): string[] {
  const errors: string[] = [];
  
  if (desiredSize < 1) {
    errors.push('期望节点数量必须至少为1');
  }
  
  if (minSize < 1) {
    errors.push('最小节点数量必须至少为1');
  }
  
  if (maxSize < desiredSize) {
    errors.push('最大节点数量不能小于期望节点数量');
  }
  
  if (minSize > desiredSize) {
    errors.push('最小节点数量不能大于期望节点数量');
  }
  
  return errors;
}

/**
 * 验证存储配置
 */
export function validateStorageConfig(storageSize: number, backupRetention: number): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (storageSize < 20) {
    errors.push('存储大小至少需要20GB');
  }
  
  if (backupRetention < 0 || backupRetention > 35) {
    errors.push('备份保留天数必须在0-35天之间');
  }
  
  if (backupRetention === 0) {
    warnings.push('备份保留设置为0天，数据将不会被备份');
  }
  
  return errors;
}

/**
 * 主配置验证函数
 */
export function validateConfig(config: SystemConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  try {
    // 验证 VPC 配置
    if (config.network?.vpcId && !isValidVpcId(config.network.vpcId)) {
      errors.push('VPC ID 格式不正确，应为 vpc-xxxxxxxxx 格式');
    }
    
    // 验证域名配置
    if (config.domain?.domainName) {
      if (!isValidDomainName(config.domain.domainName)) {
        errors.push('域名格式不正确');
      }
      
      if (config.domain.hostedZoneId && !isValidHostedZoneId(config.domain.hostedZoneId)) {
        errors.push('Hosted Zone ID 格式不正确');
      }
      
      if (config.domain.acmCertificateArn && !isValidCertificateArn(config.domain.acmCertificateArn)) {
        errors.push('ACM 证书 ARN 格式不正确');
      }
    }
    
    // 验证 EKS 集群配置
    if (config.cluster?.eksClusterName && !isValidEksClusterName(config.cluster.eksClusterName)) {
      errors.push('EKS 集群名称格式不正确，只能包含字母、数字和连字符');
    }
    
    // 验证节点配置
    if (config.cluster?.managedNodeGroups?.app) {
      const nodeGroup = config.cluster.managedNodeGroups.app;
      const nodeErrors = validateNodeCount(
        nodeGroup.desiredSize || 3,
        nodeGroup.minSize || 1,
        nodeGroup.maxSize || 6
      );
      errors.push(...nodeErrors);
    }
    
    // 验证数据库密码
    if (config.postgresSQL?.dbCredentialPassword) {
      if (!isStrongPassword(config.postgresSQL.dbCredentialPassword)) {
        warnings.push('数据库密码强度较弱，建议使用更复杂的密码（至少8位，包含大小写字母、数字和特殊字符）');
      }
    } else {
      // 密码为空时仅警告，因为可以在部署时通过 AWS Secrets Manager 自动生成
      warnings.push('数据库密码未设置，将在部署时通过 AWS Secrets Manager 自动生成');
    }
    
    // 验证 OpenSearch 密码
    if (config.openSearch?.enabled) {
      if (config.openSearch?.masterUserPassword) {
        if (!isStrongPassword(config.openSearch.masterUserPassword)) {
          warnings.push('OpenSearch 主用户密码强度较弱，建议使用更复杂的密码');
        }
      } else {
        // 密码为空时仅警告，因为可以在部署时通过 AWS Secrets Manager 自动生成
        warnings.push('OpenSearch 主用户密码未设置，将在部署时通过 AWS Secrets Manager 自动生成');
      }
    }
    
    // 验证存储配置
    if (config.postgresSQL?.storageSize !== undefined && config.postgresSQL?.backupRetention !== undefined) {
      const storageErrors = validateStorageConfig(
        config.postgresSQL.storageSize,
        config.postgresSQL.backupRetention
      );
      errors.push(...storageErrors);
    }
    
    // 中国区域特定验证
    if (config.isChinaRegion) {
      if (config.domain?.useCloudfront) {
        warnings.push('中国区域不支持 CloudFront，该选项将被忽略');
      }
    }
    
    // 生产环境建议
    if (config.cluster?.managedNodeGroups?.app?.desiredSize === 1) {
      warnings.push('单节点配置不适合生产环境，建议至少使用3个节点以确保高可用性');
    }
    
    if (config.postgresSQL?.backupRetention === 0) {
      warnings.push('生产环境建议启用数据库备份（设置备份保留天数大于0）');
    }
    
    if (!config.openSearch?.multiAz?.enabled && config.openSearch?.enabled) {
      warnings.push('生产环境建议启用 OpenSearch 多可用区部署以提高可用性');
    }
    
  } catch (error) {
    errors.push(`配置验证过程中发生错误: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 验证 AWS 凭证配置 (简化版本)
 */
export function validateAwsCredentials(): Promise<ValidationResult> {
  return new Promise((resolve) => {
    // 这里可以实现真实的 AWS 凭证验证逻辑
    // 目前返回简化的结果
    resolve({
      isValid: true,
      errors: [],
      warnings: []
    });
  });
}