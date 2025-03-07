import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import {ALBCDeploymentStack} from './aws-load-balancer-controller';
import * as lambdaLayerKubectl from '@aws-cdk/lambda-layer-kubectl-v30'; // 引入 kubectl v30
import { Construct } from 'constructs';
import { getAvailableInstanceType } from './instance-type-checker';

interface EKSClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  subnets: ec2.SelectedSubnets;
}

export class EKSStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EKSClusterStackProps) {
    super(scope, id, props);

    // EKS 控制平面安全组
    const eksControlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'EKSControlPlaneSG', {
      vpc: props.vpc,
      description: 'Cluster communication with worker nodes',
      allowAllOutbound: true,
    });

    eksControlPlaneSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all traffic from within the VPC'
    );

    // EKS 集群角色
    const eksClusterRole = new iam.Role(this, 'EKSClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy')],
    });

    // 创建 EKS 集群
    this.cluster = new eks.Cluster(this, 'EKSCluster', {
      version: eks.KubernetesVersion.of(this.node.tryGetContext('EKSClusterVersion') || '1.31'),
      clusterName: 'dify-eks', 
      vpc: props.vpc,
      vpcSubnets: [props.subnets],
      securityGroup: eksControlPlaneSecurityGroup,
      role: eksClusterRole,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      defaultCapacity: 0, // 禁用默认节点组
      kubectlLayer: new lambdaLayerKubectl.KubectlV30Layer(this, 'KubectlLayer'), 
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    // 创建节点组 IAM 角色
    const nodeGroupRole = new iam.Role(this, 'NodeGroupRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // 添加EBS卷操作权限的内联策略
    const ebsPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateVolume',
        'ec2:DeleteVolume',
        'ec2:AttachVolume',
        'ec2:DetachVolume',
        'ec2:DescribeVolumes',
        'ec2:DescribeVolumesModifications',
        'ec2:ModifyVolume',
        'ec2:DescribeInstances',
        'ec2:CreateSnapshot',
        'ec2:DeleteSnapshot',
        'ec2:DescribeSnapshots',
        'ec2:CreateTags',
        'ec2:DeleteTags'
      ],
      resources: ['*']
    });
    
    nodeGroupRole.addToPolicy(ebsPolicy);

    const invokeSagemakerPolicy = new iam.PolicyStatement({
      actions: ['sagemaker:InvokeEndpoint'],
      resources: ['*'], 
    });
    
    nodeGroupRole.addToPolicy(invokeSagemakerPolicy);

    // 异步获取可用的实例类型
    (async () => {
      const nodeInstanceType = await getAvailableInstanceType();
    console.log(`EKS Using instance type: ${nodeInstanceType}`);

    this.cluster.addNodegroupCapacity('NodeGroup', {
      instanceTypes: [new ec2.InstanceType(nodeInstanceType)],
      minSize: this.node.tryGetContext('NodeGroupMinSize') || 3,
      desiredSize: this.node.tryGetContext('NodeGroupDesiredSize') || 3,
      maxSize: this.node.tryGetContext('NodeGroupMaxSize') || 10,
      nodeRole: nodeGroupRole,
    });
    })();

    // 添加 AWS EBS CSI Driver 服务账户
    const ebsCSIServiceAccount = this.cluster.addServiceAccount('ebs-csi-controller-sa', {
      name: 'ebs-csi-controller-sa',
      namespace: 'kube-system',
    });

    // 添加 EBS CSI Controller 权限
    ebsCSIServiceAccount.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy')
    );

    // 创建 CSIDriver 对象
    this.cluster.addManifest('ebs-csi-driver', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'CSIDriver',
      metadata: {
        name: 'ebs.csi.aws.com'
      },
      spec: {
        attachRequired: true,
        podInfoOnMount: false,
        volumeLifecycleModes: ['Persistent']
      }
    });

    // 创建 gp2 StorageClass
    this.cluster.addManifest('gp2-storage-class', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'gp2',
        annotations: {
          'storageclass.kubernetes.io/is-default-class': 'true'
        }
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'Immediate',  // 修改为立即绑定模式
      parameters: {
        type: 'gp2',
        fsType: 'ext4'
      }
    });

    // 创建专用于插件系统的StorageClass
    this.cluster.addManifest('plugin-storage-class', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'plugin-storage'
      },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'Immediate',
      parameters: {
        type: 'gp2',
        fsType: 'ext4'
      }
    });

    // 配置 EBS CSI Controller Deployment
    this.cluster.addManifest('ebs-csi-controller', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'ebs-csi-controller',
        namespace: 'kube-system'
      },
      spec: {
        replicas: 2,
        selector: {
          matchLabels: {
            app: 'ebs-csi-controller'
          }
        },
        template: {
          metadata: {
            labels: {
              app: 'ebs-csi-controller'
            }
          },
          spec: {
            serviceAccountName: 'ebs-csi-controller-sa',
            priorityClassName: 'system-cluster-critical',
            containers: [
              {
                name: 'ebs-plugin',
                image: 'k8s.gcr.io/provider-aws/aws-ebs-csi-driver:v1.8.0',
                args: [
                  '--endpoint=$(CSI_ENDPOINT)',
                  '--logtostderr',
                  '--v=5'
                ],
                env: [
                  {
                    name: 'CSI_ENDPOINT',
                    value: 'unix:///var/lib/csi/sockets/pluginproxy/csi.sock'
                  }
                ],
                volumeMounts: [
                  {
                    name: 'socket-dir',
                    mountPath: '/var/lib/csi/sockets/pluginproxy/'
                  }
                ]
              },
              {
                name: 'csi-provisioner',
                image: 'k8s.gcr.io/sig-storage/csi-provisioner:v3.1.0',
                args: [
                  '--csi-address=$(ADDRESS)',
                  '--v=5',
                  '--feature-gates=Topology=true',
                  '--extra-create-metadata'
                ],
                env: [
                  {
                    name: 'ADDRESS',
                    value: '/var/lib/csi/sockets/pluginproxy/csi.sock'
                  }
                ],
                volumeMounts: [
                  {
                    name: 'socket-dir',
                    mountPath: '/var/lib/csi/sockets/pluginproxy/'
                  }
                ]
              },
              {
                name: 'csi-attacher',
                image: 'k8s.gcr.io/sig-storage/csi-attacher:v3.3.0',
                args: [
                  '--csi-address=$(ADDRESS)',
                  '--v=5'
                ],
                env: [
                  {
                    name: 'ADDRESS',
                    value: '/var/lib/csi/sockets/pluginproxy/csi.sock'
                  }
                ],
                volumeMounts: [
                  {
                    name: 'socket-dir',
                    mountPath: '/var/lib/csi/sockets/pluginproxy/'
                  }
                ]
              }
            ],
            volumes: [
              {
                name: 'socket-dir',
                emptyDir: {}
              }
            ]
          }
        }
      }
    });

    // 配置 EBS CSI Node DaemonSet
    this.cluster.addManifest('ebs-csi-node', {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: {
        name: 'ebs-csi-node',
        namespace: 'kube-system'
      },
      spec: {
        selector: {
          matchLabels: {
            app: 'ebs-csi-node'
          }
        },
        template: {
          metadata: {
            labels: {
              app: 'ebs-csi-node'
            }
          },
          spec: {
            hostNetwork: true,
            containers: [
              {
                name: 'ebs-plugin',
                image: 'k8s.gcr.io/provider-aws/aws-ebs-csi-driver:v1.8.0',
                args: [
                  '--endpoint=$(CSI_ENDPOINT)',
                  '--logtostderr',
                  '--v=5'
                ],
                env: [
                  {
                    name: 'CSI_ENDPOINT',
                    value: 'unix:/csi/csi.sock'
                  }
                ],
                // 添加特权模式配置，允许双向挂载
                securityContext: {
                  privileged: true
                },
                volumeMounts: [
                  {
                    name: 'kubelet-dir',
                    mountPath: '/var/lib/kubelet',
                    mountPropagation: 'Bidirectional'
                  },
                  {
                    name: 'plugin-dir',
                    mountPath: '/csi'
                  }
                ]
              },
              {
                name: 'node-driver-registrar',
                image: 'k8s.gcr.io/sig-storage/csi-node-driver-registrar:v2.3.0',
                args: [
                  '--csi-address=$(ADDRESS)',
                  '--kubelet-registration-path=$(DRIVER_REG_SOCK_PATH)',
                  '--v=5'
                ],
                env: [
                  {
                    name: 'ADDRESS',
                    value: '/csi/csi.sock'
                  },
                  {
                    name: 'DRIVER_REG_SOCK_PATH',
                    value: '/var/lib/kubelet/plugins/ebs.csi.aws.com/csi.sock'
                  }
                ],
                volumeMounts: [
                  {
                    name: 'plugin-dir',
                    mountPath: '/csi'
                  },
                  {
                    name: 'registration-dir',
                    mountPath: '/registration'
                  }
                ]
              }
            ],
            volumes: [
              {
                name: 'kubelet-dir',
                hostPath: {
                  path: '/var/lib/kubelet',
                  type: 'Directory'
                }
              },
              {
                name: 'plugin-dir',
                hostPath: {
                  path: '/var/lib/kubelet/plugins/ebs.csi.aws.com/',
                  type: 'DirectoryOrCreate'
                }
              },
              {
                name: 'registration-dir',
                hostPath: {
                  path: '/var/lib/kubelet/plugins_registry/',
                  type: 'Directory'
                }
              }
            ]
          }
        }
      }
    });

    // Deploy ALBC if it doesn't exist
    const _ALBC = new ALBCDeploymentStack(this, 'ALBCDeploymentStack', {
      cluster: this.cluster,})

    // 输出 EKS 集群相关信息
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      exportName: 'EKSClusterName',
    });
  }
}
