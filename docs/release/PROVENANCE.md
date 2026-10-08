# 源码与样例来源 · 2026-10-08

AI HOT Alpha 基于固定的独立干净 v0.9 候选，仅更新正式许可证和发布文案，冻结产品功能。维护者已确认完整源码及保留样例为有权公开的成果，并授权 MIT 及本次公开 Alpha。

| 内容 | 可核对证据 | 候选处理 |
| --- | --- | --- |
| server/lib/public/scripts/API/Agent/文档 | 原仓库 22 个跟踪文件与本地修改；原仓库无 LICENSE、无 AGENTS.md，祖先目录亦未找到 AGENTS.md | 白名单复制；范围内修改见验收记录 |
| briefs / concurrency / health / opml / source-catalog | 原工作区五个未跟踪 `.mjs` 文件，已进入私有源码快照 | 五个全部纳入候选，内容保持原样 |
| 外部依赖 | package.json 无 dependencies / devDependencies；所有模块使用 Node 内建 API 或本项目相对导入 | 无 npm install、无远程脚本、无内嵌第三方库；Node 本身由使用者预先安装 |
| 浏览器资产 | public 仅 HTML/CSS/JS，无 CDN、远程字体、图片、图标包 | 本地提供；引用原文的链接不是转载授权 |
| 信源目录 | source-catalog 中人工列出的名称、URL、作者与配置元数据 | 根据完整内置目录生成干净 sources.json，138 个全部停用；不带本地新增信源或健康数据 |
| 原 editorial-overrides.json | 包含真实文章 URL、中文编辑摘要和分析，无单独许可凭证 | 候选置为空对象，不分发原文摘要和编辑批注 |
| 原单元样例 | 源码内短小示例、example 域名、模拟 Responses 数据；无下载文章文件 | 保留已有测试；维护者已确认完整源码和保留样例的公开权利 |
| 本轮离线 Feed | tests/fixtures/local-feed.mjs 中 Atlas / Beacon / Cedar 三条自制虚构文本；固定时间 | 不含真实采集内容；不代表真实事件或模型输出 |
| 本轮验收、修复与文档 | 本轮在独立候选目录创建 | 无外部代码复制；MIT 采用 SPDX 标准文本 |
| CI 引用 | actions/checkout@v4、actions/setup-node@v4 | 仅工作流引用，不打包 Actions 实现；CI 运行器下载阶段不属于本轮离线验收 |

源码文件 SHA-256、最终发布提交和 CI 结果随 Release 资产提供。原工作区、私有 Git 历史和恢复资料保留在维护者本机，不进入本公开仓库或源码包。

正式许可证见 [LICENSE](../../LICENSE)，标准文本来源为 [SPDX MIT](https://spdx.org/licenses/MIT.html)。版权行为 `Copyright (c) 2026 Sealdot <sealdot404@gmail.com>`；package.json 的 license 为 MIT，private=true 仅阻止 npm 发布，不影响 GitHub 公开。

许可覆盖本项目源码与获授权样例，不重新授权外部信源文章；信源名称、链接和配置不代表第三方内容可转载。真实采集表现、模型质量与用户价值仍未验证。
