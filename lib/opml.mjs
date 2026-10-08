import { createHash } from 'node:crypto';

const decodeXml = (value = '') => value
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function parseOpmlSources(xml, { existingFeedUrls = [], maximum = 200 } = {}) {
  if (typeof xml !== 'string' || !/<opml[\s>]/i.test(xml)) throw new Error('invalid OPML document');
  const known = new Set(existingFeedUrls);
  const added = [];
  for (const match of xml.matchAll(/<outline\b([^>]*\bxmlUrl=["'][^"']+["'][^>]*)\/?\s*>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((entry) => [entry[1].toLowerCase(), decodeXml(entry[2])]));
    const feedUrl = attributes.xmlurl;
    try { if (!['http:', 'https:'].includes(new URL(feedUrl).protocol)) continue; } catch { continue; }
    if (known.has(feedUrl)) continue;
    known.add(feedUrl);
    const name = (attributes.text || attributes.title || new URL(feedUrl).hostname).trim().slice(0, 120);
    const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'feed';
    const fingerprint = createHash('sha256').update(feedUrl).digest('hex').slice(0, 8);
    added.push({ id: `opml-${slug}-${fingerprint}`, name, kind: 'news', feedUrl, homepage: attributes.htmlurl || '', enabled: true, pollMinutes: 90 });
    if (added.length >= Math.max(1, Math.min(1_000, Number(maximum) || 200))) break;
  }
  if (!added.length) throw new Error('OPML 中没有可导入的新 RSS 信源');
  return added;
}
