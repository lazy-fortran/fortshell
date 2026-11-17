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
    const req = indexedDB.open('fortshell-notebook', 1);
    req.onupgradeneeded = () => {
      for (const name of ['meta', 'strokes', 'chunks', 'assets']) req.result.createObjectStore(name);
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
    const tx = db.transaction(['meta', 'strokes', 'chunks', 'assets'], 'readwrite'), done = completion(tx);
    for (const name of ['meta', 'strokes', 'chunks', 'assets']) tx.objectStore(name).clear();
    tx.objectStore('meta').put(value.meta, 'notebook');
    for (const s of value.strokes) tx.objectStore('strokes').put(s, s.id);
    for (const c of value.chunks) tx.objectStore('chunks').put(c.data, c.key);
    if (value.pdf) tx.objectStore('assets').put(value.pdf, 'pdf');
    await done;
    return;
  }
  throw new Error(`Unknown storage operation: ${action}`);
}

self.onmessage = async ({ data: { id, action, value } }) => {
  try { self.postMessage({ id, value: await handle(action, value) }); }
  catch (error) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
};
