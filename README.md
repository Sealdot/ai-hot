# AI HOT v0.9.0-alpha.1 · 本地离线 Alpha

基于现有 v0.9 的本地单用户 AI 情报台。本轮冻结产品功能，纳入 briefs、concurrency、health、opml、source-catalog，完成无密钥、无模型、自制本地 Feed 的工程闭环。

**MIT 开源 Alpha · [Sealdot/ai-hot](https://github.com/Sealdot/ai-hot)**

Copyright (c) 2026 Sealdot <sealdot404@gmail.com>。

需要预先安装 Node.js 24+，无第三方 npm 依赖，无需 npm install：

```bash
npm run verify:offline
npm run demo:offline
```

第一条在全新候选副本中测试首次启动、简报、阅读与稍后状态、监控器、重启、Web/API/RSS、备份与恢复，然后停止。第二条验收后保持一次离线演示；打开输出中的本地地址，按 Ctrl+C 停止。

每次使用 `.alpha-runs/run-*/app`，仅白名单源码和干净信源配置进入副本。应用时间固定为 2026-10-08 08:06（上海）；环境凭证清空，网络只允许指定本地测试端口。原工作区和真实运行数据不参与。

完整内置信源目录保留，候选初始 **138 个信源全部停用**。普通 `npm start` 仍是原有产品入口，使用当前时间和可选环境配置；要保证本轮离线边界，请使用上面的验收与演示命令。

- [10 分钟运行说明](docs/release/RUN-IN-10-MINUTES.md)
- [验收记录](docs/release/ACCEPTANCE.md)
- [已知限制](docs/release/KNOWN-LIMITATIONS.md)
- [源码及样例来源](docs/release/PROVENANCE.md)
- [MIT 许可证](LICENSE)

提供 `/api/public/briefs`、`/api/reader/brief-state`、`/api/local/monitors`、`/api/health`、`/feeds/briefs.xml` 及保留的文章/日报/RSS API。接口定义见 [openapi.yaml](openapi.yaml)，Agent 查询约定见 [agent/SKILL.md](agent/SKILL.md)。无模型简报明确标记为原文摘录并保留来源 ID。

备份是 SQLite 快照，恢复须先停服务；sources.json 和管理员令牌不在 SQLite 备份中。恢复现在先验证文件和 AI HOT 核心表，再保留安全副本并原子替换。运行数据仅在本机生成，不进入源码包。

真实采集表现、模型质量和用户价值保持未验证。固定发布提交、CI 记录、源码包及校验和见 [v0.9.0-alpha.1 Release](https://github.com/Sealdot/ai-hot/releases/tag/v0.9.0-alpha.1)。不发布 npm 包；离线演示无需安装持久服务。
