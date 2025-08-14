import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import {ALBCDeploymentStack} from './aws-load-balancer-controller';
import * as lambdaLayerKubectl from '@aws-cdk/lambda-layer-kubectl-v30'; // 引入 kubectl v30 (兼容 EKS 1.33)
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';
import { ALBSecurityGroupConstruct } from '../security/alb-security-group';

interface EKSClusterStackProps extends cdk.StackProps {
  config: SystemConfig;
  vpc: ec2.IVpc;
  subnets?: ec2.SelectedSubnets;
}

export class EKSStack extends cdk.Stack {
  public readonly cluster: eks.ICluster;
  public readonly clusterSecurityGroup: ec2.ISecurityGroup;
  public readonly eksClusterSecurityGroup: ec2.ISecurityGroup; // 暴露集群安全组供其他Stack使用
  public readonly albSecurityGroup: ALBSecurityGroupConstruct; // 暴露ALB安全组供其他Stack使用
  private readonly newCluster?: eks.Cluster; // 新建集群的引用

  constructor(scope: Construct, id: string, props: EKSClusterStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const subnets = props.subnets || vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS});

    // 创建ALB安全组（在EKSStack中创建，避免循环依赖）
    this.albSecurityGroup = new ALBSecurityGroupConstruct(this, 'ALBSecurityGroup', {
      vpc: vpc,
      config: config,
    });
    console.log(`📦 ALB安全组已创建: ${this.albSecurityGroup.securityGroup.securityGroupId}`);

    if (config.cluster.useExistingCluster && config.cluster.clusterName) {
      // 使用现有EKS集群
      this.cluster = eks.Cluster.fromClusterAttributes(this, 'ExistingCluster', {
        clusterName: config.cluster.clusterName,
        vpc: vpc,
      });

      // 对于现有集群，假设已有安全组
      this.clusterSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'ExistingClusterSecurityGroup',
        this.cluster.clusterSecurityGroupId
      );

      console.log(`使用现有EKS集群: ${config.cluster.clusterName}`);

      // 输出现有集群信息
      new cdk.CfnOutput(this, 'ExistingClusterName', {
        value: this.cluster.clusterName,
        description: 'Existing EKS Cluster Name',
      });

    } else {
      // 创建新EKS集群
      console.log(`创建新EKS集群: ${config.cluster.clusterName || 'dify-eks'}`);

      // EKS 控制平面安全组
      const eksControlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'EKSControlPlaneSG', {
        vpc: vpc,
        description: 'Cluster communication with worker nodes',
        allowAllOutbound: true,
      });

      eksControlPlaneSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.allTraffic(),
        'Allow all traffic from within the VPC'
      );
      
      // 允许ALB访问NodePort范围（30000-32767）
      // 这对于ALB能够访问EKS节点上的Pod至关重要
      eksControlPlaneSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcpRange(30000, 32767),
        'Allow NodePort range from VPC for ALB access'
      );

      // EKS 集群角色
      const eksClusterRole = new iam.Role(this, 'EKSClusterRole', {
        assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy')],
      });

      // 创建 EKS 集群
      this.newCluster = new eks.Cluster(this, 'EKSCluster', {
        version: eks.KubernetesVersion.of(config.cluster.version || '1.33'),
        clusterName: config.cluster.clusterName || 'dify-eks',
        vpc: vpc,
        vpcSubnets: [subnets],
        securityGroup: eksControlPlaneSecurityGroup,
        role: eksClusterRole,
        endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
        defaultCapacity: 0, // 禁用默认节点组
        kubectlLayer: new lambdaLayerKubectl.KubectlV30Layer(this, 'KubectlLayer'),
        authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      });

      this.cluster = this.newCluster;

      // Enable EKS Pod Identity Agent
      this.newCluster.eksPodIdentityAgent;

      // Get the cluster security group for ALB connectivity
      this.clusterSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'ClusterSecurityGroup',
        this.newCluster.clusterSecurityGroupId
      );
      
      // 同时获取EKS集群的默认安全组（节点实际使用的）
      // 这是节点组实际使用的安全组，需要允许ALB访问
      const clusterDefaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'EKSClusterDefaultSecurityGroup',
        this.newCluster.clusterSecurityGroupId
      );
      
      // 暴露集群安全组供其他Stack使用
      this.eksClusterSecurityGroup = clusterDefaultSecurityGroup;

      // 配置EKS集群安全组允许来自ALB的流量
      clusterDefaultSecurityGroup.connections.allowFrom(
        this.albSecurityGroup.securityGroup,
        ec2.Port.allTcp(),
        'Allow all TCP traffic from ALB security group to EKS cluster nodes'
      );
      console.log(`✅ 已配置EKS集群安全组允许来自ALB的流量`);

      // 创建EBS CSI驱动
      this.createEbsCsiDriver();

      // 创建节点组
      this.createNodeGroup(config);

      // Deploy ALBC if it doesn't exist (only for new clusters)
      const _ALBC = new ALBCDeploymentStack(this, 'ALBCDeploymentStack', {
        cluster: this.newCluster,
      });

      // 输出新集群信息
      new cdk.CfnOutput(this, 'NewClusterName', {
        value: this.newCluster.clusterName,
        exportName: 'EKSClusterName',
        description: 'New EKS Cluster Name',
      });
      
      // 输出集群安全组ID供其他Stack使用
      new cdk.CfnOutput(this, 'ClusterSecurityGroupId', {
        value: this.newCluster.clusterSecurityGroupId,
        exportName: 'EKSClusterSecurityGroupId',
        description: 'EKS Cluster Security Group ID',
      });
    }
  }
  
  /**
   * 添加方法允许其他安全组访问EKS集群节点
   * 这是为了支持ALB等服务访问Pod
   */
  public allowIngressFrom(sourceSecurityGroup: ec2.ISecurityGroup, description: string): void {
    if (this.eksClusterSecurityGroup) {
      // 使用CDK的方法添加规则，避免循环依赖
      sourceSecurityGroup.connections.allowTo(
        new ec2.Connections({
          securityGroups: [this.eksClusterSecurityGroup],
        }),
        ec2.Port.allTcp(),
        description
      );
    }
  }

  private createNodeGroup(config: SystemConfig) {
    if (!this.newCluster) return;

    // 创建节点组 IAM 角色
    const nodeGroupRole = new iam.Role(this, 'NodeGroupRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // Add SageMaker permissions
    const invokeSagemakerPolicy = new iam.PolicyStatement({
      actions: ['sagemaker:InvokeEndpoint'],
      resources: ['*'],
    });
    
    nodeGroupRole.addToPolicy(invokeSagemakerPolicy);

    // Add S3 permissions for Dify application
    const s3Policy = new iam.PolicyStatement({
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
        's3:GetBucketLocation'
      ],
      resources: [
        'arn:aws:s3:::dify-*',
        'arn:aws:s3:::dify-*/*'
      ],
    });
    
    nodeGroupRole.addToPolicy(s3Policy);

    // 使用配置中的实例类型，如果没有则使用默认值
    const instanceType = config.cluster.managedNodeGroups?.app?.instanceType || 'm7g.large';
    console.log(`EKS Using instance type: ${instanceType}`);
    
    // 创建节点组
    this.newCluster.addNodegroupCapacity('NodeGroup', {
      instanceTypes: [new ec2.InstanceType(instanceType)],
      minSize: config.cluster.managedNodeGroups?.app?.minSize || 1,
      desiredSize: config.cluster.managedNodeGroups?.app?.desiredSize || 3,
      maxSize: config.cluster.managedNodeGroups?.app?.maxSize || 6,
      diskSize: config.cluster.managedNodeGroups?.app?.diskSize || 100,
      nodeRole: nodeGroupRole,
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD, // 使用AL2023 ARM64 AMI以支持EKS 1.33
    });
  }

  private createEbsCsiDriver() {
    if (!this.newCluster) return; // 只为新建的集群创建CSI驱动

    // Create service account with Pod Identity
    const sa = new eks.ServiceAccount(this, 'ServiceAccount-ebs-csi-controller-sa', {
      cluster: this.newCluster,
      name: 'ebs-csi-controller-sa',
      namespace: 'kube-system',
      identityType: eks.IdentityType.POD_IDENTITY,
    });

    // Add the EBS CSI Driver policy to the service account role
    sa.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
    );

    // Create the EBS CSI Driver addon
    const ebsCsiAddon = new eks.CfnAddon(this, 'ebs-csi-addon', {
      addonName: 'aws-ebs-csi-driver',
      clusterName: this.newCluster.clusterName,
      preserveOnDelete: false,
      resolveConflicts: 'OVERWRITE',
    });

    // Get the Pod Identity Agent addon to create dependency
    const cfnEksPodIdentityAgentAddon = this.newCluster.node.findChild('EksPodIdentityAgentAddon');
    ebsCsiAddon.node.addDependency(sa, cfnEksPodIdentityAgentAddon);

    // Create default storage class for plugin daemon
    this.newCluster.addManifest('plugin-storage-class', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'plugin-storage',
        annotations: {
          'storageclass.kubernetes.io/is-default-class': 'true',
        },
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'Immediate',
      parameters: {
        type: 'gp3',
        fsType: 'ext4',
      },
    });
  }
}
