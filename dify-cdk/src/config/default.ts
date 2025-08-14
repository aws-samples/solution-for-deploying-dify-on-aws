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

import { SystemConfig } from './types';

export const defaultConfig: SystemConfig = {
  isChinaRegion: false,
  deployLangfuse: false,
  dify: {
    version: '1.4.2',
    pluginDaemon: {
      enabled: true,
      storageSize: '20Gi',
    },
    migration: {
      enabled: true,                    // 默认启用自动迁移
      autoDetect: true,                 // 自动检测版本升级
      backupEnabled: false,             // 默认不备份（生产环境建议开启）
      workers: {
        extract: 20,                    // 插件提取并行数
        install: 2,                     // 插件安装并行数
      },
      skipPluginMigration: false,      // 默认执行插件迁移
      marketplaceUrl: 'https://marketplace.dify.ai',  // 默认插件市场地址
    },
  },
  network: {
    useExistingVpc: false,
    vpcCidr: '10.0.0.0/16',
    maxAzs: 2,
  },
  domain: {
    useCloudfront: false,
    cloudfront: {
      enabled: false,
      priceClass: 'PriceClass_200',  // 覆盖北美、欧洲和亚洲主要地区
      waf: {
        enabled: false,  // 默认禁用WAF以降低成本
        rateLimit: 2000,  // 每5分钟2000请求（仅在启用WAF时生效）
        geoRestriction: {
          restrictionType: 'blacklist',
          locations: [],  // 默认不限制
        },
      },
      cachePolicy: {
        defaultTTL: 300,    // 默认缓存5分钟
        maxTTL: 86400,      // 最大缓存1天
        minTTL: 0,          // 最小缓存0秒
      },
      logging: {
        enabled: true,
        prefix: 'cloudfront/',
      },
      originShield: {
        enabled: false,  // 默认不启用Origin Shield
      },
    },
  },
  cluster: {
    useExistingCluster: false,
    clusterName: 'dify-eks',
    version: '1.31', // 统一版本号
    vpcSubnetIds: [],
    managedNodeGroups: {
      app: {
        desiredSize: 3,
        minSize: 1,
        maxSize: 6,
        instanceType: 'c6g.large',
        diskSize: 100,
        workerNodeSubnetIds: [],
      },
    },
    eksClusterName: 'dify-eks', // 保持向后兼容
  },
  s3: {
    removeWhenDestroyed: false,
    useAccessKeyAuth: false, // Set to true for China region if needed
  },
  postgresSQL: {
    postgresFullVersion: '16.4',
    postgresMajorVersion: '16',
    instanceType: 'db.m6g.large',
    dbName: 'dify',
    dbCredentialUsername: 'postgres',
    dbCredentialPassword: '', // Will be generated dynamically
    backupRetention: 0,
    storageSize: 512,
    removeWhenDestroyed: false,
    subnetIds: [],
    multiAz: {
      enabled: false,
      subnetGroupName: '',
    },
  },
  redis: {
    engineVersion: '7.0',
    nodeType: 'cache.m6g.large',
    readReplicas: 1,
    subnetIds: [],
    multiAZ: {
      enabled: false,
      subnetGroupName: '',
    },
  },
  openSearch: {
    enabled: true,
    masterUserName: 'admin',
    masterUserPassword: '', // Will be generated dynamically
    multiAz: {
      enabled: false,
      azCount: 2,
    },
    subnetIds: [],
    capacity: {
      dataNodes: 2,
      dataNodeInstanceType: 'r6g.large.search',
    },
    dataNodeSize: 100,
  },
};
