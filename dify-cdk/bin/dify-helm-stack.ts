import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DifyHelmConstruct } from '../lib/helm/dify-helm';
import { SystemConfig } from '../src/config';

export interface DifyHelmStackProps extends cdk.StackProps {
  config: SystemConfig;
  cluster: eks.ICluster;
  vpc: ec2.IVpc;
  clusterSecurityGroup: ec2.ISecurityGroup;
  albSecurityGroupId: string; // 从EKSStack传递过来的ALB安全组ID
  dbEndpoint: string;
  dbPort: string;
  dbSecretArn: string;
  dbPassword?: string; // RDS密码（可选）
  s3BucketName: string;
  redisEndpoint: string;
  redisPort: string;
  openSearchEndpoint?: string;
  openSearchSecretArn?: string;
}

export class DifyHelmStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: DifyHelmStackProps) {
    super(scope, id, props);

    console.log('🚀 部署Dify Stack - 纯Ingress架构');
    console.log(`📦 使用ALB安全组: ${props.albSecurityGroupId}`);

    // 为现有集群创建 Helm 部署角色（如果需要）
    let helmDeployRole: iam.IRole | undefined;
    if (props.config.cluster.useExistingCluster) {
      helmDeployRole = new iam.Role(this, 'HelmDeployRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        ],
      });
    }

    // 创建 Dify Helm Construct
    new DifyHelmConstruct(this, 'DifyHelm', {
      config: props.config,
      cluster: props.cluster,
      vpc: props.vpc,
      helmDeployRole,
      albSecurityGroupId: props.albSecurityGroupId,
      dbEndpoint: props.dbEndpoint,
      dbPort: props.dbPort,
      dbSecretArn: props.dbSecretArn,
      dbPassword: props.dbPassword, 
      s3BucketName: props.s3BucketName,
      redisEndpoint: props.redisEndpoint,
      redisPort: props.redisPort,
      openSearchEndpoint: props.openSearchEndpoint || '',
      openSearchSecretArn: props.openSearchSecretArn || '',
    });

    // 输出安全组ID供参考
    new cdk.CfnOutput(this, 'ALBSecurityGroupId', {
      value: props.albSecurityGroupId,
      description: 'Security Group ID for ALB created by Ingress Controller',
      exportName: 'DifyALBSecurityGroupId',
    });

    // 输出说明
    new cdk.CfnOutput(this, 'IngressInfo', {
      value: 'ALB will be automatically created by AWS Load Balancer Controller via Ingress',
      description: 'Note: Use kubectl get ingress -n dify to get ALB DNS name',
    });

    console.log('💡 提示: ALB将由AWS Load Balancer Controller通过Ingress资源自动创建');
    console.log('💡 部署完成后，使用以下命令获取ALB DNS名称:');
    console.log('   kubectl get ingress -n dify -o jsonpath="{.items[0].status.loadBalancer.ingress[0].hostname}"');
  }
}