import { PointerSurface } from 'fortui/surface';
import { InkModel } from 'fortink/model';
import { createRenderer, minimumDotRadius } from './renderers.js';
import { InkShape, inkColour, GEOMETRY_REVISION, LEGACY_GEOMETRY } from './geometry.js';
import { NotebookStore } from './storage.js';
import { ServerSync } from './sync.js';
import { openPDF, renderPDF, exportPDF, pdfLinks } from './pdf.js';
import { runBenchmark } from './benchmark.js';
import { perfectOutline } from './perfect.js';
import { validateSnapshot } from './notebook.js';
import { InkLatency } from './latency.js';
import { installUpdates } from './updates.js';

const $ = id => document.getElementById(id);
const error = e => { $('error').textContent = e.message || String(e); $('error').hidden = false; console.error(e); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let M, store, committed, activeRenderer, surface, current = 0, drawn = 0, frame = 0;
let engine = 'wasm', renderer = 'canvas', model = new InkModel(), predictions = [];
let pdf = null, pdfBytes = null, pdfPages = 0, pageRevision = 0, zoom = 1, ready = false;
// PDF page shown under each page, 0 for blank; null keeps the original order.
let sources = null;
const source = page => sources ? sources[page - 1] || 0 : (page <= pdfPages ? page : 0);
let renderGeneration = 0, changing = Promise.resolve(), imports = Promise.resolve();
let saved = new Map(), strokeGeometry = new Map();
let eraserTargets = [], eraserContext;
const geometry = id => strokeGeometry.get(id) ?? LEGACY_GEOMETRY;
let operation = null, results;
let scheduling = 'immediate', profiler = null, latencyEvents, latencyResults;
let controlsDirty = false;

function pageSize(page = M._fs_current()) {
  return [M._fs_dimensions(page, 1), M._fs_dimensions(page, 2)];
}
function raw(id) {
  return new Float32Array(M.HEAPU8.buffer, M._fs_data(id, 0), M._fs_size(id) * 4);
}
function points(id) {
  return new Float32Array(M.HEAPU8.buffer, M._fs_data(id, 1), M._fs_size(id) * 3);
}
function strokeMeta(id, complete = true) {
  return { id, page: M._fs_stroke_page(id), width: M._fs_meta(id, 0), colour: M._fs_meta(id, 1),
    engine: M._fs_meta(id, 2), geometry: geometry(id), visible: !!M._fs_visible(id), complete, n: M._fs_size(id) };
}
function metadata() {
  const pages = M._fs_pages(0);
  return { version: 1, title: $('title').value, current: M._fs_current(), pdfPages,
    pages: Array.from({ length: pages }, (_, i) => pageSize(i + 1)),
    sources: Array.from({ length: pages }, (_, i) => source(i + 1)),
    pen: { tool: M._fs_tool(-1), colour: M._fs_colour(-1), width: M._fs_width(0) } };
}
function checkpointPage(page) {
  // A grouped undo or redo can change every stroke of its page.
  for (let id = 1; id <= M._fs_count(); id++) if (M._fs_stroke_page(id) === page) checkpoint(id, true);
}
function metaChanged() { if (ready) store.put('meta', 'notebook', metadata()); }
function checkpoint(id, complete = false) {
  if (!ready || !id) return;
  const n = M._fs_size(id), first = saved.get(id) || 0;
  if (n > first) {
    // Each checkpoint writes only the new tail, including a long held stroke.
    store.put('chunks', [id, first], raw(id).slice(first * 4));
    saved.set(id, n);
  }
  store.put('strokes', id, strokeMeta(id, complete));
  metaChanged();
}
function refreshControls() { M._fortui_web_step(); controlsDirty = false; }
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function name(extension) { return ($('title').value.trim() || 'Notebook').replace(/[\\/:*?"<>|]/g, '_') + extension; }

function inkViewport(width, height) {
  const paper = $('paper').getBoundingClientRect(), workspace = $('workspace');
  const visible = workspace.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const tile = 128;
  const axis = (start, size, clipStart, clipSize) => {
    const origin = Math.round(start * dpr), full = Math.max(1, Math.round(size * dpr));
    // Expand to fixed pixel boundaries so small scrolls reuse the same raster.
    const first = Math.min(full - 1, Math.max(0, Math.floor((clipStart * dpr - origin) / tile) * tile));
    const last = Math.min(full, Math.ceil(((clipStart + clipSize) * dpr - origin) / tile) * tile);
    return { offset: first, size: Math.max(1, last - first), full, css: (origin + first) / dpr - start };
  };
  const x = axis(paper.left, paper.width, visible.left + workspace.clientLeft, workspace.clientWidth);
  const y = axis(paper.top, paper.height, visible.top + workspace.clientTop, workspace.clientHeight);
  return { x: x.offset, y: y.offset, width: x.size, height: y.size, left: x.css, top: y.css,
    sx: x.full / width, sy: y.full / height, dpr };
}

async function renderPage() {
  if (current) return;
  const generation = ++renderGeneration, page = M._fs_current(), [width, height] = pageSize();
  surface?.dispose(); surface = null;
  committed?.dispose(); activeRenderer?.dispose();
  // Presenting, the page fills the screen; otherwise it keeps a margin.
  const presenting = document.body.classList.contains('presenting'), margin = presenting ? 0 : 48;
  const available = Math.max(120, $('workspace').clientWidth - margin);
  const availableHeight = Math.max(100, $('workspace').clientHeight - margin);
  const cssWidth = Math.min(presenting ? Infinity : 1400, available, availableHeight * width / height) * zoom;
  const cssHeight = cssWidth * height / width;
  $('paper').style.width = `${cssWidth}px`; $('paper').style.height = `${cssHeight}px`;
  $('paper').setAttribute('aria-label', `Page ${page}`);
  // PDF backgrounds and the comparison backends still use page-sized surfaces.
  const dpr = Math.min(devicePixelRatio || 1, 3, Math.sqrt(8e6 / (cssWidth * cssHeight)));
  const view = renderer === 'canvas' ? inkViewport(width, height) : null;
  for (const id of ['committed', 'active']) {
    const old = $(id), canvas = old.dataset.backend === renderer ? old : old.cloneNode(false);
    canvas.dataset.backend = renderer;
    if (!view) {
      canvas.removeAttribute('style');
      canvas.width = Math.max(1, Math.ceil(cssWidth * dpr));
      canvas.height = Math.max(1, Math.ceil(cssHeight * dpr));
    }
    if (old !== canvas) old.replaceWith(canvas);
  }
  const nextCommitted = await createRenderer($('committed'), renderer, width, height, view);
  const nextActive = await createRenderer($('active'), renderer, width, height, view);
  if (generation !== renderGeneration) { nextCommitted.dispose(); nextActive.dispose(); return; }
  committed = nextCommitted; activeRenderer = nextActive;
  for (let id = 1; id <= M._fs_count(); id++) {
    if (M._fs_visible(id) && M._fs_stroke_page(id) === page) drawStroke(committed, id);
  }
  $('overlay').width = Math.max(1, Math.ceil(cssWidth * dpr)); $('overlay').height = Math.max(1, Math.ceil(cssHeight * dpr));
  drawOverlay();
  if (pdf && source(page)) await renderPDF(pdf, source(page), $('background'), Math.ceil(cssWidth * dpr));
  else $('background').width = $('background').height = 1;
  await showLinks(pdf && source(page) ? await pdfLinks(pdf, source(page)) : []);
  if (generation !== renderGeneration) return;
  surface = new PointerSurface($('active'), { start: startStroke, samples: appendSamples,
    end: endStroke });
  $('active').addEventListener('contextmenu', e => e.preventDefault());
  pageRevision++;
}
function requestPage() {
  changing = changing.then(renderPage).catch(error);
  return changing;
}
function requestPageStrict() {
  const next = changing.then(renderPage);
  changing = next.catch(() => {});
  return next;
}
function coordinates(s) {
  const rect = $('paper').getBoundingClientRect(), [w, h] = pageSize();
  // Ink beyond the page edge is clipped by the page, not pressed onto its border.
  return [(s.x - rect.left) / rect.width * w, (s.y - rect.top) / rect.height * h, s.t,
    Math.max(0, Math.min(1, s.pressure ?? 0.5))];
}
function polygonPath(outline) {
  const path = new Path2D();
  outline.forEach((p, i) => i ? path.lineTo(...p) : path.moveTo(...p));
  path.closePath();
  return path;
}
function eraserRegion(id) {
  if (M._fs_meta(id, 2) === 3) {
    const outline = perfectOutline(raw(id), M._fs_meta(id, 0));
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of outline) {
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    }
    return { id, path: polygonPath(outline), bounds };
  }
  const shape = new InkShape(undefined, geometry(id));
  shape.update(points(id), 0, M._fs_meta(id, 0));
  const outline = shape.outline(0, shape.points.length, minimumDotRadius(committed));
  const path = new Path2D(); shape.path(path, outline);
  return { id, path, bounds: shape.bounds(outline) };
}
function eraseAt(x, y) {
  const tolerance = 1.5;
  const c = eraserContext ||= document.createElement('canvas').getContext('2d');
  c.lineWidth = 2 * tolerance; c.lineJoin = 'round';
  for (const { id, path, bounds: [left, top, right, bottom] } of eraserTargets) {
    if (x < left - tolerance || x > right + tolerance || y < top - tolerance || y > bottom + tolerance) continue;
    if (M._fs_visible(id) && (c.isPointInPath(path, x, y) || c.isPointInStroke(path, x, y))) {
      M._fs_toggle(id); checkpoint(id, true);
    }
  }
}
function startStroke(e) {
  if (!ready || operation || current) return false;
  const page = M._fs_current();
  if (controlsDirty) refreshControls();
  if (operation || M._fs_current() !== page) return false;
  $('error').hidden = true;
  if (document.activeElement?.matches('input,textarea,[contenteditable]')) document.activeElement.blur();
  getSelection()?.removeAllRanges();
  $('prompt').hidden = true;
  // The pointer tool clicks links and widgets; it never writes.
  if (M._fs_tool(-1) === 3) return false;
  if (M._fs_tool(-1) === 2 && e.button !== 5) {
    const [x, y] = coordinates(e);
    if (selection && x >= selection.bounds[0] && x <= selection.bounds[2]
        && y >= selection.bounds[1] && y <= selection.bounds[3]) {
      moveFrom = [x, y]; moveBy = [0, 0]; current = -3;
      redrawCommitted(new Set(selection.ids)); drawOverlay();
    } else {
      selection = null; lasso = [[x, y]]; current = -2; drawOverlay();
    }
    return true;
  }
  clearSelection();
  if (M._fs_tool(-1) === 1 || e.button === 5) {
    for (let id = M._fs_count(); id >= 1; id--)
      if (M._fs_visible(id) && M._fs_stroke_page(id) === page && M._fs_size(id)) eraserTargets.push(eraserRegion(id));
    current = -1;
    return true;
  }
  current = M._fs_begin(M._fs_width(0), M._fs_colour(-1), engine === 'wasm' ? 0 : engine === 'js' ? 1 : engine === 'perfect' ? 3 : 2);
  if (!current) return false;
  strokeGeometry.set(current, GEOMETRY_REVISION);
  model.reset(); drawn = 0; predictions = [];
  return true;
}
let checkpointTimer = null, predictionTimer = null;
function appendSamples(samples, predicted) {
  if (current === -2 || current === -3) {
    if (!samples.length) return;
    for (const sample of samples) {
      const [x, y] = coordinates(sample);
      if (current === -2) lasso.push([x, y]); else moveBy = [x - moveFrom[0], y - moveFrom[1]];
    }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawOverlay(); });
    return;
  }
  if (current === -1) {
    if (!samples.length) return;
    for (const sample of samples) {
      const [x, y] = coordinates(sample);
      eraseAt(x, y);
    }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; redrawCommitted(); });
    return;
  }
  if (!current || !(samples.length || predicted.length || predictions.length)) return;
  const timing = samples.length && profiler?.begin(samples.length, { engine, renderer, scheduling });
  for (let start = 0; start < samples.length; start += 2048) {
    const before = timing && performance.now();
    const batch = samples.slice(start, start + 2048), input = new Float32Array(batch.length * 4);
    for (let i = 0; i < batch.length; i++) input.set(coordinates(batch[i]), i * 4);
    M.HEAPF32.set(input, M._fs_input() / 4);
    const prepared = timing && performance.now();
    if (engine !== 'wasm') {
      const output = new Float32Array(batch.length * 3);
      if (engine === 'js') model.batch(input, M._fs_width(0), output);
      else for (let i = 0; i < batch.length; i++) {
        output[i * 3] = input[i * 4]; output[i * 3 + 1] = input[i * 4 + 1];
        output[i * 3 + 2] = M._fs_width(0) * (0.18 + 0.82 * input[i * 4 + 3]) / 2;
      }
      M.HEAPF32.set(output, M._fs_output() / 4);
    }
    if (!M._fs_append(batch.length)) throw new Error('Invalid or out-of-order pen samples');
    if (timing) {
      timing.preparation_ms += prepared - before;
      timing.model_document_ms += performance.now() - prepared;
    }
  }
  predictions = predicted.map(coordinates);
  clearTimeout(predictionTimer);
  if (predictions.length) predictionTimer = setTimeout(() => {
    predictionTimer = null; predictions = [];
    if (current <= 0) return;
    if (scheduling === 'immediate') drawActive();
    else if (!frame) frame = requestAnimationFrame(drawActive);
  }, 16);
  if (samples.length && !checkpointTimer) checkpointTimer = setTimeout(() => {
    checkpointTimer = null; checkpoint(current);
  }, 750);
  if (timing) profiler.accept(timing);
  if (scheduling === 'immediate') drawActive();
  else if (!frame) frame = requestAnimationFrame(drawActive);
}
function drawPerfect(target, id, preview = []) {
  // Reference pipeline uses its own outline. It is not a language benchmark.
  let input = raw(id);
  if (preview.length) {
    const combined = new Float32Array(input.length + preview.length * 4); combined.set(input);
    preview.forEach((p, i) => combined.set(p, input.length + i * 4)); input = combined;
  }
  const outline = perfectOutline(input, M._fs_meta(id, 0));
  const c = target.ctx;
  if (!c) throw new Error('The reference outline requires Canvas 2D');
  const { x, y, sx, sy } = target.raster;
  c.setTransform(sx, 0, 0, sy, -x, -y);
  c.fillStyle = inkColour(M._fs_meta(id, 1)); c.fill(polygonPath(outline));
}
function drawStroke(target, id) {
  if (M._fs_meta(id, 2) === 3) drawPerfect(target, id);
  else target.draw(points(id), 0, M._fs_meta(id, 0), false, [], geometry(id), M._fs_meta(id, 1));
}
function drawActive() {
  frame = 0;
  if (current <= 0) return;
  const started = profiler && performance.now();
  const p = points(current), latestTime = raw(current).at(-2), preview = [];
  let lastTime = latestTime;
  for (const prediction of predictions) {
    const [x, y, t] = prediction;
    if (t > lastTime && t - latestTime <= 0.016) { preview.push(prediction); lastTime = t; }
  }
  if (engine === 'perfect') { activeRenderer.clear(); drawPerfect(activeRenderer, current, preview); }
  else activeRenderer.draw(p, drawn, M._fs_meta(current, 0), true,
    preview.map(([x, y]) => [x, y, p.at(-1)]), geometry(current), M._fs_meta(current, 1));
  drawn = M._fs_size(current);
  if (profiler) profiler.submitted(started);
}
function endStroke(cancelled) {
  if (!current) return;
  cancelAnimationFrame(frame); frame = 0;
  clearTimeout(checkpointTimer); checkpointTimer = null;
  clearTimeout(predictionTimer); predictionTimer = null; predictions = [];
  if (current === -1) { current = 0; eraserTargets = []; redrawCommitted(); refreshControls(); return; }
  if (current === -2) { current = 0; finishLasso(); return; }
  if (current === -3) { current = 0; finishMove(); return; }
  const started = profiler && performance.now();
  const id = M._fs_finish(cancelled ? 1 : 0); current = 0;
  if (M._fs_visible(id)) {
    if (activeRenderer.commit && M._fs_meta(id, 2) !== 3)
      activeRenderer.commit(committed, points(id), M._fs_meta(id, 0), drawn, geometry(id), M._fs_meta(id, 1));
    else drawStroke(committed, id);
  }
  activeRenderer.clear();
  if (profiler) profiler.submitted(started);
  checkpoint(id, true); refreshControls();
}
function redrawCommitted(hidden = null) {
  committed.clear();
  for (let id = 1; id <= M._fs_count(); id++) if (M._fs_visible(id) && !hidden?.has(id)
      && M._fs_stroke_page(id) === M._fs_current()) drawStroke(committed, id);
}

// Lasso: a closed path selects the strokes with most of their samples inside;
// dragging inside the selection moves it, Delete removes it. Each is one undo step.
let lasso = [], selection = null, moveFrom = null, moveBy = [0, 0];
function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function outlinePath(id, dx = 0, dy = 0) {
  const p = points(id).slice();
  for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
  const shape = new InkShape(undefined, geometry(id));
  shape.update(p, 0, M._fs_meta(id, 0));
  const outline = shape.outline(0, shape.points.length, 0.05), path = new Path2D();
  shape.path(path, outline);
  return path;
}
function selectionBounds(ids) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const r = raw(id), w = M._fs_meta(id, 0);
    for (let i = 0; i < r.length; i += 4) {
      b[0] = Math.min(b[0], r[i] - w); b[1] = Math.min(b[1], r[i + 1] - w);
      b[2] = Math.max(b[2], r[i] + w); b[3] = Math.max(b[3], r[i + 1] + w);
    }
  }
  return b;
}
function clearSelection() {
  if (!selection && !lasso.length) return;
  selection = null; lasso = []; moveFrom = null; drawOverlay();
}
function drawOverlay() {
  const canvas = $('overlay'), c = canvas.getContext('2d');
  if (!M || !c) return;
  const [w, h] = pageSize();
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height);
  c.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  const px = w / canvas.width;
  c.lineWidth = 1.5 * px * (devicePixelRatio || 1); c.setLineDash([4 * px * (devicePixelRatio || 1), 3 * px * (devicePixelRatio || 1)]);
  c.strokeStyle = '#1a56c4';
  if (lasso.length > 1) {
    c.beginPath(); lasso.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
  }
  if (!selection) return;
  const [dx, dy] = moveBy;
  if (moveFrom) for (const id of selection.ids) { c.fillStyle = inkColour(M._fs_meta(id, 1)); c.fill(outlinePath(id, dx, dy)); }
  const [x0, y0, x1, y1] = selection.bounds;
  c.fillStyle = '#1a56c40f'; c.fillRect(x0 + dx, y0 + dy, x1 - x0, y1 - y0);
  c.strokeRect(x0 + dx, y0 + dy, x1 - x0, y1 - y0);
}
function finishLasso() {
  const page = M._fs_current(), ids = [];
  if (lasso.length > 2) for (let id = 1; id <= M._fs_count(); id++) {
    if (!M._fs_visible(id) || M._fs_stroke_page(id) !== page || !M._fs_size(id)) continue;
    const r = raw(id); let hits = 0;
    for (let i = 0; i < r.length; i += 4) if (inside(lasso, r[i], r[i + 1])) hits++;
    if (hits * 4 >= r.length * 0.6) ids.push(id);
  }
  lasso = [];
  selection = ids.length ? { ids, bounds: selectionBounds(ids) } : null;
  drawOverlay();
}
function finishMove() {
  const [dx, dy] = moveBy, moved = [];
  moveFrom = null; moveBy = [0, 0];
  if (Math.hypot(dx, dy) > 0.05) {
    M._fs_group(1);
    for (const id of selection.ids) {
      const copy = M._fs_copy(id, dx, dy);
      if (!copy) continue;
      strokeGeometry.set(copy, geometry(id)); M._fs_toggle(id);
      checkpoint(id, true); checkpoint(copy, true); moved.push(copy);
    }
    M._fs_group(0);
    selection = { ids: moved, bounds: selectionBounds(moved) };
  }
  redrawCommitted(); drawOverlay(); refreshControls();
}
function deleteSelection() {
  if (!selection || current) return;
  M._fs_group(1);
  for (const id of selection.ids) if (M._fs_visible(id)) { M._fs_toggle(id); checkpoint(id, true); }
  M._fs_group(0);
  selection = null; redrawCommitted(); drawOverlay(); refreshControls();
}

function scrollInk() {
  if (renderer !== 'canvas' || !surface) return;
  const view = inkViewport(...pageSize()), changed = committed.setView(view);
  activeRenderer.setView(view);
  if (!changed) return;
  redrawCommitted();
  if (current > 0) {
    cancelAnimationFrame(frame);
    drawn = 0; drawActive();
  }
}

function snapshot() {
  const strokes = [], chunks = [];
  for (let id = 1; id <= M._fs_count(); id++) {
    strokes.push(strokeMeta(id));
    if (M._fs_size(id)) chunks.push({ key: [id, 0], data: raw(id).slice() });
  }
  return { meta: metadata(), strokes, chunks, pdf: pdfBytes };
}
async function restore(s) {
  validateSnapshot(s);
  const nextPDF = s.pdf ? await openPDF(s.pdf) : null;
  // Validation completes before replacing the current document.
  M._fs_reset(); saved.clear(); strokeGeometry.clear();
  M._fs_pages(s.meta.pages.length);
  s.meta.pages.forEach(([w, h], i) => M._fs_set_dimensions(i + 1, w, h));
  const sorted = [...s.strokes].sort((a, b) => a.id - b.id);
  let expected = 1;
  for (const stroke of sorted) {
    while (expected < stroke.id) {
      M._fs_begin(0.65, 0, 0); M._fs_finish(1); expected++;
    }
    M._fs_page(stroke.page);
    const id = M._fs_begin(stroke.width, stroke.colour || 0, stroke.engine);
    strokeGeometry.set(id, stroke.geometry ?? LEGACY_GEOMETRY);
    const restoredModel = new InkModel();
    const pieces = s.chunks.filter(c => c.key[0] === stroke.id).sort((a, b) => a.key[1] - b.key[1]);
    let offset = 0;
    for (const piece of pieces) {
      if (piece.key[1] !== offset) throw new Error('Incomplete stroke journal');
      for (let i = 0; i < piece.data.length; i += 8192) {
        const batch = piece.data.subarray(i, i + 8192);
        M.HEAPF32.set(batch, M._fs_input() / 4);
        if (stroke.engine !== 0) {
          const output = new Float32Array(batch.length / 4 * 3);
          if (stroke.engine === 1) restoredModel.batch(batch, stroke.width, output);
          else for (let j = 0; j < batch.length / 4; j++) {
            output[j * 3] = batch[j * 4]; output[j * 3 + 1] = batch[j * 4 + 1];
            output[j * 3 + 2] = stroke.width * (0.18 + 0.82 * batch[j * 4 + 3]) / 2;
          }
          M.HEAPF32.set(output, M._fs_output() / 4);
        }
        if (!M._fs_append(batch.length / 4)) throw new Error('Invalid notebook sample sequence');
      }
      offset += piece.data.length / 4;
    }
    M._fs_finish(stroke.visible && offset ? 0 : 1);
    saved.set(id, offset); expected++;
  }
  M._fs_page(s.meta.current || 1);
  if (s.meta.pen) {
    M._fs_tool(s.meta.pen.tool | 0); M._fs_colour(s.meta.pen.colour | 0);
    if (Number.isFinite(s.meta.pen.width)) M._fs_width(s.meta.pen.width);
  }
  $('title').value = String(s.meta.title || 'Untitled notebook');
  if (pdf) await pdf.destroy();
  pdf = nextPDF; pdfBytes = s.pdf || null; pdfPages = nextPDF?.numPages || 0;
  sources = s.meta.sources ? s.meta.sources.slice() : null;
  refreshControls(); await requestPage();
}
async function importFile(file) {
  if (!file || current) return;
  operation = 'import';
  try {
    await store.flush();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let s;
    if (file.name.toLowerCase().endsWith('.pdf')) {
      const document = await openPDF(bytes), pages = [];
      for (let i = 1; i <= document.numPages; i++) {
        const viewport = (await document.getPage(i)).getViewport({ scale: 1 });
        pages.push([viewport.width * 25.4 / 72, viewport.height * 25.4 / 72]);
      }
      await document.destroy();
      s = { meta: { version: 1, pages, current: 1, title: file.name.replace(/\.pdf$/i, '') },
        strokes: [], chunks: [], pdf: bytes };
    } else {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      s = { ...parsed, chunks: (parsed.chunks || []).map(c => ({ ...c, data: new Float32Array(c.data) })),
        pdf: parsed.pdf ? Uint8Array.from(atob(parsed.pdf), c => c.charCodeAt(0)) : null };
    }
    validateSnapshot(s);
    // Opened material gets its own document unless the shown one is empty.
    if (M._fs_count() || pdf || M._fs_pages(0) > 1) await newDocument(true);
    await restore(s); await store.replace(s);
  } finally { operation = null; }
}
async function exportNotebook() {
  if (current) endStroke(false);
  const s = snapshot();
  let encoded = null;
  if (s.pdf) {
    const pieces = [];
    for (let i = 0; i < s.pdf.length; i += 8192) pieces.push(String.fromCharCode(...s.pdf.subarray(i, i + 8192)));
    encoded = btoa(pieces.join(''));
  }
  download(JSON.stringify({ ...s, chunks: s.chunks.map(c => ({ ...c, data: Array.from(c.data) })), pdf: encoded }),
    name('.fortshell'), 'application/json');
}
async function exportDocument() {
  if (operation) return;
  if (current) endStroke(false);
  operation = 'export';
  try {
    const s = snapshot(), strokes = s.strokes.map(stroke => ({ ...stroke,
      points: points(stroke.id).slice(), raw: raw(stroke.id).slice() }));
    download(await exportPDF(s, strokes), name('.pdf'), 'application/pdf');
  } finally { operation = null; }
}

// Links of the shown PDF page. Course widgets open live over the page; other
// links open in a new tab, so the notebook stays where it is.
const WIDGET = /^https:\/\/krystophny\.github\.io\/[^/]+\/notebooks\/[^?#]+\.html/;
async function showLinks(links) {
  $('links').replaceChildren(...links.map(([x, y, w, h, url]) => {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = url;
    Object.assign(a.style, { left: `${100 * x}%`, top: `${100 * y}%`, width: `${100 * w}%`, height: `${100 * h}%` });
    a.addEventListener('click', e => { e.preventDefault(); openLink(url); });
    return a;
  }));
  closeWidget();
}
function openLink(url) {
  if (WIDGET.test(url)) { $('widget').querySelector('iframe').src = url; $('widget').hidden = false; }
  else window.open(url, '_blank', 'noopener,noreferrer');
}
// Links take clicks only while the pointer tool is selected.
function showTool() { document.body.classList.toggle('pointer', M._fs_tool(-1) === 3); }
function closeWidget() {
  if ($('widget').hidden) return;
  $('widget').hidden = true; $('widget').querySelector('iframe').src = 'about:blank';
}
// A finger tap on a link opens it with any tool.
function tapLink(x, y) {
  const a = document.elementsFromPoint(x, y).find(el => el.parentElement === $('links'));
  if (a) openLink(a.href);
  return !!a;
}

// Open documents stay resident: each keeps its Fortran slot, database,
// server sync, PDF and render state, so switching shows it without loading.
const documents = [];
let shown = null, listed = [];
function statusFor(ctx) {
  return message => {
    ctx.status = message;
    if (ctx !== shown) return;
    if ($('save-status').textContent !== message) $('save-status').textContent = message;
    $('save-status').title = message;
  };
}
async function openDocument(entry) {
  const ctx = { ...entry, slot: documents.length + 1, saved: new Map(), strokeGeometry: new Map(),
    pdf: null, pdfBytes: null, pdfPages: 0, sources: null, title: 'Untitled notebook', loaded: false };
  ctx.store = await NotebookStore.open(statusFor(ctx), {
    // Another device's writes apply once no stroke or file operation runs.
    idle: async () => { while (current || operation) await wait(50); },
    apply: async (writes, clear, state) => {
      await ctx.store.applyRemote(writes, clear, state);
      if (ctx !== shown) { ctx.stale = true; return; }
      const s = await store.read();
      if (s.meta) await restore(s);
    },
    resend: async () => { const s = await ctx.store.read(); if (s.meta) await ctx.store.replace(s); },
  }, entry.db, entry.id);
  documents.push(ctx);
  return ctx;
}
// Presenting hides every control; the page fills the screen and the pen
// still writes. Escape or a tap on the top edge ends it.
function present(on) {
  document.body.classList.toggle('presenting', on);
  zoom = 1;
  void requestPage();
}
const flushAll = () => Promise.all(documents.map(d => d.store.flush()));
// Swaps the shown document's state with `ctx` without touching storage.
function show(ctx) {
  if (shown) Object.assign(shown, { pdf, pdfBytes, pdfPages, sources, saved, strokeGeometry, title: $('title').value });
  M._fs_select(ctx.slot);
  ({ pdf, pdfBytes, pdfPages, sources, saved, strokeGeometry, store } = ctx);
  $('title').value = ctx.title;
  shown = ctx;
  if (ctx.status) statusFor(ctx)(ctx.status);
}
async function switchTo(ctx, within = false) {
  // `within` lets a file operation switch to the document it fills.
  if (!within) while (operation) await wait(20);
  if (ctx === shown) return;
  if (current) endStroke(false);
  clearSelection();
  void store.flush().catch(error);
  show(ctx);
  if (!ctx.loaded || ctx.stale) {
    let s = await store.read();
    ctx.loaded = true; ctx.stale = false;
    // A document known only to the server arrives before an empty one is written.
    if (!s.meta && !within && store.sync) { await store.sync.start().catch(error); s = await store.read(); }
    // A file operation fills a new document itself, without an empty page first.
    if (s.meta) await restore(s); else if (!within) { await requestPage(); metaChanged(); }
    void store.sync?.start().catch(error);
  } else await requestPage();
  refreshControls();
}
async function newDocument(within = false) {
  const id = crypto.randomUUID(), entry = { id, db: `fortshell-doc-${id}` };
  listed.push(entry);
  await documents[0].store.set('documents', listed);
  const ctx = await openDocument(entry);
  await switchTo(ctx, within);
  return ctx;
}
async function cycle(step) {
  const k = listed.findIndex(e => e.id === shown.id), entry = listed[(k + step + listed.length) % listed.length];
  const ctx = documents.find(d => d.id === entry.id) || await openDocument(entry);
  await switchTo(ctx);
}
// Documents another device created appear in the list and load when shown.
async function discover() {
  const response = await fetch('/api/docs').catch(() => null);
  if (!response?.ok) return;
  const { docs } = await response.json();
  let added = false;
  for (const id of Object.keys(docs)) {
    if (listed.some(e => e.id === id)) continue;
    listed.push({ id, db: `fortshell-doc-${id}` }); added = true;
  }
  if (added) await documents[0].store.set('documents', listed);
}

globalThis.fortshellHost = (action, id) => {
  if (!ready) return;
  if (action === 1) { metaChanged(); void requestPage(); }
  if (action === 7) void newDocument().catch(error);
  if (action === 9) present(true);
  if (action === 10) showTool();
  if (action === 8) void cycle(id).catch(error);
  if (action === 6 && id) {
    // A blank page before page `id`: later pages and their ink move back.
    sources = Array.from({ length: M._fs_pages(0) - 1 }, (_, i) => source(i + 1));
    sources.splice(id - 1, 0, 0);
    for (let k = 1; k <= M._fs_count(); k++) if (M._fs_stroke_page(k) > id) store.put('strokes', k, strokeMeta(k, true));
    clearSelection(); metaChanged(); void requestPage();
  }
  if (action === 2 && id) { clearSelection(); checkpointPage(M._fs_stroke_page(id)); void requestPage(); }
  if (action === 1) clearSelection();
  if (action === 4) void exportDocument().catch(error);
  if (action === 5) void exportNotebook().catch(error);
};

async function boot() {
  while (!globalThis.Module?._fs_count || !$('controls').querySelector('[data-id="next"]')) await wait(10);
  M = globalThis.Module;
  // The first document's database also lists the open documents.
  const first = { id: 'notebook', db: 'fortshell-notebook' };
  const home = await openDocument(first);
  show(home);
  const s = await store.read();
  if (s.meta) await restore(s); else await requestPage();
  home.loaded = true;
  // A new device takes the server's notebook before writing its own empty one.
  let fresh = !s.meta;
  if (fresh) { await store.sync?.start().catch(error); fresh = !(await store.read()).meta; }
  ready = true;
  $('save-status').textContent = 'Saved locally';
  if (fresh) metaChanged();
  if (s.meta) void store.sync?.start().catch(error);
  showTool();
  $('widget-close').onclick = closeWidget;
  listed = (await home.store.get('documents')) || [first];
  // The list is asked for once signed in, and a document another device
  // creates later arrives with its first change event.
  ServerSync.announced = id => { if (!listed.some(e => e.id === id)) void discover().catch(error); };
  void (store.sync?.start() || Promise.resolve()).then(discover).catch(error);
  for (const type of ['click', 'input', 'change']) {
    $('controls').addEventListener(type, () => { controlsDirty = true; }, true);
  }
  // Fingers never write: one finger scrolls, two pinch to zoom about their
  // midpoint. The page scales visually during the gesture and is rendered at
  // the new zoom when it ends.
  const touches = new Map();
  let pinch = null, swipe = null, tap = null;
  const presentingFit = () => document.body.classList.contains('presenting') && zoom === 1;
  const touchGesture = event => {
    const ws = $('workspace');
    if (event.type === 'pointerdown') touches.set(event.pointerId, [event.clientX, event.clientY]);
    else if (!touches.has(event.pointerId)) return;
    const before = touches.get(event.pointerId);
    if (event.type === 'pointermove') touches.set(event.pointerId, [event.clientX, event.clientY]);
    const list = [...touches.values()];
    if (list.length >= 2) {
      const [a, b] = list, distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!pinch) {
        const rect = $('paper').getBoundingClientRect();
        pinch = { distance, mid, scale: 1, origin: [mid[0] - rect.left, mid[1] - rect.top], start: mid };
        $('paper').style.transformOrigin = `${pinch.origin[0]}px ${pinch.origin[1]}px`;
      }
      pinch.scale = Math.max(0.5 / zoom, Math.min(4 / zoom, distance / pinch.distance));
      pinch.mid = mid;
      $('paper').style.transform = `translate(${mid[0] - pinch.start[0]}px, ${mid[1] - pinch.start[1]}px) scale(${pinch.scale})`;
    } else if (event.type === 'pointermove' && !pinch && before && !swipe) {
      ws.scrollLeft -= event.clientX - before[0]; ws.scrollTop -= event.clientY - before[1];
    }
    if (event.type === 'pointerdown' && touches.size === 1) tap = { x: event.clientX, y: event.clientY };
    if (event.type === 'pointerup' && tap && touches.size <= 1
        && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 10 && !pinch) tapLink(event.clientX, event.clientY);
    if (event.type === 'pointerup' || event.type === 'pointercancel' || touches.size > 1) tap = null;
    if (event.type === 'pointerdown' && touches.size === 1 && presentingFit())
      swipe = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    if (touches.size > 1) swipe = null;
    if ((event.type === 'pointerup' || event.type === 'pointercancel') && swipe) {
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y, held = event.timeStamp - swipe.t;
      const start = swipe; swipe = null;
      // A tap on the top edge brings the controls back.
      if (Math.hypot(dx, dy) < 10 && start.y < 32) present(false);
      // A short horizontal swipe turns the page; a held one changes the document.
      else if (event.type === 'pointerup' && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
        if (held > 600) void cycle(dx < 0 ? 1 : -1).catch(error);
        else { if (dx < 0) M._fs_next(); else M._fs_previous(); metaChanged(); void requestPage(); refreshControls(); }
      }
    }
    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      touches.delete(event.pointerId);
      if (pinch && touches.size < 2) {
        const done = pinch; pinch = null;
        const rect = $('paper').getBoundingClientRect();
        const fx = (done.mid[0] - rect.left) / rect.width, fy = (done.mid[1] - rect.top) / rect.height;
        $('paper').style.transform = ''; $('paper').style.transformOrigin = '';
        if (current) return;
        zoom = Math.max(0.5, Math.min(4, zoom * done.scale));
        void requestPage().then(() => {
          // Keep the page point under the fingers where it was.
          const r = $('paper').getBoundingClientRect();
          ws.scrollLeft += r.left + fx * r.width - done.mid[0];
          ws.scrollTop += r.top + fy * r.height - done.mid[1];
        });
      }
    }
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup', 'pointercancel']) {
    $('workspace').addEventListener(type, event => {
      if (event.pointerType === 'touch') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (type !== 'pointerrawupdate') touchGesture(event);
      }
    }, { capture: true, passive: false });
  }
  for (const type of ['touchstart', 'touchmove', 'selectstart', 'contextmenu', 'dragstart']) {
    $('workspace').addEventListener(type, event => event.preventDefault(), { passive: false });
  }
  $('controls').addEventListener('click', e => {
    if (e.target.closest('[data-id="import"]')) {
      // The file chooser starts inside the original trusted click.
      $('file').value = ''; $('file').click();
    }
  }, true);
  $('file').addEventListener('change', () => {
    imports = imports.then(() => importFile($('file').files[0])).catch(error);
  });
  $('title').addEventListener('input', metaChanged);
  // The overflow menu closes after a choice or a press elsewhere.
  $('more').addEventListener('click', e => { if (e.target.closest('.menu button')) $('more').open = false; });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#more')) $('more').open = false; }, true);
  $('clear-page').onclick = () => {
    if (!ready || operation) return;
    if (current) endStroke(false);
    const page = M._fs_current();
    clearSelection();
    M._fs_group(1);
    for (let id = 1; id <= M._fs_count(); id++) {
      if (M._fs_visible(id) && M._fs_stroke_page(id) === page) {
        M._fs_toggle(id); checkpoint(id, true);
      }
    }
    M._fs_group(0);
    redrawCommitted(); refreshControls();
  };
  $('compare-toggle').onclick = () => {
    $('compare').hidden = !$('compare').hidden;
    $('compare-toggle').setAttribute('aria-expanded', String(!$('compare').hidden));
  };
  $('engine').onchange = () => {
    if (current) endStroke(false);
    engine = $('engine').value;
    if (engine === 'perfect' && renderer !== 'canvas') {
      $('renderer').value = 'canvas'; renderer = 'canvas'; void requestPage();
    }
  };
  $('renderer').onchange = async () => {
    if (current) endStroke(false);
    const previous = renderer; renderer = $('renderer').value;
    try {
      if (renderer !== 'canvas' && (engine === 'perfect' || snapshot().strokes.some(s => s.visible && s.engine === 3)))
        throw new Error('The perfect-freehand reference uses Canvas 2D. Select a language comparison in a new notebook for GPU testing.');
      await requestPageStrict();
    }
    catch (e) { renderer = previous; $('renderer').value = previous; error(e); await requestPage(); }
  };
  $('scheduling').onchange = () => {
    scheduling = $('scheduling').value;
    if (current > 0) { cancelAnimationFrame(frame); frame = 0; drawActive(); }
  };
  $('latency-toggle').onclick = () => {
    if (profiler) {
      if (current > 0) { cancelAnimationFrame(frame); frame = 0; drawActive(); }
      latencyResults = profiler.report(); profiler = null; latencyEvents.abort();
      $('latency-toggle').textContent = 'Record drawing latency';
      $('latency-results').disabled = !latencyResults.retained_batches;
      $('latency-status').textContent = `${latencyResults.retained_batches} input batches recorded. Drawing submission only, excluding display.`;
    } else {
      profiler = new InkLatency(); latencyEvents = new AbortController();
      for (const type of ['pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup']) {
        document.addEventListener(type, event => {
          if (event.target === $('active') && event.pointerType !== 'touch') profiler.capture(event);
        }, { capture: true, signal: latencyEvents.signal });
      }
      $('latency-toggle').textContent = 'Stop recording';
      $('latency-status').textContent = 'Recording. Draw normally, then stop to download timings.';
    }
  };
  $('latency-results').onclick = () => download(JSON.stringify(latencyResults, null, 2),
    'fortshell-drawing-latency.json', 'application/json');
  const setZoom = value => {
    if (current) return;
    zoom = Math.max(0.5, Math.min(4, value)); void requestPage();
  };
  $('zoom-in').onclick = () => setZoom(zoom * 1.25);
  $('zoom-out').onclick = () => setZoom(zoom / 1.25);
  $('zoom-reset').onclick = () => setZoom(1);
  let resizeTimer;
  const workspace = $('workspace');
  let scrollFrame = 0;
  workspace.addEventListener('scroll', () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; scrollInk(); });
  }, { passive: true });
  let workspaceWidth = workspace.clientWidth, workspaceHeight = workspace.clientHeight;
  new ResizeObserver(() => {
    const width = workspace.clientWidth, height = workspace.clientHeight;
    if (width === workspaceWidth && height === workspaceHeight) return;
    workspaceWidth = width; workspaceHeight = height;
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!current) void requestPage(); }, 100);
  }).observe(workspace);
  $('workspace').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.005)); }
  }, { passive: false });
  document.addEventListener('renderer-lost', () => {
    if (current) endStroke(false);
    error(new Error('Graphics device lost. Ink is retained. Switching to Canvas 2D.'));
    renderer = 'canvas'; $('renderer').value = renderer; void requestPage();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (current) endStroke(false); void flushAll().catch(error); }
  });
  window.addEventListener('pagehide', () => { if (current > 0) checkpoint(current); void flushAll().catch(error); });
  window.addEventListener('beforeunload', e => {
    if (current || documents.some(d => d.store.pending.size || d.store.running)) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
        || e.target.closest('input,textarea,select,button,[contenteditable]')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    // The field receives the key itself, so dead keys and input methods compose there.
    if (e.key.length === 1 || e.key === 'Dead') { $('prompt').hidden = false; $('prompt-text').focus(); }
    if (e.key === 'Escape') {
      if (!$('widget').hidden) closeWidget();
      else if ($('prompt').hidden && document.body.classList.contains('presenting')) present(false);
      $('prompt').hidden = true;
    }
  });
  $('prompt-close').onclick = () => { $('prompt').hidden = true; $('workspace').focus(); };
  $('prompt').onsubmit = e => {
    e.preventDefault();
    const value = $('prompt-text').value.trim().toLowerCase();
    if (value === 'next') M._fs_next();
    else if (value === 'previous') M._fs_previous();
    else if (value === 'undo') { const id = M._fs_undo(); if (id) checkpointPage(M._fs_stroke_page(id)); }
    else if (value === 'redo') { const id = M._fs_redo(); if (id) checkpointPage(M._fs_stroke_page(id)); }
    else if (value === 'pdf') void exportDocument().catch(error);
    else if (value === 'present') present(true);
    else { error(new Error('Available commands: next, previous, undo, redo, pdf, present.')); return; }
    $('prompt-text').value = ''; $('prompt').hidden = true; $('workspace').focus();
    refreshControls(); metaChanged(); void requestPage();
  };
  $('benchmark').onclick = async () => {
    if (current || operation) return;
    operation = 'benchmark'; $('benchmark').disabled = true;
    try {
      results = await runBenchmark(M, message => { $('metrics').textContent = message; });
      $('results-download').disabled = false;
    } catch (e) { error(e); }
    finally { operation = null; $('benchmark').disabled = false; }
  };
  $('results-download').onclick = () => download(JSON.stringify(results, null, 2), 'fortshell-benchmark.json', 'application/json');
  globalThis.fortshell = { module: M, store, snapshot, restore, requestPage, exportDocument, exportNotebook,
    importFile, flush: () => flushAll(), present, get listed() { return listed.length; }, get ready() { return ready; }, get pageRevision() { return pageRevision; },
    get busy() { return !!operation || !surface; },
    latencyReport: () => profiler?.report() || latencyResults,
    get engine() { return engine; }, get renderer() { return renderer; } };
  void installUpdates($('update-app'), async () => {
    if (operation) return false;
    operation = 'update';
    if (current) endStroke(false);
    try { await flushAll(); return true; }
    catch (e) { operation = null; throw e; }
  }, error).catch(error);
}
boot().catch(error);
