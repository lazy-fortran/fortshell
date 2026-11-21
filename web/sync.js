// Server copy of the notebook. Every local write is also an entry in the
// outbox, in the same IndexedDB transaction, so nothing written locally can
// miss the server. Outbox batches go up in order and stay until the server
// has them on disk; a repeated batch is harmless.

const enc = new TextEncoder(), dec = new TextDecoder();
export const PART = 256 * 1024;

const kinds = [[Float32Array, 'f32'], [Uint8Array, 'u8']];
function payload(value) {
  for (const [type, t] of kinds) if (value instanceof type) return [t, new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  return ['json', enc.encode(JSON.stringify(value))];
}
function revive(t, bytes) {
  if (t === 'f32') return new Float32Array(bytes.slice().buffer);
  if (t === 'u8') return bytes.slice();
  return JSON.parse(dec.decode(bytes));
}

// Batches of at most about PART bytes; a larger value goes up in parts.
export function encodeWrites(writes, clear = false) {
  const records = [];
  if (clear) records.push([{ op: 'clear' }, new Uint8Array()]);
  for (const { store, key, value } of writes) {
    const [t, bytes] = payload(value), parts = Math.max(1, Math.ceil(bytes.length / PART));
    for (let i = 0; i < parts; i++) {
      const head = { s: store, k: key, t };
      if (parts > 1) Object.assign(head, { part: i, parts });
      records.push([head, bytes.subarray(i * PART, (i + 1) * PART)]);
    }
  }
  const batches = [];
  let current = [], size = 0;
  for (const [head, bytes] of records) {
    const line = enc.encode(JSON.stringify({ ...head, n: bytes.length }) + '\n');
    if (current.length && size + line.length + bytes.length > PART) { batches.push(join(current)); current = []; size = 0; }
    current.push(line, bytes); size += line.length + bytes.length;
  }
  if (current.length) batches.push(join(current));
  return batches;
}
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Server log records are "client seq length\n" + batch + "\n".
export function decodeLog(bytes) {
  const batches = [];
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) break;
    const [client, seq, length] = dec.decode(bytes.subarray(at, nl)).split(' ');
    const n = Number(length), end = nl + 1 + n;
    if (!Number.isInteger(n) || end + 1 > bytes.length) break;
    batches.push({ client, seq: Number(seq), batch: bytes.subarray(nl + 1, end) });
    at = end + 1;
  }
  return { batches, consumed: at };
}

// Replays batches into writes, joining parts per key. Returns the writes and
// whether a batch cleared the notebook first.
export function decodeBatches(batches, assembling = new Map()) {
  const writes = [];
  let clear = false;
  for (const { batch } of batches) {
    let at = 0;
    while (at < batch.length) {
      const nl = batch.indexOf(10, at), head = JSON.parse(dec.decode(batch.subarray(at, nl)));
      const bytes = batch.subarray(nl + 1, nl + 1 + head.n);
      at = nl + 1 + head.n;
      if (head.op === 'clear') { clear = true; writes.length = 0; continue; }
      if (head.parts) {
        const id = JSON.stringify([head.s, head.k]), parts = assembling.get(id) || [];
        parts[head.part] = bytes.slice(); assembling.set(id, parts);
        if (parts.filter(Boolean).length < head.parts) continue;
        assembling.delete(id);
        writes.push({ store: head.s, key: head.k, value: revive(head.t, join(parts)) });
      } else writes.push({ store: head.s, key: head.k, value: revive(head.t, bytes) });
    }
  }
  return { writes, clear };
}

export class ServerSync {
  constructor(db, state, { status, apply, idle, resend }) {
    Object.assign(this, { db, state, status, apply, idle, resend });
    this.assembling = new Map();
    this.delay = 1000; this.sending = null; this.signedOut = false; this.disabled = false; this.started = false;
  }
  static async open(db, callbacks) {
    let state = await db.call('get', { store: 'sync', key: 'state' });
    if (!state) {
      state = { doc: 'notebook', client: crypto.randomUUID(), next: 1, offset: 0 };
      await db.call('write', [{ store: 'sync', key: 'state', value: state }]);
    }
    return new ServerSync(db, state, callbacks);
  }
  // Outbox entries for these writes, to commit in their transaction. The
  // sequence advances only once that transaction has committed.
  entries(writes, clear = false) {
    if (this.disabled) return { entries: [], next: this.state.next };
    let next = this.state.next;
    const entries = encodeWrites(writes, clear).map(value => ({ store: 'outbox', key: next++, value }));
    entries.push({ store: 'sync', key: 'state', value: { ...this.state, next } });
    return { entries, next };
  }
  committed(next) { this.state.next = next; this.kick(); }
  async start() {
    const login = new URLSearchParams(location.hash.slice(1)).get('login');
    if (login) {
      history.replaceState(null, '', location.pathname + location.search);
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: login });
    }
    let session;
    try { session = await fetch('/api/session'); }
    catch { this.retry = setTimeout(() => void this.start().catch(() => {}), 5000); this.status(); return; }
    // Served without the FortShell server, as in local development.
    if (session.status === 404) { this.disabled = true; this.status(); return; }
    if (session.status === 401) { this.signedOut = true; this.status(); return; }
    this.started = true;
    await this.pull();
    this.follow();
    addEventListener('online', () => this.kick());
    this.kick();
  }
  kick() {
    if (!this.started || this.disabled || this.signedOut) return;
    clearTimeout(this.retry);
    if (!this.sending) this.sending = this.send().finally(() => { this.sending = null; });
  }
  async send() {
    for (;;) {
      const first = await this.db.call('first', 'outbox');
      if (!first) { this.delay = 1000; this.status(); return; }
      let response;
      try {
        response = await fetch(`/api/docs/${this.state.doc}?client=${this.state.client}&seq=${first.key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: first.value });
      } catch { response = null; }
      if (response?.status === 401) { this.signedOut = true; this.status(); return; }
      if (response?.status === 409) {
        // The server lacks batches it once acknowledged, for example after
        // a restore: send the whole notebook again under a new client id.
        await this.db.call('clear', 'outbox');
        this.state = { ...this.state, client: crypto.randomUUID(), next: 1 };
        await this.db.call('write', [{ store: 'sync', key: 'state', value: { ...this.state } }]);
        await this.resend();
        continue;
      }
      if (!response?.ok) {
        // Offline or server trouble: the batch stays and goes up later.
        this.status();
        this.retry = setTimeout(() => this.kick(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
        return;
      }
      this.delay = 1000;
      await this.db.call('delete', { store: 'outbox', key: first.key });
    }
  }
  async pending() { return this.db.call('count', 'outbox'); }
  follow() {
    const events = new EventSource('/api/events');
    events.addEventListener('doc', event => {
      const { id, size } = JSON.parse(event.data);
      if (id === this.state.doc && size > this.state.offset) void this.pull().catch(() => {});
    });
    events.onerror = () => this.kick();
  }
  // Applies batches of other devices; our own are already local.
  async pull() {
    if (this.pulling) return this.pulling;
    this.pulling = (async () => {
      const response = await fetch(`/api/docs/${this.state.doc}?from=${this.state.offset}`);
      if (!response.ok) return;
      const { batches, consumed } = decodeLog(new Uint8Array(await response.arrayBuffer()));
      const foreign = batches.filter(b => b.client !== this.state.client);
      this.state.offset += consumed;
      if (foreign.length) {
        await this.idle();
        const { writes, clear } = decodeBatches(foreign, this.assembling);
        await this.apply(writes, clear, { store: 'sync', key: 'state', value: { ...this.state } });
      } else await this.db.call('write', [{ store: 'sync', key: 'state', value: { ...this.state } }]);
    })();
    try { await this.pulling; } finally { this.pulling = null; }
  }
}
