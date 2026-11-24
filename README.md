# Fengxi Taskboard · 峰浠项目看板

在浏览器管理自己的项目和任务。

## 下载与启动

安装 [Node.js 24 LTS](https://nodejs.org/)，[下载源码 ZIP](https://github.com/ZhangMao318009/fengxi-taskboard/archive/refs/heads/main.zip) 并解压。

在解压目录运行：

```sh
npm ci --ignore-scripts
npm run build:web
npm start
```

启动后访问 <http://127.0.0.1:47823>。Windows 也可以运行 `.\Start-Taskboard.ps1`。保持启动终端开启。

任务保存在当前用户的 `.fengxi-taskboard` 目录。升级前请保留该目录。自动派发需另行配置，见[进阶说明](docs/FENGXI-CHANGES.md)。

[许可](LICENSE) · [署名](NOTICE)
