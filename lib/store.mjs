import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
};

const dateInShanghai = (value) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
};

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function itemValues(item) {
  return [
    item.id,
    item.canonicalUrl,
    item.sourceId,
    item.sourceName,
    item.sourceKind,
    item.sourceChannel ?? null,
    item.sourceTier ?? null,
    JSON.stringify(item.sourceTopics ?? []),
    item.author ?? '',
    item.contentType ?? null,
    item.aiEligible === false ? 0 : 1,
    item.title,
    item.url,
    item.publishedAt,
    item.fetchedAt,
    item.category,
    JSON.stringify(item.tags ?? []),
    item.summary ?? '',
    item.whyItMatters ?? '',
    item.importance ?? 0,
    item.selected ? 1 : 0,
    item.status ?? 'published',
    item.contentText ?? null,
    item.contentOrigin ?? 'feed',
    JSON.stringify(item.enrichment ?? {}),
    JSON.stringify(item.review ?? {}),
    item.updatedAt ?? new Date().toISOString()
  ];
}

function rowToItem(row) {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceKind: row.source_kind,
    sourceChannel: row.source_channel ?? undefined,
    sourceTier: row.source_tier ?? undefined,
    sourceTopics: json(row.source_topics_json, []),
    author: row.author ?? '',
    contentType: row.content_type ?? undefined,
    aiEligible: row.ai_eligible === undefined || row.ai_eligible === null ? true : Boolean(row.ai_eligible),
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    category: row.category,
    tags: json(row.tags_json, []),
    summary: row.summary,
    whyItMatters: row.why_it_matters,
    importance: row.importance,
    selected: Boolean(row.selected),
    status: row.status,
    contentText: row.content_text ?? undefined,
    contentOrigin: row.content_origin ?? 'feed',
    enrichment: json(row.enrichment_json, {}),
    review: json(row.review_json, {}),
    updatedAt: row.updated_at
  };
}

function rowToSourceState(row) {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    etag: row.etag,
    lastModified: row.last_modified,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    nextPollAt: row.next_poll_at,
    failureCount: row.failure_count,
    lastError: row.last_error,
    status: row.status,
    entries: row.last_entries,
    inserted: row.last_inserted,
    duplicates: row.last_duplicates,
    httpStatus: row.http_status,
    failureKind: row.failure_kind ?? null,
    retryAfterAt: row.retry_after_at ?? null,
    lastDurationMs: row.last_duration_ms ?? null
  };
}

function rowToBriefReaderState(row) {
  if (!row) return null;
  return {
    briefId: row.brief_id,
    readAt: row.read_at,
    savedAt: row.saved_at,
    hiddenAt: row.hidden_at,
    note: row.note ?? '',
    updatedAt: row.updated_at
  };
}

function rowToBrief(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    headline: row.headline,
    summaryClaims: json(row.summary_claims_json, []),
    whyItMatters: json(row.why_it_matters_json, null),
    topics: json(row.topics_json, []),
    entities: json(row.entities_json, []),
    firstPublishedAt: row.first_published_at,
    lastPublishedAt: row.last_published_at,
    importance: row.importance,
    selected: Boolean(row.selected),
    active: row.active === undefined ? true : Boolean(row.active),
    quality: json(row.quality_json, {}),
    updatedAt: row.updated_at
  };
}

function rowToMonitor(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    include: json(row.include_json, {}),
    exclude: json(row.exclude_json, {}),
    priority: row.priority,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToReaderState(row) {
  if (!row) return null;
  return {
    itemId: row.item_id,
    readAt: row.read_at,
    savedAt: row.saved_at,
    hiddenAt: row.hidden_at,
    note: row.note ?? '',
    updatedAt: row.updated_at
  };
}

function rowToReaderFeedback(row) {
  if (!row) return null;
  return {
    itemId: row.item_id,
    dimension: row.dimension,
    target: row.target,
    value: row.value,
    updatedAt: row.updated_at
  };
}

export class SqliteStore {
  constructor({ dbPath, dataDir, sourcesPath, itemsJsonPath, issuesJsonPath, overridesPath }) {
    this.dbPath = dbPath;
    this.dataDir = dataDir;
    this.sourcesPath = sourcesPath;
    this.itemsJsonPath = itemsJsonPath;
    this.issuesJsonPath = issuesJsonPath;
    this.overridesPath = overridesPath;
    this.db = null;
    this.items = [];
    this.issues = [];
    this.sources = [];
    this.migration = { importedItems: 0, importedIssues: 0 };
  }

  async initialize() {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { timeout: 5_000 });
    const existingTables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const existingItemColumns = existingTables.has('items') ? new Set(this.db.prepare('PRAGMA table_info(items)').all().map((row) => row.name)) : new Set();
    if (existingTables.has('items') && !existingTables.has('story_briefs')) {
      const directory = path.join(this.dataDir, 'backups');
      await mkdir(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(directory, `ai-news-pre-v06-${stamp}.sqlite`);
      await sqliteBackup(this.db, file);
      this.migration.schemaBackup = path.basename(file);
    }
    if (existingTables.has('items') && !existingItemColumns.has('source_channel') && existingTables.has('story_briefs')) {
      const directory = path.join(this.dataDir, 'backups');
      await mkdir(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(directory, `ai-news-pre-v09-${stamp}.sqlite`);
      await sqliteBackup(this.db, file);
      this.migration.schemaBackup = path.basename(file);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        canonical_url TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_channel TEXT,
        source_tier INTEGER,
        source_topics_json TEXT NOT NULL DEFAULT '[]',
        author TEXT NOT NULL DEFAULT '',
        content_type TEXT,
        ai_eligible INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        why_it_matters TEXT NOT NULL,
        importance INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_text TEXT,
        content_origin TEXT NOT NULL DEFAULT 'feed',
        enrichment_json TEXT NOT NULL,
        review_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS reader_state (
        item_id TEXT PRIMARY KEY,
        read_at TEXT,
        saved_at TEXT,
        hidden_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reader_saved ON reader_state(saved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reader_hidden ON reader_state(hidden_at DESC);
      CREATE TABLE IF NOT EXISTS reader_feedback (
        item_id TEXT NOT NULL,
        dimension TEXT NOT NULL CHECK(dimension IN ('category', 'source')),
        target TEXT NOT NULL,
        value INTEGER NOT NULL CHECK(value IN (-1, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(item_id, dimension),
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reader_feedback_target ON reader_feedback(dimension, target);
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        generated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        health_json TEXT NOT NULL DEFAULT '{}',
        content_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_items (
        issue_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(issue_id, item_id),
        FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS source_state (
        source_id TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        next_poll_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_entries INTEGER NOT NULL DEFAULT 0,
        last_inserted INTEGER NOT NULL DEFAULT 0,
        last_duplicates INTEGER NOT NULL DEFAULT 0,
        http_status INTEGER,
        failure_kind TEXT,
        retry_after_at TEXT,
        last_duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_started ON job_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS story_briefs (
        id TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary_claims_json TEXT NOT NULL DEFAULT '[]',
        why_it_matters_json TEXT,
        topics_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        first_published_at TEXT NOT NULL,
        last_published_at TEXT NOT NULL,
        importance INTEGER NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        quality_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_briefs_recent ON story_briefs(last_published_at DESC, importance DESC);
      CREATE TABLE IF NOT EXISTS story_brief_items (
        brief_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(brief_id,item_id),
        FOREIGN KEY(brief_id) REFERENCES story_briefs(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_story_brief_items_item ON story_brief_items(item_id);
      CREATE TABLE IF NOT EXISTS brief_reader_state (
        brief_id TEXT PRIMARY KEY,
        read_at TEXT,
        saved_at TEXT,
        hidden_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(brief_id) REFERENCES story_briefs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_brief_reader_saved ON brief_reader_state(saved_at DESC);
      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        include_json TEXT NOT NULL DEFAULT '{}',
        exclude_json TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const itemColumns = new Set(this.db.prepare('PRAGMA table_info(items)').all().map((row) => row.name));
    if (!itemColumns.has('source_channel')) this.db.exec('ALTER TABLE items ADD COLUMN source_channel TEXT');
    if (!itemColumns.has('source_tier')) this.db.exec('ALTER TABLE items ADD COLUMN source_tier INTEGER');
    if (!itemColumns.has('source_topics_json')) this.db.exec("ALTER TABLE items ADD COLUMN source_topics_json TEXT NOT NULL DEFAULT '[]'");
    if (!itemColumns.has('author')) this.db.exec("ALTER TABLE items ADD COLUMN author TEXT NOT NULL DEFAULT ''");
    if (!itemColumns.has('content_type')) this.db.exec('ALTER TABLE items ADD COLUMN content_type TEXT');
    if (!itemColumns.has('ai_eligible')) this.db.exec('ALTER TABLE items ADD COLUMN ai_eligible INTEGER NOT NULL DEFAULT 1');
    const sourceColumns = new Set(this.db.prepare('PRAGMA table_info(source_state)').all().map((row) => row.name));
    if (!sourceColumns.has('failure_kind')) this.db.exec('ALTER TABLE source_state ADD COLUMN failure_kind TEXT');
    if (!sourceColumns.has('retry_after_at')) this.db.exec('ALTER TABLE source_state ADD COLUMN retry_after_at TEXT');
    if (!sourceColumns.has('last_duration_ms')) this.db.exec('ALTER TABLE source_state ADD COLUMN last_duration_ms INTEGER');
    const briefColumns = new Set(this.db.prepare('PRAGMA table_info(story_briefs)').all().map((row) => row.name));
    if (!briefColumns.has('active')) this.db.exec('ALTER TABLE story_briefs ADD COLUMN active INTEGER NOT NULL DEFAULT 1');

    this.sources = await readJson(this.sourcesPath, []);
    await this.importLegacyData();
    this.items = this.db.prepare('SELECT * FROM items ORDER BY published_at DESC').all().map(rowToItem);
    await this.applyEditorialOverrides();
    this.issues = this.db.prepare('SELECT content_json FROM issues ORDER BY date DESC').all().map((row) => json(row.content_json, null)).filter(Boolean);
    return this;
  }

  async importLegacyData() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM items').get().count;
    if (count === 0) {
      const legacyItems = await readJson(this.itemsJsonPath, []);
      if (legacyItems.length) {
        this.items = legacyItems;
        await this.saveItems();
        this.migration.importedItems = legacyItems.length;
      }
    }
    const issueCount = this.db.prepare('SELECT COUNT(*) AS count FROM issues').get().count;
    if (issueCount === 0) {
      const legacyIssues = await readJson(this.issuesJsonPath, []);
      if (legacyIssues.length) {
        this.issues = legacyIssues;
        await this.saveIssues();
        this.migration.importedIssues = legacyIssues.length;
      }
    }
  }

  async applyEditorialOverrides() {
    const overrides = await readJson(this.overridesPath, {});
    let changed = 0;
    this.items = this.items.map((item) => {
      const override = overrides[item.canonicalUrl];
      if (!override) return item;
      changed += 1;
      return {
        ...item,
        ...override,
        tags: Array.isArray(override.tags) ? override.tags : item.tags,
        selected: (override.importance ?? item.importance) >= 70,
        enrichment: { status: 'completed', provider: 'editorial-batch', model: 'human-editor', promptVersion: 'editorial-batch-v1', confidence: 1, requiresReview: false, attempts: 1, updatedAt: override.updatedAt ?? new Date().toISOString() },
        review: { status: 'approved', reviewedAt: override.updatedAt ?? new Date().toISOString(), note: '首批编辑批注' }
      };
    });
    if (changed) await this.saveItems();
  }

  async saveItem(item) {
    const statement = this.db.prepare(`
      INSERT INTO items (
        id, canonical_url, source_id, source_name, source_kind, source_channel, source_tier, source_topics_json, author, content_type, ai_eligible, title, url,
        published_at, fetched_at, category, tags_json, summary, why_it_matters,
        importance, selected, status, content_text, content_origin,
        enrichment_json, review_json, updated_at
      ) VALUES (${Array(27).fill('?').join(',')})
      ON CONFLICT(canonical_url) DO UPDATE SET
        source_id=excluded.source_id, source_name=excluded.source_name, source_kind=excluded.source_kind,
        source_channel=excluded.source_channel, source_tier=excluded.source_tier, source_topics_json=excluded.source_topics_json,
        author=excluded.author, content_type=excluded.content_type, ai_eligible=excluded.ai_eligible,
        title=excluded.title, url=excluded.url, published_at=excluded.published_at,
        fetched_at=excluded.fetched_at, category=excluded.category, tags_json=excluded.tags_json,
        summary=excluded.summary, why_it_matters=excluded.why_it_matters,
        importance=excluded.importance, selected=excluded.selected, status=excluded.status,
        content_text=excluded.content_text, content_origin=excluded.content_origin,
        enrichment_json=excluded.enrichment_json, review_json=excluded.review_json,
        updated_at=excluded.updated_at
    `);
    statement.run(...itemValues(item));
  }

  async saveItems() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of this.items) await this.saveItem(item);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveIssue(issue) {
    this.db.prepare(`
      INSERT INTO issues(id,date,generated_at,title,summary,status,health_json,content_json)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET id=excluded.id, generated_at=excluded.generated_at,
        title=excluded.title, summary=excluded.summary, status=excluded.status,
        health_json=excluded.health_json, content_json=excluded.content_json
    `).run(issue.id, issue.date, issue.generatedAt, issue.title, issue.summary, issue.status ?? 'complete', JSON.stringify(issue.health ?? {}), JSON.stringify(issue));
    this.db.prepare('DELETE FROM issue_items WHERE issue_id = ?').run(issue.id);
    const insert = this.db.prepare('INSERT INTO issue_items(issue_id,item_id,position,snapshot_json) VALUES(?,?,?,?)');
    const items = issue.sections?.flatMap((section) => section.items) ?? [];
    items.forEach((item, index) => insert.run(issue.id, item.id, index, JSON.stringify(item)));
  }

  async saveIssues() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const issue of this.issues) await this.saveIssue(issue);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSourceState(sourceId) {
    return rowToSourceState(this.db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId));
  }

  async replaceSources(sources) {
    if (!Array.isArray(sources)) throw new Error('sources must be an array');
    const temporary = `${this.sourcesPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.sourcesPath);
    this.sources = sources;
    return this.sources;
  }

  listSourceStates() {
    return this.db.prepare('SELECT * FROM source_state ORDER BY source_id').all().map(rowToSourceState);
  }

  getReaderState(itemId) {
    return rowToReaderState(this.db.prepare('SELECT * FROM reader_state WHERE item_id = ?').get(itemId));
  }

  listReaderStates() {
    return this.db.prepare('SELECT * FROM reader_state ORDER BY updated_at DESC').all().map(rowToReaderState);
  }

  getReaderStates(itemIds = []) {
    if (!itemIds.length) return new Map();
    const uniqueIds = [...new Set(itemIds)].filter(Boolean);
    const placeholders = uniqueIds.map(() => '?').join(',');
    return new Map(this.db.prepare(`SELECT * FROM reader_state WHERE item_id IN (${placeholders})`).all(...uniqueIds).map((row) => {
      const state = rowToReaderState(row);
      return [state.itemId, state];
    }));
  }

  updateReaderState(itemId, action, note = '') {
    if (!this.db.prepare('SELECT 1 AS found FROM items WHERE id = ?').get(itemId)) throw new Error('item not found');
    const current = this.getReaderState(itemId) ?? { itemId, readAt: null, savedAt: null, hiddenAt: null, note: '' };
    const now = new Date().toISOString();
    const next = { ...current, updatedAt: now };
    if (action === 'read') next.readAt ??= now;
    else if (action === 'unread') next.readAt = null;
    else if (action === 'save') next.savedAt ??= now;
    else if (action === 'unsave') next.savedAt = null;
    else if (action === 'hide') next.hiddenAt ??= now;
    else if (action === 'unhide') next.hiddenAt = null;
    else if (action === 'note') next.note = String(note ?? '').trim().slice(0, 2_000);
    else throw new Error('unsupported reader action');

    if (!next.readAt && !next.savedAt && !next.hiddenAt && !next.note) {
      this.db.prepare('DELETE FROM reader_state WHERE item_id = ?').run(itemId);
      return { itemId, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: now };
    }
    this.db.prepare(`
      INSERT INTO reader_state(item_id,read_at,saved_at,hidden_at,note,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET read_at=excluded.read_at,saved_at=excluded.saved_at,
        hidden_at=excluded.hidden_at,note=excluded.note,updated_at=excluded.updated_at
    `).run(itemId, next.readAt, next.savedAt, next.hiddenAt, next.note, next.updatedAt);
    return next;
  }

  getBriefSources(briefId) {
    return this.db.prepare(`
      SELECT i.* FROM story_brief_items sbi
      JOIN items i ON i.id = sbi.item_id
      WHERE sbi.brief_id = ?
      ORDER BY sbi.position ASC
    `).all(briefId).map((row) => {
      const item = rowToItem(row);
      return { ...item, reader: this.getReaderState(item.id) ?? { itemId: item.id, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: null } };
    });
  }

  getBriefReaderState(briefId) {
    return rowToBriefReaderState(this.db.prepare('SELECT * FROM brief_reader_state WHERE brief_id = ?').get(briefId));
  }

  listBriefReaderStates() {
    return this.db.prepare('SELECT * FROM brief_reader_state ORDER BY updated_at DESC').all().map(rowToBriefReaderState);
  }

  listBriefs() {
    return this.db.prepare('SELECT * FROM story_briefs WHERE active = 1 ORDER BY importance DESC,last_published_at DESC').all().map((row) => {
      const brief = rowToBrief(row);
      const sourceItems = this.getBriefSources(brief.id);
      return {
        ...brief,
        contentTypes: [...new Set(sourceItems.map((item) => item.contentType).filter(Boolean))],
        sourceChannels: [...new Set(sourceItems.map((item) => item.sourceChannel).filter(Boolean))],
        sources: sourceItems.map((item) => ({
          itemId: item.id, sourceId: item.sourceId, sourceName: item.sourceName, sourceKind: item.sourceKind,
          sourceChannel: item.sourceChannel, sourceTier: item.sourceTier, contentType: item.contentType, author: item.author,
          title: item.title, url: item.url, publishedAt: item.publishedAt, summary: item.summary, note: item.reader.note
        })),
        reader: this.getBriefReaderState(brief.id) ?? { briefId: brief.id, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: null }
      };
    });
  }

  getBrief(briefId) {
    const row = this.db.prepare('SELECT * FROM story_briefs WHERE id = ?').get(briefId);
    if (!row) return null;
    const brief = rowToBrief(row);
    const sourceItems = this.getBriefSources(briefId);
    return {
      ...brief,
      contentTypes: [...new Set(sourceItems.map((item) => item.contentType).filter(Boolean))],
      sourceChannels: [...new Set(sourceItems.map((item) => item.sourceChannel).filter(Boolean))],
      sources: sourceItems.map((item) => ({
        itemId: item.id, sourceId: item.sourceId, sourceName: item.sourceName, sourceKind: item.sourceKind,
        sourceChannel: item.sourceChannel, sourceTier: item.sourceTier, contentType: item.contentType, author: item.author,
        title: item.title, url: item.url, publishedAt: item.publishedAt, summary: item.summary,
        contentText: item.contentText, note: item.reader.note
      })),
      reader: this.getBriefReaderState(briefId) ?? { briefId, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: null }
    };
  }

  saveBriefs(briefs = []) {
    const upsert = this.db.prepare(`
      INSERT INTO story_briefs(id,canonical_key,headline,summary_claims_json,why_it_matters_json,topics_json,entities_json,first_published_at,last_published_at,importance,selected,active,quality_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET canonical_key=excluded.canonical_key,headline=excluded.headline,
        summary_claims_json=excluded.summary_claims_json,why_it_matters_json=excluded.why_it_matters_json,
        topics_json=excluded.topics_json,entities_json=excluded.entities_json,first_published_at=excluded.first_published_at,
        last_published_at=excluded.last_published_at,importance=excluded.importance,selected=excluded.selected,active=1,
        quality_json=excluded.quality_json,updated_at=excluded.updated_at
    `);
    const insertItem = this.db.prepare('INSERT INTO story_brief_items(brief_id,item_id,position) VALUES(?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE story_briefs SET active = 0').run();
      for (const brief of briefs) {
        upsert.run(
          brief.id, brief.canonicalKey, brief.headline, JSON.stringify(brief.summaryClaims ?? []),
          brief.whyItMatters ? JSON.stringify(brief.whyItMatters) : null, JSON.stringify(brief.topics ?? []),
          JSON.stringify(brief.entities ?? []), brief.firstPublishedAt, brief.lastPublishedAt,
          brief.importance ?? 0, brief.selected ? 1 : 0, 1, JSON.stringify(brief.quality ?? {}), brief.updatedAt ?? new Date().toISOString()
        );
        this.db.prepare('DELETE FROM story_brief_items WHERE brief_id = ?').run(brief.id);
        (brief.sources ?? []).forEach((source, index) => insertItem.run(brief.id, source.itemId, index));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const brief of briefs) this.migrateBriefReaderState(brief.id);
    return briefs.length;
  }

  migrateBriefReaderState(briefId) {
    if (this.getBriefReaderState(briefId)) return false;
    const sources = this.getBriefSources(briefId);
    if (!sources.length) return false;
    const states = sources.map((item) => item.reader);
    const timestamps = (field) => states.map((state) => state[field]).filter(Boolean).sort();
    const readAt = states.every((state) => state.readAt) ? timestamps('readAt').at(-1) : null;
    const savedAt = timestamps('savedAt').at(-1) ?? null;
    const hiddenAt = states.every((state) => state.hiddenAt) ? timestamps('hiddenAt').at(-1) : null;
    if (!readAt && !savedAt && !hiddenAt) return false;
    const updatedAt = timestamps('updatedAt').at(-1) ?? new Date().toISOString();
    this.db.prepare('INSERT INTO brief_reader_state(brief_id,read_at,saved_at,hidden_at,note,updated_at) VALUES(?,?,?,?,?,?)').run(briefId, readAt, savedAt, hiddenAt, '', updatedAt);
    return true;
  }

  updateBriefReaderState(briefId, action, note = '') {
    if (!this.db.prepare('SELECT 1 AS found FROM story_briefs WHERE id = ?').get(briefId)) throw new Error('brief not found');
    const current = this.getBriefReaderState(briefId) ?? { briefId, readAt: null, savedAt: null, hiddenAt: null, note: '' };
    const now = new Date().toISOString();
    const next = { ...current, updatedAt: now };
    if (action === 'read') next.readAt ??= now;
    else if (action === 'unread') next.readAt = null;
    else if (action === 'save') next.savedAt ??= now;
    else if (action === 'unsave') next.savedAt = null;
    else if (action === 'hide') next.hiddenAt ??= now;
    else if (action === 'unhide') next.hiddenAt = null;
    else if (action === 'note') next.note = String(note ?? '').trim().slice(0, 2_000);
    else throw new Error('unsupported brief reader action');
    if (!next.readAt && !next.savedAt && !next.hiddenAt && !next.note) {
      this.db.prepare('DELETE FROM brief_reader_state WHERE brief_id = ?').run(briefId);
      return { briefId, readAt: null, savedAt: null, hiddenAt: null, note: '', updatedAt: now };
    }
    this.db.prepare(`
      INSERT INTO brief_reader_state(brief_id,read_at,saved_at,hidden_at,note,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(brief_id) DO UPDATE SET read_at=excluded.read_at,saved_at=excluded.saved_at,
        hidden_at=excluded.hidden_at,note=excluded.note,updated_at=excluded.updated_at
    `).run(briefId, next.readAt, next.savedAt, next.hiddenAt, next.note, next.updatedAt);
    return next;
  }

  listMonitors() {
    return this.db.prepare('SELECT * FROM monitors ORDER BY priority DESC,updated_at DESC').all().map(rowToMonitor);
  }

  getMonitor(id) {
    return rowToMonitor(this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
  }

  saveMonitor(monitor) {
    this.db.prepare(`
      INSERT INTO monitors(id,name,include_json,exclude_json,priority,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,include_json=excluded.include_json,
        exclude_json=excluded.exclude_json,priority=excluded.priority,enabled=excluded.enabled,updated_at=excluded.updated_at
    `).run(monitor.id, monitor.name, JSON.stringify(monitor.include ?? {}), JSON.stringify(monitor.exclude ?? {}), monitor.priority ?? 2, monitor.enabled ? 1 : 0, monitor.createdAt, monitor.updatedAt);
    return this.getMonitor(monitor.id);
  }

  deleteMonitor(id) {
    return this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes;
  }

  getReaderFeedback(itemId) {
    const feedback = { itemId, category: null, source: null };
    for (const row of this.db.prepare('SELECT * FROM reader_feedback WHERE item_id = ?').all(itemId)) {
      const entry = rowToReaderFeedback(row);
      feedback[entry.dimension] = entry;
    }
    return feedback;
  }

  listReaderFeedback() {
    return this.db.prepare('SELECT * FROM reader_feedback ORDER BY updated_at DESC').all().map(rowToReaderFeedback);
  }

  getReaderFeedbacks(itemIds = []) {
    if (!itemIds.length) return new Map();
    const uniqueIds = [...new Set(itemIds)].filter(Boolean);
    const placeholders = uniqueIds.map(() => '?').join(',');
    const result = new Map(uniqueIds.map((itemId) => [itemId, { itemId, category: null, source: null }]));
    for (const row of this.db.prepare(`SELECT * FROM reader_feedback WHERE item_id IN (${placeholders})`).all(...uniqueIds)) {
      const entry = rowToReaderFeedback(row);
      result.get(entry.itemId)[entry.dimension] = entry;
    }
    return result;
  }

  listReaderPreferences() {
    return this.db.prepare(`
      SELECT dimension, target, SUM(value) AS score, COUNT(*) AS feedback_count
      FROM reader_feedback
      GROUP BY dimension, target
      HAVING SUM(value) != 0
      ORDER BY dimension, score DESC, target ASC
    `).all().map((row) => ({ dimension: row.dimension, target: row.target, score: row.score, feedbackCount: row.feedback_count }));
  }

  updateReaderFeedback(item, action) {
    if (!item?.id || !this.db.prepare('SELECT 1 AS found FROM items WHERE id = ?').get(item.id)) throw new Error('item not found');
    if (action === 'clear') {
      this.db.prepare('DELETE FROM reader_feedback WHERE item_id = ?').run(item.id);
      return { feedback: this.getReaderFeedback(item.id), preferences: this.listReaderPreferences() };
    }
    const actions = {
      'prefer-category': { dimension: 'category', value: 1, target: item.category },
      'avoid-category': { dimension: 'category', value: -1, target: item.category },
      'prefer-source': { dimension: 'source', value: 1, target: item.sourceId },
      'avoid-source': { dimension: 'source', value: -1, target: item.sourceId }
    };
    const next = actions[action];
    if (!next) throw new Error('unsupported reader feedback action');
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO reader_feedback(item_id,dimension,target,value,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(item_id,dimension) DO UPDATE SET target=excluded.target,value=excluded.value,updated_at=excluded.updated_at
    `).run(item.id, next.dimension, next.target, next.value, updatedAt);
    return { feedback: this.getReaderFeedback(item.id), preferences: this.listReaderPreferences() };
  }

  clearReaderPreference(dimension, target) {
    if (!['category', 'source'].includes(dimension) || typeof target !== 'string' || !target.trim()) throw new Error('invalid reader preference');
    const result = this.db.prepare('DELETE FROM reader_feedback WHERE dimension = ? AND target = ?').run(dimension, target.trim());
    return { dimension, target: target.trim(), cleared: result.changes, preferences: this.listReaderPreferences() };
  }

  readerLibrarySnapshot(now = new Date()) {
    return {
      version: 1,
      exportedAt: now.toISOString(),
      readerStates: this.listReaderStates(),
      feedback: this.listReaderFeedback(),
      dailyIssues: this.issues
    };
  }

  importReaderLibrary(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1 || !Array.isArray(snapshot.readerStates) || !Array.isArray(snapshot.feedback)) throw new Error('invalid library export');
    const itemById = new Map(this.items.map((item) => [item.id, item]));
    const iso = (value) => typeof value === 'string' && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toISOString() : null;
    const currentStates = new Map(this.listReaderStates().map((entry) => [entry.itemId, entry]));
    const feedbackRows = this.db.prepare('SELECT * FROM reader_feedback').all().map(rowToReaderFeedback);
    const currentFeedback = new Map(feedbackRows.map((entry) => [`${entry.itemId}:${entry.dimension}`, entry]));
    const stateUpsert = this.db.prepare(`
      INSERT INTO reader_state(item_id,read_at,saved_at,hidden_at,note,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET read_at=excluded.read_at,saved_at=excluded.saved_at,
        hidden_at=excluded.hidden_at,note=excluded.note,updated_at=excluded.updated_at
    `);
    const feedbackUpsert = this.db.prepare(`
      INSERT INTO reader_feedback(item_id,dimension,target,value,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(item_id,dimension) DO UPDATE SET target=excluded.target,value=excluded.value,updated_at=excluded.updated_at
    `);
    const result = { readerStates: 0, feedback: 0, skippedUnknownItems: 0, skippedOlder: 0, dailyIssuesInExport: Array.isArray(snapshot.dailyIssues) ? snapshot.dailyIssues.length : 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const raw of snapshot.readerStates) {
        if (!raw || typeof raw.itemId !== 'string') continue;
        if (!itemById.has(raw.itemId)) { result.skippedUnknownItems += 1; continue; }
        const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 2_000) : '';
        const readAt = iso(raw.readAt);
        const savedAt = iso(raw.savedAt);
        const hiddenAt = iso(raw.hiddenAt);
        const updatedAt = iso(raw.updatedAt) ?? new Date().toISOString();
        if (!readAt && !savedAt && !hiddenAt && !note) continue;
        const current = currentStates.get(raw.itemId);
        if (current?.updatedAt && new Date(current.updatedAt) > new Date(updatedAt)) { result.skippedOlder += 1; continue; }
        stateUpsert.run(raw.itemId, readAt, savedAt, hiddenAt, note, updatedAt);
        result.readerStates += 1;
      }
      for (const raw of snapshot.feedback) {
        if (!raw || typeof raw.itemId !== 'string' || !['category', 'source'].includes(raw.dimension) || ![-1, 1].includes(raw.value)) continue;
        const item = itemById.get(raw.itemId);
        if (!item) { result.skippedUnknownItems += 1; continue; }
        const updatedAt = iso(raw.updatedAt) ?? new Date().toISOString();
        const current = currentFeedback.get(`${raw.itemId}:${raw.dimension}`);
        if (current?.updatedAt && new Date(current.updatedAt) > new Date(updatedAt)) { result.skippedOlder += 1; continue; }
        feedbackUpsert.run(raw.itemId, raw.dimension, raw.dimension === 'category' ? item.category : item.sourceId, raw.value, updatedAt);
        result.feedback += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  upsertSourceState(sourceId, changes = {}) {
    const current = this.getSourceState(sourceId) ?? { sourceId, failureCount: 0, status: 'pending', entries: 0, inserted: 0, duplicates: 0 };
    const state = { ...current, ...changes };
    this.db.prepare(`
      INSERT INTO source_state(source_id,etag,last_modified,last_attempt_at,last_success_at,next_poll_at,failure_count,last_error,status,last_entries,last_inserted,last_duplicates,http_status,failure_kind,retry_after_at,last_duration_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,next_poll_at=excluded.next_poll_at,
        failure_count=excluded.failure_count,last_error=excluded.last_error,status=excluded.status,
        last_entries=excluded.last_entries,last_inserted=excluded.last_inserted,last_duplicates=excluded.last_duplicates,http_status=excluded.http_status,
        failure_kind=excluded.failure_kind,retry_after_at=excluded.retry_after_at,last_duration_ms=excluded.last_duration_ms
    `).run(sourceId, state.etag ?? null, state.lastModified ?? null, state.lastAttemptAt ?? null, state.lastSuccessAt ?? null, state.nextPollAt ?? null, state.failureCount ?? 0, state.lastError ?? null, state.status ?? 'pending', state.entries ?? 0, state.inserted ?? 0, state.duplicates ?? 0, state.httpStatus ?? null, state.failureKind ?? null, state.retryAfterAt ?? null, state.lastDurationMs ?? null);
    return state;
  }

  startJob(kind, reason, details = {}) {
    const job = { id: randomUUID(), kind, reason, status: 'running', startedAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO job_runs(id,kind,reason,status,started_at,details_json) VALUES(?,?,?,?,?,?)').run(job.id, kind, reason, job.status, job.startedAt, JSON.stringify(details));
    return job;
  }

  finishJob(id, changes = {}) {
    const finishedAt = new Date().toISOString();
    this.db.prepare(`UPDATE job_runs SET status=?,finished_at=?,processed=?,succeeded=?,failed=?,input_tokens=?,output_tokens=?,error=?,details_json=? WHERE id=?`).run(
      changes.status ?? 'completed', finishedAt, changes.processed ?? 0, changes.succeeded ?? 0, changes.failed ?? 0,
      changes.inputTokens ?? 0, changes.outputTokens ?? 0, changes.error ?? null, JSON.stringify(changes.details ?? {}), id
    );
  }

  listJobs(limit = 20) {
    return this.db.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit) || 20, 100))).map((row) => ({
      id: row.id, kind: row.kind, reason: row.reason, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
      processed: row.processed, succeeded: row.succeeded, failed: row.failed, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      error: row.error, details: json(row.details_json, {})
    }));
  }

  usageTotals() {
    return this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COUNT(*) AS runs FROM job_runs WHERE kind='enrichment'`).get();
  }

  databaseInfo() {
    const integrity = this.db.prepare('PRAGMA quick_check').get();
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = this.db.prepare('PRAGMA page_count').get().page_count;
    return { ok: integrity.quick_check === 'ok', path: this.dbPath, bytes: pageSize * pageCount, items: this.items.length, briefs: this.db.prepare('SELECT COUNT(*) AS count FROM story_briefs WHERE active = 1').get().count, monitors: this.db.prepare('SELECT COUNT(*) AS count FROM monitors').get().count, issues: this.issues.length, migration: this.migration };
  }

  async pruneBackups({ retain = 3 } = {}) {
    const directory = path.join(this.dataDir, 'backups');
    await mkdir(directory, { recursive: true });
    const directoryEntries = await readdir(directory);
    const files = directoryEntries.filter((name) => /^ai-news-.*\.sqlite$/.test(name)).sort().reverse();
    const removed = [];
    for (const name of files.slice(boundedInteger(retain, 3, 1, 60))) {
      await unlink(path.join(directory, name));
      removed.push(name);
    }
    for (const name of directoryEntries.filter((entry) => /^ai-news-.*\.sqlite-(?:wal|shm)$/.test(entry))) {
      try {
        await unlink(path.join(directory, name));
        removed.push(name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { kept: Math.min(files.length, boundedInteger(retain, 3, 1, 60)), removed };
  }

  async listBackups() {
    const directory = path.join(this.dataDir, 'backups');
    await mkdir(directory, { recursive: true });
    const names = (await readdir(directory)).filter((name) => /^ai-news-.*\.sqlite$/.test(name)).sort().reverse();
    return Promise.all(names.map(async (name) => {
      const details = await stat(path.join(directory, name));
      return { name, bytes: details.size, modifiedAt: details.mtime.toISOString() };
    }));
  }

  async backup({ retain = 3, now = new Date() } = {}) {
    const directory = path.join(this.dataDir, 'backups');
    await mkdir(directory, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `ai-news-${stamp}.sqlite`);
    await sqliteBackup(this.db, file);
    const pruned = await this.pruneBackups({ retain });
    return { file, removed: pruned.removed };
  }

  async maintain({ itemRetentionDays = 90, issueRetentionDays = 90, jobRetentionDays = 30, backupRetention = 3, now = new Date(), compact = true } = {}) {
    const itemDays = boundedInteger(itemRetentionDays, 90, 7, 3_650);
    const issueDays = boundedInteger(issueRetentionDays, 90, 7, 3_650);
    const jobDays = boundedInteger(jobRetentionDays, 30, 1, 365);
    const beforeBytes = this.databaseInfo().bytes;
    const itemCutoff = new Date(now.valueOf() - itemDays * 24 * 3_600_000).toISOString();
    const issueCutoff = dateInShanghai(new Date(now.valueOf() - issueDays * 24 * 3_600_000));
    const jobCutoff = new Date(now.valueOf() - jobDays * 24 * 3_600_000).toISOString();
    let deletedItems = 0;
    let deletedIssues = 0;
    let deletedJobs = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      deletedItems = this.db.prepare('DELETE FROM items WHERE published_at < ?').run(itemCutoff).changes;
      deletedIssues = this.db.prepare('DELETE FROM issues WHERE date < ?').run(issueCutoff).changes;
      deletedJobs = this.db.prepare('DELETE FROM job_runs WHERE started_at < ?').run(jobCutoff).changes;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const backups = await this.pruneBackups({ retain: backupRetention });
    if (compact && (deletedItems || deletedIssues || deletedJobs)) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA optimize;');
    else this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;');
    this.items = this.db.prepare('SELECT * FROM items ORDER BY published_at DESC').all().map(rowToItem);
    this.issues = this.db.prepare('SELECT content_json FROM issues ORDER BY date DESC').all().map((row) => json(row.content_json, null)).filter(Boolean);
    return {
      retention: { itemDays, issueDays, jobDays, backupRetention: boundedInteger(backupRetention, 3, 1, 60) },
      cutoffs: { items: itemCutoff, issues: issueCutoff, jobs: jobCutoff },
      removed: { items: deletedItems, issues: deletedIssues, jobs: deletedJobs, backups: backups.removed },
      database: { beforeBytes, afterBytes: this.databaseInfo().bytes }
    };
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;');
    return this.databaseInfo();
  }

  close() { this.db?.close(); }
}

export async function createSqliteStore(options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = options.dataDir ?? path.join(root, 'data');
  const store = new SqliteStore({
    dbPath: options.dbPath ?? process.env.DATABASE_PATH ?? path.join(dataDir, 'ai-news.sqlite'),
    dataDir,
    sourcesPath: options.sourcesPath ?? path.join(dataDir, 'sources.json'),
    itemsJsonPath: options.itemsJsonPath ?? path.join(dataDir, 'items.runtime.json'),
    issuesJsonPath: options.issuesJsonPath ?? path.join(dataDir, 'daily-issues.runtime.json'),
    overridesPath: options.overridesPath ?? path.join(dataDir, 'editorial-overrides.json')
  });
  return store.initialize();
}
