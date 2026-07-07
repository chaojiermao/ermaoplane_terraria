#!/bin/bash
#========================================
# ERPanel_terraria - 更新脚本
#========================================
# 用法: sudo bash scripts/update-panel.sh
#========================================
set -e

PANEL_DIR="/opt/erpanel-terraria"
BACKUP_DIR="/opt/erpanel-terraria-backups"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
step()  { echo -e "\n${BLUE}>>> $1${NC}"; }

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  ERPanel_terraria - 更新${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
  error "请以 root 权限运行: sudo bash $0"
  exit 1
fi

if [ ! -d "$PANEL_DIR" ]; then
  error "面板目录不存在: $PANEL_DIR"
  info "请先运行 install.sh 安装"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || echo "")"
HAS_SOURCE=false

if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/package.json" ] && [ -d "$PROJECT_DIR/app" ]; then
  HAS_SOURCE=true
  info "检测到源码目录: $PROJECT_DIR"
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/panel_backup_${TIMESTAMP}"

step "1/4 - 备份当前面板"
mkdir -p "$BACKUP_PATH"
cp -r "$PANEL_DIR/app"       "$BACKUP_PATH/app"
cp -r "$PANEL_DIR/public"    "$BACKUP_PATH/public"
cp "$PANEL_DIR/package.json" "$BACKUP_PATH/package.json" 2>/dev/null || true
info "备份到: $BACKUP_PATH"

step "2/4 - 更新文件"
if [ "$HAS_SOURCE" = true ]; then
  info "从源码目录更新..."
  cp -r "$PROJECT_DIR/app"/*     "$PANEL_DIR/app/"
  cp -r "$PROJECT_DIR/public"/*  "$PANEL_DIR/public/"
  cp "$PROJECT_DIR/package.json" "$PANEL_DIR/package.json"
  info "文件更新完成"
elif [ -d "$PANEL_DIR/.git" ]; then
  info "从 Git 仓库更新..."
  cd "$PANEL_DIR"
  git pull
  info "Git 更新完成"
else
  warn "未检测到源码目录或 Git 仓库"
  warn "请手动更新 $PANEL_DIR 中的文件"
  echo ""
  info "备份位置: $BACKUP_PATH"
  info "更新方法:"
  echo "  1. 下载新版压缩包"
  echo "  2. 解压后覆盖 $PANEL_DIR 中的 app/ 和 public/ 目录"
  echo "  3. 重新运行本脚本完成安装"
  exit 0
fi

step "3/4 - 更新 npm 依赖"
cd "$PANEL_DIR"
npm config set registry https://registry.npmmirror.com
npm install --production --registry=https://registry.npmmirror.com --loglevel=error 2>&1 || true
info "npm 依赖更新完成"

step "4/4 - 重启面板"
if systemctl is-active --quiet erpanel-terraria 2>/dev/null; then
  systemctl restart erpanel-terraria
  info "面板已重启"
else
  warn "面板服务未运行，尝试启动..."
  systemctl start erpanel-terraria 2>/dev/null || \
  warn "请手动启动: cd $PANEL_DIR && node app/server.js"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  更新完成！${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
info "备份位置: $BACKUP_PATH"
info "如果更新后有问题，可手动恢复备份:"
echo "  cp -r $BACKUP_PATH/app/* $PANEL_DIR/app/"
echo "  cp -r $BACKUP_DIR/public/* $PANEL_DIR/public/"
echo "  systemctl restart erpanel-terraria"
echo ""
