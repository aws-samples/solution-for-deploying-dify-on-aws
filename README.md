# Dify on AWS CDK 部署解决方案

使用 AWS CDK 在 AWS 上部署 [Dify](https://dify.ai/) - 一个开源的 LLM 应用开发平台。

## 🎯 最新更新 - TargetGroupBinding 架构

### v2.0.0 - 2025-08-16
- **🚀 新架构**：采用 TargetGroupBinding 模式替代传统 Ingress
- **⚡ 一键部署**：ALB 预先创建，无需手动更新 DNS
- **🔧 更灵活**：完全控制 ALB 配置和路由规则
- **🔄 双模式支持**：兼容 TargetGroupBinding 和传统 Ingress 模式

## ✅ 当前支持的功能

- **EKS 集群部署**：支持新建或使用现有 EKS 集群
- **VPC 网络**：支持新建或使用现有 VPC
- **数据存储**：
  - Aurora PostgreSQL Serverless v2 数据库
  - ElastiCache Redis 缓存集群
  - Amazon OpenSearch Service
  - S3 对象存储
- **应用部署**：通过 Helm Chart 部署 Dify
- **负载均衡**：
  - **TargetGroupBinding 模式**（推荐）：预创建 ALB，自动绑定服务
  - **传统 Ingress 模式**：AWS Load Balancer Controller 自动管理
- **CloudFront CDN**：全球内容分发网络（可选）
  - 自动 SSL/TLS 证书管理
  - 智能缓存策略
  - DDoS 防护（可选 WAF）
- **插件系统**：支持 Dify Plugin Daemon
- **区域支持**：支持全球区域和中国区域
- **并行部署**：支持同时部署多个堆栈，加速部署过程
- **数据库自动迁移**：自动执行数据库 schema 迁移

## 🏗️ 架构改进 - TargetGroupBinding 模式

### 传统 Ingress 模式的问题
- ❌ ALB 由 Ingress Controller 动态创建，DNS 名称不可预知
- ❌ 需要部署后手动获取 ALB DNS 并更新配置
- ❌ CloudFront 需要二次部署
- ❌ 配置修改复杂，需要通过 Ingress annotations

### TargetGroupBinding 模式优势
- ✅ **ALB 预创建**：在 CDK 中直接创建 ALB，DNS 立即可用
- ✅ **一次部署**：所有资源（包括 CloudFront）一次性部署完成
- ✅ **灵活配置**：完全控制 ALB 设置、监听器规则、健康检查
- ✅ **自动绑定**：通过 TargetGroupBinding CRD 自动将 K8s 服务绑定到目标组
- ✅ **更好的可观测性**：Target Groups 提供更详细的健康状态和指标

## 📋 前置条件

- Node.js 20.12.0+
- AWS CLI 已配置
- AWS CDK v2
- TypeScript
- kubectl

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
- 数据库自动迁移（推荐启用）

配置将保存在 `dify-cdk/config.json` 文件中。

### 3. 初始化 CDK（首次使用）

```bash
npx cdk bootstrap
```

### 4. 部署

#### 标准部署（TargetGroupBinding 模式）

```bash
# 构建并部署所有堆栈
npm run deploy

# 或者分步执行
npm run build
npx cdk deploy --all
```

部署完成后，您将获得：
- ✅ ALB DNS 名称（立即可用）
- ✅ Target Group ARNs
- ✅ Dify 访问 URL
- ✅ CloudFront 域名（如果启用）

#### 并行部署（加速部署）

并行部署可以显著减少部署时间，特别是在部署多个独立堆栈时：

```bash
# 使用并行部署（最多同时部署 4 个堆栈）
npx cdk deploy --all --concurrency 4

# 新加坡区域测试部署示例
export AWS_REGION=ap-southeast-1
npx cdk deploy --all --concurrency 4 --require-approval never
```

**并行部署优势**：
- ⚡ 部署速度提升 2-3 倍
- 🔄 独立堆栈同时部署
- 📊 自动处理依赖关系
- ✅ 失败堆栈不影响其他堆栈

### 5. 验证部署

部署完成后，系统会自动：
1. **创建 ALB 和 Target Groups**
2. **部署 Dify 应用到 EKS**
3. **创建 TargetGroupBinding 资源**
4. **自动执行数据库迁移**（如果启用）

验证命令：

```bash
# 检查 TargetGroupBinding 状态
kubectl get targetgroupbindings -n dify

# 检查 Pod 状态
kubectl get pods -n dify

# 检查 Target Groups 健康状态
aws elbv2 describe-target-health \
  --target-group-arn <api-target-group-arn> \
  --query "TargetHealthDescriptions[*].[Target.Id,TargetHealth.State]" \
  --output table
```

## 📁 项目结构

```
dify-cdk/
├── bin/                    # CDK 应用入口
│   ├── dify.ts            # 主入口文件
│   └── dify-helm-stack.ts # TargetGroupBinding 部署堆栈
├── lib/                    # CDK 堆栈定义
│   ├── VPC/               # VPC 网络堆栈
│   ├── EKS/               # EKS 集群堆栈
│   ├── RDS/               # RDS 数据库堆栈
│   ├── redis/             # Redis 缓存堆栈
│   ├── AOS/               # OpenSearch 堆栈
│   ├── S3/                # S3 存储堆栈
│   ├── alb/               # ALB 构造器（TargetGroupBinding）
│   │   └── dify-alb-construct.ts  # ALB 和 Target Groups 创建
│   ├── cloudfront/        # CloudFront CDN 堆栈
│   ├── database/          # 数据库迁移构造器
│   └── helm/              # Helm Chart 部署
│       └── dify-helm.ts   # 支持双模式的 Helm 部署
├── src/                    # 配置管理
│   ├── config/            # 配置类型和加载器
│   └── cli/               # 配置向导工具
├── config.json            # 部署配置文件
└── config-cloudfront-example.json  # CloudFront 示例配置
```

## 🔧 配置说明

### 基本配置示例（TargetGroupBinding 模式）

```json
{
  "dify": {
    "version": "1.1.0",
    "pluginDaemon": {
      "enabled": true,
      "storageSize": "20Gi"
    },
    "dbMigration": {
      "enabled": true  // 推荐启用自动数据库迁移
    }
  },
  "network": {
    "useExistingVpc": false,
    "vpcCidr": "10.0.0.0/16"
  },
  "cluster": {
    "useExistingCluster": false,
    "clusterName": "dify-eks",
    "version": "1.33",
    "managedNodeGroups": {
      "app": {
        "instanceType": "m8g.large",
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
    "nodeType": "cache.t4g.micro"
  },
  "openSearch": {
    "enabled": true,
    "dataNodeInstanceType": "r6g.xlarge.search"
  }
}
```

## 🎯 TargetGroupBinding 工作原理

1. **CDK 创建 ALB 资源**：
   - Application Load Balancer
   - Target Groups（API 和 Frontend）
   - 监听器和路由规则

2. **Helm 部署 Dify**：
   - 创建 Kubernetes Services（NodePort 类型）
   - 部署 Dify 应用 Pods

3. **TargetGroupBinding 自动绑定**：
   - AWS Load Balancer Controller 监测 TargetGroupBinding CRD
   - 自动将 Pod IPs 注册到 Target Groups
   - 处理健康检查和流量路由

```yaml
# TargetGroupBinding 示例
apiVersion: elbv2.k8s.aws/v1beta1
kind: TargetGroupBinding
metadata:
  name: dify-api-tgb
  namespace: dify
spec:
  serviceRef:
    name: dify-api-svc
    port: 80
  targetGroupARN: arn:aws:elasticloadbalancing:...
  networking:
    ingress:
    - from:
      - ipBlock:
          cidr: 10.0.0.0/16
```

## 🌐 CloudFront CDN 配置

### 启用 CloudFront（与 TargetGroupBinding 完美配合）

CloudFront 现在可以在初始部署时直接配置，因为 ALB DNS 是预先知道的：

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
      "priceClass": "PriceClass_200",
      "waf": {
        "enabled": false
      }
    }
  }
}
```

### CloudFront 特性

- ✅ **自动 HTTPS**：ACM 自动创建和续期 SSL/TLS 证书
- ✅ **全球加速**：200+ 边缘节点，降低延迟
- ✅ **智能缓存**：API 不缓存，静态资源长缓存
- ✅ **一次部署**：与主堆栈同时部署，无需二次操作

## 🔄 从 Ingress 模式迁移到 TargetGroupBinding

如果您已经使用传统 Ingress 模式部署，可以平滑迁移：

1. **备份现有配置**
2. **更新部署堆栈**：使用新的 `dify-helm-stack.ts`
3. **重新部署**：CDK 会自动处理资源迁移
4. **验证服务**：确认新的 ALB 正常工作
5. **清理旧资源**：删除旧的 Ingress 创建的 ALB

## 🌍 区域特定配置

### 中国区域

如果部署在中国区域（cn-north-1 或 cn-northwest-1），需要注意：
- 不支持 CloudFront
- 需要配置 S3 访问密钥
- 使用特定的实例类型映射
- TargetGroupBinding 模式正常工作

### 全球区域

- 支持 CloudFront CDN
- 可以使用 IAM 角色进行 S3 访问
- 支持更多的实例类型选择
- 推荐使用 TargetGroupBinding 模式

## 📊 资源成本估算

### 生产环境

| 组件 | 实例类型/规格 | 预估月成本 |
|------|---------------|------------|
| EKS 集群 | 管理费用 | $72 |
| EC2 节点 | m8g.large x3 | ~$240 |
| Aurora PostgreSQL | Serverless v2 (0.5-4 ACU) | ~$100-400 |
| ElastiCache Redis | cache.t4g.small | ~$25 |
| OpenSearch | r6g.xlarge x2 | ~$400 |
| ALB | 标准 | ~$25 |
| CloudFront | 请求 + 数据传输 | ~$20-50 |
| S3 | 按使用量 | 变动 |

**总计**: 约 $900-1250/月（含 CloudFront）

### 测试环境

| 组件 | 实例类型/规格 | 预估月成本 |
|------|---------------|------------|
| EKS 集群 | 管理费用 | $72 |
| EC2 节点 | m8g.large x2 | ~$160 |
| Aurora PostgreSQL | db.t4g.medium | ~$60 |
| ElastiCache Redis | cache.t4g.micro | ~$15 |
| OpenSearch | t3.small.search x1 | ~$35 |
| ALB | 标准 | ~$25 |
| CloudFront | 最小使用 | ~$5-10 |
| S3 | 最小存储 | ~$5 |

**测试环境总计**: 约 $380-400/月

## 🚨 重要提醒

1. **TargetGroupBinding 要求**：确保 AWS Load Balancer Controller v2.2+ 已安装
2. **数据库密码**：默认使用系统生成的密码，存储在 AWS Secrets Manager 中
3. **数据库迁移**：启用 `dbMigration` 可自动执行数据库 schema 迁移
4. **备份策略**：默认 RDS 备份保留 1 天，生产环境建议增加
5. **删除保护**：默认情况下，RDS 和 S3 资源不会在堆栈删除时被移除
6. **监控**：建议配置 CloudWatch 告警监控关键指标

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

### TargetGroupBinding 相关问题

```bash
# 检查 TargetGroupBinding 状态
kubectl get targetgroupbindings -n dify

# 查看 TargetGroupBinding 详情
kubectl describe targetgroupbinding dify-api-tgb -n dify

# 检查 AWS Load Balancer Controller 日志
kubectl logs -n kube-system deployment/aws-load-balancer-controller
```

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
- [AWS Load Balancer Controller 文档](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [TargetGroupBinding 规范](https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.2/guide/targetgroupbinding/targetgroupbinding/)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📝 更新日志

### v2.0.0 (2025-08-16)
- 🚀 实现 TargetGroupBinding 架构
- ⚡ 支持一键部署，无需手动配置 DNS
- 🔧 添加 ALB 构造器，预创建负载均衡器
- 🔄 保持双模式兼容性
- 📦 清理冗余代码和备份文件
- 🗄️ 添加数据库自动迁移功能

### v1.0.0
- 初始版本，使用传统 Ingress 模式