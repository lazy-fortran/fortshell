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
    const db = new StorageWorker();
    await db.call('open');
    return new NotebookStore(db, status);
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
        await this.db.call('write', [...batch.values()]);
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
    return this.db.call('read');
  }
  async replace(snapshot) {
    await this.flush();
    await this.db.call('replace', snapshot); this.status('Saved locally');
  }
}
