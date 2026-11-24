# Fengxi Taskboard · 峰浠项目看板

本地优先的项目与任务看板，支持浏览器操作、`taskctl` 命令行和受控的 Codex 执行接合。由峰浠基于 [chuspeeism/dashi-taskboard v1.1.27](https://github.com/chuspeeism/dashi-taskboard/tree/v1.1.27) 二次开发，按 Apache-2.0 开源。原作者贡献与许可见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。

## 下载与启动

先安装 [Node.js 24 LTS](https://nodejs.org/)，再下载 [源码 ZIP](https://github.com/ZhangMao318009/fengxi-taskboard/archive/refs/heads/main.zip) 并解压。

在解压后的目录打开终端，运行以下命令。

```sh
npm ci
npm run build:web
npm start
```

浏览器打开 <http://127.0.0.1:47823>。Windows 用户也可在 PowerShell 中运行 `./Start-Taskboard.ps1 -Open`，脚本会检查依赖、构建网页并启动。该终端关闭后服务停止。

默认只监听本机。数据保存在当前用户的 `.fengxi-taskboard` 目录，源码更新时保留这个目录。自定义路径可以设置 `CODEX_TASKBOARD_DATA_DIR`。多实例可设置 `CODEX_TASKBOARD_PORT` 使用不同端口和数据目录。

## 峰浠的改动

- 提供任务阶段、执行状态和执行证据展示，保留返工与失败记录。
- 用版本校验及任务身份约束认领、交接和审核，区分技术审核与人工验收。
- 提供受控执行适配层、资料收件与备份恢复能力。
- 适配独立 Codex 入口的看板显示，避免错误打开另一入口的对话。
- 统一 Fengxi 品牌，使用用户级数据目录、可配置 Python 和通用启动脚本。

详细范围见 [峰浠改动与接合说明](docs/FENGXI-CHANGES.md)。

## 使用边界

项目看板可独立启动。自动派发、资源锁及外部项目执行需要另行实现或配置与 `server/fengxi-queue.mjs` 兼容的队列和项目网关。默认关闭真实提交，公开版没有附带作者的内部调度服务。

Codex 内嵌入口取决于客户端版本和 CDP 能力。先验证浏览器看板，再按原生接合源码自行配置。公开版的 Windows 一键启动使用浏览器入口。

本次提供源码。Windows/macOS 原生安装包、签名与自动更新尚未按 Fengxi 品牌验收。原生构建前须配置自己的签名及更新密钥。云端和 Jira 源码保留作开发参考，当前本地适配会拒绝相应入口。

## CLI 和开发

```sh
npm run taskctl -- --help
npm run typecheck
npm run build:web
```

兼容已有的 `CODEX_TASKBOARD_*` 环境变量和 `taskctl` 命令名。`npm run build` 只构建网页，客户端注入通过单独命令显式执行。

问题反馈请到本仓库 Issues。提交日志前删除 Token、Cookie、账号信息和任务正文。
