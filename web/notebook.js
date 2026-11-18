import { GEOMETRY_REVISION, LEGACY_GEOMETRY, INK_COLOURS } from './geometry.js';

export function validateSnapshot(s) {
  if (s.meta?.version !== 1 || !Array.isArray(s.meta.pages) || !s.meta.pages.length
      || s.meta.pages.length > 100000 || !Array.isArray(s.strokes) || !Array.isArray(s.chunks)) throw new Error('Unsupported notebook');
  for (const size of s.meta.pages) if (size.length !== 2 || size.some(x => !Number.isFinite(x) || x <= 0 || x > 10000)) throw new Error('Invalid page dimensions');
  const ids = new Map();
  for (const stroke of s.strokes) {
    if (!Number.isInteger(stroke.id) || stroke.id < 1 || stroke.id > 1000000 || ids.has(stroke.id)
        || !Number.isInteger(stroke.page) || stroke.page < 1 || stroke.page > s.meta.pages.length
        || !Number.isFinite(stroke.width) || stroke.width <= 0 || stroke.width > 100
        || ![0, 1, 2, 3].includes(stroke.engine)
        || !(stroke.colour === undefined || (Number.isInteger(stroke.colour) && stroke.colour >= 0 && stroke.colour < INK_COLOURS.length))
        || ![undefined, LEGACY_GEOMETRY, GEOMETRY_REVISION].includes(stroke.geometry)) throw new Error('Invalid stroke');
    ids.set(stroke.id, []);
  }
  for (const chunk of s.chunks) {
    if (!Array.isArray(chunk.key) || !ids.has(chunk.key[0]) || !Number.isInteger(chunk.key[1]) || chunk.key[1] < 0
        || !(chunk.data instanceof Float32Array) || chunk.data.length % 4
        || chunk.data.some(x => !Number.isFinite(x))) throw new Error('Invalid stroke samples');
    ids.get(chunk.key[0]).push(chunk);
  }
  for (const chunks of ids.values()) {
    let offset = 0, lastTime = -Infinity;
    chunks.sort((a, b) => a.key[1] - b.key[1]);
    for (const chunk of chunks) {
      if (chunk.key[1] !== offset) throw new Error('Incomplete stroke journal');
      for (let i = 0; i < chunk.data.length; i += 4) {
        const t = chunk.data[i + 2], p = chunk.data[i + 3];
        if (t < lastTime || p < 0 || p > 1) throw new Error('Invalid pressure or sample order');
        lastTime = t;
      }
      offset += chunk.data.length / 4;
    }
  }
  return s;
}
