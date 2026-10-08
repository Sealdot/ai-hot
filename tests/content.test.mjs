import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculateBackoffMinutes, canonicalizeUrl, cleanText, contentTypeFor, createStore, curateItems, dateInShanghai, editorialScore, enrichItems, extractArticleText, generateDailyIssue, groupEditorialEvents, ingestSource, isRoutineVersion, itemFeed, parseFeed, reviewItem } from '../lib/content.mjs';
import { buildStoryBriefs, monitorMatchesBrief, normalizeMonitor } from '../lib/briefs.mjs';
import { jitteredBackoffMinutes, sourceHealth } from '../lib/health.mjs';
import { BUILT_IN_SOURCES, mergeBuiltInSources, sourceCatalogSummary } from '../lib/source-catalog.mjs';
import { parseOpmlSources } from '../lib/opml.mjs';
import { mapConcurrentByKey } from '../lib/concurrency.mjs';

test('canonicalizeUrl removes tracking data and fragments', () => {
  assert.equal(canonicalizeUrl('https://example.com/news?utm_source=rss&keep=1#section'), 'https://example.com/news?keep=1');
});

test('parseFeed reads RSS and Atom-style link content', () => {
  const records = parseFeed(`<?xml version="1.0"?><rss><channel><item><title>AI release</title><link>https://example.com/release</link><description>New model</description><pubDate>Thu, 17 Jul 2026 07:45:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'AI release');
  assert.equal(records[0].url, 'https://example.com/release');
});

test('itemFeed emits RSS that can be parsed back into items', () => {
  const publishedAt = '2026-07-17T07:45:00.000Z';
  const xml = itemFeed([{ id: 'rss-item', title: '模型 & Agent', url: 'https://example.com/item?a=1&b=2', summary: '包含 <可信来源> 的摘要', publishedAt }], 'AI HOT 精选', 'AI 新闻聚合 RSS', 'http://127.0.0.1:8787');
  const records = parseFeed(xml);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '模型 & Agent');
  assert.equal(records[0].url, 'https://example.com/item?a=1&b=2');
  assert.equal(new Date(records[0].publishedAt).toISOString(), publishedAt);
});

test('cleanText decodes common HTML entities from feed content', () => {
  assert.equal(cleanText('What&#39;s &amp; &quot;new&quot;?'), "What's & \"new\"?");
});

test('OPML import normalizes feeds, skips duplicates, and produces stable IDs', () => {
  const xml = `<?xml version="1.0"?><opml version="2.0"><body><outline text="AI &amp; News" xmlUrl="https://example.com/feed.xml?a=1&amp;b=2" htmlUrl="https://example.com/"/><outline text="Existing" xmlUrl="https://known.example/feed.xml"/></body></opml>`;
  const first = parseOpmlSources(xml, { existingFeedUrls: ['https://known.example/feed.xml'] });
  const second = parseOpmlSources(xml, { existingFeedUrls: ['https://known.example/feed.xml'] });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'AI & News');
  assert.equal(first[0].feedUrl, 'https://example.com/feed.xml?a=1&b=2');
  assert.equal(first[0].id, second[0].id);
});

test('generateDailyIssue freezes same-day items only once', async () => {
  const store = {
    items: [{ id: 'a', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'ai-models', title: 'Model', canonicalUrl: 'https://example.com/model', tags: [], summary: 'Model', importance: 90, publishedAt: '2026-07-17T01:30:00.000Z' }],
    issues: [],
    async saveIssues() {}
  };
  const first = await generateDailyIssue(store, '2026-07-17');
  const second = await generateDailyIssue(store, '2026-07-17');
  assert.equal(first.created, true);
  assert.equal(first.issue.itemIds[0], 'a');
  assert.equal(second.created, false);
});

test('generateDailyIssue records degraded source health', async () => {
  const store = { items: [], issues: [], async saveIssues() {} };
  const result = await generateDailyIssue(store, '2026-07-17', { health: { sources: 40, failing: 25, degraded: true } });
  assert.equal(result.issue.status, 'degraded');
  assert.equal(result.issue.health.failing, 25);
});

test('generateDailyIssue supports a prior-24-hour freeze window', async () => {
  const approved = (id, publishedAt) => ({ id, sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'ai-models', title: `Model ${id}`, canonicalUrl: `https://example.com/${id}`, url: `https://example.com/${id}`, tags: ['模型'], summary: 'Model update', whyItMatters: 'Material update', importance: 90, selected: true, publishedAt, review: { status: 'approved' } });
  const store = { items: [approved('before-window', '2026-07-16T00:04:00.000Z'), approved('inside-window', '2026-07-16T00:06:00.000Z')], issues: [], async saveIssues() {} };
  const result = await generateDailyIssue(store, '2026-07-17', { windowStart: '2026-07-16T00:05:00.000Z', windowEnd: '2026-07-17T00:05:00.000Z' });
  assert.deepEqual(result.issue.itemIds, ['inside-window']);
  assert.deepEqual(result.issue.window, { start: '2026-07-16T00:05:00.000Z', end: '2026-07-17T00:05:00.000Z' });
});

test('dateInShanghai is stable ISO date', () => {
  assert.equal(dateInShanghai(new Date('2026-07-16T16:30:00.000Z')), '2026-07-17');
});

test('enrichItems reports configuration requirements without a provider', async () => {
  const result = await enrichItems({ items: [], async saveItems() {} });
  assert.equal(result.configured, false);
});

test('reviewItem records an editor decision and can reject an item', async () => {
  const store = { items: [{ id: 'review-me', title: 'Example', category: 'industry', summary: 'Example', whyItMatters: 'Example', tags: [], importance: 70, selected: true, status: 'published' }], async saveItems() {} };
  const item = await reviewItem(store, 'review-me', { status: 'rejected', note: 'Not material', importance: 22 });
  assert.equal(item.status, 'rejected');
  assert.equal(item.selected, false);
  assert.equal(item.review.status, 'rejected');
});

test('curateItems collapses duplicate reports and caps routine releases', () => {
  const now = new Date().toISOString();
  const base = { status: 'published', category: 'ai-models', summary: 'Model update', tags: [], importance: 90, publishedAt: now, sourceKind: 'first-party' };
  const curated = curateItems([
    { ...base, id: 'a', sourceId: 'vendor-a', sourceName: 'Vendor A', title: 'A new reasoning model', canonicalUrl: 'https://a.example/model' },
    { ...base, id: 'b', sourceId: 'vendor-b', sourceName: 'Vendor B', title: 'A new reasoning model', canonicalUrl: 'https://b.example/model' },
    { ...base, id: 'c', sourceId: 'vendor-releases', sourceName: 'Vendor Releases', title: 'v2.1.0', canonicalUrl: 'https://vendor.example/2.1' },
    { ...base, id: 'd', sourceId: 'vendor-releases', sourceName: 'Vendor Releases', title: 'v2.1.1', canonicalUrl: 'https://vendor.example/2.1.1' }
  ]);
  assert.equal(editorialScore(curated.find((item) => item.id === 'c') ?? { ...base, sourceId: 'vendor-releases', sourceName: 'Vendor Releases', title: 'v2.1.0' }) < 70, true);
  assert.equal(curated.length, 1);
  assert.equal(curated[0].relatedCount, 2);
});

test('release feeds recognize product-prefixed package versions as routine', () => {
  const base = { sourceId: 'vendor-releases', sourceName: 'Vendor Releases' };
  assert.equal(isRoutineVersion({ ...base, title: 'CLI @vendor/cli@0.4.0-beta.365' }), true);
  assert.equal(isRoutineVersion({ ...base, title: 'Desktop v0.0.16' }), true);
  assert.equal(isRoutineVersion({ sourceId: 'vendor-news', sourceName: 'Vendor News', title: 'Model X 2.0 changes reasoning' }), false);
});

test('groupEditorialEvents exposes similar reports outside the selected feed', () => {
  const now = new Date('2026-07-17T12:00:00.000Z').valueOf();
  const base = { status: 'published', category: 'ai-models', summary: 'Model update', tags: [], importance: 22, selected: false, sourceKind: 'news' };
  const groups = groupEditorialEvents([
    { ...base, id: 'first', sourceId: 'source-a', sourceName: 'Source A', title: 'Vendor releases a new reasoning model', canonicalUrl: 'https://a.example/model', publishedAt: '2026-07-17T08:00:00.000Z' },
    { ...base, id: 'second', sourceId: 'source-b', sourceName: 'Source B', title: 'Vendor releases a new reasoning model', canonicalUrl: 'https://b.example/model', publishedAt: '2026-07-17T09:00:00.000Z' }
  ], { now, selectedOnly: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

test('curateItems applies the Hugging Face daily cap in Shanghai time', () => {
  const base = { status: 'published', category: 'ai-models', summary: 'Model update', tags: [], importance: 90, sourceKind: 'first-party', sourceId: 'huggingface-blog', sourceName: 'Hugging Face Blog' };
  const curated = curateItems([
    { ...base, id: 'a', title: 'Model Alpha', canonicalUrl: 'https://hf.example/a', publishedAt: '2026-07-16T16:10:00.000Z' },
    { ...base, id: 'b', title: 'Model Beta', canonicalUrl: 'https://hf.example/b', publishedAt: '2026-07-16T18:10:00.000Z' },
    { ...base, id: 'c', title: 'Model Gamma', canonicalUrl: 'https://hf.example/c', publishedAt: '2026-07-17T01:10:00.000Z' }
  ], { now: new Date('2026-07-17T02:00:00.000Z').valueOf() });
  assert.equal(curated.length, 2);
});

test('calculateBackoffMinutes grows exponentially and caps at three hours', () => {
  assert.deepEqual([1, 2, 3, 8].map(calculateBackoffMinutes), [5, 10, 20, 180]);
});

test('extractArticleText prefers JSON-LD articleBody', () => {
  const body = 'A detailed article body '.repeat(12);
  assert.equal(extractArticleText(`<main>fallback ${'copy '.repeat(30)}</main><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script>`), body.trim());
});

test('ingestSource sends conditional headers and handles 304', async () => {
  let requestHeaders;
  const store = { getSourceState: () => ({ etag: 'etag-1', lastModified: 'Fri, 17 Jul 2026 10:00:00 GMT' }) };
  const result = await ingestSource(store, { id: 'conditional', enabled: true, feedUrl: 'https://example.com/feed' }, { fetchImpl: async (_url, options) => {
    requestHeaders = options.headers;
    return { status: 304, ok: false, headers: { get: () => null } };
  } });
  assert.equal(requestHeaders['if-none-match'], 'etag-1');
  assert.equal(result.notModified, true);
});

test('ingestSource propagates a feed timeout without mutating stored items', async () => {
  const store = { items: [], getSourceState: () => null };
  await assert.rejects(
    ingestSource(store, { id: 'slow-feed', enabled: true, feedUrl: 'https://example.com/slow.xml' }, { fetchImpl: async (_url, options) => {
      assert.equal(options.signal instanceof AbortSignal, true);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    } }),
    { name: 'TimeoutError' }
  );
  assert.equal(store.items.length, 0);
});

test('ingestSource classifies rate limits and preserves Retry-After', async () => {
  await assert.rejects(
    ingestSource({ items: [], getSourceState: () => null }, { id: 'limited', enabled: true, feedUrl: 'https://example.com/feed.xml' }, { fetchImpl: async () => ({ ok: false, status: 429, headers: { get: (name) => name === 'retry-after' ? '120' : null } }) }),
    (error) => error.kind === 'rate_limit' && error.httpStatus === 429 && new Date(error.retryAfterAt).valueOf() > Date.now()
  );
});

test('GitHub release connector uses compact JSON and preserves source metadata', async () => {
  const store = { items: [], getSourceState: () => null, async saveItem() {} };
  const source = { id: 'demo-releases', name: 'Demo Releases', enabled: true, connector: 'github-releases', feedUrl: 'https://api.github.com/repos/example/demo/releases?per_page=10', kind: 'first-party', channel: 'release', tier: 1, topics: ['agents'], aiEligible: true };
  const result = await ingestSource(store, source, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.accept, 'application/vnd.github+json');
    return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify([{ id: 7, name: 'Demo 2.0', tag_name: 'v2.0.0', html_url: 'https://github.com/example/demo/releases/tag/v2.0.0', body: 'Agent runtime update', published_at: '2026-08-30T00:00:00Z', draft: false }]); } };
  } });
  assert.equal(result.inserted, 1);
  assert.equal(store.items[0].sourceChannel, 'release');
  assert.equal(store.items[0].sourceTier, 1);
  assert.equal(store.items[0].contentType, 'model-release');
  assert.ok(store.items[0].tags.includes('agents'));
});

test('valid sources may report an empty update window without becoming failures', async () => {
  const result = await ingestSource(
    { items: [], getSourceState: () => null },
    { id: 'weekend-paper-feed', enabled: true, feedUrl: 'https://example.com/feed.xml', allowEmpty: true },
    { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return '<?xml version="1.0"?><rss><channel></channel></rss>'; } }) }
  );
  assert.equal(result.entries, 0);
  assert.equal(result.inserted, 0);
});

test('built-in source catalog exceeds 100 active sources and preserves local toggles', () => {
  const summary = sourceCatalogSummary(BUILT_IN_SOURCES);
  assert.ok(summary.total >= 120);
  assert.ok(summary.enabled >= 100);
  assert.equal(summary.channels.social, 15);
  assert.equal(summary.channels.community, 8);
  const merged = mergeBuiltInSources([{ id: 'openai-news', enabled: false, pollMinutes: 45 }, { id: 'custom', name: 'Custom', feedUrl: 'https://example.com/feed', enabled: true }]);
  assert.equal(merged.find((source) => source.id === 'openai-news').enabled, false);
  assert.equal(merged.find((source) => source.id === 'openai-news').pollMinutes, 45);
  const retired = BUILT_IN_SOURCES.find((source) => source.forceDisabled);
  const retiredMerged = mergeBuiltInSources([{ id: retired.id, enabled: true }]).find((source) => source.id === retired.id);
  assert.equal(retiredMerged.enabled, false);
  assert.ok(retiredMerged.disabledReason);
  assert.ok(merged.some((source) => source.id === 'custom'));
});

test('multi-source tags distinguish research, policy, and community signals', () => {
  assert.equal(contentTypeFor('New benchmark paper on reasoning', { channel: 'papers' }), 'research');
  assert.equal(contentTypeFor('Government publishes AI regulation proposal', { channel: 'media' }), 'policy');
  assert.equal(contentTypeFor('Community discussion', { channel: 'community' }), 'community');
});

test('source health tolerates one failure and uses explicit degraded and failed boundaries', () => {
  const now = new Date('2026-08-24T00:00:00.000Z').valueOf();
  const source = { pollMinutes: 60, enabled: true };
  assert.equal(sourceHealth(source, { lastSuccessAt: '2026-08-23T19:00:00.000Z', failureCount: 1 }, now).status, 'ok');
  assert.equal(sourceHealth(source, { lastSuccessAt: '2026-08-23T19:00:00.000Z', failureCount: 2 }, now).status, 'degraded');
  assert.equal(sourceHealth(source, { lastSuccessAt: '2026-08-22T23:00:00.000Z', failureCount: 1 }, now).status, 'error');
  assert.equal(sourceHealth(source, { failureCount: 3 }, now).status, 'error');
  assert.equal(jitteredBackoffMinutes(2, () => 0), 8);
  assert.equal(jitteredBackoffMinutes(2, () => 1), 12);
});

test('feed concurrency caps global work at four and each host at one', async () => {
  const values = ['a:1', 'a:2', 'a:3', 'b:1', 'c:1', 'd:1', 'e:1'];
  let active = 0;
  let maxActive = 0;
  const byHost = new Map();
  let maxSameHost = 0;
  const results = await mapConcurrentByKey(values, 4, (value) => value.split(':')[0], async (value) => {
    const host = value.split(':')[0];
    active += 1;
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
    maxActive = Math.max(maxActive, active);
    maxSameHost = Math.max(maxSameHost, byHost.get(host));
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    byHost.set(host, byHost.get(host) - 1);
    return value;
  });
  assert.deepEqual(results, values);
  assert.equal(maxActive <= 4, true);
  assert.equal(maxSameHost, 1);
});

test('no-model enrichment marks old pending work skipped and keeps recent candidates explicit', async () => {
  const old = { id: 'old', publishedAt: '2026-01-01T00:00:00.000Z', enrichment: { status: 'pending' } };
  const recent = { id: 'recent', publishedAt: new Date().toISOString(), enrichment: { status: 'pending' } };
  const saved = [];
  const result = await enrichItems({ items: [old, recent], async saveItem(item) { saved.push(item); } }, { provider: null });
  assert.equal(result.skippedStale, 1);
  assert.equal(saved[0].enrichment.status, 'skipped_stale');
  assert.equal(recent.enrichment.status, 'pending');
});

test('story briefs conservatively merge a 72-hour event and trace claims to sources', () => {
  const base = { status: 'published', selected: true, sourceKind: 'first-party', category: 'ai-models', tags: ['GPT-Next'], summary: 'A factual release summary', whyItMatters: 'Changes model capability', importance: 90, enrichment: { status: 'completed', confidence: .9 }, review: { status: 'unreviewed' } };
  const briefs = buildStoryBriefs([
    { ...base, id: 'first', sourceId: 'vendor', sourceName: 'Vendor', title: 'OpenAI launches GPT-Next reasoning model', url: 'https://vendor.example/gpt-next', canonicalUrl: 'https://vendor.example/gpt-next', publishedAt: '2026-08-23T01:00:00.000Z' },
    { ...base, id: 'second', sourceId: 'news', sourceName: 'News', sourceKind: 'news', title: 'OpenAI GPT-Next reasoning model launches', url: 'https://news.example/gpt-next', canonicalUrl: 'https://news.example/gpt-next', publishedAt: '2026-08-23T03:00:00.000Z' }
  ], { now: new Date('2026-08-24T00:00:00.000Z').valueOf() });
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].sources.length, 2);
  assert.equal(briefs[0].summaryClaims.every((claim) => claim.kind === 'fact' && claim.sourceItemIds.length), true);
  assert.equal(briefs[0].whyItMatters.kind, 'analysis');
  const monitor = normalizeMonitor({ name: 'GPT monitor', include: { entities: ['GPT-Next'] }, priority: 3 });
  assert.equal(monitorMatchesBrief(briefs[0], monitor), true);
});

test('story briefs accept cross-day updates, reject stale matches, and never merge routine versions', () => {
  const base = { status: 'published', selected: true, sourceKind: 'news', category: 'industry', tags: ['Acme'], summary: 'Update', whyItMatters: '', importance: 82, enrichment: { status: 'pending' }, review: { status: 'unreviewed' } };
  const event = (id, title, publishedAt, sourceId = id) => ({ ...base, id, sourceId, sourceName: sourceId, title, url: `https://${sourceId}.example/${id}`, canonicalUrl: `https://${sourceId}.example/${id}`, publishedAt });
  const briefs = buildStoryBriefs([
    event('day-one', 'Acme launches Orion enterprise agent platform', '2026-08-20T00:00:00.000Z'),
    event('day-three', 'Acme launches Orion enterprise agent platform', '2026-08-22T12:00:00.000Z'),
    event('stale', 'Acme launches Orion enterprise agent platform', '2026-08-24T12:01:00.000Z'),
    { ...event('v1', 'CLI v1.2.3', '2026-08-23T00:00:00.000Z', 'tool-releases'), sourceName: 'Tool Releases', sourceKind: 'first-party' },
    { ...event('v2', 'CLI v1.2.4', '2026-08-23T01:00:00.000Z', 'tool-releases'), sourceName: 'Tool Releases', sourceKind: 'first-party' }
  ], { now: new Date('2026-08-25T00:00:00.000Z').valueOf(), days: 10 });
  assert.deepEqual(briefs.map((brief) => brief.sources.length).sort((a, b) => b - a), [2, 1, 1, 1]);
});

test('OpenAI Responses enrichment uses strict schema and auto-selects confident items', async () => {
  let requestBody;
  const now = new Date().toISOString();
  const item = { id: 'ai-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'ai-models', title: 'A major model launch', url: 'https://example.com/model', canonicalUrl: 'https://example.com/model', tags: ['模型'], summary: 'New model', contentText: 'Detailed factual source material. '.repeat(20), contentOrigin: 'feed', whyItMatters: 'Pending', importance: 90, selected: true, publishedAt: now, fetchedAt: now, enrichment: { status: 'pending', attempts: 0 }, review: { status: 'unreviewed' } };
  const store = { items: [item], sources: [{ id: 'source-a' }], async saveItem() {}, startJob: () => ({ id: 'job' }), finishJob() {} };
  const result = await enrichItems(store, {
    provider: { type: 'openai-responses', label: 'gpt-5.6-terra', model: 'gpt-5.6-terra', apiKey: 'test', baseUrl: 'https://api.openai.test/v1' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.test/v1/responses');
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { id: 'resp_test', model: 'gpt-5.6-terra', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: '中文摘要', whyItMatters: '值得关注', category: 'ai-models', tags: ['模型', '发布'], importance: 91, confidence: 0.92, requiresReview: false }) }] }], usage: { input_tokens: 123, output_tokens: 45 } }; } };
    }
  });
  assert.equal(requestBody.reasoning.effort, 'low');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(store.items[0].selected, true);
  assert.equal(store.items[0].enrichment.responseId, 'resp_test');
  assert.equal(result.inputTokens, 123);
});

test('OpenAI Responses enrichment retries malformed output three times then records failure', async () => {
  let calls = 0;
  const now = new Date().toISOString();
  const item = { id: 'bad-ai-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'ai-models', title: 'A major model launch', url: 'https://example.com/model', canonicalUrl: 'https://example.com/bad-model', tags: ['模型'], summary: 'New model', contentText: 'Detailed factual source material. '.repeat(20), whyItMatters: 'Pending', importance: 90, selected: true, publishedAt: now, fetchedAt: now, enrichment: { status: 'pending', attempts: 0 }, review: { status: 'unreviewed' } };
  const store = { items: [item], sources: [{ id: 'source-a' }], async saveItem() {}, startJob: () => ({ id: 'job' }), finishJob() {} };
  const result = await enrichItems(store, {
    retryDelayMs: 0,
    provider: { type: 'openai-responses', label: 'gpt-5.6-terra', model: 'gpt-5.6-terra', apiKey: 'test', baseUrl: 'https://api.openai.test/v1' },
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, async json() { return { output: [{ content: [{ type: 'output_text', text: '{"summary":"missing fields"}' }] }] }; } }; }
  });
  assert.equal(calls, 3);
  assert.equal(result.failed, 1);
  assert.equal(store.items[0].enrichment.status, 'failed');
  assert.equal(store.items[0].selected, false);
});

test('OpenAI Responses enrichment retries rate limits and then succeeds', async () => {
  let calls = 0;
  const now = new Date().toISOString();
  const item = { id: 'rate-limited-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'ai-models', title: 'A major reasoning model launch', url: 'https://example.com/rate-limited', canonicalUrl: 'https://example.com/rate-limited', tags: ['模型'], summary: 'New model', contentText: 'Detailed factual source material. '.repeat(20), contentOrigin: 'feed', whyItMatters: 'Pending', importance: 90, selected: true, publishedAt: now, fetchedAt: now, enrichment: { status: 'pending', attempts: 0 }, review: { status: 'unreviewed' } };
  const store = { items: [item], sources: [{ id: 'source-a' }], async saveItem() {}, startJob: () => ({ id: 'job' }), finishJob() {} };
  const result = await enrichItems(store, {
    retryDelayMs: 0,
    provider: { type: 'openai-responses', label: 'gpt-5.6-terra', model: 'gpt-5.6-terra', apiKey: 'test', baseUrl: 'https://api.openai.test/v1' },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 429, async text() { return 'rate limited'; } };
      return { ok: true, status: 200, async json() { return { id: 'resp_after_retry', model: 'gpt-5.6-terra', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: '中文摘要', whyItMatters: '值得关注', category: 'ai-models', tags: ['模型', '发布'], importance: 90, confidence: 0.9, requiresReview: false }) }] }], usage: { input_tokens: 100, output_tokens: 40 } }; } };
    }
  });
  assert.equal(calls, 3);
  assert.equal(result.enriched, 1);
  assert.equal(store.items[0].enrichment.responseId, 'resp_after_retry');
});

test('approved human review prevents automatic overwrite', async () => {
  let calls = 0;
  const now = new Date().toISOString();
  const item = { id: 'approved-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', status: 'published', category: 'industry', title: 'Approved editorial item', url: 'https://example.com/approved', canonicalUrl: 'https://example.com/approved', tags: ['行业'], summary: 'Human summary', whyItMatters: 'Human reason', importance: 88, selected: true, publishedAt: now, fetchedAt: now, enrichment: { status: 'pending' }, review: { status: 'approved' } };
  const result = await enrichItems({ items: [item], sources: [], async saveItem() {} }, { provider: { type: 'webhook', label: 'test', url: 'https://example.com' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(result.processed, 0);
  assert.equal(calls, 0);
  assert.equal(item.summary, 'Human summary');
});

test('SQLite migration is idempotent and preserves legacy JSON', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-store-'));
  const now = new Date().toISOString();
  const item = { id: 'legacy-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', title: 'Legacy', url: 'https://example.com/legacy', canonicalUrl: 'https://example.com/legacy', publishedAt: now, fetchedAt: now, category: 'industry', tags: ['行业'], summary: 'Legacy', whyItMatters: 'Legacy', importance: 80, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } };
  await writeFile(path.join(dataDir, 'sources.json'), JSON.stringify([{ id: 'source-a', enabled: true }]));
  await writeFile(path.join(dataDir, 'items.runtime.json'), JSON.stringify([item]));
  await writeFile(path.join(dataDir, 'daily-issues.runtime.json'), '[]');
  await writeFile(path.join(dataDir, 'editorial-overrides.json'), '{}');
  const first = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  assert.equal(first.items.length, 1);
  assert.equal(first.migration.importedItems, 1);
  first.upsertSourceState('source-a', { status: 'error', failureCount: 2, nextPollAt: now, lastError: 'timeout' });
  const backup = await first.backup({ retain: 2 });
  assert.equal(backup.file.endsWith('.sqlite'), true);
  first.close();
  const second = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  assert.equal(second.items.length, 1);
  assert.equal(second.migration.importedItems, 0);
  assert.equal(second.getSourceState('source-a').failureCount, 2);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'items.runtime.json'))).length, 1);
  second.close();
});

test('SQLite reader state persists read, saved, hidden and notes locally', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-reader-'));
  const now = new Date().toISOString();
  const item = { id: 'reader-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', title: 'Reader item', url: 'https://example.com/reader', canonicalUrl: 'https://example.com/reader', publishedAt: now, fetchedAt: now, category: 'industry', tags: ['行业'], summary: 'Reader item', whyItMatters: 'Reader item', importance: 80, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } };
  await writeFile(path.join(dataDir, 'sources.json'), '[]');
  await writeFile(path.join(dataDir, 'items.runtime.json'), JSON.stringify([item]));
  await writeFile(path.join(dataDir, 'daily-issues.runtime.json'), '[]');
  await writeFile(path.join(dataDir, 'editorial-overrides.json'), '{}');
  const first = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  first.updateReaderState(item.id, 'read');
  first.updateReaderState(item.id, 'save');
  first.updateReaderState(item.id, 'hide');
  first.updateReaderState(item.id, 'note', '在下次模型评估时复查');
  assert.deepEqual(first.getReaderState(item.id).note, '在下次模型评估时复查');
  first.updateReaderState(item.id, 'unhide');
  assert.equal(first.getReaderState(item.id).hiddenAt, null);
  first.close();
  const second = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  const state = second.getReaderState(item.id);
  assert.ok(state.readAt);
  assert.ok(state.savedAt);
  assert.equal(state.hiddenAt, null);
  assert.equal(state.note, '在下次模型评估时复查');
  assert.throws(() => second.updateReaderState(item.id, 'unsupported'), /unsupported reader action/);
  second.close();
});

test('SQLite reader feedback replaces a prior choice and aggregates local preferences', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-feedback-'));
  const now = new Date().toISOString();
  const item = { id: 'feedback-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', title: 'Feedback item', url: 'https://example.com/feedback', canonicalUrl: 'https://example.com/feedback', publishedAt: now, fetchedAt: now, category: 'ai-models', tags: ['模型'], summary: 'Feedback item', whyItMatters: 'Feedback item', importance: 80, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } };
  await writeFile(path.join(dataDir, 'sources.json'), '[]');
  await writeFile(path.join(dataDir, 'items.runtime.json'), JSON.stringify([item]));
  await writeFile(path.join(dataDir, 'daily-issues.runtime.json'), '[]');
  await writeFile(path.join(dataDir, 'editorial-overrides.json'), '{}');
  const first = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  first.updateReaderFeedback(item, 'prefer-category');
  first.updateReaderFeedback(item, 'avoid-category');
  first.updateReaderFeedback(item, 'prefer-source');
  assert.equal(first.getReaderFeedback(item.id).category.value, -1);
  assert.equal(first.getReaderFeedback(item.id).source.value, 1);
  assert.deepEqual(first.listReaderPreferences().map((entry) => [entry.dimension, entry.target, entry.score]), [['category', 'ai-models', -1], ['source', 'source-a', 1]]);
  first.close();
  const second = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  second.updateReaderFeedback(item, 'clear');
  assert.equal(second.getReaderFeedback(item.id).category, null);
  assert.deepEqual(second.listReaderPreferences(), []);
  assert.throws(() => second.updateReaderFeedback(item, 'unsupported'), /unsupported reader feedback action/);
  second.close();
});

test('SQLite library snapshots safely merge reader data and keep recoverable backups', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-library-'));
  const now = new Date().toISOString();
  const item = { id: 'library-item', sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', title: 'Library item', url: 'https://example.com/library', canonicalUrl: 'https://example.com/library', publishedAt: now, fetchedAt: now, category: 'ai-models', tags: ['模型'], summary: 'Library item', whyItMatters: 'Library item', importance: 80, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } };
  await writeFile(path.join(dataDir, 'sources.json'), '[]');
  await writeFile(path.join(dataDir, 'items.runtime.json'), JSON.stringify([item]));
  await writeFile(path.join(dataDir, 'daily-issues.runtime.json'), '[]');
  await writeFile(path.join(dataDir, 'editorial-overrides.json'), '{}');
  const store = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  store.updateReaderState(item.id, 'read');
  store.updateReaderState(item.id, 'save');
  store.updateReaderState(item.id, 'note', '下周复查这项发布');
  store.updateReaderFeedback(item, 'prefer-category');
  store.updateReaderFeedback(item, 'avoid-source');
  const snapshot = store.readerLibrarySnapshot(new Date('2026-07-26T00:00:00.000Z'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.readerStates.length, 1);
  assert.equal(snapshot.feedback.length, 2);

  store.updateReaderState(item.id, 'unread');
  store.updateReaderState(item.id, 'unsave');
  store.updateReaderState(item.id, 'note', '');
  store.updateReaderFeedback(item, 'clear');
  const imported = store.importReaderLibrary(snapshot);
  assert.deepEqual(imported, { readerStates: 1, feedback: 2, skippedUnknownItems: 0, skippedOlder: 0, dailyIssuesInExport: 0 });
  assert.equal(store.getReaderState(item.id).note, '下周复查这项发布');
  const restoredFeedback = store.getReaderFeedback(item.id);
  assert.equal(restoredFeedback.category.value, 1);
  assert.equal(restoredFeedback.category.target, 'ai-models');
  assert.equal(restoredFeedback.source.value, -1);
  assert.equal(restoredFeedback.source.target, 'source-a');

  const withUnknownItem = { ...snapshot, readerStates: [...snapshot.readerStates, { itemId: 'removed-item', note: 'ignored', updatedAt: now }] };
  assert.equal(store.importReaderLibrary(withUnknownItem).skippedUnknownItems, 1);
  assert.throws(() => store.importReaderLibrary({ version: 1 }), /invalid library export/);
  assert.equal(store.clearReaderPreference('category', 'ai-models').cleared, 1);
  assert.equal(store.listReaderPreferences().some((entry) => entry.dimension === 'category'), false);
  await store.backup({ retain: 3 });
  assert.equal((await store.listBackups()).length, 1);
  store.close();
});

test('SQLite brief state migrates saved items, requires all sources read, and persists monitors', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-briefs-'));
  const now = new Date().toISOString();
  const item = (id, sourceId) => ({ id, sourceId, sourceName: sourceId, sourceKind: 'first-party', title: 'Shared event title', url: `https://${sourceId}.example/event`, canonicalUrl: `https://${sourceId}.example/event`, publishedAt: now, fetchedAt: now, category: 'ai-models', tags: ['模型'], summary: `${sourceId} factual summary`, whyItMatters: '', importance: 88, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } });
  await writeFile(path.join(dataDir, 'sources.json'), '[]');
  const store = await createStore({ dataDir, dbPath: path.join(dataDir, 'test.sqlite') });
  store.items = [item('a', 'source-a'), item('b', 'source-b')];
  await store.saveItems();
  store.updateReaderState('a', 'save');
  store.updateReaderState('a', 'read');
  store.updateReaderState('a', 'note', 'source-specific note');
  const [brief] = buildStoryBriefs(store.items);
  store.saveBriefs([brief]);
  const migrated = store.getBrief(brief.id);
  assert.ok(migrated.reader.savedAt);
  assert.equal(migrated.reader.readAt, null);
  assert.equal(migrated.sources.find((source) => source.itemId === 'a').note, 'source-specific note');
  store.updateBriefReaderState(brief.id, 'read');
  store.updateBriefReaderState(brief.id, 'note', 'event note');
  assert.equal(store.getBrief(brief.id).reader.note, 'event note');
  const monitor = normalizeMonitor({ name: 'Models', include: { categories: ['ai-models'] } });
  store.saveMonitor(monitor);
  assert.equal(store.getMonitor(monitor.id).name, 'Models');
  assert.equal(store.deleteMonitor(monitor.id), 1);
  store.close();
});

test('SQLite maintenance retains recent records and compacts old backups', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ai-hot-maintenance-'));
  const dbPath = path.join(dataDir, 'test.sqlite');
  const oldAt = '2026-01-01T00:00:00.000Z';
  const recentAt = '2026-07-19T00:00:00.000Z';
  const item = (id, publishedAt) => ({ id, sourceId: 'source-a', sourceName: 'Source A', sourceKind: 'first-party', title: id, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, publishedAt, fetchedAt: publishedAt, category: 'industry', tags: ['行业'], summary: id, whyItMatters: id, importance: 80, selected: true, status: 'published', enrichment: { status: 'pending' }, review: { status: 'unreviewed' } });
  const issue = (date) => ({ id: `daily-${date}`, date, generatedAt: `${date}T00:00:00.000Z`, title: `${date} AI 日报`, summary: 'summary', status: 'complete', health: {}, sections: [], itemIds: [] });
  const store = await createStore({ dataDir, dbPath });
  store.items = [item('old-item', oldAt), item('recent-item', recentAt)];
  await store.saveItems();
  store.issues = [issue('2026-01-01'), issue('2026-07-19')];
  await store.saveIssues();
  const oldJob = store.startJob('ingestion', 'test');
  store.finishJob(oldJob.id, { status: 'completed' });
  store.db.prepare('UPDATE job_runs SET started_at = ? WHERE id = ?').run(oldAt, oldJob.id);
  const recentJob = store.startJob('ingestion', 'test');
  store.finishJob(recentJob.id, { status: 'completed' });
  const backupsDir = path.join(dataDir, 'backups');
  await mkdir(backupsDir, { recursive: true });
  await writeFile(path.join(backupsDir, 'ai-news-2026-01-01.sqlite'), 'old');
  await writeFile(path.join(backupsDir, 'ai-news-2026-07-19.sqlite'), 'recent');
  await writeFile(path.join(backupsDir, 'ai-news-2026-07-19.sqlite-wal'), 'orphaned sidecar');
  const result = await store.maintain({ itemRetentionDays: 90, issueRetentionDays: 90, jobRetentionDays: 30, backupRetention: 1, now: new Date('2026-07-20T02:00:00.000Z'), compact: false });
  assert.deepEqual(store.items.map((entry) => entry.id), ['recent-item']);
  assert.deepEqual(store.issues.map((entry) => entry.date), ['2026-07-19']);
  assert.deepEqual(store.listJobs(10).map((entry) => entry.id), [recentJob.id]);
  assert.equal(result.removed.items, 1);
  assert.equal(result.removed.issues, 1);
  assert.equal(result.removed.jobs, 1);
  assert.equal(result.removed.backups.includes('ai-news-2026-01-01.sqlite'), true);
  assert.equal(result.removed.backups.includes('ai-news-2026-07-19.sqlite-wal'), true);
  store.close();
});
