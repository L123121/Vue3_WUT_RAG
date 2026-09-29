#!/usr/bin/env bash
# ======================================================================
# 一键部署脚本 — 武理小精灵
# 用于在没有 CI/CD 的情况下，手动部署到阿里云 ECS
#
# 前置条件:
#   1. 阿里云 ECS 已安装 Docker + Docker Compose
#   2. 服务器已配置 SSH 密钥登录
#   3. 已在 deploy/.env.production 中填好环境变量
#   4. 域名 DNS 已指向 ECS 公网 IP
#   5. SSL 证书已就绪
#
# 用法:
#   chmod +x deploy/deploy.sh
#   ./deploy/deploy.sh                  # 本地构建 + 推送到服务器
#   ./deploy/deploy.sh --skip-build     # 只用服务器已有镜像
#   ./deploy/deploy.sh --init           # 首次部署（包括证书初始化）
# ======================================================================

set -euo pipefail

# ─── 配置区（按需修改） ───
REMOTE_HOST="your-ecs-ip-or-domain"
REMOTE_USER="root"
REMOTE_DIR="/opt/wuli-elf"
IMAGE_NAME="your-dockerhub-username/wuli-elf-backend"
DOMAIN="your-domain.com"

# ─── 颜色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── 参数解析 ───
SKIP_BUILD=false
INIT_MODE=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --init) INIT_MODE=true ;;
    *) error "未知参数: $arg" ;;
  esac
done

# ─── 检查依赖 ───
command -v docker >/dev/null 2>&1 || error "Docker 未安装"
command -v rsync >/dev/null 2>&1 || error "rsync 未安装"

# ─── 1. 构建 Docker 镜像 ───
if [ "$SKIP_BUILD" = false ]; then
  info "构建 Docker 镜像..."
  docker build -t "$IMAGE_NAME:latest" -t "$IMAGE_NAME:$(git rev-parse --short HEAD)" .

  info "推送到镜像仓库..."
  docker push "$IMAGE_NAME:latest"
else
  warn "跳过构建，使用已有镜像"
fi

# ─── 2. 初始化服务器（仅首次） ───
if [ "$INIT_MODE" = true ]; then
  info "初始化远程服务器..."

  # 创建目录
  ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

  # 检查 Docker
  ssh "$REMOTE_USER@$REMOTE_HOST" "docker --version && docker compose version" || error "服务器 Docker 未正确安装"

  # 初始化 SSL 证书（使用阿里云免费证书或 Let's Encrypt）
  warn "请确保域名 $DOMAIN 已指向 $REMOTE_HOST"
  echo "----------------------------------------"
  echo "SSL 证书获取方式："
  echo "  1) 阿里云控制台 → SSL证书 → 免费证书 → 下载 nginx 版"
  echo "  2) 手动上传到服务器 /etc/letsencrypt/live/$DOMAIN/"
  echo "  3) 或使用 certbot:"
  echo "     ssh $REMOTE_USER@$REMOTE_HOST 'docker run --rm -v /opt/wuli-elf/ssl:/etc/letsencrypt certbot/certbot certonly --manual -d $DOMAIN'"
  echo "----------------------------------------"
fi

# ─── 3. 同步部署文件到服务器 ───
info "同步部署文件到服务器..."

# 创建远程目录
ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

# 同步 compose 和 nginx 配置
rsync -avz --delete \
  docker-compose.yml \
  deploy/nginx.conf \
  deploy/.env.production \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# ─── 4. 远程部署 ───
info "在服务器上部署..."

ssh "$REMOTE_USER@$REMOTE_HOST" << EOF
  set -e
  cd $REMOTE_DIR

  # 拉取新镜像
  if [ "$SKIP_BUILD" = false ]; then
    docker compose -p wuli-elf pull backend
  fi

  # 启动所有服务
  docker compose -p wuli-elf up -d

  # 等待后端健康检查通过
  echo "等待后端启动..."
  for i in \$(seq 1 12); do
    if curl -sf http://localhost:3000/api/ready > /dev/null 2>&1; then
      echo "✅ 后端启动成功"
      break
    fi
    if [ "\$i" -eq 12 ]; then
      echo "❌ 后端启动超时，请检查日志: docker compose logs backend"
    fi
    sleep 5
  done

  # 清理旧镜像
  docker image prune -f

  echo "🎉 部署完成！"
  echo "   访问 https://$DOMAIN"
EOF

info "✅ 全部完成！"
