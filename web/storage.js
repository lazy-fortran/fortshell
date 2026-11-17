function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function completion(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Local save aborted'));
  });
}

async function acquireWriter() {
  if (!navigator.locks) throw new Error('This browser lacks notebook locking. Use a current Safari or Chromium browser.');
  await new Promise((resolve, reject) => {
    navigator.locks.request('fortshell-notebook-writer', { ifAvailable: true }, lock => {
      if (!lock) { reject(new Error('This notebook is open in another tab. Close that tab and reload.')); return; }
      resolve();
      // The document lifetime owns this lock, without heartbeat disk writes.
      return new Promise(() => {});
    }).catch(reject);
  });
}

export class NotebookStore {
  constructor(db, status = () => {}) {
    this.db = db; this.status = status; this.pending = new Map();
    this.writes = 0; this.bytes = 0; this.transactions = 0;
  }
  static async open(status) {
    await acquireWriter();
    const req = indexedDB.open('fortshell-notebook', 1);
    req.onupgradeneeded = () => {
      for (const name of ['meta', 'strokes', 'chunks', 'assets']) req.result.createObjectStore(name);
    };
    return new NotebookStore(await request(req), status);
  }
  put(store, key, value) {
    this.pending.set(`${store}:${JSON.stringify(key)}`, { store, key, value });
    this.status('Saving...');
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {}); }, 750);
  }
  async flush() {
    if (this.running) { await this.running; if (this.pending.size) return this.flush(); return; }
    clearTimeout(this.timer); this.timer = null;
    if (!this.pending.size) return;
    const batch = this.pending; this.pending = new Map();
    this.running = (async () => {
      try {
        const names = [...new Set([...batch.values()].map(x => x.store))];
        const tx = this.db.transaction(names, 'readwrite');
        const done = completion(tx);
        for (const { store, key, value } of batch.values()) tx.objectStore(store).put(value, key);
        await done;
        this.writes += batch.size; this.transactions++;
        for (const x of batch.values()) this.bytes += x.value?.byteLength || 0;
        this.status(this.pending.size ? 'Saving...' : 'Saved locally');
      } catch (error) {
        for (const [key, value] of batch) if (!this.pending.has(key)) this.pending.set(key, value);
        this.status(`Save failed: ${error.message}. Keep this tab open and download Notebook.`);
        throw error;
      }
    })();
    try { await this.running; } finally { this.running = null; }
  }
  async read() {
    const tx = this.db.transaction(['meta', 'strokes', 'chunks', 'assets'], 'readonly');
    const [meta, strokes, chunkKeys, chunks, pdf] = await Promise.all([
      request(tx.objectStore('meta').get('notebook')),
      request(tx.objectStore('strokes').getAll()),
      request(tx.objectStore('chunks').getAllKeys()),
      request(tx.objectStore('chunks').getAll()),
      request(tx.objectStore('assets').get('pdf')),
    ]);
    return { meta, strokes, chunks: chunkKeys.map((key, i) => ({ key, data: chunks[i] })), pdf };
  }
  async replace(snapshot) {
    await this.flush();
    const tx = this.db.transaction(['meta', 'strokes', 'chunks', 'assets'], 'readwrite');
    const done = completion(tx);
    for (const name of ['meta', 'strokes', 'chunks', 'assets']) tx.objectStore(name).clear();
    tx.objectStore('meta').put(snapshot.meta, 'notebook');
    for (const s of snapshot.strokes) tx.objectStore('strokes').put(s, s.id);
    for (const c of snapshot.chunks) tx.objectStore('chunks').put(c.data, c.key);
    if (snapshot.pdf) tx.objectStore('assets').put(snapshot.pdf, 'pdf');
    await done; this.status('Saved locally');
  }
}
