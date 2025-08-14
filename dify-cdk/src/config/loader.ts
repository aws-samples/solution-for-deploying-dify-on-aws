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
import { SystemConfig } from './types';
import { defaultConfig } from './default';

export function loadConfig(configPath?: string): SystemConfig {
  let customConfig: Partial<SystemConfig> = {};

  // Determine config file path
  const configFilePath = configPath || path.join(process.cwd(), 'config.json');
  
  // Load configuration from config.json only
  if (fs.existsSync(configFilePath)) {
    try {
      const configContent = fs.readFileSync(configFilePath, 'utf-8');
      customConfig = JSON.parse(configContent);
    } catch (error) {
      throw new Error(`配置文件格式错误: ${configFilePath}. 错误信息: ${error}`);
    }
  } else {
    throw new Error(`配置文件不存在: ${configFilePath}. 请先运行 'npm run config' 生成配置文件。`);
  }

  // 密码验证已移除 - 支持AWS Secrets Manager自动生成密码
  // 如果用户未提供密码，将在部署时通过Secrets Manager自动生成
  console.log('📝 配置验证:');
  if (!customConfig.postgresSQL?.dbCredentialPassword) {
    console.log('  • PostgreSQL密码未设置，将通过AWS Secrets Manager自动生成');
  }
  
  if (customConfig.openSearch?.enabled && !customConfig.openSearch?.masterUserPassword) {
    console.log('  • OpenSearch密码未设置，将通过AWS Secrets Manager自动生成');
  }

  // Deep merge with default config
  return mergeDeep(defaultConfig, customConfig);
}

function mergeDeep(target: any, source: any): any {
  const output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = mergeDeep(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}
