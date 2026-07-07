# 泰拉瑞亚服务器管理面板 - Windows打包脚本
# 使用 PowerShell 执行
$ErrorActionPreference = "Stop"

# 配置
$PROJECT_DIR = $PSScriptRoot | Split-Path -Parent
$VERSION = "1.5.1"
$OUTPUT_NAME = "erpanel-terraria-$VERSION"
$DIST_DIR = "$PROJECT_DIR\dist"
$TMP_DIR = "$env:TEMP\erpanel-terraria-build"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ERPanel_terraria - 打包" -ForegroundColor Cyan
Write-Host "  版本: $VERSION" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 创建临时目录
Write-Host "[1/3] 准备临时目录..." -ForegroundColor Yellow
if (Test-Path $TMP_DIR) {
    Remove-Item -Recurse -Force $TMP_DIR
}
New-Item -ItemType Directory -Path $TMP_DIR | Out-Null
New-Item -ItemType Directory -Path $DIST_DIR -Force | Out-Null

$TARGET_DIR = "$TMP_DIR\$OUTPUT_NAME"
New-Item -ItemType Directory -Path $TARGET_DIR | Out-Null

# 复制核心文件
Write-Host "[2/3] 复制文件并安装依赖..." -ForegroundColor Yellow
Copy-Item -Recurse "$PROJECT_DIR\app" "$TARGET_DIR\app"
Copy-Item -Recurse "$PROJECT_DIR\public" "$TARGET_DIR\public"
Copy-Item -Recurse "$PROJECT_DIR\scripts" "$TARGET_DIR\scripts"
Copy-Item "$PROJECT_DIR\package.json" "$TARGET_DIR\package.json"
if (Test-Path "$PROJECT_DIR\package-lock.json") {
    Copy-Item "$PROJECT_DIR\package-lock.json" "$TARGET_DIR\package-lock.json"
}

# 在临时目录安装依赖
Push-Location $TARGET_DIR
try {
    Write-Host "  设置 npm 镜像源..."
    npm config set registry https://registry.npmmirror.com
    
    Write-Host "  安装生产依赖..."
    npm install --production --registry=https://registry.npmmirror.com
    
    Write-Host "  清理临时文件..."
    if (Test-Path "$TARGET_DIR\node_modules\.cache") {
        Remove-Item -Recurse -Force "$TARGET_DIR\node_modules\.cache"
    }
    # 清理一些大文件
    Get-ChildItem -Path "$TARGET_DIR\node_modules" -Recurse -Filter "*.md" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path "$TARGET_DIR\node_modules" -Recurse -Filter "LICENSE" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
finally {
    Pop-Location
}

# 压缩
Write-Host "[3/3] 创建压缩包..." -ForegroundColor Yellow
$OUTPUT_FILE = "$DIST_DIR\$OUTPUT_NAME.zip"
if (Test-Path $OUTPUT_FILE) {
    Remove-Item $OUTPUT_FILE -Force
}
Compress-Archive -Path "$TMP_DIR\$OUTPUT_NAME\*" -DestinationPath $OUTPUT_FILE -Force

# 清理临时目录
Remove-Item -Recurse -Force $TMP_DIR -ErrorAction SilentlyContinue

# 获取文件大小
$fileInfo = Get-Item $OUTPUT_FILE
$sizeMB = [math]::Round($fileInfo.Length / 1MB, 2)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  打包完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  输出: $OUTPUT_FILE"
Write-Host "  大小: ${sizeMB} MB"
Write-Host ""
Write-Host "  安装方式:"
Write-Host "    1. 上传到服务器后执行:"
Write-Host "       unzip $OUTPUT_NAME.zip -d /opt/erpanel-terraria"
Write-Host "       cd /opt/erpanel-terraria"
Write-Host "       sudo bash scripts/install.sh"
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
