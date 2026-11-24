# 峰浠改动与接合说明

本公开源码从本机既有适配工程提取，沿用上游 v1.1.27，保留原许可。当前发行名称为 Fengxi Taskboard，仓库名称为 fengxi-taskboard。

## 既有适配

`server/fengxi-adapter.mjs`、`fengxi-codex.mjs`、`fengxi-work-order.mjs` 等实现受控认领、执行、审核、返工和历史保留。前端 `FengxiExecutionPanel.tsx` 展示执行阶段。客户端注入层增加独立入口的对话识别和窗口恢复处理。相关 `fengxi-*` 测试保留。

## 公开发行的调整

界面和产品元数据使用 Fengxi Taskboard。默认运行资料写入用户目录 `.fengxi-taskboard`，Python 通过 `FENGXI_PYTHON` 或系统命令提供。Windows 启动和 CLI 脚本使用当前目录及 PATH 中的 Node。`build` 脚本只构建网页。Cloudflare 配置中的数据库 ID 使用占位值。

自动执行依赖外部队列和项目网关，协议见 `server/fengxi-queue.mjs`。调用方按运行配置提供 `queueClientPath`、`projectsClientPath` 等路径。默认关闭 `liveSubmitEnabled`，配置示例为 `docs/fengxi.config.example.json`。启用后先在自己的测试目录验收完整流程。

上游原生打包源码仍在 `src-tauri`，发行元数据及更新地址指向本仓库。上游的签名公钥仅为继承的构建配置，创建自己的原生版本前必须替换并核验。本次没有发布原生安装器。

用户真实任务、账号凭据、工作库、主机数据库、内部工单及本机 Git 历史均不属于本源码发行。首版使用独立提交，来源与许可在 NOTICE 保留。
