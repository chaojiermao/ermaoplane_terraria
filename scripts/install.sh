#!/bin/bash
#========================================
# ERPanel_terraria - 一键安装脚本
#========================================
# 用法:
#   本地安装:
#     sudo bash scripts/install.sh
#
#   远程安装:
#     curl -fsSL https://你的域名/erpanel-terraria-latest.tar.gz | sudo bash
#
#   指定安装目录:
#     sudo bash scripts/install.sh /自定义/路径
#========================================
set -e

# ==================== 配置 ====================
PANEL_DIR="${1:-/opt/erpanel-terraria}"
NODE_REQUIRED="20"
NODE_MINIMUM="18"
PANEL_USER="terraria"
PANEL_GROUP="terraria"

# 颜色
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
echo -e "${BLUE}  ERPanel_terraria - 一键安装${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
  error "请以 root 权限运行: sudo bash $0"
  exit 1
fi

# 检查系统架构
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "armv7l" ]; then
  warn "检测到 ARM 架构 - tModLoader 官方不支持 ARM，纯净服可能可用"
  echo "  是否继续安装？(y/N): "
  read -r CONTINUE
  if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
    info "安装已取消"
    exit 0
  fi
fi

# ==================== 第1步：检测系统 ====================
step "1/6 - 检测系统环境"

PM=""
if command -v apt-get &>/dev/null; then
  PM="apt"
elif command -v yum &>/dev/null; then
  PM="yum"
elif command -v dnf &>/dev/null; then
  PM="dnf"
elif command -v apk &>/dev/null; then
  PM="apk"
else
  error "不支持的包管理器，请手动安装 Node.js 18+"
  exit 1
fi
info "包管理器: $PM"

if [ -f /etc/os-release ]; then
  . /etc/os-release
  info "操作系统: $NAME $VERSION_ID"
else
  info "操作系统: $(uname -s) $(uname -r)"
fi

info "架构: $ARCH"

# ==================== 第2步：安装 Node.js ====================
step "2/6 - 安装 Node.js"

install_nodejs() {
  warn "Node.js 未安装或版本过低，正在自动安装 Node.js 20 LTS..."
  case "$PM" in
    apt)
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
      apt-get update -qq
      apt-get install -y -qq nodejs
      ;;
    yum|dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      $PM install -y nodejs
      ;;
    apk)
      apk add nodejs npm
      ;;
  esac
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d'.' -f1)
  NODE_FULL=$(node -v)
  if [ "$NODE_VER" -lt "$NODE_MINIMUM" ]; then
    warn "Node.js $NODE_FULL 版本过低（需要 v$NODE_MINIMUM+）"
    install_nodejs
  else
    info "Node.js: $NODE_FULL"
  fi
else
  install_nodejs
fi

if ! command -v node &>/dev/null; then
  error "Node.js 安装失败，请手动安装 Node.js 20 LTS"
  exit 1
fi
info "Node.js: $(node -v)"
info "npm: $(npm -v)"

# ==================== 第3步：安装系统依赖 ====================
step "3/6 - 安装系统依赖"

install_packages() {
  local pkgs=("unzip" "tar" "curl" "git")
  local to_install=()
  for pkg in "${pkgs[@]}"; do
    if ! command -v "$pkg" &>/dev/null; then
      to_install+=("$pkg")
    fi
  done
  if [ ${#to_install[@]} -eq 0 ]; then
    info "所有系统依赖已就绪"
    return
  fi
  info "正在安装: ${to_install[*]}"
  case "$PM" in
    apt) apt-get install -y -qq "${to_install[@]}" ;;
    yum|dnf) $PM install -y "${to_install[@]}" ;;
    apk) apk add "${to_install[@]}" ;;
  esac
}

install_packages

# ==================== 第4步：创建目录和用户 ====================
step "4/6 - 创建面板目录"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || echo "")"
IS_SOURCE=false

if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/package.json" ] && [ -d "$PROJECT_DIR/app" ]; then
  IS_SOURCE=true
  info "检测到源码目录: $PROJECT_DIR"
fi

# 创建系统用户
if ! id -u "$PANEL_USER" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d "$PANEL_DIR" "$PANEL_USER" 2>/dev/null || \
  useradd -r -s /bin/false "$PANEL_USER" 2>/dev/null || {
    warn "无法创建 $PANEL_USER 用户，将使用 root 运行"
    PANEL_USER="root"
    PANEL_GROUP="root"
  }
fi

# 创建目录结构
create_dirs() {
  mkdir -p "$PANEL_DIR"/{app/{services,ws,utils},public/assets,scripts}
  mkdir -p "$PANEL_DIR"/data
  mkdir -p "$PANEL_DIR"/runtime/vanilla/versions
  mkdir -p "$PANEL_DIR"/runtime/tmodloader/versions
  mkdir -p "$PANEL_DIR"/servers/vanilla/{Worlds,Logs}
  mkdir -p "$PANEL_DIR"/servers/tmodloader/{Worlds,Mods,Logs}
  mkdir -p "$PANEL_DIR"/downloads
  mkdir -p "$PANEL_DIR"/backups/vanilla
  mkdir -p "$PANEL_DIR"/backups/tmodloader
  mkdir -p "$PANEL_DIR"/logs
  # Terraria 服务端需要写入 ~/.local/share/Terraria/ 存储 favorites.json 等
  mkdir -p "$PANEL_DIR"/.local/share/Terraria
}

create_dirs
info "目录结构已创建: $PANEL_DIR"

# 复制文件
if [ "$IS_SOURCE" = true ] && [ "$PROJECT_DIR" != "$PANEL_DIR" ]; then
  info "正在复制文件到 $PANEL_DIR ..."
  cp -r "$PROJECT_DIR/app"/*     "$PANEL_DIR/app/"
  cp -r "$PROJECT_DIR/public"/*  "$PANEL_DIR/public/"
  cp -r "$PROJECT_DIR/scripts"/* "$PANEL_DIR/scripts/" 2>/dev/null || true
  cp  "$PROJECT_DIR/package.json" "$PANEL_DIR/package.json"
  cp  "$PROJECT_DIR/package-lock.json" "$PANEL_DIR/package-lock.json" 2>/dev/null || true
  info "文件复制完成"
elif [ "$IS_SOURCE" = true ] && [ "$PROJECT_DIR" = "$PANEL_DIR" ]; then
  info "已在安装目录中，跳过文件复制"
elif [ -d "$PANEL_DIR/app" ] && [ -f "$PANEL_DIR/package.json" ]; then
  info "面板文件已存在，跳过文件复制"
else
  warn "未检测到面板源码，请将源码放置到 $PANEL_DIR 目录"
  echo ""
  echo "安装目录已创建，放置源码后再次运行本脚本完成安装。"
  exit 0
fi

# ==================== 第5步：检查并安装 npm 依赖 ====================
step "5/6 - 检查 npm 依赖"

cd "$PANEL_DIR"

# 设置国内镜像源
npm config set registry https://registry.npmmirror.com

# 检查是否已经有 node_modules
if [ -d "$PANEL_DIR/node_modules" ] && [ -f "$PANEL_DIR/package-lock.json" ]; then
  info "检测到已预安装的 node_modules，验证..."
  # 检查核心依赖是否存在
  OK=true
  for mod in express ws fs-extra bcryptjs jsonwebtoken adm-zip systeminformation uuid; do
    if [ ! -d "$PANEL_DIR/node_modules/$mod" ]; then
      warn "缺少 $mod，将重新安装"
      OK=false
      break
    fi
  done

  # 检查 better-sqlite3 原生模块是否可用（跨平台可能需要重新编译）
  if $OK && [ -d "$PANEL_DIR/node_modules/better-sqlite3" ]; then
    info "检测到原生模块 better-sqlite3，先尝试直接使用..."
    # 先测试 better-sqlite3 是否能正常加载
    cd "$PANEL_DIR"
    if node -e "require('better-sqlite3')" 2>/dev/null; then
      info "  better-sqlite3 直接可用！跳过重新编译"
    else
      warn "  better-sqlite3 可能需要重新编译（这可能需要几分钟）"
      info "  正在重新编译 better-sqlite3..."
      npm rebuild better-sqlite3 --registry=https://registry.npmmirror.com --loglevel=error 2>&1 || {
        warn "  重新编译 better-sqlite3 失败，尝试重新安装..."
        npm install better-sqlite3 --production --registry=https://registry.npmmirror.com --loglevel=error 2>&1 || true
      }
    fi
    cd - >/dev/null
  fi

  if $OK; then
    info "依赖已就绪！"
  else
    warn "重新安装所有依赖..."
    # 先安装构建工具
    if command -v apt-get &>/dev/null; then
      apt-get install -y -qq python3 make g++ 2>/dev/null || true
    elif command -v yum &>/dev/null; then
      yum install -y python3 make gcc-c++ 2>/dev/null || true
    fi
    npm install --production --registry=https://registry.npmmirror.com --loglevel=error 2>&1
  fi
else
  info "未预安装依赖，现在安装..."
  # 安装构建工具
  if command -v apt-get &>/dev/null; then
    apt-get install -y -qq python3 make g++ 2>/dev/null || true
  elif command -v yum &>/dev/null; then
    yum install -y python3 make gcc-c++ 2>/dev/null || true
  fi
  # 使用淘宝镜像安装
  npm install --production --registry=https://registry.npmmirror.com --loglevel=error 2>&1
fi

# 最终验证
missing=""
for mod in express ws fs-extra bcryptjs jsonwebtoken adm-zip systeminformation uuid better-sqlite3; do
  if [ ! -d "$PANEL_DIR/node_modules/$mod" ]; then
    missing="$missing $mod"
  fi
done

if [ -n "$missing" ]; then
  error "缺少必要依赖: $missing"
  warn "请手动执行: cd $PANEL_DIR && npm install --production"
  exit 1
fi

info "npm 依赖安装完成"

chown -R "$PANEL_USER:$PANEL_GROUP" "$PANEL_DIR" 2>/dev/null || true
chmod 755 "$PANEL_DIR"
chmod +x "$PANEL_DIR/scripts/"*.sh 2>/dev/null || true

# ==================== 第6步：配置 systemd 服务 ====================
step "6/6 - 配置 systemd 服务"

SERVICE_FILE="$PANEL_DIR/scripts/erpanel-terraria.service"
if [ -f "$SERVICE_FILE" ]; then
  sed "s|User=root|User=$PANEL_USER|g; s|WorkingDirectory=/opt/erpanel-terraria|WorkingDirectory=$PANEL_DIR|g; s|ExecStart=/usr/bin/node|ExecStart=$(which node)|g; s|/opt/erpanel-terraria|$PANEL_DIR|g" \
    "$SERVICE_FILE" > /etc/systemd/system/erpanel-terraria.service

  systemctl daemon-reload
  systemctl enable erpanel-terraria
  systemctl start erpanel-terraria

  info "systemd 服务已配置并启动"
else
  warn "服务文件未找到，跳过 systemd 配置"
  warn "可手动启动: cd $PANEL_DIR && node app/server.js"
fi

# ==================== 完成 ====================
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "  面板地址:  ${GREEN}http://服务器IP:3001${NC}"
echo ""
echo -e "  ${YELLOW}管理命令:${NC}"
echo -e "    systemctl status erpanel-terraria      # 查看状态"
echo -e "    systemctl start erpanel-terraria       # 启动"
echo -e "    systemctl stop erpanel-terraria        # 停止"
echo -e "    systemctl restart erpanel-terraria     # 重启"
echo -e "    journalctl -u erpanel-terraria -f      # 查看日志"
echo ""
echo -e "  ${YELLOW}面板目录:${NC} $PANEL_DIR"
echo ""
echo -e "  ${YELLOW}更新面板:${NC}"
echo -e "    sudo bash $PANEL_DIR/scripts/update-panel.sh"
echo ""
echo -e "  ${YELLOW}首次使用:${NC}"
echo -e "    1. 浏览器打开 ${GREEN}http://服务器IP:3001${NC}"
echo -e "    2. 创建管理员账号"
echo -e "    3. 进入「版本更新」页面下载服务端"
echo -e "    4. 进入「设置」页面配置服务器参数"
echo -e "    5. 返回「总览」页面启动服务器"
echo ""
echo -e "  ${YELLOW}注意:${NC}"
echo -e "    - 游戏端口默认 7777，需在 NAT 面板中额外转发"
echo -e "    - 面板端口 3001 是内部管理端口"
echo "========================================"
