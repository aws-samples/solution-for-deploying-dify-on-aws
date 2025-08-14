# Dify on AWS CDK 部署解决方案

使用 AWS CDK 在 AWS 上部署 [Dify](https://dify.ai/) - 一个开源的 LLM 应用开发平台。

## ✅ 当前支持的功能

- **EKS 集群部署**：支持新建或使用现有 EKS 集群
- **VPC 网络**：支持新建或使用现有 VPC
- **数据存储**：
  - Aurora PostgreSQL Serverless v2 数据库
  - ElastiCache Redis 缓存集群
  - Amazon OpenSearch Service
  - S3 对象存储
- **应用部署**：通过 Helm Chart 部署 Dify
- **负载均衡**：使用 AWS ALB 进行流量分发
- **CloudFront CDN**：全球内容分发网络（可选）
  - 自动 SSL/TLS 证书管理
  - 智能缓存策略
  - DDoS 防护（可选 WAF）
- **插件系统**：支持 Dify Plugin Daemon
- **区域支持**：支持全球区域和中国区域
- **并行部署**：支持同时部署多个堆栈，加速部署过程

## 📋 前置条件

- Node.js 20.12.0+
- AWS CLI 已配置
- AWS CDK v2
- TypeScript
- kubectl（用于初始化数据库）

## 🚀 快速开始

### 1. 安装依赖

```bash
# 安装项目依赖
npm install

# 进入 CDK 目录安装依赖
cd dify-cdk
npm install
cd ..
```

### 2. 配置部署参数

```bash
# 运行交互式配置工具
cd dify-cdk
npm run config
```

配置工具将引导您设置：
- Dify 版本
- AWS 区域类型（全球或中国）
- VPC 配置（新建或使用现有）
- EKS 集群配置
- RDS 数据库配置
- Redis 缓存配置
- OpenSearch 配置
- S3 存储配置

配置将保存在 `dify-cdk/config.json` 文件中。

### 3. 初始化 CDK（首次使用）

```bash
npx cdk bootstrap
```

### 4. 部署

#### 标准部署

```bash
# 构建并部署所有堆栈
npm run deploy

# 或者分步执行
npm run build
npx cdk deploy --all
```

#### 并行部署（加速部署）

并行部署可以显著减少部署时间，特别是在部署多个独立堆栈时：

```bash
# 使用并行部署（最多同时部署 4 个堆栈）
npx cdk deploy --all --concurrency 4

# 新加坡区域测试部署示例
export AWS_REGION=ap-southeast-1
cp config-singapore.json config.json
npx cdk deploy --all --concurrency 4 --require-approval never
```

**并行部署优势**：
- ⚡ 部署速度提升 2-3 倍
- 🔄 独立堆栈同时部署
- 📊 自动处理依赖关系
- ✅ 失败堆栈不影响其他堆栈

**建议并发数**：
- 开发环境：`--concurrency 2`
- 测试环境：`--concurrency 4`
- 生产环境：`--concurrency 1`（推荐顺序部署）

### 5. 初始化数据库

部署完成后，需要初始化数据库：

```bash
# 获取 EKS 集群访问权限
aws eks update-kubeconfig --region <region> --name <cluster-name>

# 等待 API Pod 就绪
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=api -n dify --timeout=300s

# 初始化数据库
kubectl exec -it $(kubectl get pods -n dify -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}') -n dify -- flask db upgrade
```

## 📁 项目结构

```
dify-cdk/
├── bin/                    # CDK 应用入口
│   └── dify.ts            # 主入口文件
├── lib/                    # CDK 堆栈定义
│   ├── VPC/               # VPC 网络堆栈
│   ├── EKS/               # EKS 集群堆栈
│   ├── RDS/               # RDS 数据库堆栈
│   ├── redis/             # Redis 缓存堆栈
│   ├── AOS/               # OpenSearch 堆栈
│   ├── S3/                # S3 存储堆栈
│   ├── alb/               # ALB 负载均衡堆栈
│   ├── cloudfront/        # CloudFront CDN 堆栈
│   └── helm/              # Helm Chart 部署
├── src/                    # 配置管理
│   ├── config/            # 配置类型和加载器
│   └── cli/               # 配置向导工具
├── config.json            # 部署配置文件
├── config-singapore.json  # 新加坡测试配置
└── config-cloudfront-example.json  # CloudFront 示例配置
```

## 🔧 配置说明

### 基本配置示例

```json
{
  "dify": {
    "version": "0.15.3",
    "pluginDaemon": {
      "enabled": true,
      "storageSize": "20Gi"
    }
  },
  "network": {
    "useExistingVpc": false,
    "vpcCidr": "10.0.0.0/16"
  },
  "cluster": {
    "useExistingCluster": false,
    "clusterName": "dify-eks",
    "version": "1.31",
    "managedNodeGroups": {
      "app": {
        "instanceType": "c6g.2xlarge",
        "desiredSize": 3,
        "minSize": 1,
        "maxSize": 6
      }
    }
  },
  "database": {
    "instanceType": "db.m6g.large"
  },
  "redis": {
    "nodeType": "cache.t4g.small"
  },
  "openSearch": {
    "enabled": true,
    "dataNodeInstanceType": "r6g.xlarge.search"
  }
}
```

## 🌐 CloudFront CDN 配置

### 启用 CloudFront

CloudFront 提供全球内容分发、自动 HTTPS 和 DDoS 防护：

```json
{
  "domain": {
    "useCloudfront": true,
    "domainName": "dify.example.com",
    "hostedZoneId": "Z1234567890ABC",
    "cloudfront": {
      "enabled": true,
      "domainName": "dify.example.com",
      "aliases": ["www.dify.example.com"],
      "priceClass": "PriceClass_200",  // 覆盖主要地区
      "waf": {
        "enabled": false  // 默认禁用以降低成本
      }
    }
  }
}
```

### CloudFront 特性

- ✅ **自动 HTTPS**：ACM 自动创建和续期 SSL/TLS 证书
- ✅ **全球加速**：200+ 边缘节点，降低延迟
- ✅ **智能缓存**：API 不缓存，静态资源长缓存
- ✅ **成本优化**：按需启用 WAF，灵活的价格等级

## 🇸🇬 新加坡测试部署

专门为新加坡区域优化的测试配置：

```bash
# 1. 使用新加坡配置
cp dify-cdk/config-singapore.json dify-cdk/config.json

# 2. 设置 AWS 区域
export AWS_REGION=ap-southeast-1

# 3. 并行部署（加速）
cd dify-cdk
npx cdk deploy --all --concurrency 4 --require-approval never
```

**新加坡配置特点**：
- 使用较小的实例规格降低测试成本
- 启用 Origin Shield 优化缓存
- 针对东南亚地区优化的 CloudFront 配置
- 单节点 OpenSearch 节省成本

## 🌍 区域特定配置

### 中国区域

如果部署在中国区域（cn-north-1 或 cn-northwest-1），需要注意：
- 不支持 CloudFront
- 需要配置 S3 访问密钥
- 使用特定的实例类型映射

### 全球区域

- 支持 CloudFront CDN
- 可以使用 IAM 角色进行 S3 访问
- 支持更多的实例类型选择

## 📊 资源成本估算

### 生产环境

| 组件 | 实例类型/规格 | 预估月成本 |
|------|---------------|------------|
| EKS 集群 | 管理费用 | $72 |
| EC2 节点 | c6g.2xlarge x3 | ~$300 |
| Aurora PostgreSQL | Serverless v2 (0.5-4 ACU) | ~$100-400 |
| ElastiCache Redis | cache.t4g.small | ~$25 |
| OpenSearch | r6g.xlarge x2 | ~$400 |
| ALB | 标准 | ~$25 |
| CloudFront | 请求 + 数据传输 | ~$20-50 |
| S3 | 按使用量 | 变动 |

**总计**: 约 $950-1300/月（含 CloudFront）

### 测试环境（新加坡）

| 组件 | 实例类型/规格 | 预估月成本 |
|------|---------------|------------|
| EKS 集群 | 管理费用 | $72 |
| EC2 节点 | m6g.large x2 | ~$100 |
| Aurora PostgreSQL | db.t4g.medium | ~$60 |
| ElastiCache Redis | cache.t4g.micro | ~$15 |
| OpenSearch | t3.small.search x1 | ~$35 |
| ALB | 标准 | ~$25 |
| CloudFront | 最小使用 | ~$5-10 |
| S3 | 最小存储 | ~$5 |

**测试环境总计**: 约 $320-350/月

## 🚨 重要提醒

1. **数据库密码**：默认使用系统生成的密码，存储在 AWS Secrets Manager 中
2. **备份策略**：默认 RDS 备份保留 1 天，生产环境建议增加
3. **删除保护**：默认情况下，RDS 和 S3 资源不会在堆栈删除时被移除
4. **监控**：建议配置 CloudWatch 告警监控关键指标

## 🔄 更新和维护

### 更新 Dify 版本

1. 修改 `config.json` 中的 `dify.version`
2. 运行 `npm run deploy` 重新部署

### 扩展节点组

```bash
# 通过 AWS 控制台或 CLI 调整节点组大小
aws eks update-nodegroup-config \
  --cluster-name dify-eks \
  --nodegroup-name NodeGroup \
  --scaling-config minSize=2,maxSize=10,desiredSize=5
```

## ⚡ 部署优化技巧

### 使用并行部署加速

```bash
# 查看堆栈依赖关系
npx cdk list

# 并行部署独立堆栈
npx cdk deploy DifyVPCStack DifyS3Stack --concurrency 2

# 部署所有堆栈（自动处理依赖）
npx cdk deploy --all --concurrency 4
```

### 跳过不需要的堆栈

```bash
# 仅部署特定堆栈
npx cdk deploy DifyStack

# 排除某些堆栈
npx cdk deploy --all --exclusively DifyCloudFrontStack
```

## 🐛 故障排除

### Pod 无法启动

```bash
# 检查 Pod 状态
kubectl get pods -n dify

# 查看 Pod 日志
kubectl logs -n dify <pod-name>

# 检查事件
kubectl get events -n dify
```

### 数据库连接问题

```bash
# 检查 RDS 安全组
# 确保允许来自 EKS 节点的连接

# 验证 Secret
kubectl get secret -n dify dify-db-secret -o yaml
```

## 📚 相关资源

- [Dify 官方文档](https://docs.dify.ai/)
- [AWS CDK 文档](https://docs.aws.amazon.com/cdk/)
- [AWS EKS 最佳实践](https://aws.github.io/aws-eks-best-practices/)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

Apache License 2.0