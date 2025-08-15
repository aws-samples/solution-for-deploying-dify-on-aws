/**
 * 极简数据库迁移 - 仅执行 flask db upgrade
 */

import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import { SystemConfig } from '../../src/config';

export interface DatabaseMigrationProps {
  readonly config: SystemConfig;
  readonly cluster: eks.ICluster;
  readonly namespace: string;
  readonly database: {
    endpoint: string;
    port: string;
    username: string;
    secretName: string;
    dbName: string;
  };
  readonly serviceAccountName: string;
  readonly difyVersion: string;
  readonly imageRegistry: string;
}

export class DatabaseMigrationConstruct extends Construct {
  constructor(scope: Construct, id: string, props: DatabaseMigrationProps) {
    super(scope, id);
    
    if (props.config.dify?.dbMigration?.enabled !== true) {
      return;
    }
    
    const jobName = `dify-db-migration-${Date.now()}`;
    const imageRegistry = props.config.isChinaRegion ?
      '048912060910.dkr.ecr.cn-northwest-1.amazonaws.com.cn/dockerhub/' : '';
    
    // 创建迁移Job
    new eks.KubernetesManifest(this, 'migration-job', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace: props.namespace,
          labels: {
            'app': 'dify',
            'component': 'db-migration',
          },
          annotations: {
            'helm.sh/hook': 'pre-install,pre-upgrade',
            'helm.sh/hook-weight': '-10',
            'helm.sh/hook-delete-policy': 'before-hook-creation,hook-succeeded',
          },
        },
        spec: {
          template: {
            spec: {
              serviceAccountName: props.serviceAccountName,
              restartPolicy: 'OnFailure',
              initContainers: [{
                name: 'wait-for-db',
                image: 'postgres:16-alpine',
                command: ['/bin/sh', '-c'],
                args: [`
                  until pg_isready -h ${props.database.endpoint} -p ${props.database.port} -U ${props.database.username}; do
                    echo "Waiting for database..."
                    sleep 5
                  done
                  echo "Database is ready!"
                `],
                env: [{
                  name: 'PGPASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: props.database.secretName,
                      key: 'password',
                    },
                  },
                }],
              }],
              containers: [{
                name: 'migration',
                image: `${imageRegistry}langgenius/dify-api:${props.difyVersion}`,
                command: ['/bin/bash', '-c'],
                args: [`
                  set -e
                  echo "Starting database migration..."
                  cd /app/api
                  source .venv/bin/activate
                  flask db upgrade
                  echo "Database migration completed!"
                `],
                env: [
                  { name: 'DB_USERNAME', value: props.database.username },
                  { name: 'DB_HOST', value: props.database.endpoint },
                  { name: 'DB_PORT', value: props.database.port },
                  { name: 'DB_DATABASE', value: props.database.dbName },
                  {
                    name: 'DB_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: props.database.secretName,
                        key: 'password',
                      },
                    },
                  },
                  { name: 'MIGRATION_ENABLED', value: 'false' },
                  { name: 'PYTHONUNBUFFERED', value: '1' },
                ],
                resources: {
                  limits: { cpu: '1', memory: '2Gi' },
                  requests: { cpu: '500m', memory: '1Gi' },
                },
              }],
            },
          },
          backoffLimit: 3,
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 86400,
        },
      }],
    });
  }
}