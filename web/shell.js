import { PointerSurface } from 'fortui/surface';
import { InkModel } from 'fortink/model';
import { createRenderer } from './renderers.js';
import { hitStroke, INK } from './geometry.js';
import { NotebookStore } from './storage.js';
import { openPDF, renderPDF, exportPDF } from './pdf.js';
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
let renderGeneration = 0, changing = Promise.resolve(), imports = Promise.resolve();
const saved = new Map();
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
    engine: M._fs_meta(id, 2), visible: !!M._fs_visible(id), complete, n: M._fs_size(id) };
}
function metadata() {
  return { version: 1, title: $('title').value, current: M._fs_current(), pdfPages,
    pages: Array.from({ length: M._fs_pages(0) }, (_, i) => pageSize(i + 1)) };
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

async function renderPage() {
  if (current) return;
  const generation = ++renderGeneration, page = M._fs_current(), [width, height] = pageSize();
  surface?.dispose(); surface = null;
  committed?.dispose(); activeRenderer?.dispose();
  const available = Math.max(120, $('workspace').clientWidth - 48);
  const availableHeight = Math.max(100, $('workspace').clientHeight - 48);
  const cssWidth = Math.min(1400, available, availableHeight * width / height) * zoom;
  const cssHeight = cssWidth * height / width;
  $('paper').style.width = `${cssWidth}px`; $('paper').style.height = `${cssHeight}px`;
  $('paper').setAttribute('aria-label', `Page ${page}`);
  // Bound backing-store area on high-DPI phones and very large zoom levels.
  const dpr = Math.min(devicePixelRatio || 1, 3, Math.sqrt(8e6 / (cssWidth * cssHeight)));
  for (const id of ['committed', 'active']) {
    const old = $(id), canvas = old.dataset.backend === renderer ? old : old.cloneNode(false);
    canvas.dataset.backend = renderer;
    canvas.width = Math.max(1, Math.ceil(cssWidth * dpr));
    canvas.height = Math.max(1, Math.ceil(cssHeight * dpr));
    if (old !== canvas) old.replaceWith(canvas);
  }
  $('background').width = $('active').width; $('background').height = $('active').height;
  const nextCommitted = await createRenderer($('committed'), renderer, width, height);
  const nextActive = await createRenderer($('active'), renderer, width, height);
  if (generation !== renderGeneration) { nextCommitted.dispose(); nextActive.dispose(); return; }
  committed = nextCommitted; activeRenderer = nextActive;
  for (let id = 1; id <= M._fs_count(); id++) {
    if (M._fs_visible(id) && M._fs_stroke_page(id) === page) drawStroke(committed, id);
  }
  if (pdf && page <= pdfPages) await renderPDF(pdf, page, $('background'), $('active').width);
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
  const rect = $('active').getBoundingClientRect(), [w, h] = pageSize();
  return [Math.max(0, Math.min(w, (s.x - rect.left) / rect.width * w)),
    Math.max(0, Math.min(h, (s.y - rect.top) / rect.height * h)), s.t,
    Math.max(0, Math.min(1, s.pressure ?? 0.5))];
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
  if (M._fs_tool(-1) === 1 || e.button === 5) { current = -1; return true; }
  current = M._fs_begin(M._fs_width(0), 0, engine === 'wasm' ? 0 : engine === 'js' ? 1 : engine === 'perfect' ? 3 : 2);
  if (!current) return false;
  model.reset(); drawn = 0; predictions = [];
  return true;
}
let checkpointTimer = null, predictionTimer = null;
function appendSamples(samples, predicted) {
  if (current === -1) {
    for (const sample of samples) {
      const [x, y] = coordinates(sample);
      for (let id = M._fs_count(); id >= 1; id--) {
        if (M._fs_visible(id) && M._fs_stroke_page(id) === M._fs_current()
            && hitStroke(points(id), x, y)) {
          M._fs_toggle(id); checkpoint(id, true);
        }
      }
    }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; redrawCommitted(); });
    return;
  }
  if (!current) return;
  const timing = profiler?.begin(samples.length, { engine, renderer, scheduling });
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
  if (!checkpointTimer) checkpointTimer = setTimeout(() => {
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
  c.setTransform(target.canvas.width / target.width, 0, 0, target.canvas.height / target.height, 0, 0);
  c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(...p) : c.moveTo(...p));
  c.closePath(); c.fillStyle = INK; c.fill();
}
function drawStroke(target, id, first = 0, live = false) {
  if (M._fs_meta(id, 2) === 3) drawPerfect(target, id);
  else target.draw(points(id), first, M._fs_meta(id, 0), live);
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
    preview.map(([x, y]) => [x, y, p.at(-1)]));
  drawn = M._fs_size(current);
  if (profiler) profiler.submitted(started);
}
function endStroke(cancelled) {
  if (!current) return;
  cancelAnimationFrame(frame); frame = 0;
  clearTimeout(checkpointTimer); checkpointTimer = null;
  clearTimeout(predictionTimer); predictionTimer = null; predictions = [];
  if (current === -1) { current = 0; redrawCommitted(); refreshControls(); return; }
  const started = profiler && performance.now();
  const id = M._fs_finish(cancelled ? 1 : 0); current = 0;
  if (M._fs_visible(id)) {
    if (activeRenderer.commit && M._fs_meta(id, 2) !== 3)
      activeRenderer.commit(committed, points(id), M._fs_meta(id, 0), drawn);
    else drawStroke(committed, id);
  }
  activeRenderer.clear();
  if (profiler) profiler.submitted(started);
  checkpoint(id, true); refreshControls();
}
function redrawCommitted() {
  committed.clear();
  for (let id = 1; id <= M._fs_count(); id++) if (M._fs_visible(id)
      && M._fs_stroke_page(id) === M._fs_current()) drawStroke(committed, id);
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
  M._fs_reset(); saved.clear();
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
  $('title').value = String(s.meta.title || 'Untitled notebook');
  if (pdf) await pdf.destroy();
  pdf = nextPDF; pdfBytes = s.pdf || null; pdfPages = nextPDF?.numPages || 0;
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

globalThis.fortshellHost = (action, id) => {
  if (!ready) return;
  if (action === 1) { metaChanged(); void requestPage(); }
  if (action === 2 && id) { checkpoint(id, true); void requestPage(); }
  if (action === 4) void exportDocument().catch(error);
  if (action === 5) void exportNotebook().catch(error);
};

async function boot() {
  while (!globalThis.Module?._fs_count || !$('controls').querySelector('[data-id="next"]')) await wait(10);
  M = globalThis.Module;
  store = await NotebookStore.open(message => {
    if ($('save-status').textContent !== message) $('save-status').textContent = message;
    $('save-status').title = message;
  });
  const s = await store.read();
  if (s.meta) await restore(s); else await requestPage();
  ready = true;
  $('save-status').textContent = 'Saved locally';
  if (!s.meta) metaChanged();
  for (const type of ['click', 'input', 'change']) {
    $('controls').addEventListener(type, () => { controlsDirty = true; }, true);
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup']) {
    $('workspace').addEventListener(type, event => {
      if (event.pointerType === 'touch') { event.preventDefault(); event.stopImmediatePropagation(); }
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
  $('clear-page').onclick = () => {
    if (!ready || operation) return;
    if (current) endStroke(false);
    const page = M._fs_current();
    for (let id = 1; id <= M._fs_count(); id++) {
      if (M._fs_visible(id) && M._fs_stroke_page(id) === page) {
        M._fs_toggle(id); checkpoint(id, true);
      }
    }
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
  new ResizeObserver(() => {
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!current) void requestPage(); }, 100);
  }).observe($('workspace'));
  $('workspace').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.005)); }
  }, { passive: false });
  document.addEventListener('renderer-lost', () => {
    if (current) endStroke(false);
    error(new Error('Graphics device lost. Ink is retained. Switching to Canvas 2D.'));
    renderer = 'canvas'; $('renderer').value = renderer; void requestPage();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (current) endStroke(false); void store.flush().catch(error); }
  });
  window.addEventListener('pagehide', () => { if (current > 0) checkpoint(current); void store.flush().catch(error); });
  window.addEventListener('beforeunload', e => {
    if (current || store.pending.size || store.running) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey
        || e.target.closest('input,textarea,select,button,[contenteditable]')) return;
    if (e.key.length === 1) {
      e.preventDefault(); $('prompt').hidden = false; $('prompt-text').focus(); $('prompt-text').value += e.key;
    }
    if (e.key === 'Escape') $('prompt').hidden = true;
  });
  $('prompt-close').onclick = () => { $('prompt').hidden = true; $('workspace').focus(); };
  $('prompt').onsubmit = e => {
    e.preventDefault();
    const value = $('prompt-text').value.trim().toLowerCase();
    if (value === 'next') M._fs_next();
    else if (value === 'previous') M._fs_previous();
    else if (value === 'undo') { const id = M._fs_undo(); if (id) checkpoint(id, true); }
    else if (value === 'redo') { const id = M._fs_redo(); if (id) checkpoint(id, true); }
    else if (value === 'pdf') void exportDocument().catch(error);
    else { error(new Error('Available commands: next, previous, undo, redo, pdf.')); return; }
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
    importFile, flush: () => store.flush(), get ready() { return ready; }, get pageRevision() { return pageRevision; },
    get busy() { return !!operation || !surface; },
    latencyReport: () => profiler?.report() || latencyResults,
    get engine() { return engine; }, get renderer() { return renderer; } };
  void installUpdates($('update-app'), async () => {
    if (operation) return false;
    operation = 'update';
    if (current) endStroke(false);
    try { await store.flush(); return true; }
    catch (e) { operation = null; throw e; }
  }, error).catch(error);
}
boot().catch(error);
