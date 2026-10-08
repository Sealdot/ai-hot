const categoryLabels = { 'ai-models': '模型', 'ai-products': '产品', industry: '行业', paper: '论文', tip: '技巧' };
const sourceLabels = { 'first-party': '一手信源', news: '资讯', social: '社区动态' };
const channelLabels = { official: '官方发布', research: '研究机构', release: '版本发布', media: '专业媒体', blog: '专家博客', newsletter: '行业通讯', papers: '论文动态', community: 'Reddit 社区', social: 'X 动态' };
const contentTypeLabels = { 'model-release': '模型发布', 'product-launch': '产品发布', research: '研究进展', benchmark: '评测基准', funding: '融资并购', policy: '政策治理', safety: '安全治理', 'open-source': '开源动态', engineering: '工程实践', opinion: '观点分析', community: '社区信号' };
const app = document.querySelector('#app');
const validRoutes = ['briefs', 'brief', 'selected', 'reading', 'daily', 'weekly', 'monitors', 'library', 'all', 'agent', 'sources', 'feedback', 'admin', 'item'];
const scopes = [['24h', '今天'], ['72h', '近 3 天'], ['7d', '近 7 天'], ['all', '全部归档']];
const readerViews = [['all', '全部'], ['unread', '未读'], ['saved', '收藏'], ['hidden', '已隐藏']];
const state = { route: 'briefs', category: 'all', topic: 'all', briefLens: 'all', sourceKind: 'all', sourceId: 'all', sourceChannel: 'all', sourceQuery: '', query: '', scope: '7d', readerView: 'all', sourceHealth: 'all', selectedDate: null, itemId: null, briefId: null, backHash: '' };
let feed = { key: '', items: [], nextCursor: null, meta: null, health: null, sources: [] };
let shouldFocusMain = false;

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const timestamp = (iso) => iso ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(iso)) : '等待首次同步';
const formatTime = (iso, complete = false) => new Intl.DateTimeFormat('zh-CN', complete ? { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' } : { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(iso));
const formatDay = (iso) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(iso));
const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('暂时无法载入数据');
  return response.json();
};
const postJson = async (url, payload) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '保存失败');
  return result;
};
const writeJson = async (url, method, payload) => {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '保存失败');
  return result;
};
const adminToken = () => sessionStorage.getItem('ai-hot-admin-token') || '';
const adminFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${adminToken()}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (response.status === 401) {
    sessionStorage.removeItem('ai-hot-admin-token');
    throw new Error('管理令牌无效，请重新输入');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || '管理操作失败');
  }
  return response.json();
};

function currentHash() {
  return location.hash || '#/briefs';
}

function rememberScroll(hash = currentHash()) {
  sessionStorage.setItem(`ai-hot-scroll:${hash}`, String(window.scrollY));
}

function restoreScroll() {
  const saved = Number(sessionStorage.getItem(`ai-hot-scroll:${currentHash()}`));
  if (Number.isFinite(saved) && saved > 0) requestAnimationFrame(() => window.scrollTo(0, saved));
}

function navigate(hash, { focus = true, resetScroll = false } = {}) {
  rememberScroll();
  if (resetScroll) sessionStorage.removeItem(`ai-hot-scroll:${hash}`);
  shouldFocusMain = focus;
  location.hash = hash;
}

function listHash() {
  const params = new URLSearchParams({ category: state.category, sourceKind: state.sourceKind, source: state.sourceId, scope: state.scope, reader: state.readerView });
  if (state.query) params.set('q', state.query);
  return `#/${state.route}?${params.toString()}`;
}

function updateList(changes) {
  Object.assign(state, changes);
  navigate(listHash(), { focus: false, resetScroll: true });
}

function parseRoute() {
  const raw = currentHash().replace(/^#\//, '') || 'briefs';
  const [path, search = ''] = raw.split('?');
  const [route, parameter] = path.split('/');
  const params = new URLSearchParams(search);
  state.route = validRoutes.includes(route) ? route : 'briefs';
  state.selectedDate = state.route === 'daily' && parameter ? parameter : null;
  state.itemId = state.route === 'item' && parameter ? decodeURIComponent(parameter) : null;
  state.briefId = state.route === 'brief' && parameter ? decodeURIComponent(parameter) : null;
  state.backHash = ['item', 'brief'].includes(state.route) ? params.get('back') || '#/briefs' : '';
  state.sourceHealth = state.route === 'sources' && ['all', 'ok', 'degraded', 'error', 'pending', 'disabled'].includes(params.get('health')) ? params.get('health') : 'all';
  state.sourceChannel = state.route === 'sources' ? (params.get('channel') || 'all').trim() : 'all';
  state.sourceQuery = state.route === 'sources' ? (params.get('q') || '').trim() : '';
  if (state.route === 'briefs') {
    state.topic = (params.get('topic') || 'all').trim() || 'all';
    state.briefLens = ['all', 'verified', 'primary', 'community'].includes(params.get('lens')) ? params.get('lens') : 'all';
    state.readerView = readerViews.some(([value]) => value === params.get('reader')) ? params.get('reader') : 'all';
    state.query = (params.get('q') || '').trim();
  }
  if (state.route === 'selected' || state.route === 'all') {
    state.category = ['all', ...Object.keys(categoryLabels)].includes(params.get('category')) ? params.get('category') : 'all';
    state.sourceKind = ['all', ...Object.keys(sourceLabels)].includes(params.get('sourceKind')) ? params.get('sourceKind') : 'all';
    state.sourceId = (params.get('source') || 'all').trim() || 'all';
    state.scope = scopes.some(([value]) => value === params.get('scope')) ? params.get('scope') : '72h';
    state.readerView = readerViews.some(([value]) => value === params.get('reader')) ? params.get('reader') : 'all';
    state.query = (params.get('q') || '').trim();
  }
  document.querySelectorAll('[data-route]').forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function readerState(item) {
  return item.reader ?? { readAt: null, savedAt: null, hiddenAt: null, note: '' };
}

function detailHash(itemId, back = listHash()) {
  return `#/item/${encodeURIComponent(itemId)}?back=${encodeURIComponent(back)}`;
}

function briefDetailHash(briefId, back = '#/briefs') {
  return `#/brief/${encodeURIComponent(briefId)}?back=${encodeURIComponent(back)}`;
}

function readerButtons(item, { compact = false } = {}) {
  const reader = readerState(item);
  return `<div class="reader-actions ${compact ? 'compact' : ''}" aria-label="阅读操作">
    <button type="button" data-reader-action="${reader.readAt ? 'unread' : 'read'}" data-item-id="${escapeHtml(item.id)}">${reader.readAt ? '标为未读' : '标为已读'}</button>
    <button type="button" data-reader-action="${reader.savedAt ? 'unsave' : 'save'}" data-item-id="${escapeHtml(item.id)}">${reader.savedAt ? '取消收藏' : '收藏'}</button>
    <button type="button" data-reader-action="${reader.hiddenAt ? 'unhide' : 'hide'}" data-item-id="${escapeHtml(item.id)}">${reader.hiddenAt ? '恢复显示' : '隐藏'}</button>
  </div>`;
}

function briefReaderButtons(brief, { compact = false } = {}) {
  const reader = readerState(brief);
  return `<div class="reader-actions ${compact ? 'compact' : ''}" aria-label="简报阅读操作">
    <button type="button" data-brief-action="${reader.readAt ? 'unread' : 'read'}" data-brief-id="${escapeHtml(brief.id)}">${reader.readAt ? '重新阅读' : '看完'}</button>
    <button type="button" data-brief-action="${reader.savedAt ? 'unsave' : 'save'}" data-brief-id="${escapeHtml(brief.id)}">${reader.savedAt ? '取消稍后读' : '稍后读'}</button>
    <button type="button" data-brief-action="${reader.hiddenAt ? 'unhide' : 'hide'}" data-brief-id="${escapeHtml(brief.id)}">${reader.hiddenAt ? '恢复' : '隐藏'}</button>
  </div>`;
}

function sourceHealthLabel(status) {
  return ({ ok: '健康', degraded: '降级', stale: '降级', error: '失败', pending: '待首次验证', disabled: '已停用' }[status] || '同步未知');
}

function trustSignalMarkup(item) {
  const trust = item.trust;
  if (!trust) return '';
  const signals = [
    `<span class="trust-badge freshness-${trust.freshness.bucket}">${escapeHtml(trust.freshness.label)}</span>`,
    `<span class="trust-badge health-${trust.sourceHealth.status}">${sourceHealthLabel(trust.sourceHealth.status)}</span>`
  ];
  if (trust.corroboration.sourceCount > 1) signals.push(`<span class="trust-badge corroborated">${trust.corroboration.sourceCount} 个独立来源</span>`);
  return `<div class="trust-signals" aria-label="内容判断线索">${signals.join('')}</div>`;
}

function trustDetailMarkup(item) {
  const trust = item.trust;
  if (!trust) return '';
  const corroboration = trust.corroboration;
  const editorial = trust.editorial.reviewed ? '已由编辑审核' : trust.editorial.enriched ? '已完成 AI 增强' : '尚未完成编辑审核';
  const related = corroboration.sourceCount > 1
    ? `<div class="corroboration-list"><h3>同一事件的其他报道</h3><p>${corroboration.sourceCount} 个独立来源：${corroboration.sources.map((source) => escapeHtml(source.name)).join('、')}</p>${corroboration.articles.length ? `<ul>${corroboration.articles.map((article) => `<li><a href="${detailHash(article.id, state.backHash)}">${escapeHtml(article.sourceName)} · ${escapeHtml(article.title)}</a></li>`).join('')}</ul>` : ''}</div>`
    : '<p>当前未识别到同一事件的其他独立来源报道。</p>';
  return `<section class="trust-panel"><h2>判断线索</h2><div class="trust-detail-grid"><div><span>时效</span><b>${escapeHtml(trust.freshness.label)}</b><small>发布于 ${formatTime(item.publishedAt, true)}</small></div><div><span>信源同步</span><b class="health-${trust.sourceHealth.status}">${sourceHealthLabel(trust.sourceHealth.status)}</b><small>${trust.sourceHealth.lastSuccessAt ? `最近成功 ${formatTime(trust.sourceHealth.lastSuccessAt, true)}` : '尚无成功抓取记录'}</small></div><div><span>编辑状态</span><b>${editorial}</b><small>用于说明编辑处理，不替代原始来源。</small></div></div>${related}<p class="trust-disclaimer">信源同步状态仅反映本机抓取是否顺利；多源提示仅代表系统识别到相近事件的独立报道，并不替代对原文的判断。</p></section>`;
}

function feedbackControls(item) {
  const feedback = item.feedback ?? { category: null, source: null };
  const categoryValue = feedback.category?.value ?? 0;
  const sourceValue = feedback.source?.value ?? 0;
  const selected = (condition) => condition ? ' selected' : '';
  return `<section class="feedback-panel"><div><h2>调整本机偏好</h2><p>反馈只保存在这台设备，会轻量调整后续精选和待读排序。</p></div><div class="feedback-groups"><div><span>主题 · ${escapeHtml(categoryLabels[item.category] || item.category)}</span><div class="feedback-actions"><button type="button" class="outline${selected(categoryValue === 1)}" data-feedback-action="prefer-category" data-item-id="${escapeHtml(item.id)}">多看此主题</button><button type="button" class="outline${selected(categoryValue === -1)}" data-feedback-action="avoid-category" data-item-id="${escapeHtml(item.id)}">少看此主题</button></div></div><div><span>信源 · ${escapeHtml(item.sourceName)}</span><div class="feedback-actions"><button type="button" class="outline${selected(sourceValue === 1)}" data-feedback-action="prefer-source" data-item-id="${escapeHtml(item.id)}">多看此信源</button><button type="button" class="outline${selected(sourceValue === -1)}" data-feedback-action="avoid-source" data-item-id="${escapeHtml(item.id)}">少看此信源</button></div></div></div>${(categoryValue || sourceValue) ? `<button type="button" class="text-button" data-feedback-action="clear" data-item-id="${escapeHtml(item.id)}">清除本篇偏好</button>` : ''}<span class="form-status" id="feedback-status"></span></section>`;
}

function itemCard(item) {
  const reader = readerState(item);
  return `
    <article class="news-card ${reader.readAt ? 'is-read' : ''}" data-item-card="${escapeHtml(item.id)}">
      <div class="timeline-time"><time>${formatTime(item.publishedAt)}</time></div>
      <div class="card-content">
        <div class="meta"><span class="source-kind ${item.sourceKind}">${sourceLabels[item.sourceKind] || item.sourceKind}</span><span>${escapeHtml(item.sourceName)}</span><span>·</span><time>${formatTime(item.publishedAt, true)}</time>${item.enrichment?.status === 'completed' ? '<span class="quality-badge">AI 增强</span>' : ''}${item.review?.status === 'approved' ? '<span class="review-badge">已审核</span>' : ''}<span class="importance" title="编辑优先级">${item.editorialScore ?? item.importance}</span></div>
        <h2><a href="${detailHash(item.id)}">${escapeHtml(item.title)}</a></h2>
        <p class="summary">${escapeHtml(item.summary)}</p>
        ${trustSignalMarkup(item)}
        <div class="tag-row">${item.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('')}<span class="category-tag">${categoryLabels[item.category]}</span></div>
        ${item.whyItMatters ? `<div class="why"><strong>值得关注</strong>${escapeHtml(item.whyItMatters)}</div>` : '<div class="why fallback"><strong>原文摘录</strong><span>未经 AI 提炼，请以原始来源为准。</span></div>'}
        <footer class="card-footer"><a class="source-link" target="_blank" rel="noreferrer" href="${escapeHtml(item.url)}">查看原文</a>${readerButtons(item, { compact: true })}</footer>
      </div>
    </article>`;
}

function timelineMarkup(items) {
  if (!items.length) return '<div class="empty">没有匹配的新闻，换个关键词或筛选条件试试。</div>';
  const groups = new Map();
  for (const item of items) {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.publishedAt));
    if (!groups.has(key)) groups.set(key, { label: formatDay(item.publishedAt), items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].map((group) => `<section class="feed-day"><header class="date-row"><strong>${group.label}</strong><small>按发布时间倒序 · 北京时间</small></header><div class="timeline">${group.items.map(itemCard).join('')}</div></section>`).join('');
}

const qualityLabel = (quality = {}) => quality.label || ({ ready: '已提炼', review: '等待复核', degraded: '原文摘录' }[quality.status] || '原文摘录');

function briefCard(brief, back = '#/briefs') {
  const reader = readerState(brief);
  const primaryItemId = brief.sources[0]?.itemId;
  const topicLabels = [...new Set(brief.topics.map((topic) => categoryLabels[topic] || topic))];
  const sourceCount = brief.ranking?.sourceCount ?? new Set(brief.sources.map((source) => source.sourceId)).size;
  const evidence = brief.ranking?.evidenceGrade || 'C';
  const channelSummary = (brief.ranking?.channels || brief.sourceChannels || []).map((channel) => channelLabels[channel] || channel).slice(0, 3).join(' · ');
  const signalLabels = (brief.contentTypes || []).map((type) => contentTypeLabels[type] || type);
  return `<article class="brief-card ${reader.readAt ? 'is-read' : ''}" data-brief-card="${escapeHtml(brief.id)}">
    <header><div class="brief-meta"><span class="evidence-grade evidence-${evidence.toLowerCase()}">证据 ${evidence}</span><span class="quality-${escapeHtml(brief.quality.status)}">${escapeHtml(qualityLabel(brief.quality))}</span><span>${sourceCount} 个来源${channelSummary ? ` · ${escapeHtml(channelSummary)}` : ''}</span><time>${formatTime(brief.lastPublishedAt, true)}</time><b title="综合优先级">${Math.round(brief.ranking?.eventScore ?? brief.importance)}</b></div><h2><a href="${briefDetailHash(brief.id, back)}">${escapeHtml(brief.headline)}</a></h2></header>
    <ul class="brief-claims">${brief.summaryClaims.slice(0, 4).map((claim) => `<li>${escapeHtml(claim.text)}<small>${claim.sourceItemIds.length} 条来源依据</small></li>`).join('')}</ul>
    ${brief.whyItMatters ? `<div class="brief-why"><strong>为什么重要</strong><p>${escapeHtml(brief.whyItMatters.text)}</p></div>` : '<p class="fallback-note">原文摘录／未经 AI 提炼；已隐藏无依据的“为什么重要”。</p>'}
    <div class="brief-topics">${[...new Set([...signalLabels, ...topicLabels])].slice(0, 6).map((topic) => `<span>#${escapeHtml(topic)}</span>`).join('')}</div>
    <p class="ranking-reason">为何出现：${escapeHtml(brief.ranking?.reasons?.slice(0, 2).join(' · ') || '重要度与新进展')}</p>
    <footer>${briefReaderButtons(brief, { compact: true })}${primaryItemId ? `<div class="inline-feedback"><button type="button" data-feedback-action="prefer-category" data-item-id="${escapeHtml(primaryItemId)}">多看</button><button type="button" data-feedback-action="avoid-category" data-item-id="${escapeHtml(primaryItemId)}">少看</button></div>` : ''}</footer>
  </article>`;
}

function briefsHash() {
  const params = new URLSearchParams({ topic: state.topic, lens: state.briefLens, reader: state.readerView });
  if (state.query) params.set('q', state.query);
  return `#/briefs?${params}`;
}

async function mutateBrief(briefId, action, note = '') {
  return postJson('/api/reader/brief-state', { id: briefId, action, note });
}

function bindBriefActions(refresh) {
  document.querySelectorAll('[data-brief-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await mutateBrief(button.dataset.briefId, button.dataset.briefAction); await refresh(); }
    catch (error) { button.textContent = error.message; button.disabled = false; }
  }));
  document.querySelectorAll('[data-feedback-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await mutateFeedback(button.dataset.itemId, button.dataset.feedbackAction); await refresh(); }
    catch (error) { button.textContent = error.message; button.disabled = false; }
  }));
}

async function renderBriefs() {
  const params = new URLSearchParams({ take: '12', reader: state.readerView, lens: state.briefLens });
  if (state.topic !== 'all') params.set('topic', state.topic);
  if (state.query) params.set('q', state.query);
  const [payload, health] = await Promise.all([fetchJson(`/api/public/briefs?${params}`), fetchJson('/api/health')]);
  app.innerHTML = `<header class="page-head brief-head" tabindex="-1"><div><p class="eyebrow">TODAY'S INTELLIGENCE</p><h1>今日简报</h1><p>同一事件只读一次，事实与分析分开，每条结论都能回到来源。</p></div><div class="head-stat"><strong>${payload.meta.activeUnread}</strong><span>近 7 天活跃未读</span></div></header>
    ${automationCard(health)}
    <section class="brief-filter"><div class="brief-filter-groups"><div class="pills intelligence-lenses"><button class="pill ${state.briefLens === 'all' ? 'selected' : ''}" data-brief-lens="all">智能推荐</button><button class="pill ${state.briefLens === 'verified' ? 'selected' : ''}" data-brief-lens="verified">多源印证</button><button class="pill ${state.briefLens === 'primary' ? 'selected' : ''}" data-brief-lens="primary">一手发布</button><button class="pill ${state.briefLens === 'community' ? 'selected' : ''}" data-brief-lens="community">社区与博主</button></div><div class="pills topic-pills"><button class="pill ${state.topic === 'all' ? 'selected' : ''}" data-brief-topic="all">全部主题</button>${Object.entries(categoryLabels).map(([value, label]) => `<button class="pill ${state.topic === value ? 'selected' : ''}" data-brief-topic="${value}">${label}</button>`).join('')}</div></div><form id="brief-search"><label class="sr-only" for="brief-q">搜索简报</label><input id="brief-q" name="q" value="${escapeHtml(state.query)}" placeholder="搜索事件、实体或主题…"><button>搜索</button></form></section>
    <section class="brief-list">${payload.briefs.length ? payload.briefs.map((brief) => briefCard(brief, briefsHash())).join('') : '<div class="empty">近 7 天没有符合条件的简报。可在“全部文章”中查找历史内容。</div>'}</section>`;
  document.querySelectorAll('[data-brief-topic]').forEach((button) => button.addEventListener('click', () => { state.topic = button.dataset.briefTopic; navigate(briefsHash(), { focus: false, resetScroll: true }); }));
  document.querySelectorAll('[data-brief-lens]').forEach((button) => button.addEventListener('click', () => { state.briefLens = button.dataset.briefLens; navigate(briefsHash(), { focus: false, resetScroll: true }); }));
  document.querySelector('#brief-search')?.addEventListener('submit', (event) => { event.preventDefault(); state.query = new FormData(event.currentTarget).get('q').trim(); navigate(briefsHash(), { focus: false, resetScroll: true }); });
  bindBriefActions(renderBriefs);
  restoreScroll();
}

async function renderBriefDetail() {
  const { brief } = await fetchJson(`/api/public/briefs/${encodeURIComponent(state.briefId)}`);
  const sourceById = new Map(brief.sources.map((source) => [source.itemId, source]));
  const claimKind = (kind) => kind === 'analysis' ? '分析' : '事实';
  app.innerHTML = `<a class="back-link" href="${escapeHtml(state.backHash)}">返回简报</a><article class="brief-detail"><header tabindex="-1"><div class="brief-meta"><span class="quality-${escapeHtml(brief.quality.status)}">${escapeHtml(qualityLabel(brief.quality))}</span><span>${brief.sources.length} 个来源</span><time>${formatTime(brief.firstPublishedAt, true)} — ${formatTime(brief.lastPublishedAt, true)}</time></div><h1>${escapeHtml(brief.headline)}</h1>${briefReaderButtons(brief)}</header>
    <section><h2>结论与依据</h2><ol class="claim-evidence">${brief.summaryClaims.map((claim) => `<li><span>${claimKind(claim.kind)}</span><p>${escapeHtml(claim.text)}</p><div>${claim.sourceItemIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => `<a target="_blank" rel="noreferrer" href="${escapeHtml(source.url)}">${escapeHtml(source.sourceName)}</a>`).join('')}</div></li>`).join('')}${brief.whyItMatters ? `<li class="analysis"><span>分析</span><p>${escapeHtml(brief.whyItMatters.text)}</p><div>${brief.whyItMatters.sourceItemIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => `<a target="_blank" rel="noreferrer" href="${escapeHtml(source.url)}">${escapeHtml(source.sourceName)}</a>`).join('')}</div></li>` : ''}</ol></section>
    <section><h2>来源时间线</h2><div class="source-timeline">${brief.sources.map((source) => `<article><time>${formatTime(source.publishedAt, true)}</time><div><b>${escapeHtml(source.sourceName)}</b><a target="_blank" rel="noreferrer" href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a>${source.note ? `<p>原文笔记：${escapeHtml(source.note)}</p>` : ''}</div></article>`).join('')}</div></section>
    <section><h2>你的简报笔记</h2><form id="brief-note-form"><textarea name="note" maxlength="2000" placeholder="记录项目关联、待验证问题或下一步…">${escapeHtml(brief.reader.note)}</textarea><div><button class="outline">保存笔记</button><span id="brief-note-status" class="form-status"></span></div></form></section></article>`;
  bindBriefActions(renderBriefDetail);
  document.querySelector('#brief-note-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const status = document.querySelector('#brief-note-status'); status.textContent = '正在保存…'; try { await mutateBrief(brief.id, 'note', new FormData(event.currentTarget).get('note')); status.textContent = '已保存'; } catch (error) { status.textContent = error.message; } });
}

function automationCard(health) {
  const scheduler = health.scheduler;
  return `<section class="sync-strip" aria-label="本机自动更新状态">
    <div><span class="sync-dot ${scheduler.failing ? 'warn' : ''}"></span><strong>${scheduler.healthy ?? 0}/${scheduler.sources ?? 0} 信源健康</strong><span>最近同步 ${timestamp(scheduler.lastSuccessfulFetchAt)}</span></div>
    <details><summary>本机自动更新</summary><p>下一轮检查 ${timestamp(scheduler.nextFeedPollAt)}；下次日报 ${timestamp(scheduler.nextDailyIssueAt)}。</p><ul>${scheduler.rules.map((rule) => `<li><b>${rule.label}</b>${rule.schedule} · ${rule.action}</li>`).join('')}</ul></details>
  </section>`;
}

function pillGroup(label, entries, selectedValue, attribute) {
  return `<div class="filter-line"><span class="filter-label">${label}</span><div class="pills">${entries.map(([value, text]) => `<button type="button" class="pill ${selectedValue === value ? 'selected' : ''}" data-${attribute}="${value}" aria-pressed="${selectedValue === value}">${text}</button>`).join('')}</div></div>`;
}

function filterBar(showSource, sources = []) {
  const sourceOptions = sources.filter((source) => source.enabled).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  return `<section class="filter-bar">
    ${pillGroup('时间', scopes, state.scope, 'scope')}
    ${pillGroup('内容', [['all', '全部'], ...Object.entries(categoryLabels)], state.category, 'category')}
    ${pillGroup('阅读', readerViews, state.readerView, 'reader')}
    ${showSource ? `<details class="source-filter"><summary>信源筛选</summary>${pillGroup('', [['all', '全部'], ...Object.entries(sourceLabels)], state.sourceKind, 'source')}<label class="source-select" for="source-id">具体信源<select id="source-id" data-source-id><option value="all">全部信源</option>${sourceOptions.map((source) => `<option value="${escapeHtml(source.id)}" ${state.sourceId === source.id ? 'selected' : ''}>${escapeHtml(source.name)}</option>`).join('')}</select></label></details>` : ''}
    <form id="search-form" class="search"><label class="sr-only" for="news-search">搜索新闻</label><input id="news-search" value="${escapeHtml(state.query)}" name="q" placeholder="搜索标题、来源或笔记…" /><button>搜索</button></form>
  </section>`;
}

function queryForNews(cursor = null) {
  const selected = state.route === 'selected';
  const params = new URLSearchParams({ mode: selected ? 'selected' : 'all', category: state.category, sourceKind: state.sourceKind, source: state.sourceId, reader: state.readerView, take: '20' });
  if (state.query) params.set('q', state.query);
  if (state.scope !== 'all') {
    const hours = { '24h': 24, '72h': 72, '7d': 24 * 7 }[state.scope];
    params.set('since', new Date(Date.now() - hours * 3_600_000).toISOString());
  }
  if (cursor) params.set('cursor', cursor);
  return params;
}

function paintNews({ restore = true } = {}) {
  const selected = state.route === 'selected';
  const displayed = feed.items.length;
  app.innerHTML = `
    <header class="page-head" tabindex="-1"><div><p class="eyebrow">${selected ? 'CURATED READING' : 'AI ACTIVITY ARCHIVE'}</p><h1>${selected ? '精选' : '全部 AI 动态'}</h1><p>${selected ? '一份可以读完、保存并回看的本机 AI 情报流。' : '完整新闻档案，支持按时间、内容、信源与阅读状态筛选。'}</p></div><div class="head-stat"><strong>${feed.meta?.total ?? 0}</strong><span>条匹配内容</span></div></header>
    ${automationCard(feed.health)}
    ${filterBar(!selected, feed.sources)}
    ${feed.meta?.personalization?.applied ? '<p class="preference-note">排序已轻量考虑本机主题与信源偏好；编辑优先级仍为主导。</p>' : ''}
    <p class="feed-count">已显示 ${displayed} / ${feed.meta?.total ?? 0} 条</p>
    <section class="news-feed">${timelineMarkup(feed.items)}</section>
    ${feed.nextCursor ? '<button class="load-more outline" type="button" data-load-more>加载更多</button>' : ''}`;
  bindNewsControls();
  if (restore) restoreScroll();
}

async function renderNews() {
  const key = listHash();
  const [data, health, sourcePayload] = await Promise.all([fetchJson(`/api/public/items?${queryForNews()}`), fetchJson('/api/health'), fetchJson('/api/public/sources')]);
  feed = { key, items: data.items, nextCursor: data.nextCursor, meta: data.meta, health, sources: sourcePayload.sources };
  paintNews();
}

async function loadMore() {
  if (!feed.nextCursor) return;
  const button = document.querySelector('[data-load-more]');
  button.disabled = true;
  button.textContent = '正在加载…';
  try {
    const data = await fetchJson(`/api/public/items?${queryForNews(feed.nextCursor)}`);
    feed = { ...feed, items: [...feed.items, ...data.items], nextCursor: data.nextCursor, meta: data.meta };
    paintNews({ restore: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}

async function mutateReader(itemId, action, note = '') {
  return postJson('/api/reader/state', { id: itemId, action, note });
}

async function mutateFeedback(itemId, action) {
  return postJson('/api/reader/feedback', { id: itemId, action });
}

function bindReaderActions(refresh) {
  document.querySelectorAll('[data-reader-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await mutateReader(button.dataset.itemId, button.dataset.readerAction);
      await refresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  }));
}

function bindNewsControls() {
  document.querySelectorAll('[data-scope]').forEach((button) => button.addEventListener('click', () => updateList({ scope: button.dataset.scope })));
  document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => updateList({ category: button.dataset.category })));
  document.querySelectorAll('[data-reader]').forEach((button) => button.addEventListener('click', () => updateList({ readerView: button.dataset.reader })));
  document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => updateList({ sourceKind: button.dataset.source })));
  document.querySelector('[data-source-id]')?.addEventListener('change', (event) => updateList({ sourceId: event.currentTarget.value }));
  document.querySelector('#search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    updateList({ query: new FormData(event.currentTarget).get('q').trim() });
  });
  document.querySelector('[data-load-more]')?.addEventListener('click', loadMore);
  bindReaderActions(renderNews);
}

function workspaceSection(title, description, briefs, allHash) {
  return `<section class="reading-section"><header><div><h2>${title}</h2><p>${description}</p></div>${allHash ? `<a class="source-link" href="${allHash}">查看全部</a>` : ''}</header><div class="brief-list compact">${briefs.length ? briefs.map((brief) => briefCard(brief, '#/reading')).join('') : '<div class="empty compact-empty">当前没有内容。</div>'}</div></section>`;
}

async function renderReading() {
  const workspace = await fetchJson('/api/public/briefs/workspace');
  const summary = workspace.summary;
  app.innerHTML = `<header class="page-head reading-head" tabindex="-1"><div><p class="eyebrow">READ LATER</p><h1>稍后读</h1><p>只管理近 7 天活跃简报、你明确保存的内容和笔记，不再展示全库未读。</p></div></header>
    <section class="reading-summary" aria-label="本机阅读摘要"><article><span>活跃未读</span><strong>${summary.activeUnread}</strong><small>近 7 天</small></article><article><span>稍后读</span><strong>${summary.saved}</strong><small>你明确保存</small></article><article><span>笔记</span><strong>${summary.noted}</strong><small>事件级记录</small></article></section>
    <div class="reading-sections">${workspaceSection('今天该读什么', '近 7 天仍活跃的精选简报。', workspace.sections.toRead, '#/briefs?reader=unread')}${workspaceSection('已收入稍后读', '按监控命中、事件重要度和新进展排序。', workspace.sections.saved, '#/briefs?reader=saved')}${workspaceSection('带笔记的简报', '笔记保留在事件上；原文笔记仍留在对应来源下。', workspace.sections.noted, null)}</div>`;
  bindBriefActions(renderReading);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

async function renderWeekly() {
  const weekly = await fetchJson('/api/public/briefs/weekly');
  const summary = weekly.summary;
  app.innerHTML = `<header class="page-head reading-head" tabindex="-1"><div><p class="eyebrow">SEVEN-DAY RECAP</p><h1>回顾</h1><p>以事件为单位回看本周完成、稍后读、笔记与持续更新。</p></div></header>
    <section class="reading-summary" aria-label="最近七天回顾"><article><span>看完</span><strong>${summary.read}</strong><small>事件简报</small></article><article><span>稍后读</span><strong>${summary.saved}</strong><small>本周加入</small></article><article><span>笔记</span><strong>${summary.noted}</strong><small>本周更新</small></article><article><span>持续更新</span><strong>${summary.continuing}</strong><small>新来源或进展</small></article><article><span>下周待处理</span><strong>${summary.next}</strong><small>已保存未看完</small></article></section>
    <div class="reading-sections">${workspaceSection('持续更新的事件', '本周出现了新来源或跨日进展。', weekly.sections.continuing, null)}${workspaceSection('下周待处理', '已收入稍后读但还未看完。', weekly.sections.next, '#/briefs?reader=saved')}${workspaceSection('本周笔记', '最近更新的事件级笔记。', weekly.sections.noted, null)}</div>`;
  bindBriefActions(renderWeekly);
}

const splitRules = (value) => [...new Set(String(value || '').split(/[,，\n]/).map((entry) => entry.trim()).filter(Boolean))];

async function renderMonitors() {
  const [{ monitors }, sourcePayload] = await Promise.all([fetchJson('/api/local/monitors'), fetchJson('/api/public/sources')]);
  const ruleText = (monitor, side) => {
    const rule = monitor[side];
    return [...rule.entities, ...rule.keywords, ...rule.categories.map((value) => categoryLabels[value] || value), ...rule.sources.map((id) => sourcePayload.sources.find((source) => source.id === id)?.name || id)].join('、') || '无';
  };
  app.innerHTML = `<header class="page-head" tabindex="-1"><div><p class="eyebrow">LOCAL MONITORS</p><h1>主题监控</h1><p>用实体、关键词、分类和信源的包含／排除规则提升简报排序。规则只保存在本机，每张卡会解释为何出现。</p></div></header>
    <section class="monitor-create"><h2>新建监控器</h2><form id="monitor-form"><label>名称<input name="name" maxlength="80" required placeholder="例如：端侧模型"></label><label>包含实体<input name="entities" placeholder="Apple, Qwen"></label><label>包含关键词<input name="keywords" placeholder="on-device, 量化"></label><label>包含分类<select name="categories" multiple>${Object.entries(categoryLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>包含信源<select name="sources" multiple>${sourcePayload.sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`).join('')}</select></label><label>排除关键词<input name="excludeKeywords" placeholder="招聘, 营销"></label><label>排除信源<select name="excludeSources" multiple>${sourcePayload.sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`).join('')}</select></label><label>优先级<select name="priority"><option value="3">高</option><option value="2" selected>中</option><option value="1">低</option></select></label><button class="outline">创建监控器</button><span class="form-status" id="monitor-status"></span></form></section>
    <section class="monitor-list">${monitors.length ? monitors.map((monitor) => `<article><header><div><span>优先级 ${monitor.priority}</span><h2>${escapeHtml(monitor.name)}</h2></div><label class="toggle"><input type="checkbox" data-monitor-toggle="${escapeHtml(monitor.id)}" ${monitor.enabled ? 'checked' : ''}>启用</label></header><p><b>包含</b>${escapeHtml(ruleText(monitor, 'include'))}</p><p><b>排除</b>${escapeHtml(ruleText(monitor, 'exclude'))}</p><button class="text-button" data-monitor-delete="${escapeHtml(monitor.id)}">删除</button></article>`).join('') : '<div class="empty">还没有主题监控器。</div>'}</section>`;
  document.querySelector('#monitor-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = (name) => [...form.elements[name].selectedOptions].map((option) => option.value);
    const payload = { name: data.get('name'), include: { entities: splitRules(data.get('entities')), keywords: splitRules(data.get('keywords')), categories: values('categories'), sources: values('sources') }, exclude: { keywords: splitRules(data.get('excludeKeywords')), sources: values('excludeSources') }, priority: Number(data.get('priority')), enabled: true };
    const status = document.querySelector('#monitor-status'); status.textContent = '正在保存…';
    try { await writeJson('/api/local/monitors', 'POST', payload); await renderMonitors(); } catch (error) { status.textContent = error.message; }
  });
  document.querySelectorAll('[data-monitor-toggle]').forEach((input) => input.addEventListener('change', async () => { input.disabled = true; try { await writeJson(`/api/local/monitors/${encodeURIComponent(input.dataset.monitorToggle)}`, 'PATCH', { enabled: input.checked }); await renderMonitors(); } catch (error) { input.disabled = false; input.checked = !input.checked; } }));
  document.querySelectorAll('[data-monitor-delete]').forEach((button) => button.addEventListener('click', async () => { if (!confirm('删除这个本地监控器？')) return; button.disabled = true; try { await writeJson(`/api/local/monitors/${encodeURIComponent(button.dataset.monitorDelete)}`, 'DELETE'); await renderMonitors(); } catch (error) { button.textContent = error.message; button.disabled = false; } }));
}

function preferenceMarkup(preferences) {
  if (!preferences.length) return '<div class="empty compact-empty">尚未记录偏好。可在文章详情中选择多看或少看主题、信源。</div>';
  return `<div class="preference-list">${preferences.map((preference) => `<article><div><span>${preference.dimension === 'category' ? '主题' : '信源'}</span><b>${escapeHtml(preference.label)}</b><small>${preference.score > 0 ? '多看' : '少看'} · ${Math.abs(preference.score)} 条反馈</small></div><button class="outline" type="button" data-clear-preference data-dimension="${preference.dimension}" data-target="${escapeHtml(preference.target)}">撤销</button></article>`).join('')}</div>`;
}

function backupMarkup(backups) {
  if (!backups.length) return '<p class="quiet-copy">尚无手动或自动备份。</p>';
  return `<ul class="backup-list">${backups.slice(0, 5).map((backup) => `<li><b>${escapeHtml(backup.name)}</b><span>${formatBytes(backup.bytes)} · ${formatTime(backup.modifiedAt, true)}</span></li>`).join('')}</ul>`;
}

async function renderLibrary() {
  const library = await fetchJson('/api/local/library');
  app.innerHTML = `<header class="page-head library-head" tabindex="-1"><div><p class="eyebrow">LOCAL LIBRARY</p><h1>资料库</h1><p>管理只保存在当前设备的阅读资产；导入会先生成 SQLite 备份，再安全合并仍存在的文章状态。</p></div></header>
    <section class="reading-summary library-summary" aria-label="本机资料库摘要"><article><span>收藏</span><strong>${library.summary.saved}</strong><small>可随时导出</small></article><article><span>笔记</span><strong>${library.summary.noted}</strong><small>个人判断记录</small></article><article><span>阅读状态</span><strong>${library.summary.readerStates}</strong><small>本机持久化</small></article><article><span>日报</span><strong>${library.summary.dailyIssues}</strong><small>随 JSON 导出</small></article></section>
    <div class="library-grid"><section class="library-card"><div><p class="eyebrow">EXPORT & IMPORT</p><h2>迁移与备份</h2><p>JSON 可用于导入；Markdown 适合归档到笔记工具。整库恢复请先停止服务，再运行下方命令。</p></div><div class="library-actions"><a class="outline" href="/api/local/library/export?format=json">导出 JSON</a><a class="outline" href="/api/local/library/export?format=markdown">导出 Markdown</a><button class="outline" type="button" data-create-backup>立即创建备份</button></div><form id="library-import-form" class="import-form"><label for="library-file">导入此前导出的 JSON</label><div><input id="library-file" name="file" type="file" accept="application/json,.json" required/><button class="outline" type="submit">安全合并导入</button></div><span class="form-status" id="library-import-status"></span></form><p class="restore-command"><code>npm run restore -- data/backups/&lt;backup-file&gt;</code><br/>恢复命令会创建额外安全副本；运行前请停止本机服务。</p><h3>最近备份</h3>${backupMarkup(library.backups)}</section>
      <section class="library-card"><div><p class="eyebrow">PREFERENCES</p><h2>当前偏好</h2><p>撤销会清除该主题或信源对应的本机反馈，后续排序不再应用它。</p></div>${preferenceMarkup(library.preferences)}</section></div>
    <div class="library-grid library-records"><section class="library-card"><p class="eyebrow">RECENT SAVES</p><h2>最近收藏</h2>${library.recent.saved.length ? `<ul class="library-item-list">${library.recent.saved.map((item) => `<li><a href="${detailHash(item.id, '#/library')}">${escapeHtml(item.title)}</a><span>${escapeHtml(item.sourceName)}</span></li>`).join('')}</ul>` : '<p class="quiet-copy">还没有收藏内容。</p>'}</section><section class="library-card"><p class="eyebrow">RECENT NOTES</p><h2>最近笔记</h2>${library.recent.noted.length ? `<ul class="library-item-list">${library.recent.noted.map((item) => `<li><a href="${detailHash(item.id, '#/library')}">${escapeHtml(item.title)}</a><span>${escapeHtml(item.note)}</span></li>`).join('')}</ul>` : '<p class="quiet-copy">还没有笔记内容。</p>'}</section></div>`;
  document.querySelectorAll('[data-clear-preference]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await postJson('/api/local/preferences/clear', { dimension: button.dataset.dimension, target: button.dataset.target }); await renderLibrary(); }
    catch (error) { button.textContent = error.message; button.disabled = false; }
  }));
  document.querySelector('[data-create-backup]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在创建…';
    try { await postJson('/api/local/library/backup', {}); await renderLibrary(); }
    catch (error) { button.textContent = error.message; button.disabled = false; }
  });
  document.querySelector('#library-import-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.querySelector('#library-import-status');
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File) || !file.size) return;
    status.textContent = '正在校验并合并…';
    try {
      const snapshot = JSON.parse(await file.text());
      const result = await postJson('/api/local/library/import', { snapshot });
      status.textContent = `已合并 ${result.imported.readerStates} 条状态和 ${result.imported.feedback} 条偏好。`;
      setTimeout(() => { void renderLibrary(); }, 500);
    } catch (error) { status.textContent = error instanceof SyntaxError ? 'JSON 文件无法解析。' : error.message; }
  });
}

function issueMarkup(issue, expanded = false) {
  const entries = issue.sections.flatMap((section) => section.items);
  const briefEntries = issue.briefs ?? [];
  const count = briefEntries.length || entries.length;
  return `<article class="issue"><div class="issue-top"><div><p class="eyebrow">DAILY · ${issue.date}</p><h2>${escapeHtml(issue.title)}</h2><p>${escapeHtml(issue.summary)}</p>${issue.quality ? `<span class="daily-quality quality-${escapeHtml(issue.quality.status)}">${issue.quality.status === 'ready' ? '全部已提炼' : `${issue.quality.fallback} 条降级摘录`}</span>` : ''}</div><div class="issue-count">${count}<small>${briefEntries.length ? '事件' : '条'}</small></div></div>
    ${expanded ? (briefEntries.length ? `<div class="brief-list">${briefEntries.map((brief) => briefCard(brief, `#/daily/${issue.date}`)).join('')}</div>` : issue.sections.map((section) => `<section class="daily-section"><h3>${section.title}<span>${section.items.length}</span></h3>${section.items.map((item) => `<a class="daily-item" href="${detailHash(item.id, `#/daily/${issue.date}`)}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.summary)}</p></a>`).join('')}</section>`).join('')) : `<button class="outline" type="button" data-open-issue="${issue.date}">查看这期日报</button>`}
  </article>`;
}

async function renderDaily() {
  const payload = state.selectedDate ? await fetchJson(`/api/public/daily/${state.selectedDate}`) : await fetchJson('/api/public/daily');
  const issues = state.selectedDate ? [payload] : payload.issues;
  app.innerHTML = `<header class="page-head daily-head" tabindex="-1"><div><p class="eyebrow">AI HOT DAILY</p><h1>AI 日报</h1><p>每日自动冻结的重点事件，适合快速回顾与回查。</p></div><a class="outline" href="/feeds/daily.xml" target="_blank" rel="noreferrer">订阅 RSS</a></header>
    <section class="issue-list">${issues.length ? issues.map((issue) => issueMarkup(issue, Boolean(state.selectedDate))).join('') : '<div class="empty">日报将在每天 08:05 自动生成。</div>'}</section>
    ${state.selectedDate ? '<a class="back-link" href="#/daily">返回日报归档</a>' : ''}`;
  document.querySelectorAll('[data-open-issue]').forEach((button) => button.addEventListener('click', () => navigate(`#/daily/${button.dataset.openIssue}`)));
  bindBriefActions(renderDaily);
}

async function renderItemDetail({ autoMarkRead = false } = {}) {
  const payload = await fetchJson(`/api/public/items/${encodeURIComponent(state.itemId)}`);
  const item = payload.item;
  if (autoMarkRead && !readerState(item).readAt) {
    try { item.reader = (await mutateReader(item.id, 'read')).state; } catch { /* The article remains readable even if state persistence is temporarily unavailable. */ }
  }
  const reader = readerState(item);
  app.innerHTML = `<a class="back-link" href="${escapeHtml(state.backHash)}">返回新闻流</a>
    <article class="detail-card"><header tabindex="-1"><div class="meta"><span class="source-kind ${item.sourceKind}">${sourceLabels[item.sourceKind] || item.sourceKind}</span><span>${escapeHtml(item.sourceName)}</span><span>·</span><time>${formatTime(item.publishedAt, true)}</time></div><h1>${escapeHtml(item.title)}</h1><div class="detail-links"><a class="outline" target="_blank" rel="noreferrer" href="${escapeHtml(item.url)}">查看原文</a>${readerButtons(item)}</div></header>
      <section><h2>摘要</h2><p class="detail-summary">${escapeHtml(item.summary)}</p></section>
      ${item.whyItMatters ? `<section class="detail-why"><h2>为什么值得关注</h2><p>${escapeHtml(item.whyItMatters)}</p></section>` : '<section class="detail-why fallback"><h2>原文摘录</h2><p>本条尚未经 AI 或编辑提炼，不生成推断性结论。</p></section>'}
      ${trustDetailMarkup(item)}
      <section><h2>你的备注</h2><form id="note-form"><label class="sr-only" for="reader-note">你的备注</label><textarea id="reader-note" name="note" maxlength="2000" placeholder="记录你想复查的问题、项目关联或下一步动作…">${escapeHtml(reader.note)}</textarea><div><button class="outline" type="submit">保存备注</button><span id="note-status" class="form-status"></span></div></form></section>
      ${feedbackControls(item)}
      ${item.contentText ? `<details class="source-extract"><summary>查看原始内容摘录</summary><p>${escapeHtml(item.contentText)}</p></details>` : ''}
    </article>`;
  bindDetailControls(item);
}

function bindDetailControls(item) {
  document.querySelectorAll('[data-reader-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await mutateReader(item.id, button.dataset.readerAction);
      if (button.dataset.readerAction === 'hide') return navigate(state.backHash, { focus: false });
      await renderItemDetail({ autoMarkRead: false });
    } catch (error) { button.textContent = error.message; button.disabled = false; }
  }));
  document.querySelector('#note-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.querySelector('#note-status');
    status.textContent = '正在保存…';
    try { await mutateReader(item.id, 'note', new FormData(event.currentTarget).get('note')); status.textContent = '已保存'; }
    catch (error) { status.textContent = error.message; }
  });
  document.querySelectorAll('[data-feedback-action]').forEach((button) => button.addEventListener('click', async () => {
    const status = document.querySelector('#feedback-status');
    button.disabled = true;
    status.textContent = '正在更新…';
    try {
      await mutateFeedback(item.id, button.dataset.feedbackAction);
      await renderItemDetail({ autoMarkRead: false });
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  }));
}

function renderAgent() {
  app.innerHTML = `<header class="agent-hero" tabindex="-1"><p class="eyebrow">AGENT INTEGRATION</p><h1>把 <em>AI HOT</em> 接进你的工作流</h1><p>通过 Skill、RSS 或 REST API，让 AI 优先获取带结论依据的事件简报。</p></header>
    <section class="integration-grid"><article><span>01</span><h2>Skill</h2><p>Agent 优先查询简报，需要归档或原始来源时再使用文章接口。</p><a href="/.well-known/ai-news-skill.md" target="_blank" rel="noreferrer">查看 Skill 文档</a></article><article><span>02</span><h2>RSS</h2><p>简报 RSS 将重复文章合并成可追溯事件。</p><a href="/feeds/briefs.xml" target="_blank" rel="noreferrer">订阅简报 RSS</a></article><article><span>03</span><h2>REST API</h2><p>对外返回事实／分析结论、来源列表、质量与阅读状态。</p><a href="/openapi.yaml" target="_blank" rel="noreferrer">查看 OpenAPI</a></article></section>
    <section class="code-section"><div><p class="eyebrow">START HERE</p><h2>一句话查询示例</h2><ul><li>“今天 AI 圈有什么新东西？”</li><li>“这个事件有哪些来源？”</li><li>“近 7 天我监控的主题有什么进展？”</li></ul></div><pre><code>GET /api/public/briefs
GET /api/public/briefs/{id}
GET /api/public/daily
GET /feeds/briefs.xml</code></pre></section>`;
}

async function renderSources() {
  const data = await fetchJson('/api/public/sources');
  const entries = [['all', '全部'], ['ok', '健康'], ['degraded', '降级'], ['error', '失败'], ['pending', '待验证'], ['disabled', '已停用']];
  const query = state.sourceQuery.toLowerCase();
  const filtered = data.sources
    .filter((source) => state.sourceHealth === 'all' || source.health.status === state.sourceHealth)
    .filter((source) => state.sourceChannel === 'all' || source.channel === state.sourceChannel)
    .filter((source) => !query || `${source.name} ${source.author} ${source.channelLabel} ${(source.topics || []).join(' ')}`.toLowerCase().includes(query))
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.tier - right.tier || left.name.localeCompare(right.name, 'zh-CN'));
  const groups = [...new Set(filtered.map((source) => source.channel))].sort((left, right) => (data.meta.channels[right] || 0) - (data.meta.channels[left] || 0));
  const sourceCard = (source) => `<article><div><div class="source-badges"><span class="source-channel channel-${escapeHtml(source.channel)}">${escapeHtml(source.channelLabel)}</span><span class="source-tier">T${source.tier}</span>${source.setupRequired ? '<span class="setup-badge">需配置</span>' : ''}${source.disabledReason ? '<span class="setup-badge">地址待修复</span>' : ''}</div><h2>${escapeHtml(source.name)}</h2><p>${source.author ? `${escapeHtml(source.author)} · ` : ''}${source.homepage ? `<a target="_blank" rel="noreferrer" href="${escapeHtml(source.homepage)}">${escapeHtml(source.homepage)}</a>` : '等待配置来源地址'}</p><div class="source-topics">${(source.topics || []).slice(0, 5).map((topic) => `<span>#${escapeHtml(topic)}</span>`).join('')}</div></div><aside><b class="source-health-${source.health.status}">${sourceHealthLabel(source.health.status)}</b><span>每 ${source.pollMinutes} 分钟</span><small>${source.disabledReason ? escapeHtml(source.disabledReason) : source.health.lastSuccessAt ? `上次成功 ${formatTime(source.health.lastSuccessAt, true)}` : source.setupRequired ? `启用前配置 ${escapeHtml(source.setupRequired)}` : '等待首次采集'}${source.health.failureKind && !source.disabledReason ? ` · ${escapeHtml(source.health.failureKind)}` : ''}${source.health.lastError && !source.disabledReason ? ` · ${escapeHtml(source.health.lastError)}` : ''}</small><div class="source-actions"><button class="text-button" data-source-retry="${escapeHtml(source.id)}" ${source.enabled ? '' : 'disabled'}>单源重试</button><button class="text-button" data-source-toggle="${escapeHtml(source.id)}" data-enabled="${source.enabled}" ${source.disabledReason ? 'disabled' : ''}>${source.disabledReason ? '等待新地址' : source.enabled ? '停用' : '启用'}</button></div></aside></article>`;
  app.innerHTML = `<header class="page-head" tabindex="-1"><div><p class="eyebrow">SOURCE TRANSPARENCY</p><h1>信源透明</h1><p>按渠道、可信层级和同步状态管理 100+ 信源。X 与 Reddit 使用官方 API，未配置凭证前保持停用。</p></div><div class="head-stat"><strong>${data.meta.enabled}</strong><span>已启用信源</span></div></header>
    <section class="source-overview"><article><strong>${data.meta.total}</strong><span>已配置</span></article><article><strong>${data.meta.enabled}</strong><span>自动采集</span></article><article><strong>${Object.keys(data.meta.channels).length}</strong><span>渠道类型</span></article><article><strong>${data.meta.setupRequired}</strong><span>需凭证启用</span></article></section>
    <section class="source-tools"><form id="opml-form"><label for="opml-file">导入 OPML 信源</label><input id="opml-file" name="file" type="file" accept=".opml,.xml,text/xml" required><button class="outline">导入</button><span id="opml-status" class="form-status"></span></form></section>
    <section class="source-health-filters">${entries.map(([value, label]) => `<button class="pill ${state.sourceHealth === value ? 'selected' : ''}" type="button" data-source-health="${value}" aria-pressed="${state.sourceHealth === value}">${label} ${value === 'all' ? data.sources.length : data.sources.filter((source) => source.health.status === value).length}</button>`).join('')}</section>
    <section class="source-discovery"><form id="source-search"><label for="source-q">搜索信源</label><input id="source-q" name="q" value="${escapeHtml(state.sourceQuery)}" placeholder="名称、作者或主题"><label for="source-channel">渠道</label><select id="source-channel" name="channel"><option value="all">全部渠道</option>${Object.entries(data.meta.channels).map(([channel, count]) => `<option value="${escapeHtml(channel)}" ${state.sourceChannel === channel ? 'selected' : ''}>${escapeHtml(channelLabels[channel] || channel)} · ${count}</option>`).join('')}</select><button class="outline">筛选</button></form></section>
    <section class="source-groups">${groups.length ? groups.map((channel) => `<details open><summary><span>${escapeHtml(channelLabels[channel] || channel)}</span><b>${filtered.filter((source) => source.channel === channel).length}</b></summary><div class="source-table">${filtered.filter((source) => source.channel === channel).map(sourceCard).join('')}</div></details>`).join('') : '<div class="empty">没有符合当前条件的信源。</div>'}</section>`;
  const sourceRoute = (changes = {}) => {
    const next = { health: state.sourceHealth, channel: state.sourceChannel, q: state.sourceQuery, ...changes };
    const params = new URLSearchParams();
    if (next.health !== 'all') params.set('health', next.health);
    if (next.channel !== 'all') params.set('channel', next.channel);
    if (next.q) params.set('q', next.q);
    return `#/sources${params.size ? `?${params}` : ''}`;
  };
  document.querySelectorAll('[data-source-health]').forEach((button) => button.addEventListener('click', () => navigate(sourceRoute({ health: button.dataset.sourceHealth }), { focus: false, resetScroll: true })));
  document.querySelector('#source-search')?.addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); navigate(sourceRoute({ q: form.get('q').trim(), channel: form.get('channel') }), { focus: false, resetScroll: true }); });
  document.querySelectorAll('[data-source-retry]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; button.textContent = '正在重试…'; try { await writeJson(`/api/local/sources/${encodeURIComponent(button.dataset.sourceRetry)}/retry`, 'POST', {}); await renderSources(); } catch (error) { button.textContent = error.message; button.disabled = false; } }));
  document.querySelectorAll('[data-source-toggle]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await writeJson(`/api/local/sources/${encodeURIComponent(button.dataset.sourceToggle)}`, 'PATCH', { enabled: button.dataset.enabled !== 'true' }); await renderSources(); } catch (error) { button.textContent = error.message; button.disabled = false; } }));
  document.querySelector('#opml-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const status = document.querySelector('#opml-status'); const file = new FormData(event.currentTarget).get('file'); if (!(file instanceof File) || !file.size) return; status.textContent = '正在导入…'; try { const result = await writeJson('/api/local/sources/opml', 'POST', { opml: await file.text() }); status.textContent = `已导入 ${result.imported} 个信源`; setTimeout(() => { void renderSources(); }, 500); } catch (error) { status.textContent = error.message; } });
}

function renderFeedback() {
  app.innerHTML = `<header class="page-head" tabindex="-1"><div><p class="eyebrow">FEEDBACK</p><h1>反馈与信源提报</h1><p>MVP 阶段请通过项目 Issue 收集错报、漏报与新信源建议。</p></div></header><section class="feedback-card"><h2>优先收集三类反馈</h2><ol><li>重要新闻漏报或重复聚合</li><li>摘要不准确、分类不合适</li><li>有明确 RSS/API 地址的高质量信源</li></ol><p>生产版可在这里接入表单、登录和审核工作流。</p></section>`;
}

function renderAdminLogin(message = '') {
  app.innerHTML = `<header class="page-head" tabindex="-1"><div><p class="eyebrow">LOCAL ADMIN</p><h1>管理后台</h1><p>令牌仅保存在当前浏览器标签会话中。</p></div></header>
    <section class="admin-login"><h2>输入管理令牌</h2>${message ? `<p class="admin-error">${escapeHtml(message)}</p>` : ''}<form id="admin-login-form"><label for="admin-token">管理令牌</label><div><input id="admin-token" name="token" type="password" autocomplete="current-password" required placeholder="data/admin-token.runtime 或 .env.local 中的令牌"/><button class="outline">进入后台</button></div></form></section>`;
  document.querySelector('#admin-login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sessionStorage.setItem('ai-hot-admin-token', new FormData(event.currentTarget).get('token').trim());
    render();
  });
}

const statusLabel = (status) => ({ ok: '正常', stale: '延迟', error: '失败', pending: '等待', completed: '完成', failed: '失败', running: '运行中', complete: '完整', degraded: '数据不完整' }[status] || status || '未知');

function adminItemCard(item, stateName) {
  const confidence = item.enrichment?.confidence == null ? '—' : `${Math.round(item.enrichment.confidence * 100)}%`;
  return `<form class="admin-item" data-item-id="${escapeHtml(item.id)}"><div class="admin-item-head"><div><span class="source-kind ${item.sourceKind}">${sourceLabels[item.sourceKind] || item.sourceKind}</span><b>${escapeHtml(item.sourceName)}</b></div><span>${confidence} · ${item.importance}</span></div><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><h3>${escapeHtml(item.title)}</h3></a><label>摘要<textarea name="summary">${escapeHtml(item.summary)}</textarea></label><label>值得关注<textarea name="whyItMatters">${escapeHtml(item.whyItMatters)}</textarea></label><div class="admin-inline"><label>分类<select name="category">${Object.entries(categoryLabels).map(([key, label]) => `<option value="${key}" ${item.category === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>重要度<input name="importance" type="number" min="1" max="99" value="${item.importance}"/></label></div>${item.enrichment?.error ? `<p class="admin-error">${escapeHtml(item.enrichment.error)}</p>` : ''}<div class="admin-actions">${stateName === 'failed' ? '<button type="button" class="outline" data-action="retry">重新处理</button>' : ''}<button type="submit" class="outline">批准并保存</button><button type="button" class="danger" data-action="reject">拒绝</button></div></form>`;
}

async function renderAdmin() {
  if (!adminToken()) return renderAdminLogin();
  try {
    const [overview, pending, failed, review] = await Promise.all([adminFetch('/api/admin/overview'), adminFetch('/api/admin/items?state=pending&take=10'), adminFetch('/api/admin/items?state=failed&take=10'), adminFetch('/api/admin/items?state=review&take=10')]);
    const queues = [pending, failed, review];
    app.innerHTML = `<header class="page-head" tabindex="-1"><div><p class="eyebrow">LOCAL ADMIN</p><h1>管理后台</h1><p>采集、AI 编辑、日报和人工审核统一管理。</p></div><button id="admin-logout" class="outline">退出</button></header><section class="admin-stats"><article><span>信源健康</span><strong>${overview.scheduler.healthy}/${overview.scheduler.sources}</strong><small>${overview.scheduler.failing} 个失败</small></article><article><span>待 AI 处理</span><strong>${overview.enrichment.pending}</strong><small>${overview.enrichment.provider || '未配置模型'}</small></article><article><span>待审核</span><strong>${overview.enrichment.review}</strong><small>${overview.enrichment.failed} 个失败</small></article><article><span>Token 用量</span><strong>${Number(overview.usage.inputTokens + overview.usage.outputTokens).toLocaleString()}</strong><small>${overview.usage.runs} 次任务</small></article></section><section class="admin-toolbar"><button class="outline" data-admin-command="ingest">刷新全部信源</button><button class="outline" data-admin-command="enrich">处理 AI 队列</button><button class="outline" data-admin-command="daily">重建今日日报</button><span id="admin-command-status"></span></section><section class="admin-health"><div><p class="eyebrow">SOURCE HEALTH</p><h2>信源状态</h2></div><div class="health-grid">${overview.sources.map((source) => `<article class="health-${source.state.status}"><b>${escapeHtml(source.name)}</b><span>${statusLabel(source.state.status)}</span><small>${source.state.lastSuccessAt ? formatTime(source.state.lastSuccessAt, true) : '尚未成功'}</small></article>`).join('')}</div></section><section class="admin-queues">${queues.map((queue) => `<article class="queue-column"><header><h2>${queue.state === 'pending' ? '等待处理' : queue.state === 'failed' ? '处理失败' : '等待审核'}</h2><span>${queue.items.length}</span></header>${queue.items.length ? queue.items.map((item) => adminItemCard(item, queue.state)).join('') : '<p class="queue-empty">当前队列为空</p>'}</article>`).join('')}</section><section class="admin-jobs"><p class="eyebrow">RECENT JOBS</p><h2>最近任务</h2>${overview.jobs.slice(0, 12).map((job) => `<div><b>${escapeHtml(job.kind)}</b><span>${escapeHtml(job.reason)}</span><em class="job-${job.status}">${statusLabel(job.status)}</em><small>${formatTime(job.startedAt, true)}</small></div>`).join('')}</section>`;
    bindAdminControls();
  } catch (error) { renderAdminLogin(error.message); }
}

function bindAdminControls() {
  document.querySelector('#admin-logout').addEventListener('click', () => { sessionStorage.removeItem('ai-hot-admin-token'); render(); });
  document.querySelectorAll('[data-admin-command]').forEach((button) => button.addEventListener('click', async () => {
    const command = button.dataset.adminCommand;
    const status = document.querySelector('#admin-command-status');
    status.textContent = '正在执行…';
    button.disabled = true;
    try {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      if (command === 'ingest') await adminFetch('/api/admin/ingest', { method: 'POST', body: '{}' });
      if (command === 'enrich') await adminFetch('/api/admin/enrich', { method: 'POST', body: JSON.stringify({ take: 30 }) });
      if (command === 'daily') await adminFetch('/api/admin/daily', { method: 'POST', body: JSON.stringify({ date, force: true }) });
      await renderAdmin();
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  }));
  document.querySelectorAll('.admin-item').forEach((form) => {
    const submitReview = async (reviewStatus) => {
      const formData = new FormData(form);
      const payload = { id: form.dataset.itemId, status: reviewStatus, summary: formData.get('summary'), whyItMatters: formData.get('whyItMatters'), category: formData.get('category'), importance: Number(formData.get('importance')), selected: reviewStatus === 'approved' };
      await adminFetch('/api/admin/review', { method: 'POST', body: JSON.stringify(payload) });
      await renderAdmin();
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); void submitReview('approved'); });
    form.querySelector('[data-action="reject"]').addEventListener('click', () => void submitReview('rejected'));
    form.querySelector('[data-action="retry"]')?.addEventListener('click', async () => { await adminFetch('/api/admin/enrich', { method: 'POST', body: JSON.stringify({ itemId: form.dataset.itemId, take: 1, force: true }) }); await renderAdmin(); });
  });
}

function bindShell() {
  const trigger = document.querySelector('.more-trigger');
  const menu = document.querySelector('#mobile-more');
  trigger.addEventListener('click', () => {
    const open = menu.hasAttribute('hidden');
    menu.toggleAttribute('hidden', !open);
    trigger.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.sidebar a[href^="#/"]').forEach((link) => link.addEventListener('click', () => { shouldFocusMain = true; }));
  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => { menu.setAttribute('hidden', ''); trigger.setAttribute('aria-expanded', 'false'); shouldFocusMain = true; }));
  document.querySelector('.skip-link').addEventListener('click', (event) => { event.preventDefault(); app.focus(); });
}

async function render() {
  parseRoute();
  app.innerHTML = '<div class="loading"><span></span>正在更新新闻流…</div>';
  try {
    if (state.route === 'briefs' || state.route === 'selected') await renderBriefs();
    else if (state.route === 'brief') await renderBriefDetail();
    else if (state.route === 'all') await renderNews();
    else if (state.route === 'reading') await renderReading();
    else if (state.route === 'daily') await renderDaily();
    else if (state.route === 'weekly') await renderWeekly();
    else if (state.route === 'monitors') await renderMonitors();
    else if (state.route === 'library') await renderLibrary();
    else if (state.route === 'item') await renderItemDetail();
    else if (state.route === 'agent') renderAgent();
    else if (state.route === 'sources') await renderSources();
    else if (state.route === 'admin') await renderAdmin();
    else renderFeedback();
    if (shouldFocusMain) requestAnimationFrame(() => app.focus({ preventScroll: true }));
    shouldFocusMain = false;
  } catch (error) {
    app.innerHTML = `<div class="error"><h1>暂时无法载入</h1><p>${escapeHtml(error.message)}</p><button class="outline" onclick="location.reload()">重新尝试</button></div>`;
  }
}

bindShell();
let previousHash = currentHash();
window.addEventListener('hashchange', () => {
  rememberScroll(previousHash);
  previousHash = currentHash();
  render();
});
window.addEventListener('beforeunload', () => rememberScroll());
window.addEventListener('scroll', () => rememberScroll(), { passive: true });
render();
