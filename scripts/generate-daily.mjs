import { createStore, dateInShanghai, generateDailyIssue } from '../lib/content.mjs';

const requestedDate = process.argv.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || dateInShanghai();
const force = process.argv.includes('--force');
const store = await createStore();
try {
  const states = store.listSourceStates();
  const failing = states.filter((state) => state.status === 'error').length;
  const result = await generateDailyIssue(store, requestedDate, { force, health: { sources: store.sources.length, healthy: states.filter((state) => state.status === 'ok').length, failing, degraded: failing > store.sources.length / 2, capturedAt: new Date().toISOString() } });
  console.log(`${result.created ? result.rebuilt ? 'Rebuilt' : 'Generated' : 'Already exists'}: ${result.issue.title}`);
} finally { store.close(); }
