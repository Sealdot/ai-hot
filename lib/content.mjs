import { randomUUID } from 'node:crypto';
import { createSqliteStore } from './store.mjs';

export const CATEGORY_LABELS = {
  'ai-models': '模型',
  'ai-products': '产品',
  industry: '行业',
  paper: '论文',
  tip: '技巧'
};

export const SOURCE_KIND_LABELS = {
  'first-party': '一手信源',
  news: '资讯',
  social: '社区动态'
};

export const SOURCE_CHANNEL_LABELS = {
  official: '官方发布',
  research: '研究机构',
  release: '版本发布',
  media: '专业媒体',
  blog: '专家博客',
  newsletter: '行业通讯',
  papers: '论文动态',
  community: '社区讨论',
  social: 'X 动态'
};

export const CONTENT_TYPE_LABELS = {
  'model-release': '模型发布',
  'product-launch': '产品发布',
  research: '研究进展',
  benchmark: '评测基准',
  funding: '融资并购',
  policy: '政策治理',
  safety: '安全治理',
  'open-source': '开源动态',
  engineering: '工程实践',
  opinion: '观点分析',
  community: '社区信号'
};

export const ENRICHMENT_MAX_AGE_HOURS = 72;
export const ENRICHMENT_MIN_RULE_SCORE = 65;

export class FeedFetchError extends Error {
  constructor(message, { kind = 'network', httpStatus = null, retryAfterAt = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FeedFetchError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.retryAfterAt = retryAfterAt;
  }
}

function retryAfterIso(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(now + Math.max(0, seconds) * 1_000).toISOString();
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function classifyFeedError(error) {
  if (error instanceof FeedFetchError) {
    return { kind: error.kind, httpStatus: error.httpStatus, retryAfterAt: error.retryAfterAt, message: error.message };
  }
  const code = error?.cause?.code || error?.code || '';
  const message = String(error?.message || error || 'Unknown feed error');
  if (/credential|token|authentication|required environment/i.test(message)) return { kind: 'credentials_missing', httpStatus: null, retryAfterAt: null, message };
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|timed out/i.test(message)) return { kind: 'timeout', httpStatus: null, retryAfterAt: null, message };
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(`${code} ${message}`)) return { kind: 'dns', httpStatus: null, retryAfterAt: null, message };
  if (/CERT|TLS|SSL|certificate/i.test(`${code} ${message}`)) return { kind: 'tls', httpStatus: null, retryAfterAt: null, message };
  if (/parse|xml|feed/i.test(message)) return { kind: 'feed_parse', httpStatus: null, retryAfterAt: null, message };
  return { kind: 'network', httpStatus: null, retryAfterAt: null, message };
}

export async function createStore(options = {}) { return createSqliteStore(options); }

export function canonicalizeUrl(input) {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['ref', 'source', 'spm'].includes(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return input;
  }
}

export function cleanText(input = '') {
  return input
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function textIn(xml, tags) {
  for (const tag of tags) {
    const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (match) return cleanText(match[1]);
  }
  return '';
}

function linkIn(xml) {
  const atom = xml.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (atom) return atom[1];
  return textIn(xml, ['link', 'guid']);
}

export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]);
  return blocks.map((block) => ({
    title: textIn(block, ['title']),
    url: linkIn(block),
    content: textIn(block, ['description', 'summary', 'content']),
    publishedAt: textIn(block, ['pubDate', 'published', 'updated', 'date']),
    sourceRef: textIn(block, ['guid', 'id'])
  })).filter((entry) => entry.title && entry.url);
}

function categoryFor(text) {
  const value = text.toLowerCase();
  if (/(paper|arxiv|论文|benchmark|评测)/.test(value)) return 'paper';
  if (/(prompt|教程|技巧|how to|最佳实践|guide)/.test(value)) return 'tip';
  if (/(model|模型|reasoning|推理|llm|gpt)/.test(value)) return 'ai-models';
  if (/(product|产品|app|agent|工具|platform|平台)/.test(value)) return 'ai-products';
  return 'industry';
}

export function contentTypeFor(text, source = {}) {
  const value = cleanText(text).toLowerCase();
  if (source.channel === 'community' || source.channel === 'social') return 'community';
  if (source.channel === 'papers' || /\b(paper|research|study|arxiv|论文|研究)\b/.test(value)) return 'research';
  if (/benchmark|leaderboard|eval(?:uation)?|评测|基准/.test(value)) return 'benchmark';
  if (/funding|fundraise|acqui(?:re|sition)|merger|融资|收购|并购/.test(value)) return 'funding';
  if (/regulat|policy|governance|law|政策|监管|法案/.test(value)) return 'policy';
  if (/safety|security|alignment|risk|安全|对齐|风险/.test(value)) return 'safety';
  if (source.channel === 'release' || /\b(model|llm|vlm)\b.*\b(release|launch|introduc)|模型.*(发布|推出)/.test(value)) return 'model-release';
  if (/open.?source|github|开源/.test(value) || source.topics?.includes('open-source')) return 'open-source';
  if (/launch|introduc|announce|available|产品|上线|推出/.test(value)) return 'product-launch';
  if (/tutorial|guide|how to|engineering|实践|教程/.test(value)) return 'engineering';
  return source.channel === 'blog' || source.channel === 'newsletter' ? 'opinion' : 'product-launch';
}

export function ruleScore(item, { now = Date.now() } = {}) {
  const sourceScore = {
    official: 38,
    research: 38,
    release: 34,
    papers: 32,
    media: 27,
    blog: 26,
    newsletter: 25,
    community: 13,
    social: 12
  }[item.sourceChannel] ?? { 'first-party': 34, news: 25, social: 12 }[item.sourceKind] ?? 18;
  const tierBonus = { 1: 4, 2: 1, 3: -3 }[Number(item.sourceTier)] ?? 0;
  const categoryScore = { 'ai-models': 26, 'ai-products': 23, industry: 18, paper: 14, tip: 10 }[item.category] ?? 10;
  const freshnessHours = Math.max(0, (now - new Date(item.publishedAt).valueOf()) / 3_600_000);
  const freshnessScore = Math.max(0, 28 - freshnessHours / 5);
  return Math.max(1, Math.min(99, Math.round(sourceScore + tierBonus + categoryScore + freshnessScore)));
}

function titleTokens(text) {
  return new Set(cleanText(text).toLowerCase().split(/[\s,，。:：;；\/]+/).filter((token) => token.length > 1));
}

function similarTitle(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

export async function normalizeItem(raw, source) {
  const publishedAt = Number.isNaN(new Date(raw.publishedAt).valueOf()) ? new Date().toISOString() : new Date(raw.publishedAt).toISOString();
  const category = categoryFor(`${raw.title} ${raw.content ?? ''}`);
  const contentType = contentTypeFor(`${raw.title} ${raw.content ?? ''}`, source);
  const draft = {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    sourceChannel: source.channel ?? (source.kind === 'first-party' ? 'official' : source.kind === 'social' ? 'social' : 'media'),
    sourceTier: Number(source.tier) || 3,
    sourceTopics: source.topics ?? [],
    author: source.author ?? '',
    title: cleanText(raw.title).slice(0, 280),
    url: raw.url,
    canonicalUrl: canonicalizeUrl(raw.url),
    publishedAt,
    fetchedAt: new Date().toISOString(),
    category,
    contentType,
    tags: [...new Set([CATEGORY_LABELS[category], CONTENT_TYPE_LABELS[contentType], ...(source.topics ?? [])])].slice(0, 10),
    summary: cleanText(raw.content || raw.title).slice(0, 360),
    whyItMatters: '',
    importance: 0,
    selected: false,
    status: 'published',
    contentText: cleanText(raw.content || ''),
    contentOrigin: 'feed',
    aiEligible: source.aiEligible !== false,
    enrichment: { status: 'pending', provider: null, model: null, promptVersion: null, confidence: null, requiresReview: false, attempts: 0, updatedAt: null },
    review: { status: 'unreviewed', reviewedAt: null },
    updatedAt: new Date().toISOString()
  };
  draft.importance = ruleScore(draft);
  draft.selected = draft.importance >= 70;
  return draft;
}

export function configuredEnricher(env = process.env) {
  if (env.OPENAI_API_KEY) return { type: 'openai-responses', label: env.OPENAI_MODEL || 'gpt-5.6-terra', model: env.OPENAI_MODEL || 'gpt-5.6-terra', apiKey: env.OPENAI_API_KEY, baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') };
  if (env.LLM_ENRICHER_URL) return { type: 'webhook', label: 'webhook', url: env.LLM_ENRICHER_URL, token: env.LLM_ENRICHER_TOKEN };
  if (env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL) return { type: 'openai-compatible', label: env.LLM_MODEL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL.replace(/\/$/, '') };
  return null;
}

function parseJsonContent(content) {
  if (typeof content !== 'string') return null;
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(normalized); } catch { return null; }
}

export function extractArticleText(html = '') {
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const findBody = (value) => {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.articleBody === 'string') return value.articleBody;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findBody(child);
      if (found) return found;
    }
    return '';
  };
  for (const match of jsonLdBlocks) {
    try {
      const found = cleanText(findBody(JSON.parse(match[1])));
      if (found.length >= 120) return found.slice(0, 12_000);
    } catch { /* Ignore malformed publisher metadata. */ }
  }
  for (const tag of ['article', 'main']) {
    const match = html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (match) {
      const found = cleanText(match[1].replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
      if (found.length >= 120) return found.slice(0, 12_000);
    }
  }
  return '';
}

function responseText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  for (const output of body.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === 'refusal') throw new Error(`OpenAI refused enrichment: ${content.refusal || 'unspecified refusal'}`);
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

const editorialSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    whyItMatters: { type: 'string' },
    category: { type: 'string', enum: ['ai-models', 'ai-products', 'industry', 'paper', 'tip'] },
    tags: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
    importance: { type: 'integer', minimum: 1, maximum: 99 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    requiresReview: { type: 'boolean' }
  },
  required: ['summary', 'whyItMatters', 'category', 'tags', 'importance', 'confidence', 'requiresReview']
};

function validateEditorialPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Enricher returned an empty payload');
  if (typeof payload.summary !== 'string' || typeof payload.whyItMatters !== 'string') throw new Error('Enricher returned invalid text fields');
  if (!CATEGORY_LABELS[payload.category]) throw new Error('Enricher returned an invalid category');
  if (!Array.isArray(payload.tags) || payload.tags.length < 2) throw new Error('Enricher returned invalid tags');
  if (!Number.isFinite(payload.importance) || !Number.isFinite(payload.confidence) || typeof payload.requiresReview !== 'boolean') throw new Error('Enricher returned invalid scores');
  return payload;
}

async function requestEnrichment(raw, { provider, fetchImpl = fetch } = {}) {
  if (!provider) return { provider: null, payload: null, usage: {} };
  if (provider.type === 'webhook') {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(provider.token ? { authorization: `Bearer ${provider.token}` } : {}) },
      body: JSON.stringify({ task: 'news_enrichment', language: 'zh-CN', item: raw })
    });
    if (!response.ok) throw new Error(`LLM webhook returned HTTP ${response.status}`);
    return { provider, payload: validateEditorialPayload(await response.json()), usage: {} };
  }
  if (provider.type === 'openai-responses') {
    const response = await fetchImpl(`${provider.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(Number(process.env.OPENAI_TIMEOUT_MS) || 45_000, 120_000))),
      body: JSON.stringify({
        model: provider.model,
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 800,
        input: [
          { role: 'system', content: '你是严谨的 AI 新闻编辑。只依据输入材料，用简体中文提炼事实；不确定时降低 confidence 并要求人工复核。摘要不超过120字，“值得关注”不超过70字。营销稿、信息不足、仅有标题或存在夸大风险时 requiresReview=true。' },
          { role: 'user', content: JSON.stringify(raw) }
        ],
        text: { format: { type: 'json_schema', name: 'ai_news_editorial', strict: true, schema: editorialSchema } }
      })
    });
    if (!response.ok) {
      const details = cleanText(await response.text()).slice(0, 240);
      throw new Error(`OpenAI Responses returned HTTP ${response.status}${details ? `: ${details}` : ''}`);
    }
    const body = await response.json();
    const payload = validateEditorialPayload(parseJsonContent(responseText(body)));
    return {
      provider: { ...provider, label: body.model || provider.label },
      payload,
      responseId: body.id,
      usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 }
    };
  }
  const endpoint = provider.baseUrl.endsWith('/chat/completions') ? provider.baseUrl : `${provider.baseUrl}/chat/completions`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: '你是严谨的 AI 新闻编辑。只依据输入内容，用简体中文输出 JSON，不要 Markdown。字段：summary、whyItMatters、category、tags、importance、confidence、requiresReview。不确定时保守表述并要求人工复核。' },
        { role: 'user', content: JSON.stringify(raw) }
      ]
    })
  });
  if (!response.ok) throw new Error(`LLM provider returned HTTP ${response.status}`);
  const body = await response.json();
  const payload = validateEditorialPayload(parseJsonContent(body.choices?.[0]?.message?.content));
  return { provider, payload, responseId: body.id, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 } };
}

function applyEnrichment(item, payload, provider, metadata = {}) {
  const category = CATEGORY_LABELS[payload.category] ? payload.category : item.category;
  const summary = typeof payload.summary === 'string' ? cleanText(payload.summary).slice(0, 360) : item.summary;
  const whyItMatters = typeof payload.whyItMatters === 'string' ? cleanText(payload.whyItMatters).slice(0, 220) : item.whyItMatters;
  const tags = Array.isArray(payload.tags) ? payload.tags.map((tag) => cleanText(String(tag)).slice(0, 30)).filter(Boolean).slice(0, 5) : item.tags;
  const importance = Number.isFinite(payload.importance) ? Math.max(1, Math.min(99, Math.round(payload.importance))) : item.importance;
  return {
    ...item,
    category,
    summary,
    whyItMatters,
    tags: tags.length ? tags : item.tags,
    importance,
    selected: importance >= 70 && payload.confidence >= 0.75 && !payload.requiresReview,
    updatedAt: new Date().toISOString(),
    enrichment: {
      ...item.enrichment,
      status: 'completed', provider: provider.label, model: provider.model ?? provider.label,
      promptVersion: 'editorial-v2', confidence: Math.max(0, Math.min(1, payload.confidence)),
      requiresReview: payload.requiresReview, responseId: metadata.responseId ?? null,
      inputTokens: metadata.usage?.inputTokens ?? 0, outputTokens: metadata.usage?.outputTokens ?? 0,
      updatedAt: new Date().toISOString(), error: null
    }
  };
}

async function fetchArticleForItem(item, source, fetchImpl) {
  if ((item.contentText ?? item.summary ?? '').length >= 240) return item;
  const allowed = source?.allowArticleFetch ?? !source?.id?.endsWith('-releases');
  if (!allowed || !/^https?:/.test(item.url)) return item;
  try {
    const response = await fetchImpl(item.url, { headers: { 'user-agent': 'AI-Hot-MVP/0.3 (+http://127.0.0.1)' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return item;
    const extracted = extractArticleText(await response.text());
    if (extracted.length < 120) return item;
    return { ...item, contentText: extracted, contentOrigin: 'article', updatedAt: new Date().toISOString() };
  } catch { return item; }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withRetries(action, attempts = 3, baseDelayMs = 500) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await action(); }
    catch (current) {
      error = current;
      if (attempt < attempts && baseDelayMs > 0) await wait(Math.min(4_000, baseDelayMs * (2 ** (attempt - 1))));
    }
  }
  throw error;
}

async function mapConcurrent(values, concurrency, worker) {
  let cursor = 0;
  const results = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

export async function enrichItems(store, { take = 30, force = false, itemId = null, retryDelayMs = 500, provider = configuredEnricher(), fetchImpl = fetch } = {}) {
  const now = Date.now();
  const staleCutoff = now - 7 * 24 * 3_600_000;
  const stale = store.items.filter((item) => item.enrichment?.status === 'pending' && new Date(item.publishedAt).valueOf() < staleCutoff);
  for (const item of stale) {
    const next = { ...item, enrichment: { ...item.enrichment, status: 'skipped_stale', updatedAt: new Date().toISOString(), error: null }, updatedAt: new Date().toISOString() };
    const index = store.items.findIndex((current) => current.id === item.id);
    if (index >= 0) store.items[index] = next;
    await store.saveItem?.(next);
  }
  if (!provider) return { configured: false, message: '未配置模型；将使用明确标注的原文摘录。', processed: 0, enriched: 0, failed: 0, review: 0, skippedStale: stale.length, inputTokens: 0, outputTokens: 0 };
  const cutoff = now - ENRICHMENT_MAX_AGE_HOURS * 3_600_000;
  const candidates = store.items
    .filter((item) => !itemId || item.id === itemId)
    .filter((item) => item.aiEligible !== false)
    .filter((item) => item.review?.status !== 'approved' && item.review?.status !== 'rejected')
    .filter((item) => !isRoutineVersion(item))
    .filter((item) => ruleScore(item, { now }) >= ENRICHMENT_MIN_RULE_SCORE)
    .filter((item) => force || new Date(item.publishedAt).valueOf() >= cutoff)
    .filter((item) => force || !['completed', 'processing'].includes(item.enrichment?.status))
    .filter((item) => force || (item.enrichment?.attempts ?? 0) < 3)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, Math.max(1, Math.min(Number(take) || 30, 30)));
  const job = store.startJob?.('enrichment', force ? 'manual-force' : 'automatic', { provider: provider.label, itemId, candidateIds: candidates.map((item) => item.id) });
  const results = await mapConcurrent(candidates, 2, async (item) => {
    const attempts = (item.enrichment?.attempts ?? 0) + 1;
    let working = { ...item, enrichment: { ...item.enrichment, status: 'processing', provider: provider.label, model: provider.model ?? provider.label, attempts, updatedAt: new Date().toISOString(), error: null } };
    const index = store.items.findIndex((current) => current.id === item.id);
    if (index >= 0) store.items[index] = working;
    await store.saveItem?.(working);
    try {
      working = await fetchArticleForItem(working, store.sources.find((source) => source.id === item.sourceId), fetchImpl);
      const result = await withRetries(() => requestEnrichment({ title: working.title, sourceName: working.sourceName, sourceKind: working.sourceKind, publishedAt: working.publishedAt, content: (working.contentText || working.summary).slice(0, 12_000), url: working.url }, { provider, fetchImpl }), 3, retryDelayMs);
      const current = store.items.find((candidate) => candidate.id === item.id) ?? working;
      if (current.review?.status === 'approved' || current.review?.status === 'rejected') return { status: 'skipped', usage: result.usage };
      const enrichedItem = applyEnrichment(working, result.payload, result.provider, result);
      const currentIndex = store.items.findIndex((candidate) => candidate.id === item.id);
      if (currentIndex >= 0) store.items[currentIndex] = enrichedItem;
      await store.saveItem?.(enrichedItem);
      return { status: enrichedItem.selected ? 'enriched' : 'review', usage: result.usage };
    } catch (error) {
      const failedItem = { ...working, selected: false, enrichment: { ...working.enrichment, status: 'failed', requiresReview: true, updatedAt: new Date().toISOString(), error: error.message.slice(0, 240) }, updatedAt: new Date().toISOString() };
      const currentIndex = store.items.findIndex((candidate) => candidate.id === item.id);
      if (currentIndex >= 0) store.items[currentIndex] = failedItem;
      await store.saveItem?.(failedItem);
      return { status: 'failed', usage: {} };
    }
  });
  const summary = {
    configured: true,
    provider: provider.label,
    processed: candidates.length,
    enriched: results.filter((result) => result.status === 'enriched').length,
    review: results.filter((result) => result.status === 'review').length,
    failed: results.filter((result) => result.status === 'failed').length,
    inputTokens: results.reduce((sum, result) => sum + (result.usage?.inputTokens ?? 0), 0),
    outputTokens: results.reduce((sum, result) => sum + (result.usage?.outputTokens ?? 0), 0)
  };
  summary.skippedStale = stale.length;
  if (job) store.finishJob(job.id, { status: summary.failed === summary.processed && summary.processed ? 'failed' : 'completed', processed: summary.processed, succeeded: summary.enriched + summary.review, failed: summary.failed, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, details: summary });
  return summary;
}

export async function reviewItem(store, id, changes = {}) {
  const index = store.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('item not found');
  const item = store.items[index];
  if (changes.category && !CATEGORY_LABELS[changes.category]) throw new Error('invalid category');
  const requestedImportance = changes.importance === undefined ? item.importance : Number(changes.importance);
  if (!Number.isFinite(requestedImportance)) throw new Error('invalid importance');
  const importance = Math.max(1, Math.min(99, Math.round(requestedImportance)));
  const selected = changes.selected === undefined ? importance >= 70 : Boolean(changes.selected);
  const status = ['approved', 'rejected', 'unreviewed'].includes(changes.status) ? changes.status : 'approved';
  store.items[index] = {
    ...item,
    ...(changes.category ? { category: changes.category } : {}),
    ...(typeof changes.summary === 'string' ? { summary: cleanText(changes.summary).slice(0, 360) } : {}),
    ...(typeof changes.whyItMatters === 'string' ? { whyItMatters: cleanText(changes.whyItMatters).slice(0, 220) } : {}),
    ...(Array.isArray(changes.tags) ? { tags: changes.tags.map((tag) => cleanText(String(tag)).slice(0, 30)).filter(Boolean).slice(0, 5) } : {}),
    importance,
    selected,
    status: status === 'rejected' ? 'rejected' : 'published',
    updatedAt: new Date().toISOString(),
    review: { status, reviewedAt: new Date().toISOString(), note: typeof changes.note === 'string' ? cleanText(changes.note).slice(0, 280) : undefined }
  };
  if (store.saveItem) await store.saveItem(store.items[index]);
  else await store.saveItems?.();
  return store.items[index];
}

export function isDuplicate(candidate, existing) {
  return existing.canonicalUrl === candidate.canonicalUrl || (
    Math.abs(new Date(existing.publishedAt).valueOf() - new Date(candidate.publishedAt).valueOf()) < 72 * 3_600_000 &&
    similarTitle(existing.title, candidate.title) >= 0.8
  );
}

function isReleaseItem(item) {
  return item.sourceId.endsWith('-releases') || /\breleases?\b/i.test(item.sourceName);
}

export function isRoutineVersion(item) {
  const title = item.title.trim();
  if (/^(?:v?\d+(?:\.\d+){1,3}(?:[-./][\w.-]+)?|sdk\/[\w/-]+\/v?\d|@?[\w-]+\/[\w-]+@v?\d|(?:patch|hotfix|minor)\s+release\b)/i.test(title)) return true;
  // Release feeds commonly prefix a package/product label before a bare
  // version (for example "CLI @scope/pkg@0.4.0" or "Desktop v0.0.16").
  return isReleaseItem(item) && /^(?:.{1,80}[\s@/-])v?\d+(?:\.\d+){1,3}(?:[-.][\w.-]+)?$/i.test(title);
}

function sourcePriority(item) {
  return { 'first-party': 3, news: 2, social: 1 }[item.sourceKind] ?? 1;
}

export function editorialScore(item, { now } = {}) {
  const hasEditorialAssessment = item.enrichment?.status === 'completed' || item.review?.status === 'approved';
  const base = hasEditorialAssessment ? item.importance : ruleScore(item, { now });
  const releasePenalty = isReleaseItem(item) ? (isRoutineVersion(item) ? 35 : 14) : 0;
  return Math.max(1, Math.min(99, Math.round(base - releasePenalty)));
}

export function isEditoriallySelected(item, { now } = {}) {
  if (item.status !== 'published' || item.review?.status === 'rejected' || item.selected === false) return false;
  if (item.review?.status === 'approved') return editorialScore(item, { now }) >= 70;
  if (item.enrichment?.status === 'completed' && (item.enrichment.confidence < 0.75 || item.enrichment.requiresReview)) return false;
  return editorialScore(item, { now }) >= 70;
}

function sameEditorialEvent(left, right) {
  const distance = Math.abs(new Date(left.publishedAt).valueOf() - new Date(right.publishedAt).valueOf());
  return left.canonicalUrl === right.canonicalUrl || (distance < 48 * 3_600_000 && similarTitle(left.title, right.title) >= 0.72);
}

function eventRepresentative(current, candidate, now) {
  const currentScore = editorialScore(current, { now }) * 10 + sourcePriority(current);
  const candidateScore = editorialScore(candidate, { now }) * 10 + sourcePriority(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return new Date(candidate.publishedAt) > new Date(current.publishedAt) ? candidate : current;
}

/**
 * Groups reports about the same editorial event. The public reading API also
 * uses this with `selectedOnly: false` to disclose corroborating sources; it
 * does not turn the group into an unqualified truth claim.
 */
export function groupEditorialEvents(items, { now = Date.now(), selectedOnly = true } = {}) {
  const ranked = [...items]
    .filter((item) => selectedOnly
      ? isEditoriallySelected(item, { now })
      : item.status === 'published' && item.review?.status !== 'rejected')
    .sort((a, b) => editorialScore(b, { now }) - editorialScore(a, { now }) || new Date(b.publishedAt) - new Date(a.publishedAt));
  const clusters = [];
  for (const item of ranked) {
    const cluster = clusters.find((candidate) => sameEditorialEvent(candidate.representative, item));
    if (!cluster) {
      clusters.push({ representative: item, items: [item] });
      continue;
    }
    cluster.items.push(item);
    cluster.representative = eventRepresentative(cluster.representative, item, now);
  }
  return clusters;
}

/**
 * Converts raw updates into editorial events. Similar reports are grouped; routine
 * package releases are limited to one event per project per calendar day.
 */
export function curateItems(items, { sortBy = 'published', now = Date.now() } = {}) {
  const clusters = groupEditorialEvents(items, { now });
  const releaseQuota = new Set();
  const sourceQuota = new Map();
  const curated = [];
  for (const cluster of clusters) {
    const item = cluster.representative;
    const day = dateInShanghai(new Date(item.publishedAt));
    const sourceDay = `${item.sourceId}:${day}`;
    if (isReleaseItem(item)) {
      if (releaseQuota.has(sourceDay)) continue;
      releaseQuota.add(sourceDay);
    } else {
      const sourceCount = sourceQuota.get(sourceDay) ?? 0;
      // Keep a single prolific blog from dominating a day. Research-heavy feeds
      // have a tighter cap because one lab can otherwise occupy the full view.
      const sourceLimit = ['huggingface-blog', 'apple-ml-research'].includes(item.sourceId) ? 2 : 3;
      if (sourceCount >= sourceLimit) continue;
      sourceQuota.set(sourceDay, sourceCount + 1);
    }
    curated.push({
      ...item,
      editorialScore: editorialScore(item, { now }),
      relatedCount: cluster.items.length,
      relatedSources: [...new Set(cluster.items.map((entry) => entry.sourceName))]
    });
  }
  return curated.sort((a, b) => sortBy === 'importance'
    ? b.editorialScore - a.editorialScore || new Date(b.publishedAt) - new Date(a.publishedAt)
    : new Date(b.publishedAt) - new Date(a.publishedAt) || b.editorialScore - a.editorialScore);
}

export function calculateBackoffMinutes(failureCount) {
  return Math.min(180, 5 * (2 ** Math.max(0, Number(failureCount || 1) - 1)));
}

let redditTokenCache = { token: null, expiresAt: 0 };

function retryableFeedFailure(error) {
  const classified = classifyFeedError(error);
  return ['network', 'timeout', 'dns', 'tls'].includes(classified.kind)
    || classified.httpStatus === 408
    || Number(classified.httpStatus) >= 500;
}

async function redditToken(fetchImpl) {
  if (process.env.REDDIT_BEARER_TOKEN) return process.env.REDDIT_BEARER_TOKEN;
  if (redditTokenCache.token && redditTokenCache.expiresAt > Date.now() + 60_000) return redditTokenCache.token;
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new FeedFetchError('Reddit credentials require REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET', { kind: 'credentials_missing' });
  const response = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': process.env.REDDIT_USER_AGENT || 'AI-Hot/0.9 (local personal intelligence reader)'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new FeedFetchError(`Reddit OAuth returned HTTP ${response.status}`, { kind: response.status === 429 ? 'rate_limit' : 'http', httpStatus: response.status, retryAfterAt: retryAfterIso(response.headers?.get?.('retry-after')) });
  const payload = await response.json();
  if (!payload.access_token) throw new FeedFetchError('Reddit OAuth returned no access token', { kind: 'credentials_missing' });
  redditTokenCache = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1_000 };
  return redditTokenCache.token;
}

async function sourceRequest(source, fetchImpl) {
  const connector = source.connector || 'feed';
  const headers = { 'user-agent': 'AI-Hot/0.9 (+http://127.0.0.1)', accept: 'application/atom+xml, application/rss+xml, application/json;q=0.9, */*;q=0.1' };
  if (connector === 'github-releases') {
    headers.accept = 'application/vnd.github+json';
    headers['x-github-api-version'] = '2022-11-28';
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return { url: source.feedUrl, headers };
  }
  if (connector === 'x-user') {
    if (!process.env.X_BEARER_TOKEN) throw new FeedFetchError('X source requires X_BEARER_TOKEN', { kind: 'credentials_missing' });
    headers.authorization = `Bearer ${process.env.X_BEARER_TOKEN}`;
    const query = encodeURIComponent(`from:${source.xUsername} -is:retweet`);
    return { url: `https://api.x.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=created_at,entities`, headers };
  }
  if (connector === 'reddit-subreddit') {
    headers.authorization = `Bearer ${await redditToken(fetchImpl)}`;
    headers['user-agent'] = process.env.REDDIT_USER_AGENT || 'AI-Hot/0.9 (local personal intelligence reader)';
    return { url: `https://oauth.reddit.com/r/${encodeURIComponent(source.subreddit)}/new?limit=25&raw_json=1`, headers };
  }
  return { url: source.feedUrl, headers };
}

async function responseBody(response, source) {
  if ((source.connector || 'feed') !== 'feed' || !response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let completeEntries = 0;
  const maximumBytes = Math.max(262_144, Math.min(Number(process.env.FEED_MAX_BYTES) || 2_000_000, 8_000_000));
  try {
    while (text.length < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      completeEntries = (text.match(/<\/(?:item|entry)>/gi) || []).length;
      if (completeEntries >= 40) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    text += decoder.decode();
  }
  if (!text.trim()) throw new FeedFetchError(`${source.id} returned an empty response body`, { kind: 'empty_feed', httpStatus: response.status });
  return text;
}

function jsonEntries(payload, source) {
  if (source.connector === 'github-releases') {
    if (!Array.isArray(payload)) throw new Error('GitHub releases response is not an array');
    return payload.filter((release) => !release.draft).map((release) => ({
      title: release.name || release.tag_name,
      url: release.html_url,
      content: release.body || release.name || release.tag_name,
      publishedAt: release.published_at || release.created_at,
      sourceRef: String(release.id)
    })).filter((entry) => entry.title && entry.url);
  }
  if (source.connector === 'x-user') {
    return (payload.data || []).map((post) => ({
      title: cleanText(post.text).slice(0, 180),
      url: `https://x.com/${source.xUsername}/status/${post.id}`,
      content: post.text,
      publishedAt: post.created_at,
      sourceRef: post.id
    })).filter((entry) => entry.title && entry.url);
  }
  if (source.connector === 'reddit-subreddit') {
    return (payload.data?.children || []).map(({ data: post }) => ({
      title: post.title,
      url: post.url_overridden_by_dest || `https://www.reddit.com${post.permalink}`,
      content: post.selftext || post.title,
      publishedAt: new Date(Number(post.created_utc) * 1_000).toISOString(),
      sourceRef: post.name || post.id
    })).filter((entry) => entry.title && entry.url);
  }
  return [];
}

function rateLimitRetryAfter(response) {
  const retryAfter = retryAfterIso(response.headers?.get?.('retry-after'));
  if (retryAfter) return retryAfter;
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1_000).toISOString() : null;
}

export async function ingestSource(store, source, { fetchImpl = fetch } = {}) {
  if (!source.enabled || (!source.feedUrl && !['x-user', 'reddit-subreddit'].includes(source.connector))) return { source: source.id, skipped: true, reason: 'source disabled or missing endpoint', inserted: 0, duplicates: 0 };
  const startedAt = Date.now();
  const timeoutMs = Math.max(5_000, Math.min(Number(process.env.FEED_TIMEOUT_MS) || 45_000, 90_000));
  const state = store.getSourceState?.(source.id);
  let response;
  let body = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const request = await sourceRequest(source, fetchImpl);
      response = await fetchImpl(request.url, {
        headers: {
          ...request.headers,
          ...(state?.etag ? { 'if-none-match': state.etag } : {}),
          ...(state?.lastModified ? { 'if-modified-since': state.lastModified } : {})
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.status !== 304 && response.ok) body = await responseBody(response, source);
      break;
    } catch (error) {
      const classified = classifyFeedError(error);
      if (attempt < 2 && retryableFeedFailure(error)) {
        await wait((350 * (2 ** attempt)) + Math.floor(Math.random() * 300));
        continue;
      }
      const wrapped = new FeedFetchError(classified.message, { ...classified, cause: error });
      if (classified.kind === 'timeout') wrapped.name = error.name || 'TimeoutError';
      throw wrapped;
    }
  }
  const responseHeaders = {
    etag: response.headers?.get?.('etag') ?? state?.etag ?? null,
    lastModified: response.headers?.get?.('last-modified') ?? state?.lastModified ?? null
  };
  if (response.status === 304) return { source: source.id, notModified: true, entries: 0, inserted: 0, duplicates: 0, httpStatus: 304, durationMs: Date.now() - startedAt, ...responseHeaders };
  if (!response.ok) {
    const retryAfterAt = rateLimitRetryAfter(response);
    const exhausted = response.headers?.get?.('x-ratelimit-remaining') === '0';
    const kind = response.status === 429 || (response.status === 403 && exhausted) ? 'rate_limit' : response.status === 404 || response.status === 410 ? 'invalid_url' : 'http';
    throw new FeedFetchError(`${source.id} returned HTTP ${response.status}`, { kind, httpStatus: response.status, retryAfterAt });
  }
  let entries;
  try {
    entries = (source.connector || 'feed') === 'feed' ? parseFeed(body) : jsonEntries(JSON.parse(body), source);
  } catch (error) {
    throw new FeedFetchError(`${source.id} ${source.connector || 'feed'} parsing failed: ${error.message}`, { kind: 'feed_parse', httpStatus: response.status, cause: error });
  }
  if (!entries.length && !source.allowEmpty) throw new FeedFetchError(`${source.id} feed contained no usable entries`, { kind: 'empty_feed', httpStatus: response.status });
  let inserted = 0;
  let duplicates = 0;
  for (const entry of entries.slice(0, 80)) {
    const item = await normalizeItem(entry, source);
    if (store.items.some((current) => isDuplicate(item, current))) {
      duplicates += 1;
      continue;
    }
    store.items.push(item);
    if (store.saveItem) await store.saveItem(item);
    inserted += 1;
  }
  if (inserted && !store.saveItem) await store.saveItems?.();
  return { source: source.id, entries: entries.length, inserted, duplicates, httpStatus: response.status, durationMs: Date.now() - startedAt, ...responseHeaders };
}

export function dateInShanghai(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export async function generateDailyIssue(store, date = dateInShanghai(), { force = false, health = {}, windowStart = null, windowEnd = null } = {}) {
  const previousIndex = store.issues.findIndex((issue) => issue.date === date);
  if (previousIndex >= 0 && !force) return { issue: store.issues[previousIndex], created: false };
  if (previousIndex >= 0) store.issues.splice(previousIndex, 1);
  const calendarStart = new Date(`${date}T00:00:00+08:00`).valueOf();
  const start = windowStart ? new Date(windowStart).valueOf() : calendarStart;
  const end = windowEnd ? new Date(windowEnd).valueOf() : calendarStart + 24 * 3_600_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invalid daily issue window');
  const entries = curateItems(store.items
    .filter((item) => {
      const time = new Date(item.publishedAt).valueOf();
      return time >= start && time < end;
    }), { sortBy: 'importance', now: end })
    .slice(0, 20);
  const issue = {
    id: `daily-${date}`,
    date,
    generatedAt: new Date().toISOString(),
    title: `${date} AI 日报`,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    summary: entries.length ? `收录 ${entries.length} 条 AI 动态，重点覆盖 ${[...new Set(entries.map((item) => CATEGORY_LABELS[item.category]))].join('、')}。${health.degraded ? ' 部分信源抓取异常，本期数据可能不完整。' : ''}` : '今日尚无已发布动态。',
    status: health.degraded || entries.some((item) => item.enrichment?.status !== 'completed' && item.review?.status !== 'approved') ? 'degraded' : 'complete',
    quality: {
      status: entries.some((item) => item.enrichment?.status !== 'completed' && item.review?.status !== 'approved') ? 'degraded' : 'ready',
      ready: entries.filter((item) => item.enrichment?.status === 'completed' || item.review?.status === 'approved').length,
      fallback: entries.filter((item) => item.enrichment?.status !== 'completed' && item.review?.status !== 'approved').length,
      generatedWithoutBlockingOnModel: true
    },
    health,
    sections: Object.entries(CATEGORY_LABELS).map(([category, title]) => ({
      category,
      title,
      items: entries.filter((item) => item.category === category)
    })).filter((section) => section.items.length),
    itemIds: entries.map((item) => item.id)
  };
  store.issues.unshift(issue);
  if (store.saveIssue) await store.saveIssue(issue);
  else await store.saveIssues?.();
  return { issue, created: true, rebuilt: force && previousIndex >= 0 };
}

export function escapeXml(value = '') {
  return String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

export function itemFeed(items, title, description, host) {
  const content = items.map((item) => `\n    <item>\n      <title>${escapeXml(item.title)}</title>\n      <link>${escapeXml(item.url)}</link>\n      <guid isPermaLink="false">${escapeXml(item.id)}</guid>\n      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>\n      <description>${escapeXml(item.summary)}</description>\n    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>${escapeXml(title)}</title>\n  <link>${escapeXml(host)}</link>\n  <description>${escapeXml(description)}</description>${content}\n</channel></rss>`;
}
