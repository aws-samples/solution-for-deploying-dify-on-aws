# Dify on AWS 交互式配置工具

## 概述

这个交互式配置工具为 Dify on AWS 项目提供了用户友好的配置体验，参考了 `genai-agent-workflow-main` 项目的优秀实践。

## 功能特性

### 🎯 智能配置向导
- **快速配置模式**: 适合新用户，使用推荐的默认设置
- **高级配置模式**: 允许自定义所有配置选项
- **配置模板支持**: 提供常见部署场景的预设模板

### 🔐 安全性增强
- **动态密码生成**: 自动生成强密码，避免硬编码
- **密码强度验证**: 确保密码符合安全要求
- **敏感信息保护**: 避免在日志中泄露敏感信息

### 🌍 区域适配
- **海外区域优化**: 支持全球 AWS 区域的最佳实践
- **中国区域支持**: 针对中国区域的特殊配置需求
- **CloudFront 智能选择**: 根据区域自动启用/禁用 CDN

### 💡 智能推荐
- **实例类型推荐**: 根据工作负载推荐合适的实例类型
- **成本估算**: 提供简化的月度费用预估
- **最佳实践提示**: 生产环境配置建议

### ✅ 配置验证
- **实时验证**: 输入时即时验证配置项
- **依赖检查**: 检查配置项之间的依赖关系
- **错误提示**: 提供详细的错误信息和解决建议

## 使用方法

### 安装依赖

```bash
npm install
```

### 运行配置工具

```bash
# 方法1: 使用 npm script
npm run config

# 方法2: 直接运行 TypeScript
npx ts-node src/cli/config-tool.ts

# 方法3: 编译后运行
npm run build
node dist/cli/config-tool.js
```

### 配置流程

1. **选择配置模式**
   - 快速配置：使用默认推荐设置
   - 高级配置：自定义所有选项

2. **基础设置**
   - 选择部署区域（海外/中国）
   - 选择 Dify 版本
   - 选择网络配置方式

3. **计算资源配置**
   - EKS 集群配置
   - 节点实例类型选择
   - 节点数量设置

4. **数据存储配置**
   - PostgreSQL 数据库设置
   - Redis 缓存配置
   - OpenSearch 搜索服务

5. **高级选项**
   - 自定义域名配置
   - CDN 设置
   - 数据保留策略

6. **配置确认**
   - 查看完整配置预览
   - 成本估算
   - 确认并生成配置文件

## 配置选项说明

### 实例类型选择指南

#### EKS 节点实例
- **t4g.small**: 2 vCPU, 2 GiB - 测试环境
- **c6g.large**: 2 vCPU, 4 GiB - 小型生产环境
- **c6g.2xlarge**: 8 vCPU, 16 GiB - 中型生产环境
- **c6g.4xlarge**: 16 vCPU, 32 GiB - 大型生产环境

#### PostgreSQL 数据库
- **db.t4g.small**: 开发测试环境
- **db.m6g.large**: 生产环境推荐
- **db.m6g.2xlarge**: 高并发应用
- **db.m6g.4xlarge**: 大型应用

#### Redis 缓存
- **cache.t4g.small**: 轻量缓存需求
- **cache.m6g.large**: 生产环境推荐
- **cache.m6g.2xlarge**: 高性能缓存

#### OpenSearch 搜索
- **r6g.large.search**: 小到中型数据集
- **r6g.xlarge.search**: 中型数据集
- **r6g.2xlarge.search**: 大型数据集

### 生产环境建议

- **高可用性**: 至少使用 3 个 EKS 节点
- **数据备份**: 启用数据库备份（设置保留天数 > 0）
- **多可用区**: 在生产环境中启用多 AZ 部署
- **监控**: 考虑部署 Langfuse 进行可观测性
- **域名**: 配置自定义域名和 SSL 证书

## 配置文件

生成的配置文件将保存为 `config.json`，包含所有部署所需的配置信息。

### 配置文件结构

```json
{
  "isChinaRegion": false,
  "deployLangfuse": false,
  "dify": {
    "version": "1.4.2"
  },
  "network": {
    "vpcId": "vpc-xxxxxxxxx"
  },
  "cluster": {
    "eksClusterName": "dify-production",
    "managedNodeGroups": {
      "app": {
        "instanceType": "c6g.2xlarge",
        "desiredSize": 3
      }
    }
  },
  // ... 更多配置项
}
```

## 故障排除

### 常见问题

1. **VPC ID 格式错误**
   - 确保格式为 `vpc-xxxxxxxxx`
   - 检查 VPC 是否存在于指定区域

2. **域名配置问题**
   - 确保域名已在 Route 53 中托管
   - 检查 Hosted Zone ID 是否正确

3. **密码验证失败**
   - 密码至少 8 位
   - 必须包含大小写字母、数字和特殊字符

4. **权限问题**
   - 确保 AWS CLI 已正确配置
   - 检查 IAM 权限是否足够

### 获取帮助

- 查看项目文档
- 检查 AWS 服务限制
- 联系技术支持

## 下一步操作

配置完成后，可以使用以下命令进行部署：

```bash
# 构建项目
npm run build

# 部署到 AWS
npm run cdk deploy

# 查看部署状态
npm run cdk list
```

## 贡献

欢迎提交问题报告和功能建议！