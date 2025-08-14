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

import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import { SystemConfig } from '../../src/config';

// GCR Registry for China region
const GCR_REGISTRY = '048912060910.dkr.ecr.cn-northwest-1.amazonaws.com.cn/dockerhub/';

export interface DifyMigrationProps {
  readonly config: SystemConfig;
  readonly cluster: eks.ICluster;
  readonly namespace: string;
  readonly dbEndpoint: string;
  readonly dbPort: string;
  readonly dbUsername: string;
  readonly dbName: string;
  readonly dbSecretName: string;
  readonly imageRegistry: string;
  readonly difyVersion: string;
  readonly serviceAccountName: string;
}

export class DifyMigrationConstruct extends Construct {
  private readonly props: DifyMigrationProps;
  
  constructor(scope: Construct, id: string, props: DifyMigrationProps) {
    super(scope, id);
    this.props = props;
    
    // 检查是否需要执行迁移
    if (!this.shouldRunMigration()) {
      console.log('Migration skipped: Either disabled or not required for this version.');
      return;
    }
    
    // 创建共享的 PersistentVolumeClaim 用于存储迁移数据
    const migrationPvc = this.createMigrationPvc();
    
    // 创建迁移 ConfigMap 用于状态追踪
    const migrationConfigMap = this.createMigrationConfigMap();
    
    // 创建迁移 Jobs
    const extractJob = this.createExtractPluginsJob(migrationPvc, migrationConfigMap);
    const installJob = this.createInstallPluginsJob(migrationPvc, migrationConfigMap, extractJob);
    const dbUpgradeJob = this.createDbUpgradeJob(migrationConfigMap, installJob);
    const dataMigrationJob = this.createDataMigrationJob(migrationConfigMap, dbUpgradeJob);
  }
  
  private shouldRunMigration(): boolean {
    const migrationConfig = this.props.config.dify.migration;
    
    // 如果明确禁用迁移，直接返回
    if (!migrationConfig?.enabled) {
      console.log('Migration disabled in configuration');
      return false;
    }
    
    // 获取当前版本
    const currentVersion = this.props.difyVersion;
    console.log(`Current Dify version: ${currentVersion}`);
    
    // 解析版本号 - Dify 使用 x.y.z 格式
    const versionParts = currentVersion.split('.');
    const major = parseInt(versionParts[0]);
    const minor = parseInt(versionParts[1]);
    const patch = parseInt(versionParts[2] || '0');
    
    // Dify 1.0.0 是插件系统的版本
    // 1.7.1 等版本是在 1.0.0 之前的版本（0.x 系列后的版本）
    // 实际上 Dify 的版本历史是: 0.x -> 1.x -> 2.x
    // 插件系统在某个特定版本引入，需要检查具体版本
    
    // 暂时禁用自动迁移，因为 1.7.1 不需要插件迁移
    // 只有明确配置了 fromVersion 时才执行迁移
    if (migrationConfig.fromVersion) {
      console.log(`Migration configured from version ${migrationConfig.fromVersion} to ${currentVersion}`);
      
      // 如果是全新安装，可以跳过插件迁移
      if (migrationConfig.skipPluginMigration) {
        console.log('Skipping plugin migration for fresh installation');
        return false;
      }
      return true;
    }
    
    // 默认不执行迁移（1.7.1 不需要插件迁移）
    console.log('No migration needed for version', currentVersion);
    return false;
  }
  
  private createMigrationPvc(): eks.KubernetesManifest {
    return new eks.KubernetesManifest(this, 'migration-pvc', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: 'dify-migration-pvc',
          namespace: this.props.namespace,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: {
              storage: '5Gi',
            },
          },
          storageClassName: 'gp3',  // 使用 EKS 默认的 gp3 存储类
        },
      }],
    });
  }
  
  private createMigrationConfigMap(): eks.KubernetesManifest {
    return new eks.KubernetesManifest(this, 'migration-configmap', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'dify-migration-status',
          namespace: this.props.namespace,
        },
        data: {
          status: 'pending',
          fromVersion: this.props.config.dify.migration?.fromVersion || 'unknown',
          toVersion: this.props.difyVersion,
          timestamp: new Date().toISOString(),
        },
      }],
    });
  }
  
  private createExtractPluginsJob(
    pvc: eks.KubernetesManifest, 
    configMap: eks.KubernetesManifest
  ): eks.KubernetesManifest {
    const job = new eks.KubernetesManifest(this, 'extract-plugins-job', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `dify-extract-plugins-${Date.now()}`,
          namespace: this.props.namespace,
          labels: {
            'app': 'dify-migration',
            'step': 'extract-plugins',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: this.props.serviceAccountName,
              restartPolicy: 'OnFailure',
              containers: [{
                name: 'extract-plugins',
                image: `${this.props.imageRegistry}langgenius/dify-api:${this.props.difyVersion}`,
                command: ['/bin/sh', '-c'],
                args: [`
                  echo "Starting plugin extraction..."
                  cd /app/api
                  
                  # Set up database connection
                  export DB_USERNAME="${this.props.dbUsername}"
                  export DB_PASSWORD=$(cat /etc/dify/db-secret/password)
                  export DB_HOST="${this.props.dbEndpoint}"
                  export DB_PORT="${this.props.dbPort}"
                  export DB_DATABASE="${this.props.dbName}"
                  export MIGRATION_ENABLED=false
                  
                  # Run extraction
                  poetry run flask extract-plugins --workers=${this.props.config.dify.migration?.workers?.extract || 20}
                  
                  # Copy the result to shared volume
                  cp plugins.jsonl /migration/plugins.jsonl
                  
                  echo "Plugin extraction completed. File saved to /migration/plugins.jsonl"
                  ls -la /migration/
                `],
                volumeMounts: [
                  {
                    name: 'migration-data',
                    mountPath: '/migration',
                  },
                  {
                    name: 'db-secret',
                    mountPath: '/etc/dify/db-secret',
                    readOnly: true,
                  },
                ],
                env: [
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                  { name: 'LOG_LEVEL', value: 'INFO' },
                ],
              }],
              volumes: [
                {
                  name: 'migration-data',
                  persistentVolumeClaim: {
                    claimName: 'dify-migration-pvc',
                  },
                },
                {
                  name: 'db-secret',
                  secret: {
                    secretName: this.props.dbSecretName,
                  },
                },
              ],
            },
          },
          backoffLimit: 3,
          ttlSecondsAfterFinished: 3600,  // 清理完成的 Job
        },
      }],
    });
    
    job.node.addDependency(pvc);
    job.node.addDependency(configMap);
    
    return job;
  }
  
  private createInstallPluginsJob(
    pvc: eks.KubernetesManifest,
    configMap: eks.KubernetesManifest,
    previousJob: eks.KubernetesManifest
  ): eks.KubernetesManifest {
    const job = new eks.KubernetesManifest(this, 'install-plugins-job', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `dify-install-plugins-${Date.now()}`,
          namespace: this.props.namespace,
          labels: {
            'app': 'dify-migration',
            'step': 'install-plugins',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: this.props.serviceAccountName,
              restartPolicy: 'OnFailure',
              initContainers: [{
                name: 'wait-for-extraction',
                image: 'busybox:1.35',
                command: ['sh', '-c'],
                args: [`
                  echo "Waiting for plugin extraction to complete..."
                  while [ ! -f /migration/plugins.jsonl ]; do
                    sleep 5
                  done
                  echo "Plugin extraction completed, proceeding with installation..."
                `],
                volumeMounts: [{
                  name: 'migration-data',
                  mountPath: '/migration',
                }],
              }],
              containers: [{
                name: 'install-plugins',
                image: `${this.props.imageRegistry}langgenius/dify-api:${this.props.difyVersion}`,
                command: ['/bin/sh', '-c'],
                args: [`
                  echo "Starting plugin installation..."
                  cd /app/api
                  
                  # Copy plugins.jsonl from shared volume
                  cp /migration/plugins.jsonl ./plugins.jsonl
                  
                  # Set up database connection
                  export DB_USERNAME="${this.props.dbUsername}"
                  export DB_PASSWORD=$(cat /etc/dify/db-secret/password)
                  export DB_HOST="${this.props.dbEndpoint}"
                  export DB_PORT="${this.props.dbPort}"
                  export DB_DATABASE="${this.props.dbName}"
                  export MIGRATION_ENABLED=false
                  
                  # Set marketplace URL
                  export MARKETPLACE_URL="${this.props.config.dify.migration?.marketplaceUrl || 'https://marketplace.dify.ai'}"
                  
                  # Run installation
                  poetry run flask install-plugins --workers=${this.props.config.dify.migration?.workers?.install || 2}
                  
                  echo "Plugin installation completed."
                  
                  # Mark completion
                  touch /migration/install-complete
                `],
                volumeMounts: [
                  {
                    name: 'migration-data',
                    mountPath: '/migration',
                  },
                  {
                    name: 'db-secret',
                    mountPath: '/etc/dify/db-secret',
                    readOnly: true,
                  },
                ],
                env: [
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                  { name: 'LOG_LEVEL', value: 'INFO' },
                ],
              }],
              volumes: [
                {
                  name: 'migration-data',
                  persistentVolumeClaim: {
                    claimName: 'dify-migration-pvc',
                  },
                },
                {
                  name: 'db-secret',
                  secret: {
                    secretName: this.props.dbSecretName,
                  },
                },
              ],
            },
          },
          backoffLimit: 3,
          ttlSecondsAfterFinished: 3600,
        },
      }],
    });
    
    job.node.addDependency(previousJob);
    
    return job;
  }
  
  private createDbUpgradeJob(
    configMap: eks.KubernetesManifest,
    previousJob: eks.KubernetesManifest
  ): eks.KubernetesManifest {
    const job = new eks.KubernetesManifest(this, 'db-upgrade-job', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `dify-db-upgrade-${Date.now()}`,
          namespace: this.props.namespace,
          labels: {
            'app': 'dify-migration',
            'step': 'db-upgrade',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: this.props.serviceAccountName,
              restartPolicy: 'OnFailure',
              initContainers: [{
                name: 'wait-for-plugin-install',
                image: 'busybox:1.35',
                command: ['sh', '-c'],
                args: [`
                  echo "Waiting for plugin installation to complete..."
                  while [ ! -f /migration/install-complete ]; do
                    sleep 5
                  done
                  echo "Plugin installation completed, proceeding with database upgrade..."
                `],
                volumeMounts: [{
                  name: 'migration-data',
                  mountPath: '/migration',
                }],
              }],
              containers: [{
                name: 'db-upgrade',
                image: `${this.props.imageRegistry}langgenius/dify-api:${this.props.difyVersion}`,
                command: ['/bin/sh', '-c'],
                args: [`
                  echo "Starting database upgrade..."
                  cd /app/api
                  
                  # Set up database connection
                  export DB_USERNAME="${this.props.dbUsername}"
                  export DB_PASSWORD=$(cat /etc/dify/db-secret/password)
                  export DB_HOST="${this.props.dbEndpoint}"
                  export DB_PORT="${this.props.dbPort}"
                  export DB_DATABASE="${this.props.dbName}"
                  export MIGRATION_ENABLED=false
                  
                  # Run database upgrade
                  poetry run flask db upgrade
                  
                  echo "Database upgrade completed."
                  
                  # Mark completion
                  touch /migration/db-upgrade-complete
                `],
                volumeMounts: [
                  {
                    name: 'migration-data',
                    mountPath: '/migration',
                  },
                  {
                    name: 'db-secret',
                    mountPath: '/etc/dify/db-secret',
                    readOnly: true,
                  },
                ],
                env: [
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                  { name: 'LOG_LEVEL', value: 'INFO' },
                ],
              }],
              volumes: [
                {
                  name: 'migration-data',
                  persistentVolumeClaim: {
                    claimName: 'dify-migration-pvc',
                  },
                },
                {
                  name: 'db-secret',
                  secret: {
                    secretName: this.props.dbSecretName,
                  },
                },
              ],
            },
          },
          backoffLimit: 3,
          ttlSecondsAfterFinished: 3600,
        },
      }],
    });
    
    job.node.addDependency(previousJob);
    
    return job;
  }
  
  private createDataMigrationJob(
    configMap: eks.KubernetesManifest,
    previousJob: eks.KubernetesManifest
  ): eks.KubernetesManifest {
    const job = new eks.KubernetesManifest(this, 'data-migration-job', {
      cluster: this.props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `dify-data-migration-${Date.now()}`,
          namespace: this.props.namespace,
          labels: {
            'app': 'dify-migration',
            'step': 'data-migration',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: this.props.serviceAccountName,
              restartPolicy: 'OnFailure',
              initContainers: [{
                name: 'wait-for-db-upgrade',
                image: 'busybox:1.35',
                command: ['sh', '-c'],
                args: [`
                  echo "Waiting for database upgrade to complete..."
                  while [ ! -f /migration/db-upgrade-complete ]; do
                    sleep 5
                  done
                  echo "Database upgrade completed, proceeding with data migration..."
                `],
                volumeMounts: [{
                  name: 'migration-data',
                  mountPath: '/migration',
                }],
              }],
              containers: [{
                name: 'data-migration',
                image: `${this.props.imageRegistry}langgenius/dify-api:${this.props.difyVersion}`,
                command: ['/bin/sh', '-c'],
                args: [`
                  echo "Starting data migration for plugin compatibility..."
                  echo "WARNING: This operation is irreversible. Ensure you have backups!"
                  cd /app/api
                  
                  # Set up database connection
                  export DB_USERNAME="${this.props.dbUsername}"
                  export DB_PASSWORD=$(cat /etc/dify/db-secret/password)
                  export DB_HOST="${this.props.dbEndpoint}"
                  export DB_PORT="${this.props.dbPort}"
                  export DB_DATABASE="${this.props.dbName}"
                  export MIGRATION_ENABLED=false
                  
                  # Run data migration
                  poetry run flask migrate-data-for-plugin
                  
                  echo "Data migration completed successfully."
                  
                  # Mark completion
                  touch /migration/migration-complete
                  
                  # Update status in ConfigMap (simulation)
                  echo "Migration completed at $(date)" > /migration/status.txt
                `],
                volumeMounts: [
                  {
                    name: 'migration-data',
                    mountPath: '/migration',
                  },
                  {
                    name: 'db-secret',
                    mountPath: '/etc/dify/db-secret',
                    readOnly: true,
                  },
                ],
                env: [
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                  { name: 'LOG_LEVEL', value: 'INFO' },
                ],
              }],
              volumes: [
                {
                  name: 'migration-data',
                  persistentVolumeClaim: {
                    claimName: 'dify-migration-pvc',
                  },
                },
                {
                  name: 'db-secret',
                  secret: {
                    secretName: this.props.dbSecretName,
                  },
                },
              ],
            },
          },
          backoffLimit: 3,
          ttlSecondsAfterFinished: 3600,
        },
      }],
    });
    
    job.node.addDependency(previousJob);
    
    return job;
  }
}