import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

interface OpenSearchStackProps extends cdk.StackProps {
  config: SystemConfig;
  vpc: ec2.IVpc;
  subnets?: ec2.SelectedSubnets;
  domainName?: string;
}

export class OpenSearchStack extends cdk.Stack {
  public readonly openSearchDomain?: opensearch.Domain;
  public readonly openSearchSecret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: OpenSearchStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const subnets = props.subnets || vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS});
    const domainName = props.domainName || 'dify-aos';

    // 检查是否启用OpenSearch
    if (!config.openSearch.enabled) {
      console.log('OpenSearch未启用，跳过创建');
      return;
    }

    // OpenSearch 密码处理优化 - 使用用户密码或默认密码
    let masterUserPassword: string;
    if (config.openSearch.masterUserPassword) {
      // 如果用户提供了密码，使用用户密码
      masterUserPassword = config.openSearch.masterUserPassword;
      console.log('OpenSearch: 使用用户配置的密码');
    } else {
      // 使用系统默认密码
      masterUserPassword = 'Dify.Default.OpenSearch.2024!';
      console.log('OpenSearch: 使用系统默认密码');
    }

    // 密码强度验证
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\da-zA-Z]).*$/;
    if (!passwordRegex.test(masterUserPassword)) {
      throw new Error('OpenSearch密码必须包含至少一个大写字母、一个小写字母、一个数字和一个特殊字符');
    }

    // 创建Secrets Manager Secret存储OpenSearch凭证（简化版）
    this.openSearchSecret = new secretsmanager.Secret(this, 'OpenSearchSecret', {
      secretName: 'dify-opensearch-credentials',
      description: 'OpenSearch master user credentials for Dify',
      secretObjectValue: {
        username: cdk.SecretValue.unsafePlainText(config.openSearch.masterUserName || 'admin'),
        password: cdk.SecretValue.unsafePlainText(masterUserPassword),
      },
    });

    const openSearchSecurityGroup = new ec2.SecurityGroup(this, 'OpenSearchSecurityGroup', {
      vpc: vpc,
      description: 'Security group for Amazon OpenSearch Service',
      allowAllOutbound: true,
    });

    openSearchSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS connections from within the VPC'
    );

    // 添加对 9200 端口的入站规则
    openSearchSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(9200),
      'Allow HTTP connections on port 9200 from within the VPC'
    );

    // 使用配置参数创建OpenSearch域
    this.openSearchDomain = new opensearch.Domain(this, 'Domain', {
      version: opensearch.EngineVersion.OPENSEARCH_2_13,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      domainName: domainName,
      capacity: {
        multiAzWithStandbyEnabled: config.openSearch.multiAz?.enabled || false,
        masterNodes: 3,
        masterNodeInstanceType: 'm6g.large.search',
        dataNodes: config.openSearch.capacity?.dataNodes || 2,
        dataNodeInstanceType: config.openSearch.capacity?.dataNodeInstanceType || 't3.small.search',
      },
      ebs: {
        volumeSize: config.openSearch.dataNodeSize || 100,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      zoneAwareness: {
        enabled: true,
        availabilityZoneCount: config.openSearch.multiAz?.azCount || 2,
      },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      encryptionAtRest: {
        enabled: true,
      },
      fineGrainedAccessControl: {
        masterUserName: config.openSearch.masterUserName || 'admin',
        masterUserPassword: cdk.SecretValue.unsafePlainText(masterUserPassword),
      },
      vpc: vpc,
      vpcSubnets: [subnets],
      securityGroups: [openSearchSecurityGroup],

      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ['es:*'],
          resources: [`arn:aws:es:${this.region}:${this.account}:domain/${domainName}/*`],
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'OpenSearchDomainEndpoint', {
      value: this.openSearchDomain.domainEndpoint,
      description: 'OpenSearch Domain Endpoint',
      exportName: 'OpenSearchDomainEndpoint',
    });

    new cdk.CfnOutput(this, 'OpenSearchSecretArn', {
      value: this.openSearchSecret!.secretArn,
      description: 'OpenSearch credentials secret ARN',
      exportName: 'OpenSearchSecretArn',
    });

    console.log(`OpenSearch配置: 数据节点=${config.openSearch.capacity?.dataNodes}, 实例类型=${config.openSearch.capacity?.dataNodeInstanceType}, 存储大小=${config.openSearch.dataNodeSize}GB`);
    console.log(`OpenSearch密码管理: ${config.openSearch.masterUserPassword ? '使用用户配置的密码' : '使用系统默认密码'}`);
  }
}