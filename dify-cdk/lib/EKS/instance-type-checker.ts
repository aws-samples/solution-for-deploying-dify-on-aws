import { EC2Client, DescribeInstanceTypeOfferingsCommand } from '@aws-sdk/client-ec2';

// 初始化 EC2 客户端
const ec2Client = new EC2Client({ region: 'ap-northeast-1' });

// 检查实例类型的可用性
export async function getAvailableInstanceType(): Promise<string> {
  const instanceTypes = ['m8g.large', 'm7g.large', 'm6g.large', 'm6i.large'];


  for (const instanceType of instanceTypes) {
    const params = {
      Filters: [
        { Name: 'instance-type', Values: [instanceType] },
        { Name: 'location', Values: ['ap-northeast-1'] } // 确保使用正确的过滤条件
      ]
    };

    try {
      const command = new DescribeInstanceTypeOfferingsCommand(params);
      const result = await ec2Client.send(command);
      if (result.InstanceTypeOfferings && result.InstanceTypeOfferings.length > 0) {
        return instanceType;
      }
    } catch (error) {
      console.error(`Error checking instance type ${instanceType}:`, error);
    }
  }

  throw new Error('No suitable instance type found');
}
