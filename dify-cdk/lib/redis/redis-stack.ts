import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ElastiCacheClient, DescribeCacheEngineVersionsCommand, DescribeReservedCacheNodesOfferingsCommand } from '@aws-sdk/client-elasticache';    

interface RedisClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  subnets: ec2.SubnetSelection;
}

export class RedisClusterStack extends cdk.Stack {
  public redisReplicationGroup: elasticache.CfnReplicationGroup;
  

  constructor(scope: Construct, id: string, props: RedisClusterStackProps) {
    super(scope, id, props);

    const region = 'ap-southeast-1';

    // 创建安全组
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: true,
    });

    // 允许 VPC 内的 Redis 访问
    redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Allow Redis connections from within the VPC',
    );

    // 选择实际的子网
    const selectedSubnets = props.vpc.selectSubnets(props.subnets);

    // 创建子网组
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis clusters',
      subnetIds: selectedSubnets.subnetIds, // 使用 selectedSubnets.subnetIds
      cacheSubnetGroupName: 'redis-subnet-group',
    });

    // 异步函数来初始化 Redis 复制组
    const initializeRedisReplicationGroup = async () => {
      try {
        const cacheNodeType = await getAvailableRedisInstanceType(region);
        console.log(`Selected cache node type: ${cacheNodeType}`);

        // 初始化 Redis 复制组
        this.redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
          replicationGroupDescription: 'Dify Redis Replication Group',
          replicationGroupId: 'dify-redis',
          engine: 'valkey',
          cacheNodeType: cacheNodeType,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
          securityGroupIds: [redisSecurityGroup.securityGroupId],
          automaticFailoverEnabled: true,
          transitEncryptionEnabled: true,  
          transitEncryptionMode: 'preferred',
          atRestEncryptionEnabled: true,
          numCacheClusters: 2, 
          multiAzEnabled: true,
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

      } catch (error) {
        console.error('Failed to initialize Redis Replication Group:', error);
      }
    };

    initializeRedisReplicationGroup();
  }
}

export async function getAvailableRedisInstanceType(region: string): Promise<string> {
  const instanceTypes = ['cache.m7g.large', 'cache.m6g.large', 'cache.m6i.large'];
  const elasticacheClient = new ElastiCacheClient({ region });

  for (const instanceType of instanceTypes) {
    const params = {
      CacheNodeType: instanceType,
    };

    try {
      const command = new DescribeReservedCacheNodesOfferingsCommand(params);
      const result = await elasticacheClient.send(command);

      if (result.ReservedCacheNodesOfferings && result.ReservedCacheNodesOfferings.length > 0) {
        return instanceType;
      }
    } catch (error) {
      console.error(`Error checking instance type ${instanceType}:`, error);
    }
  }

  throw new Error('No suitable Redis instance type found');
}