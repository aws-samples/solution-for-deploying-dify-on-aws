#!/usr/bin/env node

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

import * as fs from 'fs';
import * as path from 'path';
import { Command } from '@commander-js/extra-typings';
import Enquirer from 'enquirer';
import chalk from 'chalk';
import { SystemConfig } from '../config/types';
import { defaultConfig } from '../config/default';
import { loadConfig } from '../config/loader';
import {
  EC2_INSTANCE_MAP,
  EC2_INSTANCE_GCR_MAP,
  RDS_INSTANCE_MAP,
  REDIS_NODE_MAP,
  OPENSEARCH_INSTANCE_MAP,
  DIFY_VERSIONS
} from '../config/constants';
import { validateConfig, ValidationResult } from './modules/validators';
import { getQuestions, getDetailedQuestions, getConditionalQuestions } from './modules/questions';

/**
 * Dify on AWS 交互式配置工具
 */

const program = new Command()
  .name('dify-config')
  .description('Dify on AWS 交互式配置工具')
  .version('1.0.0');

/**
 * 显示欢迎信息
 */
function showWelcome(): void {
  console.log(chalk.cyan(`
╔══════════════════════════════════════════════════════════════╗
║                    🚀 Dify on AWS 配置向导                    ║
║                                                              ║
║  欢迎使用 Dify on AWS 部署配置工具！                           ║
║  本工具将引导您完成部署前的所有必要配置。                       ║
╚══════════════════════════════════════════════════════════════╝
  `));
}

/**
 * 显示配置预览
 */
function showConfigPreview(config: SystemConfig): void {
  console.log(chalk.yellow('\n📋 配置预览'));
  console.log(chalk.gray('═'.repeat(60)));
  
  // 基础设置
  console.log(chalk.white('🌍 基础设置:'));
  console.log(`  区域类型: ${config.isChinaRegion ? '中国区域' : '海外区域'}`);
  console.log(`  Dify 版本: ${config.dify.version}`);
  
  // 网络配置
  console.log(chalk.white('\n🌐 网络配置:'));
  if (config.network.vpcId) {
    console.log(`  使用现有 VPC: ${config.network.vpcId}`);
  } else {
    console.log('  创建新的 VPC');
  }
  
  // 计算资源
  console.log(chalk.white('\n💻 计算资源:'));
  console.log(`  EKS 集群名称: ${config.cluster.eksClusterName}`);
  console.log(`  EKS 版本: ${config.cluster.version}`);
  console.log(`  节点实例类型: ${config.cluster.managedNodeGroups?.app?.instanceType}`);
  console.log(`  节点数量: ${config.cluster.managedNodeGroups?.app?.desiredSize} (最小: ${config.cluster.managedNodeGroups?.app?.minSize}, 最大: ${config.cluster.managedNodeGroups?.app?.maxSize})`);
  
  // 数据存储
  console.log(chalk.white('\n🗄️  数据存储:'));
  console.log(`  PostgreSQL 版本: ${config.postgresSQL.postgresFullVersion}`);
  console.log(`  PostgreSQL 实例: ${config.postgresSQL.instanceType}`);
  console.log(`  Redis 版本: ${config.redis.engineVersion}`);
  console.log(`  Redis 节点类型: ${config.redis.nodeType}`);
  
  if (config.openSearch.enabled) {
    console.log(`  OpenSearch 实例: ${config.openSearch.capacity?.dataNodeInstanceType}`);
    console.log(`  OpenSearch 节点数: ${config.openSearch.capacity?.dataNodes}`);
  }
  
  // 域名配置
  if (config.domain.useCloudfront) {
    console.log(chalk.white('\n🌐 域名配置:'));
    console.log('  使用 CloudFront 分发');
    if (config.domain.domainName) {
      console.log(`  自定义域名: ${config.domain.domainName}`);
    }
  }
  
  console.log(chalk.gray('═'.repeat(60)));
}


/**
 * 创建配置文件
 */
function createConfigFile(config: SystemConfig): void {
  const configPath = path.join(process.cwd(), 'config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(chalk.green(`\n✅ 配置文件已生成: ${configPath}`));
  } catch (error) {
    console.error(chalk.red('❌ 创建配置文件失败:'), error);
    process.exit(1);
  }
}

/**
 * 主配置流程
 */
async function runConfigWizard(): Promise<void> {
  showWelcome();
  
  // 检查是否存在现有配置
  let existingConfig: SystemConfig | undefined;
  const configPath = path.join(process.cwd(), 'config.json');
  
  if (fs.existsSync(configPath)) {
    console.log(chalk.yellow('📋 检测到现有配置文件'));
    const { useExisting } = await Enquirer.prompt([
      {
        type: 'confirm',
        name: 'useExisting',
        message: '是否基于现有配置进行修改？',
        initial: true,
      }
    ]) as { useExisting: boolean };
    
    if (useExisting) {
      try {
        existingConfig = loadConfig(configPath);
        console.log(chalk.green('✅ 已加载现有配置'));
      } catch (error) {
        console.log(chalk.yellow('⚠️  现有配置文件格式有误，将使用默认配置'));
      }
    }
  }
  
  try {
    console.log(chalk.cyan('\n🔧 开始配置过程...\n'));
    
    // 第一步：基础配置
    console.log(chalk.blue('📝 第一步：基础配置'));
    const baseQuestions = getQuestions(existingConfig);
    const baseAnswers = await Enquirer.prompt(baseQuestions) as any;
    
    // 第二步：详细配置（如果选择高级模式或需要VPC配置）
    let detailedAnswers: any = {};
    const detailedQuestions = getDetailedQuestions(baseAnswers, existingConfig);
    if (detailedQuestions.length > 0) {
      console.log(chalk.blue('\n📝 第二步：详细配置'));
      detailedAnswers = await Enquirer.prompt(detailedQuestions) as any;
    }
    
    // 第三步：条件性配置
    let conditionalAnswers: any = {};
    const allAnswers = { ...baseAnswers, ...detailedAnswers };
    const conditionalQuestions = getConditionalQuestions(allAnswers, existingConfig);
    if (conditionalQuestions.length > 0) {
      console.log(chalk.blue('\n📝 第三步：附加配置'));
      conditionalAnswers = await Enquirer.prompt(conditionalQuestions) as any;
    }
    
    // 合并所有答案
    const answers = { ...baseAnswers, ...detailedAnswers, ...conditionalAnswers };
    console.log(chalk.green('✅ 配置问答完成，开始构建配置...'));
    
    // 构建配置对象
    const config: SystemConfig = {
      ...defaultConfig,
      isChinaRegion: answers.isChinaRegion || false,
      dify: {
        version: answers.difyVersion || '1.4.2',
      },
      network: {
        vpcId: answers.useExistingVpc ? answers.vpcId : undefined,
      },
      domain: {
        ...defaultConfig.domain,
        useCloudfront: (answers.useCloudfront || false) && !answers.isChinaRegion,
        domainName: answers.customDomain ? (answers.domainName || '') : '',
        hostedZoneId: answers.customDomain ? (answers.hostedZoneId || '') : '',
        acmCertificateArn: answers.customDomain ? (answers.certificateArn || '') : '',
      },
      cluster: {
        ...defaultConfig.cluster,
        eksClusterName: answers.eksClusterName || defaultConfig.cluster.eksClusterName,
        managedNodeGroups: {
          app: {
            ...defaultConfig.cluster.managedNodeGroups!.app,
            instanceType: answers.eksNodeInstanceType ||
              (answers.isChinaRegion ? EC2_INSTANCE_GCR_MAP['large'] : EC2_INSTANCE_MAP['large']),
            desiredSize: answers.nodeCount || 3,
            minSize: Math.min(1, answers.nodeCount || 3),
            maxSize: Math.max((answers.nodeCount || 3) * 2, 6),
          },
        },
      },
      s3: {
        ...defaultConfig.s3,
        removeWhenDestroyed: answers.retainData !== undefined ? !answers.retainData : true,
      },
      postgresSQL: {
        ...defaultConfig.postgresSQL,
        instanceType: answers.rdsInstanceType || RDS_INSTANCE_MAP['large'],
        dbCredentialPassword: answers.dbPassword || '', // 空值时由 AWS Secrets Manager 自动生成
        removeWhenDestroyed: answers.retainData !== undefined ? !answers.retainData : true,
      },
      redis: {
        ...defaultConfig.redis,
        nodeType: answers.redisNodeType || REDIS_NODE_MAP['large'],
      },
      openSearch: {
        ...defaultConfig.openSearch,
        enabled: answers.enableOpenSearch !== undefined ? answers.enableOpenSearch : true,
        masterUserPassword: answers.openSearchPassword || '', // 空值时由 AWS Secrets Manager 自动生成
        capacity: {
          ...defaultConfig.openSearch.capacity,
          dataNodeInstanceType: answers.openSearchInstanceType || OPENSEARCH_INSTANCE_MAP['small'],
        },
      },
    };
    
    // 配置验证
    console.log(chalk.cyan('\n🔍 验证配置...'));
    const validation: ValidationResult = validateConfig(config);
    
    if (validation.warnings.length > 0) {
      console.log(chalk.yellow('\n⚠️  配置警告:'));
      validation.warnings.forEach((warning: string) => {
        console.log(chalk.yellow(`  • ${warning}`));
      });
    }
    
    if (!validation.isValid) {
      console.log(chalk.red('\n❌ 配置验证失败:'));
      validation.errors.forEach((error: string) => {
        console.log(chalk.red(`  • ${error}`));
      });
      process.exit(1);
    }
    
    // 显示配置预览
    showConfigPreview(config);
    
    // 最终确认
    const { confirmCreate } = await Enquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmCreate',
        message: '确认创建此配置？',
        initial: true,
      }
    ]) as { confirmCreate: boolean };
    
    if (confirmCreate) {
      createConfigFile(config);
      
      console.log(chalk.green('\n🎉 配置完成！'));
      console.log(chalk.cyan('\n📝 下一步操作:'));
      console.log('  1. 确保 AWS CLI 已配置正确的凭证');
      console.log('  2. 运行 npm run build 构建项目');
      console.log('  3. 运行 npm run cdk deploy 开始部署');
      console.log('\n📚 更多信息请参考项目文档。');
      
      // 显示密码安全提醒
      console.log(chalk.yellow('\n🔐 重要提醒:'));
      console.log('您设置的数据库和OpenSearch密码已保存在配置文件中，请妥善保管！');
      console.log('建议在部署完成后定期更新密码以确保安全。');
    } else {
      console.log(chalk.yellow('\n取消配置创建。'));
    }
    
  } catch (error) {
    if (error instanceof Error && error.message.includes('canceled')) {
      console.log(chalk.yellow('\n配置过程已取消。'));
    } else {
      console.error(chalk.red('\n❌ 配置过程中发生错误:'), error);
    }
    process.exit(1);
  }
}

// 主程序入口
program
  .action(async () => {
    try {
      await runConfigWizard();
    } catch (error) {
      console.error(chalk.red('配置工具执行失败:'), error);
      process.exit(1);
    }
  });

program.parse(process.argv);