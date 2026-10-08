# 10 分钟运行说明（本地离线）

前提：已安装 Node.js 24 或更高，终端支持 npm。不需要账号、密钥、模型、联网 npm 安装、Docker 或数据库服务。源码包不内含 Node。

## 0–2 分钟：校验并解压

从 [v0.9.0-alpha.1 Release](https://github.com/Sealdot/ai-hot/releases/tag/v0.9.0-alpha.1) 下载源码包、SHA256SUMS 和其列出的配套资产，放入新目录，先检查：

```bash
shasum -a 256 -c SHA256SUMS
tar -xzf ai-hot-v0.9.0-alpha.1-source.tar.gz
cd ai-hot-v0.9.0-alpha.1
node --version
```

只在解压后的候选中运行。不要进入原 app-ai-news 工作区运行任何启动或恢复命令。

## 2–4 分钟：执行完整验收

```bash
npm run verify:offline
```

命令用白名单复制候选源码到 `.alpha-runs/run-*/app`，全新 data 中运行真实服务和恢复脚本；保留调度开启，固定应用时间为 **2026-10-08 08:06 上海时间**。仅自制本地 Feed，清除继承的 API 密钥、模型和数据库路径，阻断非测试端口网络。约十秒内应出现 `Offline Alpha PASSED`；机器负载较高可能更慢。

结果在输出指出的 `.alpha-runs/run-*/result.json`；该目录也含单元测试、恢复、完整性检查记录。测试失败时查看对应 `failure.txt`。每次运行新目录，不复用先前数据库。

## 4–8 分钟：在网页中检查

```bash
npm run demo:offline
```

验收通过后自动保持一次演示服务，输出 `Demo ready: http://127.0.0.1:<临时端口>`。打开该地址；网页使用虚构的 Atlas、Beacon、Cedar 数据。

- 今日简报会显示规则精选；“全部文章”可查看三条虚构文章。
- 打开 Atlas 事件，检查原文摘录、来源，切换“看完 / 稍后读”，查看阅读台和回顾。
- 监控器里会有 Atlas Alpha，测试过包含、排除与优先级；可在页面继续试用。
- 同端口 `/api/health`、`/api/public/briefs?scope=all`、`/feeds/briefs.xml` 可直接查看。演示应用时间固定，不代表今天真实新闻。
- 验收已通过备份 → 修改笔记/删除监控器 → 停服务 → CLI 恢复 → 重启对比。演示不是持久服务。

## 8–10 分钟：停止及可选手工恢复

按 **Ctrl+C** 关闭演示服务和 Feed。所有测试数据留在该次 `.alpha-runs/run-*/app/data`，不影响候选根目录的干净 data 或原工作区。

如需手工复核，先确保该次演示已经关闭，然后进入输出所指向的 **该次 app 目录**，任选那里已有的备份文件名：

```bash
cd .alpha-runs/run-实际编号/app
npm run backup
npm run restore -- data/backups/ai-news-实际文件名.sqlite
```

手工 backup / restore 仍只操作这份候选副本。**必须先停服务**；该脚本不会检测其他进程是否打开同一库。普通启动使用当前时间会使固定时间样例逐渐过期；重新运行 `demo:offline` 会用新目录复现完整场景。

不执行 `service:install`，不启动原工作区，不配置真实密钥。若临时端口竞争导致失败，重跑会重新分配端口。读完后可删除 `.alpha-runs`，里面只有本轮自制数据；不要删除原工作区 data。

MIT 许可与来源说明见 [PROVENANCE.md](PROVENANCE.md)，边界见 [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)。
