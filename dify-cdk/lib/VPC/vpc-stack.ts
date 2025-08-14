import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SystemConfig } from '../../src/config';

export interface VPCStackProps extends cdk.StackProps {
  config: SystemConfig;
}

export class VPCStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly publicSubnets: ec2.ISubnet[];

  constructor(scope: Construct, id: string, props: VPCStackProps) {
    super(scope, id, props);

    const { config } = props;

    if (config.network.useExistingVpc && config.network.vpcId) {
      // Use existing VPC
      this.vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
        vpcId: config.network.vpcId,
      });
      
      console.log(`使用现有VPC: ${config.network.vpcId}`);
      
      // Output existing VPC info
      new cdk.CfnOutput(this, 'ExistingVpcId', {
        value: this.vpc.vpcId,
        description: 'Existing VPC ID',
      });
    } else {
      // Create new VPC
      const newVpc = new ec2.Vpc(this, 'DifyVpc', {
        maxAzs: config.network.maxAzs || 2,
        ipAddresses: config.network.vpcCidr ?
          ec2.IpAddresses.cidr(config.network.vpcCidr) :
          ec2.IpAddresses.cidr('10.0.0.0/16'),
        natGateways: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });

      this.vpc = newVpc;
      
      console.log(`创建新VPC: ${config.network.vpcCidr || '10.0.0.0/16'}`);

      // Output new VPC information
      new cdk.CfnOutput(this, 'NewVpcId', {
        value: newVpc.vpcId,
        description: 'New VPC ID',
      });

      // Output the Subnet IDs for new VPC
      newVpc.publicSubnets.forEach((subnet, index) => {
        new cdk.CfnOutput(this, `PublicSubnet${index}Id`, {
          value: subnet.subnetId,
        });
      });

      newVpc.privateSubnets.forEach((subnet, index) => {
        new cdk.CfnOutput(this, `PrivateSubnet${index}Id`, {
          value: subnet.subnetId,
        });
      });
    }
  }
}