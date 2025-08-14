import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { SystemConfig } from '../../src/config';

interface S3StackProps extends cdk.StackProps {
  config: SystemConfig;
}

export class S3Stack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    const { config } = props;

    // 创建 S3 存储桶，使用配置参数
    this.bucket = new s3.Bucket(this, 'S3Bucket', {
      bucketName: `dify-${this.account}-${this.region}`,
      // 使用配置中的删除策略
      removalPolicy: config.s3.removeWhenDestroyed ?
        cdk.RemovalPolicy.DESTROY :
        cdk.RemovalPolicy.RETAIN,
      // 自动删除对象（当配置为可删除时）
      autoDeleteObjects: config.s3.removeWhenDestroyed || false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // 使用 addToResourcePolicy 添加策略
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [this.bucket.arnForObjects('*')],
      principals: [new iam.AccountRootPrincipal()],
    }));

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 Bucket Name',
      exportName: 'S3BucketName',
    });

    console.log(`S3配置: 存储桶=${this.bucket.bucketName}, 删除策略=${config.s3.removeWhenDestroyed ? 'DESTROY' : 'RETAIN'}`);
  }
}