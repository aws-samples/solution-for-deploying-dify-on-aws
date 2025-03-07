# 修复Plugin Pod无法启动的问题

## 问题描述

Dify的plugin pod一直处于Pending状态，无法正常启动。经过调查，发现是由于PersistentVolumeClaim无法绑定导致的。

## 根本原因

问题根源是存在循环依赖：

1. gp2 StorageClass 使用了`volumeBindingMode: WaitForFirstConsumer`策略
2. 这种策略要求Pod先完成调度后，才会绑定PVC
3. 但Plugin Pod需要先绑定PVC才能调度，形成了循环依赖

## 解决方案

在EKS stack配置中，修改了StorageClass的绑定模式：

```typescript
// 创建 gp2 StorageClass
this.cluster.addManifest('gp2-storage-class', {
  apiVersion: 'storage.k8s.io/v1',
  kind: 'StorageClass',
  metadata: {
    name: 'gp2',
    annotations: {
      'storageclass.kubernetes.io/is-default-class': 'true'
    }
  },
  provisioner: 'ebs.csi.aws.com',
  volumeBindingMode: 'Immediate',  // 修改为立即绑定模式，解决循环依赖
  parameters: {
    type: 'gp2',
    fsType: 'ext4'
  }
});
```

## 部署步骤

1. 在1.0.0分支上已提交此修复
2. 执行以下命令部署更新：

```bash
cd dify-cdk
npm run build
cdk deploy EKSStack
```

3. 更新后，删除现有的pending状态PVC和Pod，让系统重新创建：

```bash
kubectl delete pod -n dify <plugin-pod-name>
kubectl delete pvc -n dify dify-plugin-daemon-pvc
```

## 验证方法

执行以下命令检查plugin pod是否正常启动：

```bash
kubectl get pods -n dify | grep plugin
```
