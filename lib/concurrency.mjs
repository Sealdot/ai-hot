export async function mapConcurrentByKey(values, concurrency, keyOf, worker, { minDelayMs = 0 } = {}) {
  let cursor = 0;
  const results = new Array(values.length);
  const tails = new Map();
  const lastStarted = new Map();
  const withKeyLock = async (value, index) => {
    const key = keyOf(value);
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
      const delay = typeof minDelayMs === 'function' ? Number(minDelayMs(key, value)) || 0 : Number(minDelayMs) || 0;
      const elapsed = Date.now() - (lastStarted.get(key) ?? 0);
      if (delay > elapsed) await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
      lastStarted.set(key, Date.now());
      return await worker(value, index);
    }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await withKeyLock(values[index], index);
    }
  }));
  return results;
}
