import { createStore } from '../lib/content.mjs';

const store = await createStore();
try {
  const result = await store.backup({ retain: 3 });
  console.log(`Backup created: ${result.file}`);
  if (result.removed.length) console.log(`Expired backups removed: ${result.removed.join(', ')}`);
} finally { store.close(); }
