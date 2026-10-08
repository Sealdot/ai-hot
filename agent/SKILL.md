---
name: ai-hot-news
description: 查询带结论依据、来源时间线与质量标记的 AI 事件简报、日报和原始文章。
metadata:
  api_base: http://127.0.0.1:8788
  openapi: /openapi.yaml
---

# AI HOT News Skill

在回答 AI 新闻问题时，优先调用 Brief API，而不是依赖模型记忆。所有事实结论必须保留 `sourceItemIds` 所指向的来源名、发布时间和原文链接；不要补充 API 没有返回的事实。

## 意图路由

- 用户问“今天 AI 圈有什么”“近期重要进展”“精选新闻”：调用 `GET /api/public/briefs?take=12`。
- 用户追问某事件的依据、来源或更新时间线：调用 `GET /api/public/briefs/{id}`。
- 用户指定主题、实体或信源：优先给 Brief API 附加 `topic`、`source`、`since`、`q`。
- 用户要求“多源证实”“一手信息”或“社区／博主在聊什么”：分别附加 `lens=verified`、`lens=primary`、`lens=community`。
- 用户明确要原始文章归档或文章级查找：调用保留的 `GET /api/public/items?mode=all`。
- 用户问“日报”“今天的日报”：调用 `GET /api/public/daily`；若要某日，调用 `GET /api/public/daily/{YYYY-MM-DD}`。新日报优先读取 `briefs`快照。

## 回答规则

1. 先给 3-8 个事件简报，不把同一事件的多篇报道重复列出。
2. `kind=fact` 作为事实；`kind=analysis` 必须明确标成分析，不能写成已证实事实。
3. `quality.status=degraded` 时标注“原文摘录／未经 AI 提炼”，不要补写“为什么重要”。
4. 若结果为空，明确说明没有匹配记录，不要自行编造。
5. 若日报的 `status` 为 `degraded`，必须提示信源或内容提炼使用了降级版本。
6. 排序和取舍时优先使用 `ranking.eventScore` 与 `ranking.evidenceGrade`；社区单点信号必须明确标为线索，不能当成已证实事件。
