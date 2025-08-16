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

import {
  Aws,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

export interface DifyCloudFrontStackProps extends StackProps {
  readonly config: SystemConfig;
  readonly albDnsName?: string; // 可选，可通过参数或context提供
  readonly albSecurityGroup: ec2.ISecurityGroup;
}

export class DifyCloudFrontStack extends Stack {
  public readonly distributionDomainName: string;
  public readonly distributionId: string;
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DifyCloudFrontStackProps) {
    super(scope, id, props);

    const config = props.config.domain.cloudfront;
    if (!config?.enabled) {
      console.log('CloudFront is not enabled in configuration');
      return;
    }

    // 获取ALB DNS名称 - 支持多种方式
    let albDnsName = props.albDnsName;
    
    // 如果没有提供，尝试从context获取
    if (!albDnsName) {
      albDnsName = this.node.tryGetContext('albDnsName');
    }
    
    // 如果还是没有，尝试从DifyStack的导出值获取
    if (!albDnsName) {
      try {
        // 尝试从CloudFormation导出值获取 - 使用正确的导出名称
        albDnsName = Fn.importValue('DifyALBDnsName');
        console.log('✅ 自动从DifyStack获取ALB DNS');
      } catch (e) {
        // 如果导出值不存在，创建一个参数作为后备方案
        const albDnsParam = new CfnParameter(this, 'ALBDnsName', {
          type: 'String',
          description: 'The DNS name of the ALB created by DifyStack',
          default: 'MUST_PROVIDE_ALB_DNS_NAME',
        });
        albDnsName = albDnsParam.valueAsString;
        
        console.log('⚠️ 无法自动获取ALB DNS，需要手动提供');
        console.log('使用以下命令部署CloudFront:');
        console.log('cdk deploy DifyCloudFrontStack --parameters ALBDnsName=<ALB_DNS>');
      }
    }

    // 获取或创建 Route53 托管区域
    let hostedZone: route53.IHostedZone | undefined;
    if (props.config.domain.hostedZoneId && props.config.domain.domainName) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.config.domain.hostedZoneId,
        zoneName: props.config.domain.domainName,
      });
    }

    // 创建或使用现有证书（必须在 us-east-1）
    if (config.certificateArn) {
      this.certificate = acm.Certificate.fromCertificateArn(
        this,
        'Certificate',
        config.certificateArn
      );
    } else if (config.domainName && hostedZone) {
      // 在 us-east-1 创建新证书
      this.certificate = new acm.DnsValidatedCertificate(this, 'CloudFrontCertificate', {
        domainName: config.domainName,
        subjectAlternativeNames: config.aliases || [`*.${config.domainName}`],
        hostedZone: hostedZone,
        region: 'us-east-1', // CloudFront 需要 us-east-1 的证书
      });
    }

    // 创建日志存储桶
    let logBucket: s3.IBucket | undefined;
    if (config.logging?.enabled) {
      logBucket = new s3.Bucket(this, 'CloudFrontLogBucket', {
        bucketName: config.logging.bucketName || `${props.config.domain.domainName}-cloudfront-logs`,
        encryption: s3.BucketEncryption.S3_MANAGED,
        lifecycleRules: [{
          id: 'DeleteOldLogs',
          expiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        }],
        removalPolicy: RemovalPolicy.RETAIN,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      });

      // 授予 CloudFront 写入权限
      logBucket.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${logBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': Aws.ACCOUNT_ID,
          },
        },
      }));
    }

    // 创建 WAF WebACL（如果启用）
    let webAcl: wafv2.CfnWebACL | undefined;
    if (config.waf?.enabled) {
      const rules: wafv2.CfnWebACL.RuleProperty[] = [];

      // 速率限制规则
      if (config.waf.rateLimit) {
        rules.push({
          name: 'RateLimitRule',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: config.waf.rateLimit,
              aggregateKeyType: 'IP',
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
          },
        });
      }

      // 地理位置限制规则
      if (config.waf.geoRestriction?.locations && config.waf.geoRestriction.locations.length > 0) {
        const geoAction = config.waf.geoRestriction.restrictionType === 'whitelist' 
          ? { block: {} } 
          : { allow: {} };
        
        rules.push({
          name: 'GeoRestrictionRule',
          priority: 2,
          statement: {
            notStatement: {
              statement: {
                geoMatchStatement: {
                  countryCodes: config.waf.geoRestriction.locations,
                },
              },
            },
          },
          action: config.waf.geoRestriction.restrictionType === 'whitelist' ? { block: {} } : { allow: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoRestrictionRule',
          },
        });
      }

      // AWS 托管规则 - Core Rule Set
      rules.push({
        name: 'AWSManagedRulesCommonRuleSet',
        priority: 10,
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        overrideAction: { none: {} },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'AWSManagedRulesCommonRuleSetMetric',
        },
      });

      // AWS 托管规则 - SQL注入防护
      rules.push({
        name: 'AWSManagedRulesSQLiRuleSet',
        priority: 20,
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesSQLiRuleSet',
          },
        },
        overrideAction: { none: {} },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'AWSManagedRulesSQLiRuleSetMetric',
        },
      });

      webAcl = new wafv2.CfnWebACL(this, 'WebACL', {
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        rules: rules,
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'DifyCloudFrontWebACL',
        },
      });
    }

    // 创建缓存策略
    // API 缓存策略 - 当缓存被禁用时（所有TTL为0），只能设置TTL参数
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'Dify-API-CachePolicy',
      comment: 'Cache policy for Dify API endpoints - no caching',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      // 当缓存被禁用时，不能设置以下参数：
      // - queryStringBehavior
      // - headerBehavior
      // - cookieBehavior
      // - enableAcceptEncodingGzip
      // - enableAcceptEncodingBrotli
    });

    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      cachePolicyName: 'Dify-Static-CachePolicy',
      comment: 'Cache policy for static assets',
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('v', 'version'),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: 'Dify-Default-CachePolicy',
      comment: 'Default cache policy for Dify',
      defaultTtl: Duration.seconds(config.cachePolicy?.defaultTTL || 300),
      maxTtl: Duration.seconds(config.cachePolicy?.maxTTL || 86400),
      minTtl: Duration.seconds(config.cachePolicy?.minTTL || 0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'Accept',
        'Accept-Language',
        'Content-Type',
        'CloudFront-Viewer-Country'
      ),
      cookieBehavior: cloudfront.CacheCookieBehavior.allowList('session_id', 'auth_token'),
    });

    // 创建源请求策略
    // 注意: CloudFront 限制最多10个自定义头部
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
      originRequestPolicyName: 'Dify-OriginRequestPolicy',
      comment: 'Origin request policy for Dify',
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'Accept',
        'Accept-Language',
        'Content-Type',
        'Origin',
        'Referer',
        'User-Agent',
        'X-Forwarded-For',
        'X-Request-Id',
        'CloudFront-Viewer-Country'
      ),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
    });

    // 创建响应头策略
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: 'Dify-ResponseHeadersPolicy',
      comment: 'Security headers for Dify',
      securityHeadersBehavior: {
        contentTypeOptions: {
          override: true,
        },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(63072000),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: {
          modeBlock: true,
          protection: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https: wss:;",
          override: true,
        },
      },
      // 自定义头部 - 移除安全头部，因为它们已在 securityHeadersBehavior 中设置
      customHeadersBehavior: {
        customHeaders: [
          // X-Frame-Options 和 X-Content-Type-Options 已在 securityHeadersBehavior 中设置
          // CloudFront 不允许在 customHeaders 中重复设置安全头部
        ],
      },
      corsBehavior: {
        accessControlAllowCredentials: true,
        // 当 allowCredentials 为 true 时，不能使用通配符 *
        accessControlAllowHeaders: [
          'Accept',
          'Accept-Language',
          'Content-Type',
          'Authorization',
          'X-Request-Id',
          'X-CSRF-Token',
          'Origin',
          'Referer'
        ],
        accessControlAllowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
        accessControlAllowOrigins: config.domainName ? [`https://${config.domainName}`] : ['http://localhost:3000'],
        accessControlMaxAge: Duration.seconds(86400),
        originOverride: true,
      },
    });

    // 创建 CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: config.domainName ? [config.domainName, ...(config.aliases || [])] : undefined,
      certificate: this.certificate,
      priceClass: config.priceClass === 'PriceClass_All' 
        ? cloudfront.PriceClass.PRICE_CLASS_ALL
        : config.priceClass === 'PriceClass_100'
        ? cloudfront.PriceClass.PRICE_CLASS_100
        : cloudfront.PriceClass.PRICE_CLASS_200,
      
      defaultRootObject: 'index.html',
      enableLogging: config.logging?.enabled,
      logBucket: logBucket,
      logFilePrefix: config.logging?.prefix,
      
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      
      webAclId: webAcl?.attrArn,
      
      comment: `CloudFront distribution for Dify application`,
      
      defaultBehavior: {
        origin: new origins.HttpOrigin(albDnsName!, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, // ALB使用HTTP
          httpPort: 80,
          originPath: '',
          connectionAttempts: 3,
          connectionTimeout: Duration.seconds(10),
          readTimeout: Duration.seconds(30),
          keepaliveTimeout: Duration.seconds(5),
          customHeaders: {
            'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: defaultCachePolicy,
        originRequestPolicy: originRequestPolicy,
        responseHeadersPolicy: responseHeadersPolicy,
        compress: true,
      },
      
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(albDnsName!, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
        '/v1/*': {
          origin: new origins.HttpOrigin(albDnsName!, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
        '/static/*': {
          origin: new origins.HttpOrigin(albDnsName!, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
        '*.js': {
          origin: new origins.HttpOrigin(albDnsName!, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
        '*.css': {
          origin: new origins.HttpOrigin(albDnsName!, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: {
              'X-CloudFront-Secret': config.domainName || 'dify-cloudfront-secret',
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: staticCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
      },
      
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    // 注意：ALB 安全组规则已经在 ALB Stack 中配置
    // ALB Stack 会根据 useCloudfront 配置自动添加正确的前缀列表规则
    // 这确保只有来自 CloudFront 的流量可以访问 ALB

    // 创建 Route53 记录（如果配置了域名）
    if (config.domainName && hostedZone) {
      new route53.ARecord(this, 'CloudFrontARecord', {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution)
        ),
        ttl: Duration.minutes(5),
      });

      // 创建 www 子域名记录
      if (config.aliases?.includes(`www.${config.domainName}`)) {
        new route53.ARecord(this, 'CloudFrontWWWARecord', {
          zone: hostedZone,
          recordName: `www.${config.domainName}`,
          target: route53.RecordTarget.fromAlias(
            new route53Targets.CloudFrontTarget(distribution)
          ),
          ttl: Duration.minutes(5),
        });
      }
    }

    // 输出
    this.distributionDomainName = distribution.distributionDomainName;
    this.distributionId = distribution.distributionId;

    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new CfnOutput(this, 'DistributionId', {
      value: this.distributionId,
      description: 'CloudFront distribution ID',
    });

    if (config.domainName) {
      new CfnOutput(this, 'CustomDomainName', {
        value: `https://${config.domainName}`,
        description: 'Custom domain URL',
      });
    }

    if (webAcl) {
      new CfnOutput(this, 'WebACLArn', {
        value: webAcl.attrArn,
        description: 'WAF WebACL ARN',
      });
    }

    if (logBucket) {
      new CfnOutput(this, 'LogBucketName', {
        value: logBucket.bucketName,
        description: 'CloudFront logs bucket',
      });
    }

    new CfnOutput(this, 'OriginALBDNS', {
      value: albDnsName!,
      description: 'Origin ALB DNS Name',
    });
  }
}