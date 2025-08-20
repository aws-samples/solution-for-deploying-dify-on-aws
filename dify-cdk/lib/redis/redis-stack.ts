import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ElastiCacheClient, DescribeCacheEngineVersionsCommand, DescribeReservedCacheNodesOfferingsCommand } from '@aws-sdk/client-elasticache';
import { SystemConfig } from '../../src/config';

interface RedisClusterStackProps extends cdk.StackProps {
  config: SystemConfig;
  vpc: ec2.IVpc;
  subnets?: ec2.SubnetSelection;
}

export class RedisClusterStack extends cdk.Stack {
  public redisReplicationGroup: elasticache.CfnReplicationGroup;
  

  constructor(scope: Construct, id: string, props: RedisClusterStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const subnets = props.subnets || {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS};
    const region = this.region;

    // 创建安全组
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: vpc,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: true,
    });

    // 允许 VPC 内的 Redis 访问
    redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Allow Redis connections from within the VPC',
    );

    // 选择实际的子网
    const selectedSubnets = vpc.selectSubnets(subnets);

    // 创建子网组
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis clusters',
      subnetIds: selectedSubnets.subnetIds,
      cacheSubnetGroupName: 'redis-subnet-group',
    });

    // 异步函数来初始化 Redis 复制组
    const initializeRedisReplicationGroup = async () => {
      try {
        // 使用配置中的节点类型或动态获取
        const configuredNodeType = config.redis.nodeType;
        const cacheNodeType = configuredNodeType;
        console.log(`Redis节点类型: ${cacheNodeType}`);

        // 使用配置参数初始化 Redis 复制组
        this.redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
          replicationGroupDescription: 'Dify Redis Replication Group',
          replicationGroupId: 'dify-redis',
          engine: 'redis',
          engineVersion: config.redis.engineVersion || '7.0',
          cacheNodeType: cacheNodeType,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
          securityGroupIds: [redisSecurityGroup.securityGroupId],
          automaticFailoverEnabled: true,
          transitEncryptionEnabled: true,
          transitEncryptionMode: 'preferred',
          atRestEncryptionEnabled: true,
          numCacheClusters: (config.redis.readReplicas || 1) + 1, // 主节点 + 副本数
          multiAzEnabled: config.redis.multiAZ?.enabled || true,
          preferredCacheClusterAZs: selectedSubnets.availabilityZones,
        });

        // 添加依赖
        this.redisReplicationGroup.addDependency(redisSubnetGroup);

        // 输出
        new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', {
          value: this.redisReplicationGroup.attrPrimaryEndPointAddress,
          description: 'Primary endpoint for the Redis replication group',
          exportName: 'RedisPrimaryEndpoint',
        });

        new cdk.CfnOutput(this, 'RedisPort', {
          value: this.redisReplicationGroup.attrPrimaryEndPointPort,
          description: 'Redis Port',
          exportName: 'RedisPort',
        });

        console.log(`Redis配置: 引擎版本=${config.redis.engineVersion}, 节点类型=${cacheNodeType}, 副本数=${config.redis.readReplicas}`);

      } catch (error) {
        console.error('Failed to initialize Redis Replication Group:', error);
      }
    };

    initializeRedisReplicationGroup();
  }
}