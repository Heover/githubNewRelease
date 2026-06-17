# GitHub Star 仓库 Release 监控 + 手机通知

通过 GitHub Action 每日自动检查指定用户 star 的仓库，**只通知上次检查后新增的 Release**，通过 **Server 酱3** 推送到手机 App。

> 首次运行回退至 48 小时内；后续只通知增量。基于 Node.js 原生 fetch，**零外部依赖**。

## 功能

- 🕘 每日 00:07（北京时间）自动扫描
- ⭐ 检查指定 GitHub 用户所有 star 仓库
- 🚀 发现 48 小时内的新 Release 并汇总通知
- 📱 通过 Server 酱3 推送到手机 App
- 🔄 支持手动触发

## 快速开始

### 1. 获取必要凭证

| 凭证 | 说明 | 获取方式 |
|------|------|----------|
| `MONITOR_USER` | 要监控的 GitHub **个人**用户名 | Variables 标签页配置 |
| `SERVER_UID` | Server 酱3 用户 UID | [Server 酱3](https://sc3.ft07.com/sendkey) 登录后在 SendKey 页面获取 |
| `SERVER_KEY` | Server 酱3 SendKey | [Server 酱3](https://sc3.ft07.com/sendkey) 登录后在 SendKey 页面获取 |

> 💡 `GITHUB_TOKEN` 自动使用内置 `secrets.GITHUB_TOKEN`，无需手动配置。`MONITOR_USER` 使用 Variables 而非 Secrets（避免 `GITHUB_` 保留前缀）。

### 2. 配置 GitHub Secrets 和 Variables

在仓库 **Settings → Secrets and variables → Actions** 中：

**Variables** 标签页添加：

```
MONITOR_USER        = 你的个人GitHub用户名
```

**Secrets** 标签页添加：

```
SERVER_UID          = 你的uid
SERVER_KEY          = 你的sendkey
```

### 3. 推送代码到 GitHub

```bash
git init
git add .
git commit -m "feat: GitHub Star Release 监控"
git remote add origin git@github.com:你的用户名/仓库名.git
git push -u origin main
```

### 4. 手动测试

在 GitHub 仓库的 **Actions** 标签页 → 选择 `GitHub Release 每日监控` → **Run workflow** 手动触发。

## 通知示例

**有新 Release 时：**
```
1. torvalds/linux
   🏷️ v6.12 — Linux Kernel 6.12
   🔗 https://github.com/torvalds/linux/releases/tag/v6.12
   🕐 2026-06-17 02:30:00

2. facebook/react
   🏷️ v19.2.0 — React 19.2.0
   🔗 https://github.com/facebook/react/releases/tag/v19.2.0
   🕐 2026-06-16 20:15:00

📊 上次检查后新增 2 个 Release | example-user | 监控 42 个仓库 | 2026-06-17 00:07:00
```

**无新 Release 时：**
```
📭 用户 example-user star 的 42 个仓库无新增 Release
⏰ 2026-06-17 00:07:00
```

## 工作原理

每次运行后会将当前时间写入 `last_check.txt` 并提交到仓库。下次运行时只检查该时间之后发布的 Release，**不会重复通知**。首次运行无记录时回退至 48 小时内。

## 项目结构

```
.
├── .github/workflows/daily_release_check.yml  # GitHub Action 工作流
├── scripts/check_releases.mjs                  # 核心脚本（Node.js）
├── package.json                                # Node.js 项目配置
├── last_check.txt                              # 上次检查时间（自动维护）
└── README.md                                   # 本文件
```

## 项目结构

```
.
├── .github/workflows/daily_release_check.yml  # GitHub Action 工作流
├── scripts/check_releases.py                  # 核心脚本
├── requirements.txt                           # Python 依赖
└── README.md                                  # 本文件
```
