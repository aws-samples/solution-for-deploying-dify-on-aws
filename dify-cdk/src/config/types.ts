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

export interface DifyConfig {
  version?: string;
  pluginDaemon?: {
    serverKey?: string;
    difyInnerApiKey?: string;
    enabled?: boolean;
    storageSize?: string;
  };
  migration?: {
    enabled?: boolean;          // 是否启用自动迁移
    autoDetect?: boolean;        // 自动检测版本升级需求
    fromVersion?: string;        // 源版本（用于手动指定）
    backupEnabled?: boolean;     // 是否在迁移前备份数据
    workers?: {
      extract?: number;          // 插件提取并行数
      install?: number;          // 插件安装并行数
    };
    skipPluginMigration?: boolean;  // 跳过插件迁移（适用于全新安装）
    marketplaceUrl?: string;     // 插件市场地址
  };
  dbMigration?: {
    enabled?: boolean;           // 启用数据库自动迁移
  };
}

export interface DomainConfig {
  hostedZoneId?: string;
  domainName?: string;
  acmCertificateArn?: string;
  useCloudfront?: boolean;
  cloudfront?: CloudFrontConfig;
  // Ingress configuration for ALB management
  ingress?: {
    mode?: 'targetgroup' | 'ingress'; // ALB管理模式：targetgroup（CDK创建）或 ingress（Controller创建）
    className?: string; // Ingress类名，默认为 'alb'
    annotations?: Record<string, string>; // 自定义Ingress注解
    securityGroupId?: string; // 指定安全组ID（可选，将自动创建）
  };
}

export interface CloudFrontConfig {
  enabled?: boolean;
  domainName?: string;
  certificateArn?: string;  // 可选，自动创建
  aliases?: string[];        // 备用域名
  priceClass?: 'PriceClass_All' | 'PriceClass_200' | 'PriceClass_100';
  waf?: {
    enabled?: boolean;
    webAclArn?: string;     // 可选，自动创建
    rateLimit?: number;     // 速率限制
    geoRestriction?: {
      restrictionType?: 'whitelist' | 'blacklist';
      locations?: string[];
    };
  };
  cachePolicy?: {
    defaultTTL?: number;
    maxTTL?: number;
    minTTL?: number;
  };
  logging?: {
    enabled?: boolean;
    bucketName?: string;    // 可选，自动创建
    prefix?: string;
  };
  originShield?: {
    enabled?: boolean;
    region?: string;
  };
}

export interface EksClusterConfig {
  useExistingCluster?: boolean; // 是否使用现有EKS
  clusterName?: string;         // 集群名称
  version?: string;             // EKS版本
  vpcSubnetIds?: string[];
  managedNodeGroups?: {
    app?: {
      desiredSize?: number;
      minSize?: number;
      maxSize?: number;
      instanceType?: string;
      diskSize?: number;
      workerNodeSubnetIds?: string[];
    };
  };
  eksClusterName?: string; // 保持向后兼容
}

export interface NetworkConfig {
  useExistingVpc?: boolean;     // 是否使用现有VPC
  vpcId?: string;               // 现有VPC ID
  vpcCidr?: string;             // 新建VPC的CIDR
  maxAzs?: number;              // 可用区数量
  availabilityZones?: string[];
  publicSubnetIds?: string[];
  privateSubnetIds?: string[];
}

export interface S3Config {
  removeWhenDestroyed?: boolean;
  // China region specific S3 configuration
  accessKey?: string;
  secretKey?: string;
  useAccessKeyAuth?: boolean;
}

export interface PostgresSQLConfig {
  postgresFullVersion?: string;
  postgresMajorVersion?: string;
  instanceType?: string;
  dbName?: string;
  dbCredentialUsername?: string;
  dbCredentialPassword?: string;
  backupRetention?: number;
  storageSize?: number;
  removeWhenDestroyed?: boolean;
  subnetIds?: string[];
  multiAz?: {
    enabled?: boolean;
    subnetGroupName?: string;
  };
}

export interface RedisConfig {
  engineVersion?: string;
  nodeType?: string;
  readReplicas?: number;
  subnetIds?: string[];
  multiAZ?: {
    enabled?: boolean;
    subnetGroupName?: string;
  };
}

export interface OpenSearchConfig {
  enabled?: boolean;
  masterUserName?: string;
  masterUserPassword?: string;
  multiAz?: {
    enabled?: boolean;
    azCount?: number;
  };
  subnetIds?: string[];
  capacity?: {
    dataNodes?: number;
    dataNodeInstanceType?: string;
  };
  dataNodeSize?: number;
}

export interface SystemConfig {
  // Deploy in China region or not
  isChinaRegion?: boolean;

  // Deploy Langfuse or not
  deployLangfuse?: boolean;

  // Dify config
  dify: DifyConfig;

  // Network config
  network: NetworkConfig;

  // Domain config
  domain: DomainConfig;

  // EKS cluster config
  cluster: EksClusterConfig;

  // s3 bucket config
  s3: S3Config;

  // AuroraPGSQL config
  postgresSQL: PostgresSQLConfig;

  // Redis config
  redis: RedisConfig;

  // OpenSearch config
  openSearch: OpenSearchConfig;
}
