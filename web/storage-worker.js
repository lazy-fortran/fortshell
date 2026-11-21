let db;
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const completion = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('Local save aborted'));
});

async function handle(action, value) {
  if (action === 'open') {
    const req = indexedDB.open(value || 'fortshell-notebook', 2);
    req.onupgradeneeded = () => {
      for (const name of ['meta', 'strokes', 'chunks', 'assets', 'outbox', 'sync'])
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    db = await request(req);
    return;
  }
  if (action === 'write') {
    const names = [...new Set(value.map(x => x.store))], tx = db.transaction(names, 'readwrite');
    const done = completion(tx);
    for (const { store, key, value: data } of value) tx.objectStore(store).put(data, key);
    await done;
    return;
  }
  if (action === 'get') return request(db.transaction(value.store).objectStore(value.store).get(value.key));
  if (action === 'count') return request(db.transaction(value).objectStore(value).count());
  if (action === 'first') {
    const cursor = await request(db.transaction(value).objectStore(value).openCursor());
    return cursor ? { key: cursor.key, value: cursor.value } : null;
  }
  if (action === 'delete' || action === 'clear') {
    const store = action === 'clear' ? value : value.store, tx = db.transaction(store, 'readwrite'), done = completion(tx);
    if (action === 'clear') tx.objectStore(store).clear(); else tx.objectStore(store).delete(value.key);
    await done;
    return;
  }
  if (action === 'apply') {
    const notebook = ['meta', 'strokes', 'chunks', 'assets'];
    const names = [...new Set([...(value.clear ? notebook : []), ...value.writes.map(x => x.store)])];
    const tx = db.transaction(names, 'readwrite'), done = completion(tx);
    if (value.clear) for (const name of notebook) tx.objectStore(name).clear();
    for (const { store, key, value: data } of value.writes) tx.objectStore(store).put(data, key);
    await done;
    return;
  }
  if (action === 'read') {
    const tx = db.transaction(['meta', 'strokes', 'chunks', 'assets'], 'readonly');
    const [meta, strokes, keys, chunks, pdf] = await Promise.all([
      request(tx.objectStore('meta').get('notebook')), request(tx.objectStore('strokes').getAll()),
      request(tx.objectStore('chunks').getAllKeys()), request(tx.objectStore('chunks').getAll()),
      request(tx.objectStore('assets').get('pdf')),
    ]);
    return { meta, strokes, chunks: keys.map((key, i) => ({ key, data: chunks[i] })), pdf };
  }
  if (action === 'replace') {
    // `extra` entries (outbox, sync state) commit in the same transaction.
    const extra = value.extra || [], names = [...new Set(['meta', 'strokes', 'chunks', 'assets', ...extra.map(x => x.store)])];
    const tx = db.transaction(names, 'readwrite'), done = completion(tx);
    for (const name of ['meta', 'strokes', 'chunks', 'assets']) tx.objectStore(name).clear();
    tx.objectStore('meta').put(value.meta, 'notebook');
    for (const s of value.strokes) tx.objectStore('strokes').put(s, s.id);
    for (const c of value.chunks) tx.objectStore('chunks').put(c.data, c.key);
    if (value.pdf) tx.objectStore('assets').put(value.pdf, 'pdf');
    for (const { store, key, value: data } of extra) tx.objectStore(store).put(data, key);
    await done;
    return;
  }
  throw new Error(`Unknown storage operation: ${action}`);
}

self.onmessage = async ({ data: { id, action, value } }) => {
  try { self.postMessage({ id, value: await handle(action, value) }); }
  catch (error) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
};
