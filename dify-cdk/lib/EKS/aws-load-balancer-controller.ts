import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface ALBCDeploymentStackProps extends cdk.NestedStackProps {
  cluster: eks.Cluster;
}

export class ALBCDeploymentStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: ALBCDeploymentStackProps) {
    super(scope, id, props);

    // Read local IAM policy file
    const policyFilePath = path.join(__dirname, 'iam_policy.json');
    const policyJson = JSON.parse(fs.readFileSync(policyFilePath, 'utf-8'));

    // Create ALB Load Balancer Controller ServiceAccount
    const albServiceAccount = props.cluster.addServiceAccount('ALBServiceAccount', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });

    // Create IAM Policy
    const albPolicy = new iam.Policy(this, 'ALBControllerPolicy');

    // Apply the downloaded IAM policy to the Policy object
    this.applyPolicyFromJson(albPolicy, policyJson);

    // Attach the policy to the ServiceAccount's IAM Role
    albServiceAccount.role.attachInlinePolicy(albPolicy);

    // Deploy AWS Load Balancer Controller via Helm chart
    props.cluster.addHelmChart('ALBController', {
      chart: 'aws-load-balancer-controller',
      release: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'kube-system',
      version: '1.8.1', // 指定稳定版本
      values: {
        clusterName: props.cluster.clusterName,
        serviceAccount: {
          create: false, // Use the manually created ServiceAccount
          name: albServiceAccount.serviceAccountName,
        },
        // 添加VPC ID参数，修复webhook启动问题 - 通过args传递
        vpcId: props.cluster.vpc.vpcId,
        // 添加region参数
        region: props.cluster.stack.region,
        // 显式添加命令行参数，确保VPC ID被正确传递
        defaultArgs: {
          "cluster-name": props.cluster.clusterName,
          "aws-vpc-id": props.cluster.vpc.vpcId,
          "aws-region": props.cluster.stack.region,
        },
        // 增加副本数以提高可用性
        replicaCount: 2,
        // 禁用webhook的cert-manager自动管理，使用自签名证书
        enableCertManager: false,
        // 确保webhook正确配置
        webhookTLS: {
          caCert: '',
          cert: '',
          key: ''
        },
        // 添加资源限制
        resources: {
          limits: {
            cpu: '200m',
            memory: '500Mi'
          },
          requests: {
            cpu: '100m',
            memory: '200Mi'
          }
        },
        // 启用服务监控
        serviceMonitor: {
          enabled: false
        },
        // 设置日志级别便于调试
        logLevel: 'info',
        // 为ARM架构添加节点选择器
        nodeSelector: {
          'kubernetes.io/os': 'linux'
        },
        // 添加容忍度以在各种节点上运行
        tolerations: [],
        // Pod反亲和性，确保副本分布在不同节点
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [{
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchExpressions: [{
                    key: 'app.kubernetes.io/name',
                    operator: 'In',
                    values: ['aws-load-balancer-controller']
                  }]
                },
                topologyKey: 'kubernetes.io/hostname'
              }
            }]
          }
        }
      },
      wait: true, // 等待部署完成
    });
  }

  // Apply policy from JSON file to the Policy object
  private applyPolicyFromJson(policy: iam.Policy, policyJson: any) {
    policyJson.Statement.forEach((statement: any) => {
      policy.addStatements(new iam.PolicyStatement({
        actions: statement.Action,
        resources: statement.Resource || ['*'],
      }));
    });
  }
}