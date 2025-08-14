#!/bin/bash

# ================================================================
# Dify on AWS 一键部署脚本（使用CDK内置并行功能）
# 
# 使用方法：
# ./deploy.sh
# ================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 配置
REGION=${AWS_REGION:-"ap-northeast-1"}
CONCURRENCY=4  # 并行度

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 显示部署信息
show_info() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}   Dify on AWS 一键部署${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
    echo -e "${YELLOW}部署配置:${NC}"
    echo "  - 区域: $REGION"
    echo "  - EKS版本: 1.33"
    echo "  - CloudFront: 已启用"
    echo "  - 并行度: $CONCURRENCY"
    echo ""
    echo -e "${YELLOW}将部署以下资源:${NC}"
    echo "  ✓ VPC网络"
    echo "  ✓ S3存储"
    echo "  ✓ RDS PostgreSQL"
    echo "  ✓ ElastiCache Redis"
    echo "  ✓ EKS集群 (1.33)"
    echo "  ✓ Dify应用"
    echo "  ✓ CloudFront CDN"
    echo ""
}

# 检查前置条件
check_prerequisites() {
    log_info "检查环境..."
    
    # 检查AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "请先安装 AWS CLI"
        exit 1
    fi
    
    # 检查CDK
    if ! command -v cdk &> /dev/null; then
        log_error "请先安装 AWS CDK: npm install -g aws-cdk"
        exit 1
    fi
    
    # 验证AWS凭证
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "请配置 AWS 凭证"
        exit 1
    fi
    
    log_success "环境检查通过"
}

# 主部署函数
deploy_all() {
    # 开始计时
    START_TIME=$(date +%s)
    
    log_info "安装依赖..."
    npm install
    
    log_info "编译项目..."
    npm run build
    
    log_info "Bootstrap CDK..."
    cdk bootstrap || true
    
    echo ""
    log_info "开始并行部署（并行度: $CONCURRENCY）..."
    echo -e "${YELLOW}提示: 这将需要 30-45 分钟${NC}"
    echo ""
    
    # 部署除CloudFront外的所有Stack
    # CloudFront需要ALB DNS，所以需要特殊处理
    npx cdk deploy --all \
        --concurrency $CONCURRENCY \
        --require-approval never \
        --outputs-file outputs.json \
        --exclude DifyCloudFrontStack
    
    if [ $? -eq 0 ]; then
        log_success "基础设施部署完成！"
    else
        log_error "部署失败"
        exit 1
    fi
    
    # 更新kubeconfig
    log_info "更新kubeconfig..."
    aws eks update-kubeconfig --name dify-eks --region "$REGION" || true
    
    # 等待并获取ALB DNS
    log_info "等待Ingress ALB创建..."
    
    local max_wait=300
    local wait_time=0
    local alb_dns=""
    
    while [ $wait_time -lt $max_wait ]; do
        alb_dns=$(kubectl get ingress -n dify -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
        
        if [ -n "$alb_dns" ]; then
            log_success "ALB创建成功: $alb_dns"
            break
        fi
        
        echo -ne "\r等待中... ($wait_time/$max_wait 秒)"
        sleep 10
        wait_time=$((wait_time + 10))
    done
    
    echo ""
    
    # 部署CloudFront
    if [ -n "$alb_dns" ]; then
        log_info "部署CloudFront CDN..."
        
        npx cdk deploy DifyCloudFrontStack \
            -c albDnsName="$alb_dns" \
            --require-approval never \
            --outputs-file outputs-cloudfront.json
        
        if [ $? -eq 0 ]; then
            log_success "CloudFront部署成功！"
            
            # 获取CloudFront域名
            if [ -f outputs-cloudfront.json ]; then
                CF_DOMAIN=$(jq -r '.DifyCloudFrontStack.DistributionDomainName // empty' outputs-cloudfront.json 2>/dev/null)
            fi
        else
            log_warning "CloudFront部署失败，但其他服务正常"
        fi
    else
        log_warning "无法获取ALB DNS，跳过CloudFront部署"
        log_info "您可以稍后手动部署CloudFront:"
        log_info "  1. 获取ALB: kubectl get ingress -n dify"
        log_info "  2. 部署: npx cdk deploy DifyCloudFrontStack -c albDnsName=<ALB_DNS>"
    fi
    
    # 计算总时间
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    MINUTES=$((DURATION / 60))
    
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   🎉 部署完成！${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    
    # 显示访问信息
    if [ -n "$alb_dns" ]; then
        echo -e "${YELLOW}访问地址:${NC}"
        echo "  ALB: http://$alb_dns"
    fi
    
    if [ -n "$CF_DOMAIN" ]; then
        echo "  CloudFront: https://$CF_DOMAIN"
        echo ""
        echo -e "${YELLOW}注意:${NC} CloudFront需要15-20分钟传播到全球节点"
    fi
    
    echo ""
    echo -e "${YELLOW}常用命令:${NC}"
    echo "  查看Pods: kubectl get pods -n dify"
    echo "  查看日志: kubectl logs -n dify <pod-name>"
    echo "  查看服务: kubectl get svc -n dify"
    echo ""
    
    log_success "总耗时: ${MINUTES} 分钟"
}

# 清理函数
cleanup() {
    log_warning "是否要清理所有资源? (y/n)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        log_info "开始清理..."
        npx cdk destroy --all --force
        log_success "清理完成"
    fi
}

# 主函数
main() {
    show_info
    
    # 确认部署
    echo -ne "${YELLOW}是否开始部署? (y/n): ${NC}"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log_info "部署已取消"
        exit 0
    fi
    
    check_prerequisites
    deploy_all
}

# 解析参数
case "${1:-}" in
    clean|cleanup|destroy)
        cleanup
        ;;
    *)
        main
        ;;
esac