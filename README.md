# ERPanel-Terraria | 泰拉瑞亚服务器管理面板

> 作者：[@ER猫](https://github.com/chaojiermao)

一款基于 Web 的泰拉瑞亚服务器管理面板，支持 **纯净版 (Vanilla)** 和 **TModLoader** 双模式切换，提供可视化的服务器管理体验。

---
![Uploading image.png…]()

## 功能特性

### 双模式支持
- **纯净版 (Vanilla)** — 管理原版泰拉瑞亚服务器
- **TModLoader** — 管理模组服务器，支持模组启用/禁用

### 核心功能
- **服务器控制** — 启动/停止/重启服务器，实时控制台日志输出
- **模组管理** — 在线启用/禁用模组，上传 `.tmod` 文件，可视化编辑 ModConfigs 配置
- **文件管理** — 文件上传（最大 50MB 分片上传）、下载、解压、压缩，目录导航
- **世界管理** — 世界文件查看与管理
- **配置编辑** — 在线编辑 `serverconfig.txt` 等配置文件
- **自动备份** — 定期自动备份服务器状态与配置

### 安全特性
- 密码版本验证（密码修改后自动失效旧令牌）
- 登录失败锁定（3 次警告，10 次锁定 15 分钟）
- JWT 令牌认证

### 技术栈
- **后端**: Node.js + Express + WebSocket (ws)
- **前端**: 原生 HTML/CSS/JavaScript (像素风格 UI)
- **认证**: JWT + bcrypt
- **通信**: WebSocket 实时双向通信

---

## 快速安装

### 环境要求
- Node.js >= 16.x
- Linux 服务器（推荐 Ubuntu 20.04+ / CentOS 7+）

### 一键安装

```bash
# 下载最新版本
wget https://github.com/chaojiermao/ermaoplane_terraria/releases/latest/download/erpanel-terraria.tar.gz

# 解压
tar -xzf erpanel-terraria.tar.gz
cd erpanel-terraria

# 安装依赖
npm install --production

# 启动面板
node app/server.js
```

默认访问地址：`http://服务器IP:3000`

首次访问将引导创建管理员账号。

### systemd 服务管理

```bash
# 安装服务
cp scripts/erpanel-terraria.service /etc/systemd/system/

# 启动并设置开机自启
systemctl enable --now erpanel-terraria
```

---

## 目录结构

```
erpanel-terraria/
├── app/
│   ├── server.js          # 服务端入口
│   ├── services/          # 业务逻辑服务
│   │   ├── auth.js        # 认证服务
│   │   ├── game.js        # 游戏进程管理
│   │   ├── mod.js         # 模组管理
│   │   ├── modConfig.js   # ModConfigs 配置
│   │   ├── file.js        # 文件操作
│   │   ├── console.js     # 控制台服务
│   │   ├── backup.js      # 备份服务
│   │   ├── mode.js        # 模式切换
│   │   └── ...
│   ├── ws/gateway.js      # WebSocket 网关
│   └── utils/             # 工具函数
├── public/
│   └── index.html         # 前端页面
├── scripts/               # 部署脚本
├── runtime/               # 运行时文件
├── servers/               # 服务器配置
├── data/                  # 数据存储
└── package.json
```

---

## 配置说明

面板配置文件位于 `data/state.json`，主要配置项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `mode` | 运行模式 (`vanilla` / `tmodloader`) | `vanilla` |
| `server.port` | 面板端口 | `3000` |
| `server.host` | 监听地址 | `0.0.0.0` |
| `backup.interval` | 备份间隔（分钟） | `60` |
| `backup.maxBackups` | 最大备份数 | `10` |

---

## 许可证

**版权所有 (c) 2025 @ER猫 (chaojiermao)**

**保留所有权利。未经著作权人书面许可，任何人不得：**
- 复制、分发、传播或修改本软件的源代码或二进制形式
- 将本软件用于任何商业用途
- 基于本软件创作衍生作品

本软件按"原样"提供，不提供任何明示或暗示的保证。

---

## 致谢

- [Terraria](https://terraria.org) — Re-Logic
- [TModLoader](https://github.com/tModLoader/tModLoader) — TML Team
- [@ER猫](https://github.com/chaojiermao) — 开发维护
