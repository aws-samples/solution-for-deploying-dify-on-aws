import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

interface RDSStackProps extends cdk.StackProps {
  config: SystemConfig;
  vpc: ec2.IVpc;
  subnets?: ec2.SelectedSubnets;
}

export class RDSStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;
  public readonly dbSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: RDSStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const subnets = props.subnets || vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS});

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: vpc,
      description: 'Security group for RDS database',
      allowAllOutbound: true,
    });

    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow database connections from within the VPC'
    );

    // RDS 密码处理优化 - 使用用户密码或默认密码
    let dbPassword: string;
    if (config.postgresSQL.dbCredentialPassword) {
      // 如果用户提供了密码，使用用户密码
      dbPassword = config.postgresSQL.dbCredentialPassword;
      console.log('RDS: 使用用户配置的密码');
    } else {
      // 使用系统默认密码
      dbPassword = 'Dify.Default.RDS.Postgres.2024!';
      console.log('RDS: 使用系统默认密码');
    }

    // 手动创建 Secret 存储数据库凭证
    this.dbSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      secretName: 'dify-rds-credentials',
      description: 'RDS database credentials for Dify',
      secretObjectValue: {
        username: cdk.SecretValue.unsafePlainText(config.postgresSQL.dbCredentialUsername || 'postgres'),
        password: cdk.SecretValue.unsafePlainText(dbPassword),
      },
    });

    // 使用配置参数创建Aurora集群
    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of(
          config.postgresSQL.postgresFullVersion || '16.4',
          config.postgresSQL.postgresMajorVersion || '16'
        ),
      }),
      vpc: vpc,
      vpcSubnets: subnets,
      credentials: rds.Credentials.fromPassword(
        config.postgresSQL.dbCredentialUsername || 'postgres',
        cdk.SecretValue.unsafePlainText(dbPassword)
      ),
      clusterIdentifier: 'dify-db',
      defaultDatabaseName: config.postgresSQL.dbName || 'dify',
      serverlessV2MaxCapacity: 4,
      serverlessV2MinCapacity: 0.5,
      securityGroups: [dbSecurityGroup],
      writer: rds.ClusterInstance.serverlessV2('writer', {
        instanceIdentifier: 'dify-db-writer',
      }),
      // 使用配置中的备份设置 - RDS要求至少1天
      backup: {
        retention: cdk.Duration.days(config.postgresSQL.backupRetention || 1),
      },
      // 使用配置中的删除策略
      removalPolicy: config.postgresSQL.removeWhenDestroyed ?
        cdk.RemovalPolicy.DESTROY :
        cdk.RemovalPolicy.RETAIN,
    });

    // Output database information
    this.dbEndpoint = this.cluster.clusterEndpoint.hostname;
    this.dbPort = this.cluster.clusterEndpoint.port.toString();

    new cdk.CfnOutput(this, 'DBEndpoint', {
      value: this.dbEndpoint,
      description: 'RDS Endpoint',
      exportName: 'RDSInstanceEndpoint',
    });

    new cdk.CfnOutput(this, 'DBPort', {
      value: this.dbPort,
      description: 'RDS Port',
      exportName: 'RDSInstancePort',
    });

    new cdk.CfnOutput(this, 'DBSecretArn', {
      value: this.dbSecret.secretArn,
      description: 'RDS credentials secret ARN',
      exportName: 'RDSSecretArn',
    });

    console.log(`RDS配置: 版本=${config.postgresSQL.postgresFullVersion}, 用户名=${config.postgresSQL.dbCredentialUsername}, 数据库=${config.postgresSQL.dbName}`);
    console.log(`RDS密码管理: ${config.postgresSQL.dbCredentialPassword ? '使用用户配置的密码' : '使用系统默认密码'}`);
  }
}