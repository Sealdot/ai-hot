import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_LABELS,
  CONTENT_TYPE_LABELS,
  ENRICHMENT_MAX_AGE_HOURS,
  ENRICHMENT_MIN_RULE_SCORE,
  SOURCE_CHANNEL_LABELS,
  SOURCE_KIND_LABELS,
  classifyFeedError,
  contentTypeFor,
  configuredEnricher,
  createStore,
  curateItems,
  dateInShanghai,
  enrichItems,
  generateDailyIssue,
  groupEditorialEvents,
  ingestSource,
  isRoutineVersion,
  itemFeed,
  reviewItem,
  ruleScore
} from './lib/content.mjs';
import { buildStoryBriefs, monitorMatchesBrief, normalizeMonitor } from './lib/briefs.mjs';
import { jitteredBackoffMinutes, sourceHealth, summarizeSourceHealth } from './lib/health.mjs';
import { parseOpmlSources } from './lib/opml.mjs';
import { mapConcurrentByKey } from './lib/concurrency.mjs';
import { mergeBuiltInSources, sourceCatalogSummary } from './lib/source-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.join(here, 'data');
const logsDir = path.join(dataDir, 'logs');
const store = await createStore();
const mergedSources = mergeBuiltInSources(store.sources);
if (JSON.stringify(mergedSources) !== JSON.stringify(store.sources)) await store.replaceSources(mergedSources);
const sourceProfileById = new Map(store.sources.map((source) => [source.id, source]));
for (let index = 0; index < store.items.length; index += 1) {
  const item = store.items[index];
  if (item.sourceChannel && item.contentType && item.sourceTier) continue;
  const source = sourceProfileById.get(item.sourceId);
  if (!source) continue;
  const contentType = item.contentType || contentTypeFor(`${item.title} ${item.summary}`, source);
  const next = {
    ...item,
    sourceChannel: source.channel,
    sourceTier: source.tier,
    sourceTopics: source.topics || [],
    author: source.author || '',
    contentType,
    aiEligible: source.aiEligible !== false,
    tags: [...new Set([...(item.tags || []), CONTENT_TYPE_LABELS[contentType], ...(source.topics || [])].filter(Boolean))].slice(0, 10)
  };
  store.items[index] = next;
  await store.saveItem(next);
}
await enrichItems(store, { take: 1, provider: null });
rebuildBriefs();
let ingestionInFlight = null;
let enrichmentInFlight = null;
let maintenanceInFlight = null;

function numberFromEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

const retentionPolicy = Object.freeze({
  itemDays: numberFromEnv('ITEM_RETENTION_DAYS', 90, 7, 3_650),
  issueDays: numberFromEnv('ISSUE_RETENTION_DAYS', 90, 7, 3_650),
  jobDays: numberFromEnv('JOB_RETENTION_DAYS', 30, 1, 365),
  backups: numberFromEnv('BACKUP_RETENTION_COUNT', 3, 1, 60),
  maxLogBytes: numberFromEnv('MAX_LOG_BYTES', 524_288, 65_536, 5_242_880)
});

const updateRules = Object.freeze([
  { id: 'continuous', label: '常规追踪', schedule: '每个信源按 30–360 分钟周期错峰', action: '条件抓取、去重并记录信源健康' },
  { id: 'morning', label: '晨间加急', schedule: '每天北京时间 07:40', action: '按域名限速刷新全部已启用信源' },
  { id: 'daily', label: '日报冻结', schedule: '每天北京时间 08:05', action: '冻结当日已完成内容、记录健康度并备份' },
  { id: 'recovery', label: '离线补跑', schedule: '服务在 08:05 后恢复时', action: '补抓信源并补生成缺失日报' },
  { id: 'storage', label: '空间维护', schedule: '启动后及每次日报后', action: '清理过期内容、压缩 SQLite、截断 WAL 和日志' }
]);

async function resolveAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const tokenPath = path.join(dataDir, 'admin-token.runtime');
  try { return (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dataDir, { recursive: true });
    const token = randomBytes(24).toString('base64url');
    try { await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (writeError) { if (writeError.code === 'EEXIST') return (await readFile(tokenPath, 'utf8')).trim(); throw writeError; }
    await chmod(tokenPath, 0o600);
    console.log(`Generated local admin token at ${tokenPath}`);
    return token;
  }
}

const adminToken = await resolveAdminToken();

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.yaml': 'application/yaml; charset=utf-8' };

function send(response, status, payload, headers = {}, { publicCors = true } = {}) {
  response.writeHead(status, { ...(publicCors ? { 'access-control-allow-origin': '*' } : {}), ...headers });
  response.end(payload);
}

function json(response, status, payload, options) {
  send(response, status, JSON.stringify(payload), { 'content-type': 'application/json; charset=utf-8' }, options);
}

function adminAuthorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expectedBuffer = Buffer.from(adminToken);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function adminSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

const emptyReaderState = (itemId) => ({ itemId, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: null });

function freshnessFor(item, now = Date.now()) {
  const hours = Math.max(0, Math.round((now - new Date(item.publishedAt).valueOf()) / 3_600_000));
  if (hours < 6) return { bucket: 'fresh', label: '6 小时内', ageHours: hours };
  if (hours < 24) return { bucket: 'today', label: '24 小时内', ageHours: hours };
  if (hours < 72) return { bucket: 'recent', label: '近 3 天', ageHours: hours };
  return { bucket: 'archive', label: '归档内容', ageHours: hours };
}

function corroborationByItem(items, now) {
  const byItem = new Map();
  for (const group of groupEditorialEvents(items, { now, selectedOnly: false })) {
    const sources = [...new Map(group.items.map((item) => [item.sourceId, { id: item.sourceId, name: item.sourceName, kind: item.sourceKind }])).values()];
    const articles = group.items
      .sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt))
      .slice(0, 4)
      .map(({ id, title, sourceId, sourceName, sourceKind, publishedAt, url }) => ({ id, title, sourceId, sourceName, sourceKind, publishedAt, url }));
    for (const item of group.items) byItem.set(item.id, { sourceCount: sources.length, sources, articles: articles.filter((article) => article.id !== item.id) });
  }
  return byItem;
}

function publicContext() {
  const now = Date.now();
  const publishedItems = store.items.filter((item) => item.status === 'published');
  const readerStates = store.getReaderStates(publishedItems.map((item) => item.id));
  const feedbacks = store.getReaderFeedbacks(publishedItems.map((item) => item.id));
  const preferences = store.listReaderPreferences();
  const preferenceWeights = new Map(preferences.map((preference) => [`${preference.dimension}:${preference.target}`, preference.score]));
  const sourceById = new Map(store.sources.map((source) => [source.id, source]));
  const sourceStates = new Map(store.sources.map((source) => [source.id, store.getSourceState(source.id) ?? { status: 'pending' }]));
  return {
    now,
    readerStateOf: (item) => readerStates.get(item.id) ?? emptyReaderState(item.id),
    feedbackOf: (item) => feedbacks.get(item.id) ?? { itemId: item.id, category: null, source: null },
    preferences,
    preferenceWeights,
    sourceById,
    sourceStates,
    corroboration: corroborationByItem(publishedItems, now)
  };
}

function sourceHealthFor(item, context) {
  return sourceHealth(context.sourceById.get(item.sourceId), context.sourceStates.get(item.sourceId) ?? { status: 'pending' }, context.now);
}

function preferenceFor(item, context) {
  const categoryScore = context.preferenceWeights.get(`category:${item.category}`) ?? 0;
  const sourceScore = context.preferenceWeights.get(`source:${item.sourceId}`) ?? 0;
  const score = Math.max(-16, Math.min(16, categoryScore * 4 + sourceScore * 3));
  const reasons = [];
  if (categoryScore) reasons.push(`${categoryScore > 0 ? '偏好' : '少看'}：${CATEGORY_LABELS[item.category] ?? item.category}`);
  if (sourceScore) reasons.push(`${sourceScore > 0 ? '偏好' : '少看'}：${item.sourceName}`);
  return { score, reasons };
}

function publicItem(item, context) {
  const reader = context.readerStateOf(item);
  const corroboration = context.corroboration.get(item.id) ?? { sourceCount: 1, sources: [{ id: item.sourceId, name: item.sourceName, kind: item.sourceKind }], articles: [] };
  const preference = preferenceFor(item, context);
  return {
    ...item,
    whyItMatters: item.review?.status === 'approved' || item.enrichment?.status === 'completed' ? item.whyItMatters : '',
    reader,
    feedback: context.feedbackOf(item),
    trust: {
      freshness: freshnessFor(item, context.now),
      sourceHealth: sourceHealthFor(item, context),
      editorial: {
        reviewed: item.review?.status === 'approved',
        enriched: item.enrichment?.status === 'completed',
        confidence: item.enrichment?.confidence ?? null
      },
      corroboration
    },
    ranking: { preferenceScore: preference.score, reasons: preference.reasons }
  };
}

function listComparator(mode) {
  return (left, right) => {
    if (mode === 'selected') {
      const priority = (right.editorialScore ?? right.importance) + right.ranking.preferenceScore - ((left.editorialScore ?? left.importance) + left.ranking.preferenceScore);
      if (priority) return priority;
    }
    const published = new Date(right.publishedAt) - new Date(left.publishedAt);
    if (published) return published;
    return right.id.localeCompare(left.id);
  };
}

function cursorFrom(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return null; }
}

function cursorFor(item) {
  return Buffer.from(JSON.stringify({ id: item.id, publishedAt: item.publishedAt, preferenceScore: item.ranking.preferenceScore })).toString('base64url');
}

function matchesSearch(item, reader, query) {
  if (!query) return true;
  const haystack = `${item.title} ${item.summary} ${item.sourceName} ${(item.tags ?? []).join(' ')} ${reader.note ?? ''}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

function getItems(search) {
  const mode = search.get('mode') === 'all' ? 'all' : 'selected';
  const category = search.get('category');
  const sourceKind = search.get('sourceKind');
  const sourceId = search.get('source');
  const readerView = ['all', 'unread', 'saved', 'hidden'].includes(search.get('reader')) ? search.get('reader') : 'all';
  const query = (search.get('q') || '').trim().toLowerCase();
  const since = search.get('since');
  const take = Math.max(1, Math.min(Number(search.get('take')) || 20, 50));
  const context = publicContext();
  const filtered = store.items
    .filter((item) => item.status === 'published')
    .filter((item) => !category || category === 'all' || item.category === category)
    .filter((item) => !sourceKind || sourceKind === 'all' || item.sourceKind === sourceKind)
    .filter((item) => !sourceId || sourceId === 'all' || item.sourceId === sourceId)
    .filter((item) => !since || new Date(item.publishedAt) >= new Date(since))
    .filter((item) => readerView === 'hidden' ? Boolean(context.readerStateOf(item).hiddenAt) : !context.readerStateOf(item).hiddenAt)
    .filter((item) => readerView !== 'saved' || Boolean(context.readerStateOf(item).savedAt))
    .filter((item) => readerView !== 'unread' || !context.readerStateOf(item).readAt)
    .filter((item) => matchesSearch(item, context.readerStateOf(item), query));
  const candidates = mode === 'selected' ? curateItems(filtered, { now: context.now }) : filtered;
  const sorted = candidates.map((item) => publicItem(item, context)).sort(listComparator(mode));
  const cursor = search.get('cursor') ? cursorFrom(search.get('cursor')) : null;
  const cursorIndex = cursor ? sorted.findIndex((item) => item.id === cursor.id && item.publishedAt === cursor.publishedAt && item.ranking.preferenceScore === cursor.preferenceScore) : -1;
  const afterCursor = cursorIndex >= 0 ? sorted.slice(cursorIndex + 1) : sorted;
  const items = afterCursor.slice(0, take);
  const tail = items.at(-1);
  return {
    items,
    nextCursor: tail && afterCursor.length > take ? cursorFor(tail) : null,
    meta: {
      mode,
      readerView,
      total: sorted.length,
      generatedAt: new Date(context.now).toISOString(),
      personalization: { active: context.preferences.length, applied: mode === 'selected' && context.preferences.length > 0 }
    }
  };
}

function getReaderWorkspace() {
  const context = publicContext();
  const visible = store.items.filter((item) => item.status === 'published' && !context.readerStateOf(item).hiddenAt);
  const score = (item) => (item.editorialScore ?? item.importance) + item.ranking.preferenceScore;
  const selectedUnread = curateItems(visible.filter((item) => !context.readerStateOf(item).readAt), { now: context.now })
    .map((item) => publicItem(item, context))
    .filter((item) => context.now - new Date(item.publishedAt).valueOf() <= 72 * 3_600_000)
    .sort((left, right) => score(right) - score(left) || new Date(right.publishedAt) - new Date(left.publishedAt));
  const saved = visible.filter((item) => context.readerStateOf(item).savedAt)
    .map((item) => publicItem(item, context))
    .sort((left, right) => new Date(right.reader.savedAt) - new Date(left.reader.savedAt));
  const noted = visible.filter((item) => context.readerStateOf(item).note)
    .map((item) => publicItem(item, context))
    .sort((left, right) => new Date(right.reader.updatedAt) - new Date(left.reader.updatedAt));
  return {
    summary: {
      unread: visible.filter((item) => !context.readerStateOf(item).readAt).length,
      unreadSelected72h: selectedUnread.length,
      saved: saved.length,
      noted: noted.length
    },
    sections: { toRead: selectedUnread.slice(0, 12), saved: saved.slice(0, 12), noted: noted.slice(0, 12) },
    meta: { generatedAt: new Date(context.now).toISOString(), personalization: { active: context.preferences.length, applied: context.preferences.length > 0 } }
  };
}

function getWeeklyReview() {
  const context = publicContext();
  const since = context.now - 7 * 24 * 3_600_000;
  const visible = store.items.filter((item) => item.status === 'published' && !context.readerStateOf(item).hiddenAt);
  const withPublicShape = (items) => items.map((item) => publicItem(item, context));
  const read = visible.filter((item) => {
    const at = context.readerStateOf(item).readAt;
    return at && new Date(at).valueOf() >= since;
  });
  const saved = visible.filter((item) => {
    const at = context.readerStateOf(item).savedAt;
    return at && new Date(at).valueOf() >= since;
  });
  const noted = visible.filter((item) => {
    const reader = context.readerStateOf(item);
    return reader.note && reader.updatedAt && new Date(reader.updatedAt).valueOf() >= since;
  });
  const unread = curateItems(visible.filter((item) => !context.readerStateOf(item).readAt), { now: context.now })
    .map((item) => publicItem(item, context))
    .sort((left, right) => ((right.editorialScore ?? right.importance) + right.ranking.preferenceScore) - ((left.editorialScore ?? left.importance) + left.ranking.preferenceScore) || new Date(right.publishedAt) - new Date(left.publishedAt));
  const topicCounts = new Map();
  for (const item of [...read, ...saved, ...noted]) topicCounts.set(item.category, (topicCounts.get(item.category) ?? 0) + 1);
  return {
    window: { start: new Date(since).toISOString(), end: new Date(context.now).toISOString() },
    summary: { read: read.length, saved: saved.length, noted: noted.length, unread: visible.filter((item) => !context.readerStateOf(item).readAt).length },
    topics: [...topicCounts.entries()].map(([category, count]) => ({ category, label: CATEGORY_LABELS[category] ?? category, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN')),
    sections: {
      saved: withPublicShape(saved).sort((left, right) => new Date(right.reader.savedAt) - new Date(left.reader.savedAt)).slice(0, 12),
      noted: withPublicShape(noted).sort((left, right) => new Date(right.reader.updatedAt) - new Date(left.reader.updatedAt)).slice(0, 12),
      unread: unread.slice(0, 12)
    },
    meta: { generatedAt: new Date(context.now).toISOString(), personalization: { active: context.preferences.length, applied: context.preferences.length > 0 } }
  };
}

function libraryItems(snapshot) {
  const itemById = new Map(store.items.map((item) => [item.id, item]));
  return snapshot.readerStates.map((reader) => ({ item: itemById.get(reader.itemId), reader })).filter((entry) => entry.item);
}

async function getLocalLibrary() {
  const snapshot = store.readerLibrarySnapshot();
  const saved = libraryItems(snapshot).filter(({ reader }) => reader.savedAt).sort((left, right) => new Date(right.reader.savedAt) - new Date(left.reader.savedAt));
  const noted = libraryItems(snapshot).filter(({ reader }) => reader.note).sort((left, right) => new Date(right.reader.updatedAt) - new Date(left.reader.updatedAt));
  return {
    summary: { saved: saved.length, noted: noted.length, readerStates: snapshot.readerStates.length, dailyIssues: snapshot.dailyIssues.length },
    preferences: store.listReaderPreferences().map((preference) => ({
      ...preference,
      label: preference.dimension === 'category' ? CATEGORY_LABELS[preference.target] ?? preference.target : store.sources.find((source) => source.id === preference.target)?.name ?? preference.target
    })),
    recent: {
      saved: saved.slice(0, 12).map(({ item, reader }) => ({ id: item.id, title: item.title, url: item.url, sourceName: item.sourceName, savedAt: reader.savedAt, note: reader.note })),
      noted: noted.slice(0, 12).map(({ item, reader }) => ({ id: item.id, title: item.title, url: item.url, sourceName: item.sourceName, updatedAt: reader.updatedAt, note: reader.note }))
    },
    backups: await store.listBackups(),
    export: { version: snapshot.version, exportedAt: snapshot.exportedAt }
  };
}

function libraryMarkdown(snapshot) {
  const saved = libraryItems(snapshot).filter(({ reader }) => reader.savedAt).sort((left, right) => new Date(right.reader.savedAt) - new Date(left.reader.savedAt));
  const noted = libraryItems(snapshot).filter(({ reader }) => reader.note).sort((left, right) => new Date(right.reader.updatedAt) - new Date(left.reader.updatedAt));
  const preferenceLines = store.listReaderPreferences().map((preference) => `- ${preference.dimension === 'category' ? '主题' : '信源'}：${preference.dimension === 'category' ? CATEGORY_LABELS[preference.target] ?? preference.target : store.sources.find((source) => source.id === preference.target)?.name ?? preference.target}（${preference.score > 0 ? '多看' : '少看'}）`);
  const itemLine = ({ item, reader }, includeNote = false) => `- [${item.title}](${item.url}) · ${item.sourceName}${includeNote && reader.note ? `\n  - 备注：${reader.note.replace(/\n/g, ' ')}` : ''}`;
  const dailyLines = snapshot.dailyIssues.map((issue) => `- ${issue.date} · ${issue.title}${issue.summary ? `：${issue.summary}` : ''}`);
  return `# AI HOT 本地资料库\n\n导出时间：${snapshot.exportedAt}\n\n## 收藏\n${saved.length ? saved.map((entry) => itemLine(entry, true)).join('\n') : '- 暂无收藏'}\n\n## 笔记\n${noted.length ? noted.map((entry) => itemLine(entry, true)).join('\n') : '- 暂无笔记'}\n\n## 当前偏好\n${preferenceLines.length ? preferenceLines.join('\n') : '- 暂无偏好'}\n\n## 日报归档\n${dailyLines.length ? dailyLines.join('\n') : '- 暂无日报'}\n`;
}

function getPublicItem(itemId) {
  const item = store.items.find((candidate) => candidate.id === itemId && candidate.status === 'published');
  if (!item) return null;
  return publicItem(item, publicContext());
}

function rebuildBriefs({ now = Date.now(), days = 30 } = {}) {
  const briefs = buildStoryBriefs(store.items, { now, days });
  store.saveBriefs(briefs);
  return { rebuilt: briefs.length, generatedAt: new Date(now).toISOString() };
}

function briefRanking(brief, monitors = store.listMonitors(), preferences = store.listReaderPreferences()) {
  const matched = monitors.filter((monitor) => monitorMatchesBrief(brief, monitor)).sort((left, right) => right.priority - left.priority);
  const reasons = matched.map((monitor) => `命中监控：${monitor.name}`);
  const sourceIds = new Set(brief.sources.map((source) => source.sourceId));
  const sourceProfiles = [...sourceIds].map((sourceId) => store.sources.find((candidate) => candidate.id === sourceId)).filter(Boolean);
  const healthScores = sourceProfiles.map((source) => {
    const status = sourceHealth(source, store.getSourceState(source.id) ?? { status: 'pending' }).status;
    return { ok: 3, degraded: 2, pending: 1, error: 0 }[status] ?? 1;
  });
  const sourceQuality = healthScores.length ? healthScores.reduce((sum, score) => sum + score, 0) / healthScores.length : 0;
  const authorityScore = sourceProfiles.length ? sourceProfiles.reduce((sum, source) => sum + ({ 1: 10, 2: 6, 3: 2 }[Number(source.tier)] ?? 3), 0) / sourceProfiles.length : 0;
  const channels = [...new Set(sourceProfiles.map((source) => source.channel || 'media'))];
  const primaryCount = sourceProfiles.filter((source) => Number(source.tier) === 1 && ['official', 'research', 'release', 'papers'].includes(source.channel)).length;
  const communityOnly = sourceProfiles.length > 0 && sourceProfiles.every((source) => ['social', 'community'].includes(source.channel));
  const behaviorScore = preferences.reduce((sum, preference) => {
    if (preference.dimension === 'category' && brief.topics.includes(preference.target)) return sum + preference.score;
    if (preference.dimension === 'source' && sourceIds.has(preference.target)) return sum + preference.score;
    return sum;
  }, 0);
  if (sourceIds.size > 1) reasons.push(`${sourceIds.size} 个独立来源相互印证`);
  if (primaryCount) reasons.push(`${primaryCount} 个一手／研究来源`);
  if (behaviorScore) reasons.push(`${behaviorScore > 0 ? '本地偏好' : '本地少看反馈'}加权`);
  if (!reasons.length) reasons.push(brief.selected ? '重要度达到精选门槛' : '最新事件更新');
  const evidenceGrade = sourceIds.size >= 2 && (primaryCount > 0 || channels.length >= 2) ? 'A' : primaryCount > 0 || sourceIds.size >= 2 ? 'B' : 'C';
  const continuing = new Date(brief.lastPublishedAt).valueOf() > new Date(brief.firstPublishedAt).valueOf();
  const eventScore = Math.max(0, Math.min(140,
    Number(brief.importance || 0)
    + Math.min(16, Math.max(0, sourceIds.size - 1) * 7)
    + Math.min(8, Math.max(0, channels.length - 1) * 4)
    + (continuing ? 5 : 0)
    + authorityScore
    + Math.max(-10, Math.min(10, behaviorScore * 2))
    - (communityOnly && sourceIds.size < 2 ? 24 : 0)
  ));
  return {
    monitorPriority: matched[0]?.priority ?? 0,
    monitorIds: matched.map((monitor) => monitor.id),
    sourceQuality,
    authorityScore,
    behaviorScore,
    eventScore,
    sourceCount: sourceIds.size,
    channelCount: channels.length,
    channels,
    primaryCount,
    communityOnly,
    evidenceGrade,
    reasons
  };
}

function publicBrief(brief, monitors, preferences) {
  return { ...brief, ranking: briefRanking(brief, monitors, preferences) };
}

function getBriefs(search = new URLSearchParams()) {
  const take = Math.max(1, Math.min(Number(search.get('take')) || 12, 50));
  const scope = search.get('scope') === 'all' ? 'all' : 'selected';
  const readerView = ['all', 'unread', 'saved', 'hidden'].includes(search.get('reader')) ? search.get('reader') : 'all';
  const query = (search.get('q') || '').trim().toLowerCase();
  const topic = search.get('topic');
  const lens = ['all', 'verified', 'primary', 'community'].includes(search.get('lens')) ? search.get('lens') : 'all';
  const sourceId = search.get('source');
  const explicitSince = search.get('since');
  const since = explicitSince ? new Date(explicitSince).valueOf() : Date.now() - 7 * 24 * 3_600_000;
  const monitors = store.listMonitors().filter((monitor) => monitor.enabled);
  const preferences = store.listReaderPreferences();
  const all = store.listBriefs();
  const visible = all
    .filter((brief) => scope === 'all' || brief.selected)
    .filter((brief) => !Number.isFinite(since) || new Date(brief.lastPublishedAt).valueOf() >= since)
    .filter((brief) => !topic || topic === 'all' || brief.topics.includes(topic))
    .filter((brief) => !sourceId || sourceId === 'all' || brief.sources.some((source) => source.sourceId === sourceId))
    .filter((brief) => !query || `${brief.headline} ${brief.summaryClaims.map((claim) => claim.text).join(' ')} ${brief.topics.join(' ')} ${brief.entities.join(' ')} ${brief.reader.note}`.toLowerCase().includes(query))
    .filter((brief) => readerView === 'hidden' ? Boolean(brief.reader.hiddenAt) : !brief.reader.hiddenAt)
    .filter((brief) => readerView !== 'saved' || Boolean(brief.reader.savedAt))
    .filter((brief) => readerView !== 'unread' || !brief.reader.readAt)
    .map((brief) => publicBrief(brief, monitors, preferences))
    .filter((brief) => lens === 'all'
      || (lens === 'verified' && brief.ranking.evidenceGrade === 'A')
      || (lens === 'primary' && brief.ranking.primaryCount > 0)
      || (lens === 'community' && brief.ranking.channels.some((channel) => ['community', 'social', 'blog', 'newsletter'].includes(channel))))
    .sort((left, right) => right.ranking.monitorPriority - left.ranking.monitorPriority || right.ranking.eventScore - left.ranking.eventScore || new Date(right.lastPublishedAt) - new Date(left.lastPublishedAt));
  const cursor = search.get('cursor') ? cursorFrom(search.get('cursor')) : null;
  const start = cursor ? Math.max(0, visible.findIndex((brief) => brief.id === cursor.id) + 1) : 0;
  const briefs = visible.slice(start, start + take);
  const activeCutoff = Date.now() - 7 * 24 * 3_600_000;
  const activeUnread = all.filter((brief) => brief.selected && !brief.reader.hiddenAt && !brief.reader.readAt && new Date(brief.lastPublishedAt).valueOf() >= activeCutoff).length;
  return {
    briefs,
    nextCursor: start + take < visible.length && briefs.length ? Buffer.from(JSON.stringify({ id: briefs.at(-1).id })).toString('base64url') : null,
    meta: { total: visible.length, activeUnread, scope, readerView, lens, generatedAt: new Date().toISOString(), monitors: monitors.length }
  };
}

function getBriefWorkspace() {
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const briefs = store.listBriefs().filter((brief) => !brief.reader.hiddenAt);
  const monitors = store.listMonitors().filter((monitor) => monitor.enabled);
  const preferences = store.listReaderPreferences();
  const ranked = (values) => values.map((brief) => publicBrief(brief, monitors, preferences)).sort((left, right) => right.ranking.monitorPriority - left.ranking.monitorPriority || right.ranking.eventScore - left.ranking.eventScore || new Date(right.lastPublishedAt) - new Date(left.lastPublishedAt));
  const toRead = ranked(briefs.filter((brief) => brief.selected && !brief.reader.readAt && new Date(brief.lastPublishedAt).valueOf() >= cutoff));
  const saved = ranked(briefs.filter((brief) => brief.reader.savedAt));
  const noted = ranked(briefs.filter((brief) => brief.reader.note));
  return {
    summary: { activeUnread: toRead.length, saved: saved.length, noted: noted.length },
    sections: { toRead: toRead.slice(0, 12), saved: saved.slice(0, 12), noted: noted.slice(0, 12) },
    meta: { generatedAt: new Date().toISOString(), activeWindowDays: 7 }
  };
}

function getBriefWeeklyReview() {
  const since = Date.now() - 7 * 24 * 3_600_000;
  const briefs = store.listBriefs().filter((brief) => !brief.reader.hiddenAt);
  const monitors = store.listMonitors().filter((monitor) => monitor.enabled);
  const preferences = store.listReaderPreferences();
  const recentState = (brief, field) => brief.reader[field] && new Date(brief.reader[field]).valueOf() >= since;
  const read = briefs.filter((brief) => recentState(brief, 'readAt'));
  const saved = briefs.filter((brief) => recentState(brief, 'savedAt'));
  const noted = briefs.filter((brief) => brief.reader.note && recentState(brief, 'updatedAt'));
  const continuing = briefs.filter((brief) => brief.sources.length > 1 && new Date(brief.lastPublishedAt).valueOf() >= since && new Date(brief.lastPublishedAt) > new Date(brief.firstPublishedAt));
  const next = briefs.filter((brief) => brief.reader.savedAt && !brief.reader.readAt);
  const shape = (values) => values.map((brief) => publicBrief(brief, monitors, preferences)).sort((left, right) => new Date(right.lastPublishedAt) - new Date(left.lastPublishedAt)).slice(0, 12);
  return {
    window: { start: new Date(since).toISOString(), end: new Date().toISOString() },
    summary: { read: read.length, saved: saved.length, noted: noted.length, continuing: continuing.length, next: next.length },
    sections: { read: shape(read), saved: shape(saved), noted: shape(noted), continuing: shape(continuing), next: shape(next) },
    meta: { generatedAt: new Date().toISOString() }
  };
}

function publicIssue(issue) {
  if (!Array.isArray(issue.briefs)) return issue;
  const monitors = store.listMonitors().filter((monitor) => monitor.enabled);
  const preferences = store.listReaderPreferences();
  return {
    ...issue,
    briefs: issue.briefs.map((snapshot) => publicBrief({
      ...snapshot,
      reader: store.getBriefReaderState(snapshot.id) ?? { briefId: snapshot.id, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: null }
    }, monitors, preferences))
  };
}

function briefFeedItems(briefs) {
  return briefs.map((brief) => ({
    id: brief.id,
    title: brief.headline,
    url: brief.sources[0]?.url || `http://127.0.0.1:8788/#/brief/${brief.id}`,
    publishedAt: brief.lastPublishedAt,
    summary: brief.summaryClaims.map((claim) => claim.text).join(' ')
  }));
}

function nextPollIso(source, failureCount = 0, retryAfterAt = null) {
  const minutes = failureCount ? jitteredBackoffMinutes(failureCount) : Math.max(1, source.pollMinutes || 60);
  const scheduled = Date.now() + minutes * 60_000;
  const requested = retryAfterAt ? new Date(retryAfterAt).valueOf() : 0;
  return new Date(Math.max(scheduled, Number.isFinite(requested) ? requested : 0)).toISOString();
}

function ensureSourceStates() {
  const deterministicOffset = (source) => {
    const hash = [...source.id].reduce((sum, character) => ((sum * 31) + character.charCodeAt(0)) >>> 0, 0);
    const windowMs = Math.min(6 * 3_600_000, Math.max(60_000, Number(source.pollMinutes || 180) * 60_000));
    return hash % windowMs;
  };
  for (const source of store.sources) {
    if (!store.getSourceState(source.id)) store.upsertSourceState(source.id, { status: 'pending', nextPollAt: new Date(Date.now() + 10_000 + deterministicOffset(source)).toISOString(), failureCount: 0 });
  }
}

function sourceHost(source) {
  if (source.connector === 'x-user') return 'api.x.com';
  if (source.connector === 'reddit-subreddit') return 'oauth.reddit.com';
  try { return new URL(source.feedUrl).hostname; } catch { return source.id; }
}

async function ingestSources(targets, { reason = 'manual' } = {}) {
  if (ingestionInFlight) return { busy: true, reason, results: [] };
  const job = store.startJob('ingestion', reason, { sourceIds: targets.map((source) => source.id) });
  ingestionInFlight = (async () => {
    const activeTargets = targets.filter((source) => source.enabled && (source.feedUrl || ['x-user', 'reddit-subreddit'].includes(source.connector)));
    const results = await mapConcurrentByKey(activeTargets, 4, sourceHost, async (source) => {
      const startedAt = new Date().toISOString();
      try {
        const result = await ingestSource(store, source);
        store.upsertSourceState(source.id, {
          status: 'ok', lastAttemptAt: startedAt, lastSuccessAt: new Date().toISOString(), nextPollAt: nextPollIso(source), failureCount: 0,
          lastError: null, entries: result.entries ?? 0, inserted: result.inserted ?? 0, duplicates: result.duplicates ?? 0,
          httpStatus: result.httpStatus ?? null, etag: result.etag, lastModified: result.lastModified,
          failureKind: null, retryAfterAt: null, lastDurationMs: result.durationMs ?? null
        });
        return result;
      } catch (error) {
        const previous = store.getSourceState(source.id);
        const failureCount = (previous?.failureCount ?? 0) + 1;
        const classified = classifyFeedError(error);
        const result = { source: source.id, error: classified.message, failureKind: classified.kind, httpStatus: classified.httpStatus, retryAfterAt: classified.retryAfterAt, failureCount };
        store.upsertSourceState(source.id, {
          status: 'error', lastAttemptAt: startedAt, nextPollAt: nextPollIso(source, failureCount, classified.retryAfterAt), failureCount,
          lastError: classified.message.slice(0, 240), failureKind: classified.kind, httpStatus: classified.httpStatus,
          retryAfterAt: classified.retryAfterAt, lastDurationMs: Date.now() - new Date(startedAt).valueOf()
        });
        return result;
      }
    }, { minDelayMs: (host) => host === 'api.github.com' ? 900 : host.includes('reddit') ? 1_500 : 150 });
    const failed = results.filter((result) => result.error).length;
    let storage = null;
    try { storage = store.checkpoint(); }
    catch (error) { console.error('SQLite checkpoint after ingestion failed:', error); }
    store.finishJob(job.id, { status: failed === results.length && results.length ? 'failed' : 'completed', processed: results.length, succeeded: results.length - failed, failed, details: { results, storage } });
    const briefs = rebuildBriefs();
    return { busy: false, reason, results, storage, briefs };
  })();
  try {
    const result = await ingestionInFlight;
    if (result.results.some((entry) => entry.inserted > 0)) void runEnrichment({ reason: 'after-ingestion' });
    return result;
  } finally { ingestionInFlight = null; }
}

async function runEnrichment({ take = 30, force = false, itemId = null, reason = 'manual' } = {}) {
  if (enrichmentInFlight) return { busy: true, reason };
  enrichmentInFlight = enrichItems(store, { take, force, itemId });
  try {
    const result = await enrichmentInFlight;
    return { busy: false, reason, ...result, briefs: rebuildBriefs() };
  }
  finally { enrichmentInFlight = null; }
}

async function trimServiceLogs() {
  await mkdir(logsDir, { recursive: true });
  const trimmed = [];
  for (const entry of await readdir(logsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const file = path.join(logsDir, entry.name);
    const details = await stat(file);
    if (details.size <= retentionPolicy.maxLogBytes) continue;
    const contents = await readFile(file);
    await writeFile(file, contents.subarray(-retentionPolicy.maxLogBytes));
    trimmed.push({ name: entry.name, fromBytes: details.size, toBytes: retentionPolicy.maxLogBytes });
  }
  return trimmed;
}

async function runMaintenance({ reason = 'scheduled' } = {}) {
  if (maintenanceInFlight) return { busy: true, reason };
  const job = store.startJob('maintenance', reason, { retention: retentionPolicy });
  maintenanceInFlight = (async () => {
    const result = await store.maintain({
      itemRetentionDays: retentionPolicy.itemDays,
      issueRetentionDays: retentionPolicy.issueDays,
      jobRetentionDays: retentionPolicy.jobDays,
      backupRetention: retentionPolicy.backups
    });
    const logs = await trimServiceLogs();
    store.finishJob(job.id, { status: 'completed', processed: result.removed.items + result.removed.issues + result.removed.jobs, succeeded: 1, details: { ...result, logs } });
    return { ...result, logs };
  })();
  try { return { busy: false, reason, ...(await maintenanceInFlight) }; }
  catch (error) {
    store.finishJob(job.id, { status: 'failed', failed: 1, error: error.message, details: { retention: retentionPolicy } });
    throw error;
  } finally { maintenanceInFlight = null; }
}

function sourceSummary() {
  return summarizeSourceHealth(store.sources, (sourceId) => store.getSourceState(sourceId));
}

function schedulerSnapshot(now = new Date()) {
  const states = store.sources.filter((source) => source.enabled).map((source) => store.getSourceState(source.id)).filter(Boolean);
  const latestSuccessAt = states.map((state) => state.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null;
  const nextFeedPollAt = states.map((state) => state.nextPollAt).filter(Boolean).sort().at(0) ?? null;
  return {
    ingestionRunning: Boolean(ingestionInFlight),
    enrichmentRunning: Boolean(enrichmentInFlight),
    maintenanceRunning: Boolean(maintenanceInFlight),
    lastSuccessfulFetchAt: latestSuccessAt,
    nextFeedPollAt,
    nextMorningRefreshAt: new Date(now.valueOf() + millisecondsUntilShanghai(7, 40, now)).toISOString(),
    nextDailyIssueAt: new Date(now.valueOf() + millisecondsUntilShanghai(8, 5, now)).toISOString(),
    rules: updateRules,
    ...sourceSummary()
  };
}

function queueSummary() {
  const cutoff = Date.now() - ENRICHMENT_MAX_AGE_HOURS * 3_600_000;
  const review = store.items.filter((item) => item.review?.status === 'unreviewed' && item.enrichment?.status === 'completed' && (item.enrichment.requiresReview || item.enrichment.confidence < 0.75)).length;
  return {
    pending: store.items.filter((item) => item.enrichment?.status === 'pending' && new Date(item.publishedAt).valueOf() >= cutoff && ruleScore(item) >= ENRICHMENT_MIN_RULE_SCORE && !isRoutineVersion(item)).length,
    skippedStale: store.items.filter((item) => item.enrichment?.status === 'skipped_stale').length,
    processing: store.items.filter((item) => item.enrichment?.status === 'processing').length,
    failed: store.items.filter((item) => item.enrichment?.status === 'failed').length,
    review
  };
}

function dailyWindow(date) {
  const end = new Date(`${date}T08:05:00+08:00`);
  return { windowStart: new Date(end.valueOf() - 24 * 3_600_000).toISOString(), windowEnd: end.toISOString() };
}

function publicHealth() {
  return {
    ok: true,
    date: dateInShanghai(),
    database: store.databaseInfo(),
    scheduler: schedulerSnapshot(),
    enrichment: { configured: Boolean(configuredEnricher()), provider: configuredEnricher()?.label ?? null, ...queueSummary() },
    retention: retentionPolicy,
    latestDaily: store.issues[0] ? { date: store.issues[0].date, status: store.issues[0].status, generatedAt: store.issues[0].generatedAt } : null
  };
}

function adminOverview() {
  return {
    ...publicHealth(),
    usage: store.usageTotals(),
    sources: store.sources.map((source) => ({ id: source.id, name: source.name, kind: source.kind, enabled: source.enabled, pollMinutes: source.pollMinutes, state: sourceHealth(source, store.getSourceState(source.id) ?? { status: 'pending' }) })),
    jobs: store.listJobs(30),
    todayIssue: store.issues.find((issue) => issue.date === dateInShanghai()) ?? null
  };
}

function adminItems(state, take = 30) {
  const matches = store.items.filter((item) => {
    if (state === 'failed') return item.enrichment?.status === 'failed';
    if (state === 'review') return item.review?.status === 'unreviewed' && item.enrichment?.status === 'completed' && (item.enrichment.requiresReview || item.enrichment.confidence < 0.75);
    return item.enrichment?.status === 'pending' && new Date(item.publishedAt).valueOf() >= Date.now() - ENRICHMENT_MAX_AGE_HOURS * 3_600_000 && ruleScore(item) >= ENRICHMENT_MIN_RULE_SCORE && !isRoutineVersion(item);
  });
  return matches.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, Math.max(1, Math.min(Number(take) || 30, 100)));
}

async function bodyOf(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 250_000) throw new Error('payload too large');
  }
  return value ? JSON.parse(value) : {};
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requested).replace(/^\/+/, '');
  if (normalized.startsWith('..')) return send(response, 403, 'Forbidden');
  try {
    const file = path.join(publicDir, normalized);
    const content = await readFile(file);
    send(response, 200, content, { 'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream' });
  } catch { send(response, 404, 'Not found'); }
}

async function runDaily(date = dateInShanghai(), { force = false, reason = 'scheduled', backup = false } = {}) {
  const job = store.startJob('daily', reason, { date, force });
  try {
    const window = dailyWindow(date);
    rebuildBriefs();
    const result = await generateDailyIssue(store, date, { force, health: { ...sourceSummary(), enrichment: queueSummary(), capturedAt: new Date().toISOString() }, ...window });
    if (result.created || result.rebuilt) {
      const start = new Date(window.windowStart).valueOf();
      const end = new Date(window.windowEnd).valueOf();
      result.issue.briefs = store.listBriefs()
        .filter((brief) => brief.selected && new Date(brief.lastPublishedAt).valueOf() >= start && new Date(brief.lastPublishedAt).valueOf() < end)
        .sort((left, right) => right.importance - left.importance || new Date(right.lastPublishedAt) - new Date(left.lastPublishedAt))
        .slice(0, 20)
        .map(({ reader: _reader, sources, ...brief }) => ({ ...brief, sources: sources.map(({ note: _note, ...source }) => source) }));
      result.issue.briefIds = result.issue.briefs.map((brief) => brief.id);
      result.issue.quality = {
        status: result.issue.briefs.some((brief) => brief.quality.status !== 'ready') ? 'degraded' : 'ready',
        ready: result.issue.briefs.filter((brief) => brief.quality.status === 'ready').length,
        fallback: result.issue.briefs.filter((brief) => brief.quality.status !== 'ready').length,
        cutoffAt: new Date(`${date}T08:03:00+08:00`).toISOString(),
        generatedWithoutBlockingOnModel: true
      };
      result.issue.status = result.issue.health.degraded || result.issue.quality.status === 'degraded' ? 'degraded' : 'complete';
      await store.saveIssue(result.issue);
    }
    const maintenance = await runMaintenance({ reason: `${reason}-daily` });
    const backupResult = backup ? await store.backup({ retain: retentionPolicy.backups }) : null;
    store.finishJob(job.id, { status: 'completed', processed: result.issue.briefIds?.length ?? result.issue.itemIds.length, succeeded: result.issue.briefIds?.length ?? result.issue.itemIds.length, details: { date, window, created: result.created, rebuilt: result.rebuilt, quality: result.issue.quality, maintenance, backup: backupResult } });
    return { ...result, maintenance, backup: backupResult };
  } catch (error) {
    store.finishJob(job.id, { status: 'failed', failed: 1, error: error.message, details: { date } });
    throw error;
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;
  const isAdmin = pathname.startsWith('/api/admin/');
  const isReaderMutation = ['/api/reader/state', '/api/reader/brief-state', '/api/reader/feedback'].includes(pathname) && request.method === 'POST';
  const isLocalMutation = ((['/api/local/library/import', '/api/local/library/backup', '/api/local/preferences/clear'].includes(pathname) && request.method === 'POST')
    || (pathname.startsWith('/api/local/monitors') && ['POST', 'PATCH', 'DELETE'].includes(request.method))
    || (pathname.startsWith('/api/local/sources') && ['POST', 'PATCH'].includes(request.method)));
  if ((isAdmin || isReaderMutation || isLocalMutation) && !adminSameOrigin(request)) return json(response, 403, { error: 'cross-origin write request blocked' }, { publicCors: false });
  if (request.method === 'OPTIONS') return send(response, 204, '', isAdmin ? {} : { 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type, authorization' }, { publicCors: !isAdmin });
  if (isAdmin && !adminAuthorized(request)) return json(response, 401, { error: 'unauthorized' }, { publicCors: false });
  if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, publicHealth());
  if (request.method === 'GET' && pathname === '/api/public/briefs') return json(response, 200, getBriefs(searchParams));
  if (request.method === 'GET' && pathname === '/api/public/briefs/workspace') return json(response, 200, getBriefWorkspace());
  if (request.method === 'GET' && pathname === '/api/public/briefs/weekly') return json(response, 200, getBriefWeeklyReview());
  if (request.method === 'GET' && pathname.startsWith('/api/public/briefs/')) {
    const brief = store.getBrief(decodeURIComponent(pathname.slice('/api/public/briefs/'.length)));
    return brief ? json(response, 200, { brief: publicBrief(brief) }) : json(response, 404, { error: '简报不存在' });
  }
  if (request.method === 'GET' && pathname === '/api/public/items') return json(response, 200, getItems(searchParams));
  if (request.method === 'GET' && pathname === '/api/public/reader/workspace') return json(response, 200, getReaderWorkspace());
  if (request.method === 'GET' && pathname === '/api/public/reader/weekly') return json(response, 200, getWeeklyReview());
  if (request.method === 'GET' && pathname.startsWith('/api/public/items/')) {
    const item = getPublicItem(decodeURIComponent(pathname.slice('/api/public/items/'.length)));
    return item ? json(response, 200, { item }) : json(response, 404, { error: '新闻不存在' });
  }
  if (request.method === 'GET' && pathname === '/api/public/sources') {
    const sources = store.sources.map(({ id, name, kind, channel, tier, topics, language, author, homepage, enabled, pollMinutes, allowArticleFetch, connector, setupRequired, disabledReason, aiEligible }) => ({
      id,
      name,
      kind,
      channel: channel || (kind === 'first-party' ? 'official' : kind === 'social' ? 'social' : 'media'),
      channelLabel: SOURCE_CHANNEL_LABELS[channel] || channel || SOURCE_KIND_LABELS[kind] || kind,
      tier: Number(tier) || 3,
      topics: topics || [],
      language: language || 'en',
      author: author || '',
      homepage,
      enabled,
      pollMinutes,
      connector: connector || 'feed',
      setupRequired: setupRequired || null,
      disabledReason: disabledReason || null,
      aiEligible: aiEligible !== false,
      allowArticleFetch: allowArticleFetch ?? !id.endsWith('-releases'),
      health: sourceHealth({ id, enabled, pollMinutes }, store.getSourceState(id) ?? { status: 'pending' })
    }));
    return json(response, 200, { sources, meta: { ...sourceCatalogSummary(store.sources), channelLabels: SOURCE_CHANNEL_LABELS } });
  }
  if (request.method === 'GET' && pathname === '/api/public/daily') return json(response, 200, { issues: store.issues.map(publicIssue) });
  if (request.method === 'GET' && pathname.startsWith('/api/public/daily/')) {
    const issue = store.issues.find((candidate) => candidate.date === pathname.split('/').at(-1));
    return issue ? json(response, 200, publicIssue(issue)) : json(response, 404, { error: '日报不存在' });
  }
  if (request.method === 'GET' && pathname === '/feeds/briefs.xml') {
    const briefs = getBriefs(new URLSearchParams('scope=selected&take=50')).briefs;
    return send(response, 200, itemFeed(briefFeedItems(briefs), 'AI HOT 今日简报', '可追溯的 AI 事件简报', `${url.protocol}//${url.host}`), { 'content-type': 'application/rss+xml; charset=utf-8' });
  }
  if (request.method === 'GET' && ['/feeds/selected.xml', '/feeds/all.xml', '/feeds/daily.xml'].includes(pathname)) {
    const isDaily = pathname.endsWith('daily.xml');
    const items = isDaily ? (store.issues[0]?.sections.flatMap((section) => section.items) ?? []) : getItems(new URLSearchParams(`mode=${pathname.includes('selected') ? 'selected' : 'all'}&take=50`)).items;
    return send(response, 200, itemFeed(items, isDaily ? 'AI HOT 日报' : pathname.includes('selected') ? 'AI HOT 精选' : 'AI HOT 全部动态', 'AI 新闻聚合 RSS', `${url.protocol}//${url.host}`), { 'content-type': 'application/rss+xml; charset=utf-8' });
  }
  if (request.method === 'GET' && pathname === '/openapi.yaml') return send(response, 200, await readFile(path.join(here, 'openapi.yaml')), { 'content-type': mimeTypes['.yaml'] });
  if (request.method === 'GET' && pathname === '/.well-known/ai-news-skill.md') return send(response, 200, await readFile(path.join(here, 'agent', 'SKILL.md')), { 'content-type': 'text/markdown; charset=utf-8' });
  if (request.method === 'GET' && pathname === '/api/admin/overview') return json(response, 200, adminOverview(), { publicCors: false });
  if (request.method === 'GET' && pathname === '/api/admin/items') return json(response, 200, { state: searchParams.get('state') || 'pending', items: adminItems(searchParams.get('state') || 'pending', searchParams.get('take')) }, { publicCors: false });
  if (request.method === 'POST' && pathname === '/api/admin/daily') {
    const { date = dateInShanghai(), force = false } = await bodyOf(request);
    return json(response, 201, await runDaily(date, { force: Boolean(force), reason: 'manual' }), { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/admin/ingest') {
    const { sourceId } = await bodyOf(request);
    const targets = sourceId ? store.sources.filter((source) => source.id === sourceId) : store.sources;
    if (sourceId && !targets.length) return json(response, 404, { error: 'source not found' }, { publicCors: false });
    const result = await ingestSources(targets, { reason: 'manual' });
    return json(response, result.busy ? 409 : 200, result, { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/admin/enrich') {
    const { take = 30, force = false, itemId = null } = await bodyOf(request);
    const result = await runEnrichment({ take, force: Boolean(force), itemId, reason: 'manual' });
    return json(response, result.busy ? 409 : 200, result, { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/admin/review') {
    const { id, ...changes } = await bodyOf(request);
    if (typeof id !== 'string' || !id) return json(response, 400, { error: 'id is required' }, { publicCors: false });
    return json(response, 200, { item: await reviewItem(store, id, changes) }, { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/reader/state') {
    const { id, action, note } = await bodyOf(request);
    if (typeof id !== 'string' || !id || typeof action !== 'string') return json(response, 400, { error: 'id and action are required' }, { publicCors: false });
    try { return json(response, 200, { state: store.updateReaderState(id, action, note) }, { publicCors: false }); }
    catch (error) { return json(response, error.message === 'item not found' ? 404 : 400, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'POST' && pathname === '/api/reader/brief-state') {
    const { id, action, note } = await bodyOf(request);
    if (typeof id !== 'string' || !id || typeof action !== 'string') return json(response, 400, { error: 'id and action are required' }, { publicCors: false });
    try { return json(response, 200, { state: store.updateBriefReaderState(id, action, note) }, { publicCors: false }); }
    catch (error) { return json(response, error.message === 'brief not found' ? 404 : 400, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'POST' && pathname === '/api/reader/feedback') {
    const { id, action } = await bodyOf(request);
    if (typeof id !== 'string' || !id || typeof action !== 'string') return json(response, 400, { error: 'id and action are required' }, { publicCors: false });
    const item = store.items.find((candidate) => candidate.id === id && candidate.status === 'published');
    if (!item) return json(response, 404, { error: '新闻不存在' }, { publicCors: false });
    try { return json(response, 200, store.updateReaderFeedback(item, action), { publicCors: false }); }
    catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'GET' && pathname === '/api/local/library') return json(response, 200, await getLocalLibrary(), { publicCors: false });
  if (request.method === 'GET' && pathname === '/api/local/monitors') return json(response, 200, { monitors: store.listMonitors() }, { publicCors: false });
  if (request.method === 'POST' && pathname === '/api/local/monitors') {
    try { return json(response, 201, { monitor: store.saveMonitor(normalizeMonitor(await bodyOf(request))) }, { publicCors: false }); }
    catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
  }
  if (pathname.startsWith('/api/local/monitors/')) {
    const id = decodeURIComponent(pathname.slice('/api/local/monitors/'.length));
    const current = store.getMonitor(id);
    if (!current) return json(response, 404, { error: '监控器不存在' }, { publicCors: false });
    if (request.method === 'PATCH') {
      try { return json(response, 200, { monitor: store.saveMonitor(normalizeMonitor(await bodyOf(request), current)) }, { publicCors: false }); }
      catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
    }
    if (request.method === 'DELETE') return json(response, 200, { deleted: Boolean(store.deleteMonitor(id)), id }, { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/local/sources/opml') {
    try {
      const { opml } = await bodyOf(request);
      const added = parseOpmlSources(opml, { existingFeedUrls: store.sources.map((source) => source.feedUrl) });
      await store.replaceSources([...store.sources, ...added]);
      ensureSourceStates();
      return json(response, 201, { imported: added.length, sources: added }, { publicCors: false });
    } catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
  }
  if (pathname.startsWith('/api/local/sources/')) {
    const suffix = pathname.slice('/api/local/sources/'.length);
    const retry = suffix.endsWith('/retry');
    const id = decodeURIComponent(retry ? suffix.slice(0, -'/retry'.length) : suffix);
    const source = store.sources.find((candidate) => candidate.id === id);
    if (!source) return json(response, 404, { error: 'source not found' }, { publicCors: false });
    if (request.method === 'PATCH' && !retry) {
      const payload = await bodyOf(request);
      if (payload.enabled === undefined) return json(response, 400, { error: 'enabled is required' }, { publicCors: false });
      const sources = store.sources.map((candidate) => candidate.id === id ? { ...candidate, enabled: Boolean(payload.enabled) } : candidate);
      await store.replaceSources(sources);
      return json(response, 200, { source: store.sources.find((candidate) => candidate.id === id) }, { publicCors: false });
    }
    if (request.method === 'POST' && retry) {
      const result = await ingestSources([{ ...source, enabled: true }], { reason: 'single-source-retry' });
      return json(response, result.busy ? 409 : 200, result, { publicCors: false });
    }
  }
  if (request.method === 'GET' && pathname === '/api/local/library/export') {
    const format = searchParams.get('format') === 'markdown' ? 'markdown' : searchParams.get('format') === 'json' ? 'json' : null;
    if (!format) return json(response, 400, { error: 'format must be json or markdown' }, { publicCors: false });
    const snapshot = store.readerLibrarySnapshot();
    const extension = format === 'markdown' ? 'md' : 'json';
    const content = format === 'markdown' ? libraryMarkdown(snapshot) : JSON.stringify(snapshot, null, 2);
    return send(response, 200, content, { 'content-type': format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="ai-hot-library-${dateInShanghai()}.${extension}"` }, { publicCors: false });
  }
  if (request.method === 'POST' && pathname === '/api/local/library/backup') {
    try {
      const backup = await store.backup({ retain: retentionPolicy.backups });
      return json(response, 201, { backup: { name: path.basename(backup.file), removed: backup.removed }, backups: await store.listBackups() }, { publicCors: false });
    } catch (error) { return json(response, 500, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'POST' && pathname === '/api/local/library/import') {
    const { snapshot } = await bodyOf(request);
    try {
      const backup = await store.backup({ retain: retentionPolicy.backups });
      const imported = store.importReaderLibrary(snapshot);
      return json(response, 200, { imported, backup: { name: path.basename(backup.file), removed: backup.removed }, library: await getLocalLibrary() }, { publicCors: false });
    } catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'POST' && pathname === '/api/local/preferences/clear') {
    const { dimension, target } = await bodyOf(request);
    try { return json(response, 200, store.clearReaderPreference(dimension, target), { publicCors: false }); }
    catch (error) { return json(response, 400, { error: error.message }, { publicCors: false }); }
  }
  if (request.method === 'GET' && pathname === '/api/meta') return json(response, 200, { categories: CATEGORY_LABELS, sourceKinds: SOURCE_KIND_LABELS });
  if (request.method === 'GET') return serveStatic(response, pathname);
  return json(response, 405, { error: 'method not allowed' }, { publicCors: !isAdmin });
}

function millisecondsUntilShanghai(hour, minute, now = new Date()) {
  const shiftedNow = new Date(now.valueOf() + 8 * 3_600_000);
  const shiftedNext = new Date(shiftedNow);
  shiftedNext.setUTCHours(hour, minute, 0, 0);
  if (shiftedNext <= shiftedNow) shiftedNext.setUTCDate(shiftedNext.getUTCDate() + 1);
  return shiftedNext - shiftedNow;
}

function startSchedulers() {
  ensureSourceStates();
  setTimeout(() => { void runMaintenance({ reason: 'startup' }).catch((error) => console.error('Startup maintenance failed:', error)); }, 3_000);
  const tick = () => {
    const now = Date.now();
    const due = store.sources.filter((source) => source.enabled && now >= new Date(store.getSourceState(source.id)?.nextPollAt ?? 0).valueOf());
    if (due.length) void ingestSources(due, { reason: 'scheduled' }).catch((error) => console.error('Scheduled ingestion failed:', error));
  };
  setTimeout(tick, 10_000);
  setInterval(tick, 60_000);

  const scheduleMorning = () => setTimeout(async () => {
    try {
      await ingestSources(store.sources, { reason: 'morning-refresh' });
      await runEnrichment({ take: 30, reason: 'morning-refresh' });
    } catch (error) {
      console.error('Morning refresh failed:', error);
    } finally {
      scheduleMorning();
    }
  }, millisecondsUntilShanghai(7, 40));
  const scheduleDaily = () => setTimeout(async () => {
    try { await runDaily(dateInShanghai(), { reason: 'scheduled', backup: true }); }
    catch (error) { console.error('Scheduled daily issue failed:', error); }
    finally { scheduleDaily(); }
  }, millisecondsUntilShanghai(8, 5));
  scheduleMorning();
  scheduleDaily();

  const shifted = new Date(Date.now() + 8 * 3_600_000);
  const afterDailyTime = shifted.getUTCHours() > 8 || (shifted.getUTCHours() === 8 && shifted.getUTCMinutes() >= 5);
  if (afterDailyTime && !store.issues.some((issue) => issue.date === dateInShanghai())) {
    setTimeout(async () => {
      try {
        await ingestSources(store.sources, { reason: 'startup-catchup' });
        await runEnrichment({ take: 30, reason: 'startup-catchup' });
        await runDaily(dateInShanghai(), { reason: 'startup-catchup', backup: true });
      } catch (error) {
        console.error('Startup catch-up failed:', error);
      }
    }, 2_000);
  }
}

const port = Number(process.env.PORT || 8788);
const host = '127.0.0.1';
const server = createServer((request, response) => route(request, response).catch((error) => json(response, 500, { error: error.message }, { publicCors: !request.url.startsWith('/api/admin/') })));
server.listen(port, host, () => {
  console.log(`AI HOT v0.9 running at http://${host}:${port}`);
  if (store.migration.importedItems || store.migration.importedIssues) console.log(`SQLite migration imported ${store.migration.importedItems} items and ${store.migration.importedIssues} issues.`);
});

if (process.env.DISABLE_SCHEDULER !== '1') startSchedulers();

function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
