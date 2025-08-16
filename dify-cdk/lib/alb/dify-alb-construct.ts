/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { CfnOutput, Stack, Duration } from 'aws-cdk-lib';
import { IVpc, Port, Peer, SecurityGroup, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { 
  ApplicationLoadBalancer, 
  ApplicationTargetGroup, 
  ApplicationProtocol, 
  ListenerAction,
  ApplicationListenerRule,
  ListenerCondition,
  TargetType,
  ApplicationListener
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

export interface DifyALBConstructProps {
  readonly vpc: IVpc;
  readonly config: SystemConfig;
  readonly albSecurityGroupId?: string; // 可选，如果不提供则创建新的
}

export class DifyALBConstruct extends Construct {
  readonly applicationLoadBalancer: ApplicationLoadBalancer;
  readonly apiTargetGroup: ApplicationTargetGroup;
  readonly frontendTargetGroup: ApplicationTargetGroup;
  readonly listener: ApplicationListener;
  readonly albDnsName: string;
  readonly albSecurityGroup: ISecurityGroup;

  constructor(scope: Construct, id: string, props: DifyALBConstructProps) {
    super(scope, id);

    // 创建或使用现有的安全组
    if (props.albSecurityGroupId) {
      this.albSecurityGroup = SecurityGroup.fromSecurityGroupId(
        this, 
        'ExistingSG', 
        props.albSecurityGroupId
      );
    } else {
      const newSecurityGroup = new SecurityGroup(this, 'ALBSecurityGroup', {
        vpc: props.vpc,
        allowAllOutbound: true,
        description: 'Security group for Dify ALB',
      });
      
      // 添加入站规则
      newSecurityGroup.addIngressRule(
        Peer.anyIpv4(),
        Port.tcp(80),
        'Allow HTTP traffic'
      );
      
      // 如果配置了 CloudFront 或自定义域名，可能需要 HTTPS
      // 这里暂时只开放 HTTP，HTTPS 可以通过 CloudFront 提供
      
      this.albSecurityGroup = newSecurityGroup;
    }

    // 创建 ALB
    this.applicationLoadBalancer = new ApplicationLoadBalancer(this, 'DifyALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup as SecurityGroup,
    });

    // 创建监听器
    this.listener = this.applicationLoadBalancer.addListener('Listener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // 创建 API Target Group
    this.apiTargetGroup = new ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${Stack.of(this).stackName}-api-tg`,
      healthCheck: {
        enabled: true,
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // 创建 Frontend Target Group
    this.frontendTargetGroup = new ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      vpc: props.vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${Stack.of(this).stackName}-frontend-tg`,
      healthCheck: {
        enabled: true,
        path: '/apps',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // 配置路由规则 - Console API
    new ApplicationListenerRule(this, 'ConsoleApiRule', {
      listener: this.listener,
      priority: 1,
      conditions: [
        ListenerCondition.pathPatterns(['/console/api', '/console/api/*'])
      ],
      action: ListenerAction.forward([this.apiTargetGroup]),
    });

    // 配置路由规则 - API
    new ApplicationListenerRule(this, 'ApiRule', {
      listener: this.listener,
      priority: 2,
      conditions: [
        ListenerCondition.pathPatterns(['/api', '/api/*'])
      ],
      action: ListenerAction.forward([this.apiTargetGroup]),
    });

    // 配置路由规则 - V1 API
    new ApplicationListenerRule(this, 'V1Rule', {
      listener: this.listener,
      priority: 3,
      conditions: [
        ListenerCondition.pathPatterns(['/v1', '/v1/*'])
      ],
      action: ListenerAction.forward([this.apiTargetGroup]),
    });

    // 配置路由规则 - Files
    new ApplicationListenerRule(this, 'FilesRule', {
      listener: this.listener,
      priority: 4,
      conditions: [
        ListenerCondition.pathPatterns(['/files', '/files/*'])
      ],
      action: ListenerAction.forward([this.apiTargetGroup]),
    });

    // 配置路由规则 - Frontend (默认规则)
    new ApplicationListenerRule(this, 'FrontendRule', {
      listener: this.listener,
      priority: 5,
      conditions: [
        ListenerCondition.pathPatterns(['/*'])
      ],
      action: ListenerAction.forward([this.frontendTargetGroup]),
    });

    this.albDnsName = this.applicationLoadBalancer.loadBalancerDnsName;

    // 输出 ALB DNS
    new CfnOutput(this, 'ALBDnsName', {
      value: this.albDnsName,
      description: 'DNS name of the Application Load Balancer',
      exportName: `${Stack.of(this).stackName}-alb-dns`,
    });

    // 输出 Target Group ARNs
    new CfnOutput(this, 'ApiTargetGroupArn', {
      value: this.apiTargetGroup.targetGroupArn,
      description: 'ARN of the API Target Group',
      exportName: `${Stack.of(this).stackName}-api-tg-arn`,
    });

    new CfnOutput(this, 'FrontendTargetGroupArn', {
      value: this.frontendTargetGroup.targetGroupArn,
      description: 'ARN of the Frontend Target Group',
      exportName: `${Stack.of(this).stackName}-frontend-tg-arn`,
    });
  }
}