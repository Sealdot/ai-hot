import { createHash, randomUUID } from 'node:crypto';
import { CATEGORY_LABELS, cleanText, editorialScore, isEditoriallySelected, isRoutineVersion } from './content.mjs';

const HOUR = 3_600_000;
const GENERIC_WHY = '该动态已被纳入 AI 新闻流，等待更多信源和用户反馈验证其影响。';
const COMMON_TOKENS = new Set([
  'about', 'after', 'again', 'agent', 'with', 'from', 'into', 'that', 'this', 'the', 'and', 'for', 'are',
  'new', 'release', 'releases', 'update', 'updates', 'introducing', 'announcing', 'using', 'your', 'more',
  '模型', '产品', '行业', '论文', '技巧', '发布', '更新', '推出', '最新', '版本'
]);

const unique = (values) => [...new Set(values.filter(Boolean))];

function titleTokens(value = '') {
  return unique(cleanText(value).toLowerCase()
    .replace(/v?\d+(?:\.\d+)+(?:[-.][\w]+)?/g, ' ')
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((token) => token.replace(/^[#.+-]+|[#.+-]+$/g, ''))
    .filter((token) => token.length > 1 && !COMMON_TOKENS.has(token)));
}

function similarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const overlap = [...a].filter((value) => b.has(value)).length;
  return { overlap, ratio: overlap / Math.max(1, new Set([...a, ...b]).size) };
}

export function extractBriefEntities(item) {
  const fromTags = (item.tags ?? []).filter((tag) => tag && !Object.values(CATEGORY_LABELS).includes(tag));
  const fromTitle = cleanText(item.title).match(/(?:[A-Z][A-Za-z0-9.+-]{2,}|[A-Za-z]+\d[A-Za-z0-9.+-]*|[\u4e00-\u9fff]{2,8})/g) ?? [];
  return unique([...fromTags, ...fromTitle])
    .filter((value) => !COMMON_TOKENS.has(value.toLowerCase()))
    .slice(0, 12);
}

function sameStory(left, right) {
  if (left.canonicalUrl === right.canonicalUrl) return true;
  if (isRoutineVersion(left) || isRoutineVersion(right)) return false;
  const distance = Math.abs(new Date(left.publishedAt).valueOf() - new Date(right.publishedAt).valueOf());
  if (distance > 72 * HOUR) return false;
  const tokens = similarity(titleTokens(left.title), titleTokens(right.title));
  if (tokens.overlap >= 3 && tokens.ratio >= 0.5) return true;
  if (tokens.overlap >= 2 && tokens.ratio >= 0.66) return true;
  const entities = similarity(extractBriefEntities(left).map((value) => value.toLowerCase()), extractBriefEntities(right).map((value) => value.toLowerCase()));
  return entities.overlap >= 2 && tokens.overlap >= 2 && tokens.ratio >= 0.4;
}

function representativeOf(items, now) {
  return [...items].sort((left, right) => {
    const editorial = Number(right.review?.status === 'approved' || right.enrichment?.status === 'completed') - Number(left.review?.status === 'approved' || left.enrichment?.status === 'completed');
    if (editorial) return editorial;
    const score = editorialScore(right, { now }) - editorialScore(left, { now });
    if (score) return score;
    return new Date(right.publishedAt) - new Date(left.publishedAt);
  })[0];
}

function stableBriefId(items) {
  const canonical = [...items].map((item) => item.canonicalUrl || item.url || item.id).sort()[0];
  return `brief-${createHash('sha256').update(canonical).digest('hex').slice(0, 20)}`;
}

function claimFor(item) {
  const text = cleanText(item.summary || item.contentText || item.title).slice(0, 360);
  if (!text) return null;
  return { text, sourceItemIds: [item.id], kind: 'fact' };
}

function qualityFor(items, representative) {
  const completed = items.filter((item) => item.enrichment?.status === 'completed');
  const approved = items.filter((item) => item.review?.status === 'approved');
  if (approved.length) return { mode: 'editorial', status: 'ready', confidence: 1, label: '编辑确认' };
  if (completed.length) {
    const confidence = Math.max(...completed.map((item) => Number(item.enrichment?.confidence) || 0));
    return { mode: 'model', status: confidence >= 0.75 ? 'ready' : 'review', confidence, label: confidence >= 0.75 ? 'AI 提炼' : '等待复核' };
  }
  return { mode: 'fallback', status: 'degraded', confidence: null, label: '原文摘录' };
}

function briefFromCluster(items, now) {
  const representative = representativeOf(items, now);
  const sourceItems = [...items].sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
  const edited = sourceItems.filter((item) => item.review?.status === 'approved' || item.enrichment?.status === 'completed');
  const claimCandidates = edited.length ? edited : [representative];
  const claims = [];
  for (const item of claimCandidates) {
    const claim = claimFor(item);
    if (!claim || claims.some((current) => current.text === claim.text)) continue;
    claims.push(claim);
    if (claims.length >= 4) break;
  }
  const why = representative.whyItMatters && representative.whyItMatters !== GENERIC_WHY
    ? { text: cleanText(representative.whyItMatters).slice(0, 220), sourceItemIds: [representative.id], kind: 'analysis' }
    : null;
  const topics = unique([representative.category, ...(sourceItems.flatMap((item) => item.tags ?? [])), ...(sourceItems.flatMap((item) => item.sourceTopics ?? []))]).slice(0, 16);
  const entities = unique(sourceItems.flatMap(extractBriefEntities)).slice(0, 16);
  const contentTypes = unique(sourceItems.map((item) => item.contentType).filter(Boolean));
  const sourceChannels = unique(sourceItems.map((item) => item.sourceChannel).filter(Boolean));
  const firstPublishedAt = new Date(Math.min(...sourceItems.map((item) => new Date(item.publishedAt).valueOf()))).toISOString();
  const lastPublishedAt = new Date(Math.max(...sourceItems.map((item) => new Date(item.publishedAt).valueOf()))).toISOString();
  const importance = Math.max(...sourceItems.map((item) => editorialScore(item, { now })));
  return {
    id: stableBriefId(sourceItems),
    canonicalKey: representative.canonicalUrl || representative.url,
    headline: representative.title,
    summaryClaims: claims,
    whyItMatters: why,
    topics,
    entities,
    firstPublishedAt,
    lastPublishedAt,
    importance,
    selected: sourceItems.some((item) => isEditoriallySelected(item, { now }))
      && !(sourceItems.every((item) => ['social', 'community'].includes(item.sourceChannel)) && sourceItems.length < 2),
    contentTypes,
    sourceChannels,
    quality: qualityFor(sourceItems, representative),
    sources: sourceItems.map((item) => ({
      itemId: item.id,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      sourceKind: item.sourceKind,
      sourceChannel: item.sourceChannel,
      sourceTier: item.sourceTier,
      contentType: item.contentType,
      author: item.author,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      summary: item.summary,
      note: ''
    })),
    updatedAt: new Date(now).toISOString()
  };
}

export function buildStoryBriefs(items, { now = Date.now(), days = 30 } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 30) * 24 * HOUR;
  const ranked = [...items]
    .filter((item) => item.status === 'published' && item.review?.status !== 'rejected')
    .filter((item) => new Date(item.publishedAt).valueOf() >= cutoff)
    .sort((left, right) => editorialScore(right, { now }) - editorialScore(left, { now }) || new Date(right.publishedAt) - new Date(left.publishedAt));
  const clusters = [];
  for (const item of ranked) {
    // Compare against the cluster anchor instead of any member. This prevents
    // single-link chains (A~B, B~C, A!~C) from growing into false mega-events.
    const cluster = clusters.find((candidate) => sameStory(candidate[0], item));
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters.map((cluster) => briefFromCluster(cluster, now))
    .sort((left, right) => right.importance - left.importance || new Date(right.lastPublishedAt) - new Date(left.lastPublishedAt));
}

export function monitorMatchesBrief(brief, monitor) {
  if (!monitor?.enabled) return false;
  const include = monitor.include ?? {};
  const exclude = monitor.exclude ?? {};
  const text = `${brief.headline} ${brief.summaryClaims.map((claim) => claim.text).join(' ')} ${brief.topics.join(' ')} ${brief.entities.join(' ')}`.toLowerCase();
  const sourceIds = new Set(brief.sources.map((source) => source.sourceId));
  const includes = [
    ...(include.entities ?? []),
    ...(include.keywords ?? []),
    ...(include.categories ?? [])
  ].map((value) => String(value).toLowerCase()).filter(Boolean);
  const includeSource = (include.sources ?? []).some((value) => sourceIds.has(value));
  const excluded = [...(exclude.keywords ?? []), ...(exclude.entities ?? [])].some((value) => text.includes(String(value).toLowerCase()))
    || (exclude.sources ?? []).some((value) => sourceIds.has(value));
  if (excluded) return false;
  return includeSource || includes.some((value) => text.includes(value));
}

export function normalizeMonitor(input, current = null) {
  if (!input || typeof input !== 'object') throw new Error('invalid monitor');
  const name = String(input.name ?? current?.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('monitor name is required');
  const list = (value, maximum = 30) => unique((Array.isArray(value) ? value : []).map((entry) => String(entry).trim()).filter(Boolean)).slice(0, maximum);
  const section = (value = {}) => ({
    entities: list(value.entities), keywords: list(value.keywords), categories: list(value.categories, 10), sources: list(value.sources, 100)
  });
  const now = new Date().toISOString();
  return {
    id: current?.id ?? String(input.id || randomUUID()),
    name,
    include: section(input.include ?? current?.include),
    exclude: section(input.exclude ?? current?.exclude),
    priority: Math.max(1, Math.min(3, Number(input.priority ?? current?.priority) || 2)),
    enabled: input.enabled === undefined ? current?.enabled ?? true : Boolean(input.enabled),
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };
}
