import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DifyHelmConstruct } from '../lib/helm/dify-helm';
import { DifyALBConstruct } from '../lib/alb/dify-alb-construct';
import { SystemConfig } from '../src/config';

export interface DifyHelmStackProps extends cdk.StackProps {
  config: SystemConfig;
  cluster: eks.ICluster;
  vpc: ec2.IVpc;
  clusterSecurityGroup: ec2.ISecurityGroup;
  albSecurityGroupId: string; // 从EKSStack传递过来的ALB安全组ID（现在用于创建ALB）
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

    console.log('🚀 部署Dify Stack - TargetGroupBinding架构');
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

    // 创建 ALB（TargetGroupBinding 模式必需）
    const difyAlb = new DifyALBConstruct(this, 'DifyALB', {
      vpc: props.vpc,
      config: props.config,
      albSecurityGroupId: props.albSecurityGroupId,
    });

    // 创建 Dify Helm Construct（使用 TargetGroupBinding 模式）
    const difyHelm = new DifyHelmConstruct(this, 'DifyHelm', {
      config: props.config,
      cluster: props.cluster,
      vpc: props.vpc,
      helmDeployRole,
      
      // 启用 TargetGroupBinding 模式
      useTargetGroupBinding: true,
      
      // 传递 ALB 信息
      alb: {
        apiTargetGroupArn: difyAlb.apiTargetGroup.targetGroupArn,
        frontendTargetGroupArn: difyAlb.frontendTargetGroup.targetGroupArn,
        dnsName: difyAlb.albDnsName,
      },
      
      // 数据库配置
      dbEndpoint: props.dbEndpoint,
      dbPort: props.dbPort,
      dbSecretArn: props.dbSecretArn,
      dbPassword: props.dbPassword, 
      
      // S3 配置
      s3BucketName: props.s3BucketName,
      
      // Redis 配置
      redisEndpoint: props.redisEndpoint,
      redisPort: props.redisPort,
      
      // OpenSearch 配置
      openSearchEndpoint: props.openSearchEndpoint || '',
      openSearchSecretArn: props.openSearchSecretArn || '',
    });

    // 确保 ALB 在 Helm 之前创建
    difyHelm.node.addDependency(difyAlb);

    // 输出 ALB DNS
    new cdk.CfnOutput(this, 'ALBDnsName', {
      value: difyAlb.albDnsName,
      description: 'Application Load Balancer DNS Name',
      exportName: 'DifyALBDnsName',
    });

    // 输出 Target Group ARNs
    new cdk.CfnOutput(this, 'ApiTargetGroupArn', {
      value: difyAlb.apiTargetGroup.targetGroupArn,
      description: 'API Target Group ARN',
      exportName: 'DifyApiTargetGroupArn',
    });

    new cdk.CfnOutput(this, 'FrontendTargetGroupArn', {
      value: difyAlb.frontendTargetGroup.targetGroupArn,
      description: 'Frontend Target Group ARN',
      exportName: 'DifyFrontendTargetGroupArn',
    });

    // 输出访问地址
    new cdk.CfnOutput(this, 'DifyAccessURL', {
      value: `http://${difyAlb.albDnsName}`,
      description: 'URL to access Dify application',
    });

    // 输出部署模式
    new cdk.CfnOutput(this, 'DeploymentMode', {
      value: 'TargetGroupBinding',
      description: 'Deployment mode used for Dify',
    });

    console.log('💡 提示: 使用 TargetGroupBinding 模式，ALB 已预先创建');
    console.log(`💡 ALB DNS: ${difyAlb.albDnsName}`);
    console.log('💡 Dify 服务将自动绑定到 Target Groups');
    console.log('✅ 一次部署即可完成所有配置，无需手动更新域名');
  }
}