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

import { Stack, Aws } from 'aws-cdk-lib';
import { IVpc, Port, Peer, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';
import { CLOUDFRONT_PREFIX_LIST_IDS } from '../../src/config/constants';

export interface ALBSecurityGroupProps {
  readonly vpc: IVpc;
  readonly config: SystemConfig;
}

export class ALBSecurityGroupConstruct extends Construct {
  readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: ALBSecurityGroupProps) {
    super(scope, id);

    this.securityGroup = new SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Security group for ALB managed by Ingress Controller',
    });
    
    if (props.config.domain.useCloudfront) {
      console.log('Configuring ALB security group for CloudFront');
      
      // 注意：由于CloudFront前缀列表包含大量IP地址，可能超过安全组规则限制
      // 因此暂时允许所有流量，通过CloudFront自定义header进行验证
      // 未来可以考虑使用WAF或其他方式增强安全性
      this.securityGroup.addIngressRule(
        Peer.ipv4('0.0.0.0/0'),
        Port.tcp(80),
        'Allow HTTP - Security via CloudFront custom header'
      );
      
      this.securityGroup.addIngressRule(
        Peer.ipv4('0.0.0.0/0'),
        Port.tcp(443),
        'Allow HTTPS - Security via CloudFront custom header'
      );
      
      console.log('⚠️ 注意: 使用CloudFront自定义header进行安全验证，而非IP限制');
    } else {
      // 不使用CloudFront时允许所有流量
      this.securityGroup.addIngressRule(
        Peer.ipv4('0.0.0.0/0'),
        Port.tcp(80),
        'Allow HTTP from anywhere'
      );
      
      this.securityGroup.addIngressRule(
        Peer.ipv4('0.0.0.0/0'),
        Port.tcp(443),
        'Allow HTTPS from anywhere'
      );
    }
    
    // 允许健康检查（来自VPC内部）
    this.securityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcpRange(80, 443),
      'Allow health checks from VPC'
    );
  }
}