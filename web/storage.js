import { ServerSync } from './sync.js';

export function snapshotWrites(s) {
  const writes = [{ store: 'meta', key: 'notebook', value: s.meta }];
  for (const stroke of s.strokes) writes.push({ store: 'strokes', key: stroke.id, value: stroke });
  for (const chunk of s.chunks) writes.push({ store: 'chunks', key: chunk.key, value: chunk.data });
  if (s.pdf) writes.push({ store: 'assets', key: 'pdf', value: s.pdf });
  return writes;
}

class StorageWorker {
  constructor() {
    this.worker = new Worker(new URL('./storage-worker.js', import.meta.url), { type: 'module' });
    this.requests = new Map(); this.next = 0;
    this.worker.onmessage = ({ data }) => {
      const pending = this.requests.get(data.id);
      if (!pending) return;
      this.requests.delete(data.id);
      if (data.error) pending.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
      else pending.resolve(data.value);
    };
    this.worker.onerror = event => {
      this.failure = new Error(event.message || 'Local storage worker failed');
      for (const pending of this.requests.values()) pending.reject(this.failure);
      this.requests.clear();
    };
  }
  call(action, value) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.requests.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, action, value }); }
      catch (error) { this.requests.delete(id); reject(error); }
    });
  }
}

async function acquireWriter(name) {
  if (!navigator.locks) throw new Error('This browser lacks notebook locking. Use a current Safari or Chromium browser.');
  await new Promise((resolve, reject) => {
    navigator.locks.request(`${name}-writer`, { ifAvailable: true }, lock => {
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
  // `name` is the IndexedDB database of one document, `doc` its server id.
  static async open(status, server, name = 'fortshell-notebook', doc = 'notebook') {
    await acquireWriter(name);
    const db = new StorageWorker();
    await db.call('open', name);
    const store = new NotebookStore(db, status);
    if (server) {
      store.sync = await ServerSync.open(db, doc, { ...server, status: () => void store.report() });
    }
    return store;
  }
  // Local state first; the server state once local writes are done.
  async report() {
    if (this.pending.size || this.running) return;
    const sync = this.sync;
    if (!sync || sync.disabled) { this.status('Saved locally'); return; }
    if (sync.signedOut) { this.status('Saved locally. Sign in to save on the server.'); return; }
    const waiting = await sync.pending();
    this.status(waiting ? `Saved locally, ${waiting} waiting for the server` : 'Saved');
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
        const writes = [...batch.values()], outbox = this.sync?.entries(writes);
        await this.db.call('write', outbox ? [...writes, ...outbox.entries] : writes);
        if (outbox) this.sync.committed(outbox.next);
        this.writes += batch.size; this.transactions++;
        for (const x of batch.values()) this.bytes += x.value?.byteLength || 0;
        if (this.pending.size) this.status('Saving...');
      } catch (error) {
        for (const [key, value] of batch) if (!this.pending.has(key)) this.pending.set(key, value);
        this.status(`Save failed: ${error.message}. Keep this tab open and download Notebook.`);
        throw error;
      }
    })();
    try { await this.running; } finally { this.running = null; }
    if (!this.pending.size) void this.report();
  }
  async read() {
    return this.db.call('read');
  }
  // Small values kept with the notebook, such as the list of documents.
  async get(key) { return this.db.call('get', { store: 'sync', key }); }
  async set(key, value) { return this.db.call('write', [{ store: 'sync', key, value }]); }
  async replace(snapshot) {
    await this.flush();
    const outbox = this.sync?.entries(snapshotWrites(snapshot), true);
    await this.db.call('replace', { ...snapshot, extra: outbox?.entries || [] });
    if (outbox) this.sync.committed(outbox.next);
    void this.report();
  }
  // Writes from another device, with the sync state, in one transaction.
  async applyRemote(writes, clear, state) {
    await this.flush();
    await this.db.call('apply', { writes: [...writes, state], clear });
  }
}
