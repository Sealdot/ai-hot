// Entirely invented Alpha acceptance content; no upstream article text.
export function feedXml(base) {
  const entries = [
    ['atlas', 'Atlas introduces open source reasoning model', 'Atlas fictional model release improves reasoning benchmark and agent tools.'],
    ['beacon', 'Beacon launches AI agent developer platform', 'Beacon fictional AI agent platform introduces developer tools and open source workflows.'],
    ['cedar', 'Cedar publishes AI safety benchmark research', 'Cedar fictional research paper introduces an AI safety benchmark for reasoning models.']
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Invented Alpha Feed</title>${entries.map(([id, title, description]) => `<item><guid>${base}/articles/${id}</guid><title>${title}</title><link>${base}/articles/${id}</link><description>${description}</description><pubDate>Wed, 07 Oct 2026 23:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
}
