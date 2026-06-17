# GitHub Star 仓库 Release 监控 + 手机通知

通过 GitHub Action 每日自动检查指定用户 star 的仓库，**只通知上次检查后新增的 Release**，通过 **Server 酱3** 推送到手机 App。

> 首次运行回退至 48 小时内；后续只通知增量。使用 MongoDB 存储检查时间，不产生额外 git 提交。

## 功能

- 🕘 每日 00:07（北京时间）自动扫描
- ⭐ 检查指定 GitHub 用户所有 star 仓库
- 🚀 增量通知，不会重复推送已通知过的 Release
- 🧪 push 触发时若无新增，自动展示 star 仓库中最新一条 Release
- 📱 通过 Server 酱3 推送到手机 App
- 🔄 支持手动触发

## 快速开始

### 1. 获取必要凭证

| 凭证 | 说明 | 获取方式 |
|------|------|----------|
| `MONITOR_USER` | 要监控的 GitHub **个人**用户名 | Variables 标签页配置 |
| `MONGODB_URI` | MongoDB 连接字符串 | [MongoDB Atlas](https://www.mongodb.com/atlas) 免费集群 → Connect → Drivers |
| `SERVER_UID` | Server 酱3 用户 UID | [Server 酱3](https://sc3.ft07.com/sendkey) 登录后在 SendKey 页面获取 |
| `SERVER_KEY` | Server 酱3 SendKey | [Server 酱3](https://sc3.ft07.com/sendkey) 登录后在 SendKey 页面获取 |

> 💡 `GITHUB_TOKEN` 自动使用内置 `secrets.GITHUB_TOKEN`，无需手动配置。

### 2. 配置 MongoDB Atlas（免费）

1. 注册 [MongoDB Atlas](https://www.mongodb.com/atlas)，创建免费 M0 集群
2. Database Access → 创建用户（读写权限）
3. Network Access → 添加 `0.0.0.0/0`（允许所有 IP）
4. Connect → Drivers → 复制连接字符串，格式如 `mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/`

### 3. 配置 GitHub Secrets 和 Variables

在仓库 **Settings → Secrets and variables → Actions** 中：

**Variables** 标签页：

```
MONITOR_USER = 你的个人GitHub用户名
```

**Secrets** 标签页：

```
MONGODB_URI = mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/
SERVER_UID  = 你的uid
SERVER_KEY  = 你的sendkey
```

### 4. 手动测试

在 GitHub 仓库的 **Actions** 标签页 → 选择 `GitHub Release 每日监控` → **Run workflow** 手动触发。

## 通知示例

**有新 Release 时：**
```
1. torvalds/linux
   🏷️ [v6.12](https://github.com/torvalds/linux/releases/tag/v6.12)
   🕐 2026-06-17 02:30:00

2. facebook/react
   🏷️ [v19.2.0](https://github.com/facebook/react/releases/tag/v19.2.0)
   🕐 2026-06-16 20:15:00

📊 上次检查后新增 2 个 Release | example-user | 监控 42 个仓库 | 2026-06-17 00:07:00
```

**push 测试无新增时：**
```
1. Heover/deepseekRest
   🏷️ [v1.0.0](https://github.com/Heover/deepseekRest/releases/tag/v1.0.0)
   🕐 2026-05-20 10:00:00

📊 🧪 测试模式 — star 仓库最新 Release | Heover | 监控 42 个仓库 | 2026-06-17 12:00:00
```

## 项目结构

```
.
├── .github/workflows/daily_release_check.yml  # GitHub Action 工作流
├── scripts/check_releases.mjs                  # 核心脚本（Node.js）
├── package.json                                # Node.js 依赖配置
└── README.md                                   # 本文件
```
