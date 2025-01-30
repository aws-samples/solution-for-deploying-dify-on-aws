import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface RDSStackProps extends cdk.StackProps {
  subnets: cdk.aws_ec2.SelectedSubnets;
  vpc: ec2.Vpc;
}

export class RDSStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;

  constructor(scope: Construct, id: string, props: RDSStackProps) {
    super(scope, id, props);

    // Retrieve the password from context
    const dbPassword = this.node.tryGetContext('dbPassword');
    if (!dbPassword) {
      throw new Error("Context variable 'dbPassword' is missing");
    }

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for RDS database',
      allowAllOutbound: true,
    });

    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow database connections from within the VPC'
    );

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_7,
      }),
      vpc: props.vpc,
      vpcSubnets: props.subnets,
      credentials: rds.Credentials.fromPassword('postgres', cdk.SecretValue.unsafePlainText(dbPassword)),
      clusterIdentifier: 'dify-db',
      defaultDatabaseName: 'dify',
      serverlessV2MaxCapacity: 4,
      serverlessV2MinCapacity: 0.5,
      securityGroups: [dbSecurityGroup],
      writer: rds.ClusterInstance.serverlessV2('writer', {
        instanceIdentifier: 'dify-db-writer',
      }),
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

  }
}