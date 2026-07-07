#!/bin/bash
#========================================
# ERPanel_terraria - 打包脚本
#========================================
# 用法: ./scripts/build.sh [版本号]
# 例如: ./scripts/build.sh 1.0.0
# 输出: dist/erpanel-terraria-{version}.tar.gz
#========================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:-1.0.0}"
DIST_DIR="$PROJECT_DIR/dist"
OUTPUT_NAME="erpanel-terraria-${VERSION}"
OUTPUT_FILE="${DIST_DIR}/${OUTPUT_NAME}.tar.gz"

echo "========================================"
echo "  ERPanel_terraria - 打包"
echo "  版本: ${VERSION}"
echo "========================================"

# 创建打包临时目录
BUILD_DIR=$(mktemp -d)
TARGET_DIR="$BUILD_DIR/$OUTPUT_NAME"

echo "[1/3] 整理文件..."
mkdir -p "$TARGET_DIR"

# 复制核心文件
cp -r "$PROJECT_DIR/app"          "$TARGET_DIR/app"
cp -r "$PROJECT_DIR/public"       "$TARGET_DIR/public"
cp -r "$PROJECT_DIR/scripts"      "$TARGET_DIR/scripts"
cp    "$PROJECT_DIR/package.json" "$TARGET_DIR/package.json"

# 复制文档
if [ -f "$PROJECT_DIR/README.md" ]; then
  cp "$PROJECT_DIR/README.md" "$TARGET_DIR/README.md"
fi

# 清理 scripts 目录中的临时文件
rm -f "$TARGET_DIR/scripts/install.js"

# 确保所有 shell 脚本可执行
chmod +x "$TARGET_DIR/scripts/"*.sh

# 移除 macOS 隐藏文件
find "$BUILD_DIR" -name '.DS_Store' -delete 2>/dev/null || true

echo "[2/3] 安装依赖到打包目录..."
cd "$TARGET_DIR"

# 先设置淘宝镜像源加快下载
npm config set registry https://registry.npmmirror.com

# 安装生产依赖
info "正在安装 npm 依赖..."
npm install --production --registry=https://registry.npmmirror.com 2>&1

# 如果当前是 Windows 并且有原生模块，我们需要处理一下
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
  warn "检测到在 Windows 上打包，better-sqlite3 这类原生模块可能需要重新编译"
  info "在服务器上会自动检测重新安装"
else
  # Linux/Mac 上可以直接保留
  info "依赖安装完成"
fi

# 清理 node_modules 中的临时文件
find node_modules -name '.cache' -type d -exec rm -rf {} \; 2>/dev/null || true

echo "[3/3] 创建压缩包..."
mkdir -p "$DIST_DIR"
cd "$BUILD_DIR"
tar -czf "$OUTPUT_FILE" "$OUTPUT_NAME"

# 计算校验值
MD5=$(md5sum "$OUTPUT_FILE" | cut -d' ' -f1)
SHA256=$(sha256sum "$OUTPUT_FILE" | cut -d' ' -f1)
FILESIZE=$(ls -lh "$OUTPUT_FILE" | awk '{print $5}')

# 清理临时目录
rm -rf "$BUILD_DIR"

echo ""
echo "========================================"
echo "  打包完成！"
echo "========================================"
echo "  输出: $OUTPUT_FILE"
echo "  大小: $FILESIZE"
echo "  MD5:  $MD5"
echo "  SHA256: $SHA256"
echo "========================================"
echo ""
echo "  安装方式:"
echo "    1. 上传到服务器后执行:"
echo "       tar -xzf $OUTPUT_NAME.tar.gz"
echo "       cd $OUTPUT_NAME"
echo "       sudo bash scripts/install.sh"
echo ""
echo "    2. 或使用远程安装（需托管到 HTTP 服务器）:"
echo "       curl -fsSL http://your-server/$OUTPUT_NAME.tar.gz | sudo bash"
echo "========================================"
