import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWrites, decodeLog, decodeBatches, PART } from '../web/sync.js';

const enc = new TextEncoder();
// The server's log record around one batch.
function record(client, seq, batch) {
  const head = enc.encode(`${client} ${seq} ${batch.length}\n`), out = new Uint8Array(head.length + batch.length + 1);
  out.set(head); out.set(batch, head.length); out[out.length - 1] = 10;
  return out;
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

test('writes survive encoding, the server log and decoding unchanged', () => {
  const samples = new Float32Array([1.5, -2, 0.25, 1, 3, 4, 0.5, 0.75]);
  const pdf = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  const writes = [
    { store: 'meta', key: 'notebook', value: { version: 1, title: 'Plasma 05', pages: [[297, 210]] } },
    { store: 'strokes', key: 7, value: { id: 7, page: 1, width: 1.5 } },
    { store: 'chunks', key: [7, 0], value: samples },
    { store: 'assets', key: 'pdf', value: pdf },
  ];
  const log = concat(encodeWrites(writes).map((b, i) => record('dev-a', i + 1, b)));
  const { batches, consumed } = decodeLog(log);
  assert.equal(consumed, log.length);
  const { writes: back, clear } = decodeBatches(batches);
  assert.equal(clear, false);
  assert.deepEqual(back[0], writes[0]);
  assert.deepEqual(back[1], writes[1]);
  assert.deepEqual(back[2].key, [7, 0]);
  assert.ok(back[2].value instanceof Float32Array);
  assert.deepEqual([...back[2].value], [...samples]);
  assert.ok(back[3].value instanceof Uint8Array);
  assert.deepEqual([...back[3].value], [...pdf]);
});

test('a value larger than a batch goes up in parts and is joined again', () => {
  const big = Uint8Array.from({ length: 2 * PART + 123 }, (_, i) => (i * 7) % 256);
  const batches = encodeWrites([{ store: 'assets', key: 'pdf', value: big }]);
  assert.ok(batches.length >= 3);
  for (const b of batches) assert.ok(b.length <= PART + 200);
  const log = concat(batches.map((b, i) => record('dev-a', i + 1, b)));
  // Parts arriving over two pulls are still joined.
  const { batches: all } = decodeLog(log), assembling = new Map();
  const first = decodeBatches(all.slice(0, 1), assembling), rest = decodeBatches(all.slice(1), assembling);
  assert.equal(first.writes.length, 0);
  assert.equal(rest.writes.length, 1);
  assert.deepEqual([...rest.writes[0].value], [...big]);
});

test('a clear drops earlier writes of the same replay', () => {
  const before = encodeWrites([{ store: 'meta', key: 'notebook', value: { title: 'old' } }]);
  const after = encodeWrites([{ store: 'meta', key: 'notebook', value: { title: 'new' } }], true);
  const log = concat([...before, ...after].map((b, i) => record('dev-a', i + 1, b)));
  const { writes, clear } = decodeBatches(decodeLog(log).batches);
  assert.equal(clear, true);
  assert.deepEqual(writes, [{ store: 'meta', key: 'notebook', value: { title: 'new' } }]);
});

test('an incomplete record at the end waits for the next read', () => {
  const batch = encodeWrites([{ store: 'meta', key: 'notebook', value: { title: 'x' } }])[0];
  const whole = record('dev-a', 1, batch), log = concat([whole, whole.subarray(0, 10)]);
  const { batches, consumed } = decodeLog(log);
  assert.equal(batches.length, 1);
  assert.equal(consumed, whole.length);
});
