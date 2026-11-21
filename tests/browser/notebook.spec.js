import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, rgb, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createNotebookServer } from '../../tools/serve.mjs';

async function open(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.fortshell?.ready);
  await expect(page.locator('#error')).toBeHidden();
}
async function draw(page) {
  await page.waitForFunction(() => window.fortshell?.ready && !window.fortshell.busy);
  await expect(page.locator('#active')).toBeVisible();
  const box = await page.locator('#active').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 40 });
  await page.mouse.up();
  await page.waitForFunction(() => window.fortshell.module._fs_count() >= 1);
}
async function darkPixels(page) {
  return page.evaluate(() => {
    const source = document.getElementById('committed'), canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    const c = canvas.getContext('2d'); c.drawImage(source, 0, 0);
    const data = c.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 127 && data[i] < 100) dark++;
    return dark;
  });
}

test('landscape notebook, ink, undo, redo, new page and recovery', async ({ page }) => {
  await open(page);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  expect(await page.evaluate(() => window.fortshell.snapshot().meta.pages)).toEqual([[297, 210]]);
  await draw(page);
  expect(await darkPixels(page)).toBeGreaterThan(100);
  await page.locator('[data-id=undo]').click();
  await expect.poll(() => darkPixels(page)).toBe(0);
  await page.locator('[data-id=redo]').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
  await page.locator('[data-id=next]').click();
  await expect(page.locator('[data-id=page-count]')).toHaveText('2 / 2');
  expect(await darkPixels(page)).toBe(0);
  await page.locator('[data-id=previous]').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
  await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(page)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.fortshell.snapshot().meta.pages.length)).toBe(2);
  expect(errors).toEqual([]);
});

test('bounded autosave writes, no writes at idle, and instant outer typing', async ({ page }) => {
  await open(page); await page.evaluate(() => window.fortshell.flush());
  const before = await page.evaluate(() => window.fortshell.store.transactions);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.fortshell.store.transactions)).toBe(before);
  await draw(page); await page.evaluate(() => window.fortshell.flush());
  const after = await page.evaluate(() => window.fortshell.store.transactions);
  expect(after - before).toBeLessThanOrEqual(3);
  await page.locator('#workspace').focus(); await page.keyboard.type('next');
  await expect(page.locator('#prompt-text')).toHaveValue('next');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-id=page-count]')).toHaveText('2 / 2');
  await page.locator('#title').fill('Teacher notes');
  await expect(page.locator('#prompt')).toBeHidden();
});

test('a dead key opens command entry and its composed character arrives once', async ({ page }) => {
  await open(page); await page.locator('#workspace').focus();
  await page.evaluate(() => document.getElementById('workspace').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote', bubbles: true, cancelable: true })));
  await expect(page.locator('#prompt-text')).toBeFocused();
  await page.keyboard.insertText('é');
  await page.keyboard.type('x');
  await expect(page.locator('#prompt-text')).toHaveValue('éx');
});

test('another tab cannot overwrite the working notebook', async ({ page, context }) => {
  await open(page); await draw(page); await page.evaluate(() => window.fortshell.flush());
  const other = await context.newPage(); await other.goto('/');
  await expect(other.locator('#error')).toContainText('open in another tab');
  await page.close(); await other.reload();
  await other.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(other)).toBeGreaterThan(100);
});

test('pointer-rate drawing does not recompose the toolbar for each sample', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const M = window.fortshell.module, original = M._fortui_web_step;
    window.toolbarSteps = 0;
    M._fortui_web_step = (...args) => { window.toolbarSteps++; return original(...args); };
  });
  await draw(page);
  expect(await page.evaluate(() => window.fortshell.module._fs_size(1))).toBeGreaterThan(30);
  expect(await page.evaluate(() => window.toolbarSteps)).toBeLessThanOrEqual(2);
});

test('a light first pen contact paints immediately without a control update', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.firstContactSteps = 0;
    const M = window.fortshell.module, step = M._fortui_web_step;
    M._fortui_web_step = (...args) => { window.firstContactSteps++; return step(...args); };
    document.getElementById('active').addEventListener('pointerdown', e => {
      Object.defineProperty(e, 'pointerType', { value: 'pen' });
      Object.defineProperty(e, 'pressure', { value: 0.01 });
    }, { capture: true, once: true });
  });
  const box = await page.locator('#active').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const first = await page.evaluate(() => {
    const M = window.fortshell.module, points = new Float32Array(M.HEAPU8.buffer, M._fs_data(1, 1), 3);
    const c = document.getElementById('active'), pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return { steps: window.firstContactSteps, size: M._fs_size(1), width: points[2] * 2,
      visible: pixels.some((value, i) => i % 4 === 3 && value > 127) };
  });
  expect(first.steps).toBe(0); expect(first.size).toBe(1);
  expect(first.width).toBeCloseTo(0.2823, 4); expect(first.visible).toBe(true);
  await page.mouse.up();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(0);
});

test('palm contacts before and after a pen stroke cannot move or select the page', async ({ page }) => {
  await open(page);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  const palm = () => page.evaluate(() => {
    const canvas = document.getElementById('active');
    canvas.setPointerCapture = () => {}; canvas.hasPointerCapture = () => false;
    for (const [type, x] of [['pointerdown', 200], ['pointermove', 20], ['pointerup', 20]]) {
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerType: 'touch', pointerId: 90, clientX: x, clientY: 300, button: 0 }));
    }
    return { page: window.fortshell.module._fs_current(), transform: document.getElementById('paper').style.transform,
      selection: getSelection().toString(),
      selectionPrevented: !canvas.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })) };
  });
  let state = await palm();
  expect(state.page).toBe(1); expect(state.transform).toBe(''); expect(state.selection).toBe('');
  expect(state.selectionPrevented).toBe(true);
  await draw(page); state = await palm();
  expect(state.page).toBe(1); expect(state.selection).toBe('');
  expect(await page.evaluate(() => window.fortshell.pageRevision)).toBe(revision);
});

test('database work stays off the input thread', async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => { throw new Error('Database access on the input thread'); };
  });
  await open(page); await draw(page); await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(page)).toBeGreaterThan(100);
});

test('unchanged workspace observation preserves the canvas and a real resize updates it', async ({ page }) => {
  await page.addInitScript(() => {
    const Observer = ResizeObserver;
    window.ResizeObserver = class extends Observer {
      constructor(callback) {
        super((entries, observer) => {
          callback(entries, observer);
          window.observeWorkspaceAgain = () => callback(entries, observer);
        });
      }
    };
  });
  await open(page);
  await page.waitForFunction(() => !!window.observeWorkspaceAgain);
  const revision = await page.evaluate(() => {
    window.observeWorkspaceAgain(); return window.fortshell.pageRevision;
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.fortshell.pageRevision)).toBe(revision);
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width + 100, height: size.height + 100 });
  await expect.poll(() => page.evaluate(() => window.fortshell.pageRevision)).toBeGreaterThan(revision);
});

test('Retina ink stays at display density after zooming and scrolling', async ({ browser, baseURL }) => {
  const page = await browser.newPage({ baseURL, serviceWorkers: 'block',
    viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2 });
  try {
    await open(page);
    // This mark starts outside the viewport at maximum zoom.
    await page.evaluate(async () => {
      const f = window.fortshell, M = f.module;
      M._fs_begin(1.5, 0, 2);
      M.HEAPF32.set([270, 187, 0, 0.5], M._fs_input() / 4);
      M.HEAPF32.set([270, 187, 0.75], M._fs_output() / 4);
      M._fs_append(1); M._fs_finish(0); await f.requestPage();
      document.getElementById('workspace').dispatchEvent(new WheelEvent('wheel', {
        deltaY: -280, ctrlKey: true, cancelable: true,
      }));
      await f.requestPage();
    });
    const initial = await page.evaluate(() => {
      const canvas = document.getElementById('committed'), rect = canvas.getBoundingClientRect();
      const workspace = document.getElementById('workspace');
      const size = [canvas.width / rect.width, canvas.height / rect.height];
      workspace.scrollTo(workspace.scrollWidth, workspace.scrollHeight);
      return { size, width: canvas.width, height: canvas.height, dpr: devicePixelRatio };
    });
    expect(initial.dpr).toBe(2);
    expect(initial.size[0]).toBeCloseTo(2, 2); expect(initial.size[1]).toBeCloseTo(2, 2);
    expect(initial.width).toBeLessThanOrEqual(1194 * 2 + 256);
    expect(initial.height).toBeLessThanOrEqual(834 * 2 + 256);
    const mark = () => page.evaluate(() => {
      const canvas = document.getElementById('committed'), rect = canvas.getBoundingClientRect();
      const paper = document.getElementById('paper').getBoundingClientRect();
      const x = Math.floor((paper.left + 270 / 297 * paper.width - rect.left) * devicePixelRatio);
      const y = Math.floor((paper.top + 187 / 210 * paper.height - rect.top) * devicePixelRatio);
      return canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
    });
    await expect.poll(mark).toBe(255);
    await page.mouse.click(760, 490);
    const error = await page.evaluate(() => {
      const f = window.fortshell, M = f.module;
      const paper = document.getElementById('paper').getBoundingClientRect();
      const raw = new Float32Array(M.HEAPU8.buffer, M._fs_data(2, 0), 4);
      return Math.hypot(raw[0] - (760 - paper.left) / paper.width * 297,
        raw[1] - (490 - paper.top) / paper.height * 210);
    });
    expect(error).toBeLessThan(0.001);
  } finally { await page.close(); }
});

test('a pending save does not delay the next pen contact or resize the page', async ({ page }) => {
  await open(page); await page.evaluate(() => window.fortshell.flush());
  await page.evaluate(() => {
    const db = window.fortshell.store.db, call = db.call.bind(db);
    window.originalStoreCall = call;
    db.call = (action, value) => action === 'write'
      ? new Promise((resolve, reject) => { window.releaseSave = () => call(action, value).then(resolve, reject); })
      : call(action, value);
  });
  await draw(page);
  await page.evaluate(() => { window.saveInFlight = window.fortshell.flush(); });
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  const box = await page.locator('#active').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down();
  expect(await page.evaluate(() => window.fortshell.module._fs_size(2))).toBe(1);
  expect(await page.evaluate(() => !!window.fortshell.store.running)).toBe(true);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.fortshell.pageRevision)).toBe(revision);
  await page.evaluate(() => window.releaseSave());
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 12 });
  expect(await page.evaluate(() => window.fortshell.module._fs_size(2))).toBeGreaterThan(10);
  await page.mouse.up();
  await page.evaluate(async () => {
    window.fortshell.store.db.call = window.originalStoreCall;
    await window.saveInFlight;
    await window.fortshell.flush();
  });
});

for (const scheduling of ['frame', 'immediate']) {
  test(`${scheduling} drawing submission and live latency recording`, async ({ page }) => {
    await open(page); await page.locator('#more summary').click(); await page.locator('#compare-toggle').click();
    await page.locator('#scheduling').selectOption(scheduling);
    await page.locator('#latency-toggle').click();
    await page.evaluate(() => {
      window.heldFrames = []; window.nativeRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { window.heldFrames.push(callback); return 1000000; };
    });
    const box = await page.locator('#active').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 12 });
    const activeInk = () => page.evaluate(() => {
      const canvas = document.getElementById('active'), ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 127) count++;
      return count;
    });
    if (scheduling === 'frame') {
      expect(await activeInk()).toBe(0);
      expect(await page.evaluate(() => window.fortshell.latencyReport().pending_batches)).toBeGreaterThan(1);
      await page.waitForTimeout(30);
      await page.evaluate(() => window.heldFrames.splice(0).forEach(callback => callback(performance.now())));
    } else expect(await page.evaluate(() => window.heldFrames.length)).toBe(0);
    expect(await activeInk()).toBeGreaterThan(100);
    await page.evaluate(() => { window.requestAnimationFrame = window.nativeRAF; });
    await page.mouse.up(); await page.locator('#latency-toggle').click();
    const report = await page.evaluate(() => window.fortshell.latencyReport());
    expect(report.physical_latency_measured).toBe(false);
    expect(report.policy.evaluated).toBe(false);
    expect(report.pending_batches).toBe(0);
    expect(report.pipelines[0].samples).toBeGreaterThan(10);
    expect(report.pipelines[0].callback_to_submit_ms.p95_ms).toBeGreaterThanOrEqual(0);
    if (scheduling === 'frame') expect(report.pipelines[0].wait_to_draw_ms.p95_ms).toBeGreaterThanOrEqual(30);
    await expect(page.locator('#latency-results')).toBeEnabled();
    await expect(page.locator('#error')).toBeHidden();
  });
}

test('installed notebook reloads offline with its saved ink', async ({ browser }) => {
  const pdf = await PDFDocument.create(), source = pdf.addPage([600, 400]);
  source.drawText('Offline teaching material', { x: 30, y: 340, size: 24 });
  const server = createNotebookServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ serviceWorkers: 'allow' }), page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fortshell?.ready);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await draw(page); await page.evaluate(() => window.fortshell.flush());
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    await page.reload();
    await page.waitForFunction(() => window.fortshell?.ready);
    expect(await darkPixels(page)).toBeGreaterThan(100);
    await page.locator('[data-id=next]').click();
    await expect(page.locator('[data-id=page-count]')).toHaveText('2 / 2');
    // Server saving fails offline by design and retries; the application must not.
    const failed = []; page.on('requestfailed', request => { if (!new URL(request.url()).pathname.startsWith('/api/')) failed.push(request.url()); });
    const revision = await page.evaluate(() => window.fortshell.pageRevision);
    await page.locator('#file').setInputFiles({ name: 'offline.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
    await page.waitForFunction(r => window.fortshell.pageRevision > r && !window.fortshell.busy, revision);
    await expect(page.locator('#error')).toBeHidden(); await draw(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
    expect((await PDFDocument.load(await readFile(await download.path()))).getPageCount()).toBe(1);
    expect(failed).toEqual([]);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('compact vector PDF and editable notebook round trip', async ({ page }) => {
  await open(page); await draw(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
  const bytes = await readFile(await download.path()), pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(297 * 72 / 25.4, 2);
  expect(pdf.getPage(0).getHeight()).toBeCloseTo(210 * 72 / 25.4, 2);
  expect(bytes.length).toBeLessThan(30000);
  const [backup] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=backup]').click()]);
  const path = await backup.path(), original = await page.evaluate(() => window.fortshell.snapshot().chunks[0].data.length);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'restored.fortshell', mimeType: 'application/json', buffer: await readFile(path) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision);
  await expect.poll(() => page.evaluate(() => window.fortshell.module._fs_count())).toBe(1);
  expect(await page.evaluate(() => window.fortshell.snapshot().chunks[0].data.length)).toBe(original);
  expect(await darkPixels(page)).toBeGreaterThan(100);
});

test('invalid import preserves ink and a failed save remains retryable', async ({ page }) => {
  await open(page); await draw(page); await page.evaluate(() => window.fortshell.flush());
  await page.locator('#file').setInputFiles({ name: 'bad.fortshell', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ meta: { version: 999 }, strokes: [], chunks: [] })) });
  await expect(page.locator('#error')).toBeVisible();
  expect(await darkPixels(page)).toBeGreaterThan(100);
  const state = await page.evaluate(async () => {
    const store = window.fortshell.store, db = store.db, call = db.call.bind(db);
    db.call = () => Promise.reject(new DOMException('Test disk quota', 'QuotaExceededError'));
    store.put('meta', 'notebook', window.fortshell.snapshot().meta);
    let rejected = false;
    try { await store.flush(); } catch { rejected = true; }
    const retained = store.pending.size;
    db.call = call; await store.flush();
    return { rejected, retained, remaining: store.pending.size };
  });
  expect(state).toEqual({ rejected: true, retained: 1, remaining: 0 });
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(page)).toBeGreaterThan(100);
});

test('legacy and new stroke geometry survive backup, import and reload', async ({ page }) => {
  await open(page);
  const old = { meta: { version: 1, pages: [[297, 210]], current: 1 },
    strokes: [{ id: 1, page: 1, width: 1.5, engine: 2, visible: true }],
    chunks: [{ key: [1, 0], data: [50, 70, 0, 1, 58, 74, 0.01, 1, 60, 74.4, 0.02, 1, 65, 74, 0.03, 1] }] };
  const importNotebook = async buffer => {
    const revision = await page.evaluate(() => window.fortshell.pageRevision);
    await page.locator('#file').setInputFiles({ name: 'strokes.fortshell', mimeType: 'application/json', buffer });
    await page.waitForFunction(r => window.fortshell.pageRevision > r && !window.fortshell.busy, revision);
    await expect(page.locator('#error')).toBeHidden();
  };
  await importNotebook(Buffer.from(JSON.stringify(old)));
  const livePage = await page.locator('#active').boundingBox();
  await page.mouse.move(livePage.x + livePage.width * 0.55, livePage.y + livePage.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(livePage.x + livePage.width * 0.72, livePage.y + livePage.height * 0.63, { steps: 12 });
  await page.mouse.up();
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=backup]').click()]);
  const buffer = await readFile(await file.path()), exported = JSON.parse(buffer);
  expect(exported.strokes.map(s => s.geometry)).toEqual([1, 2]);
  expect(exported.chunks[0].data).toEqual(old.chunks[0].data.map(Math.fround));
  await importNotebook(buffer);
  const raster = () => page.evaluate(() => document.querySelector('#committed').toDataURL());
  const before = await raster();
  await page.reload(); await open(page);
  expect(await page.evaluate(() => window.fortshell.snapshot().strokes.map(s => s.geometry))).toEqual([1, 2]);
  expect(await raster()).toBe(before);
});

test('a long stroke checkpoints its tail and recovers after interruption', async ({ page }) => {
  await open(page);
  const b = await page.locator('#active').boundingBox();
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.3); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.4, { steps: 30 });
  await page.waitForTimeout(850); await page.evaluate(() => window.fortshell.flush());
  const saved = await page.evaluate(async () => {
    const s = await window.fortshell.store.read();
    return { n: s.chunks.reduce((n, c) => n + c.data.length / 4, 0), complete: s.strokes[0].complete };
  });
  expect(saved.n).toBeGreaterThan(10); expect(saved.complete).toBe(false);
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(page)).toBeGreaterThan(100);
});

for (const angle of [0, 90, 180, 270]) test(`cropped PDF rotation ${angle} keeps ink aligned after export`, async ({ page }) => {
  const pdf = await PDFDocument.create(), original = pdf.addPage([700, 500]);
  original.setCropBox(50, 40, 600, 400); original.setRotation(degrees(angle));
  await open(page);
  let revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision); await draw(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
  revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'export.pdf', mimeType: 'application/pdf', buffer: await readFile(await download.path()) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision);
  const dark = await page.evaluate(() => {
    const c = document.getElementById('background'), ctx = c.getContext('2d');
    const x = Math.round(c.width * 0.45), y = Math.round(c.height * 0.35);
    const data = ctx.getImageData(x - 8, y - 8, 17, 17).data;
    let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 3] > 127) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(5);
});

test('PDF annotation preserves the original page and adds landscape teaching pages', async ({ page }) => {
  const pdf = await PDFDocument.create(), source = pdf.addPage([600, 400]);
  source.drawText('Original teaching material', { x: 30, y: 340, size: 24, color: rgb(0, 0, 0) });
  source.drawRectangle({ x: 40, y: 40, width: 100, height: 100, color: rgb(0, 0, 1) });
  const bytes = await pdf.save();
  await open(page);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'lesson.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision);
  await expect(page.locator('#error')).toBeHidden();
  expect(await page.evaluate(() => window.fortshell.snapshot().meta.pages[0][0])).toBeCloseTo(600 * 25.4 / 72, 3);
  await draw(page);
  await page.locator('[data-id=next]').click();
  await expect(page.locator('[data-id=page-count]')).toHaveText('2 / 2');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
  const out = await PDFDocument.load(await readFile(await download.path()));
  expect(out.getPageCount()).toBe(2);
  expect(out.getPage(0).getWidth()).toBe(600);
  expect(out.getPage(1).getWidth()).toBeCloseTo(297 * 72 / 25.4, 2);
  expect(out.getPage(0).node.Contents()).toBeTruthy();
});

test('a blank page inserted between deck pages moves later pages and their ink', async ({ page }) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]); pdf.addPage([500, 300]);
  await open(page);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision);
  const shown = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('[data-id=next]').click();
  await page.waitForFunction(r => window.fortshell.pageRevision > r, shown);
  await draw(page);
  await page.locator('[data-id=previous]').click();
  await expect(page.locator('[data-id=page-count]')).toHaveText('1 / 2');
  await page.locator('[data-id=insert]').click();
  await expect(page.locator('[data-id=page-count]')).toHaveText('2 / 3');
  await expect.poll(() => page.evaluate(() => document.getElementById('background').width)).toBe(1);
  const meta = await page.evaluate(() => window.fortshell.snapshot().meta);
  expect(meta.sources).toEqual([1, 0, 2]);
  expect(meta.pages[1][0]).toBeCloseTo(600 * 25.4 / 72, 3);
  expect(await page.evaluate(() => window.fortshell.module._fs_stroke_page(1))).toBe(3);
  await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect((await page.evaluate(() => window.fortshell.snapshot().meta)).sources).toEqual([1, 0, 2]);
  expect(await page.evaluate(() => window.fortshell.module._fs_stroke_page(1))).toBe(3);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
  const out = await PDFDocument.load(await readFile(await download.path()));
  expect(out.getPages().map(p => Math.round(p.getWidth()))).toEqual([600, 600, 500]);
});

test('documents stay open, switch without loading and survive a reload', async ({ page }) => {
  const revision = () => page.evaluate(() => window.fortshell.pageRevision);
  const after = async (act, ...args) => { const r = await revision(); await act(...args); await page.waitForFunction(r => window.fortshell.pageRevision > r, r); };
  const count = () => page.evaluate(() => window.fortshell.module._fs_count());
  await open(page); await draw(page);
  await after(() => page.locator('[data-id=document-new]').click());
  expect(await count()).toBe(0);
  await page.locator('#title').fill('Whiteboard');
  await draw(page); await draw(page);
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]); pdf.addPage([600, 400]);
  await page.locator('#file').setInputFiles({ name: 'deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => window.fortshell.snapshot().meta.sources?.[0] === 1);
  await expect(page.locator('#title')).toHaveValue('deck');
  expect(await count()).toBe(0);
  const started = Date.now();
  await after(() => page.keyboard.press('Shift+ArrowLeft'));
  const elapsed = Date.now() - started;
  await expect(page.locator('#title')).toHaveValue('Whiteboard');
  expect(await count()).toBe(2);
  await expect(page.locator('[data-id=page-count]')).toHaveText('1 / 1');
  console.log(`document switch ${elapsed} ms`);
  expect(elapsed).toBeLessThan(1000);
  await after(() => page.keyboard.press('Shift+ArrowLeft'));
  expect(await count()).toBe(1);
  await after(() => page.keyboard.press('Shift+ArrowLeft'));
  await expect(page.locator('#title')).toHaveValue('deck');
  await expect(page.locator('[data-id=page-count]')).toHaveText('1 / 2');
  await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await count()).toBe(1);
  await after(() => page.locator('[data-id=document-next]').click());
  await expect(page.locator('#title')).toHaveValue('Whiteboard');
  expect(await count()).toBe(2);
});

test('presenting hides the controls, fills the screen, writes and swipes', async ({ page }) => {
  const revision = () => page.evaluate(() => window.fortshell.pageRevision);
  const after = async act => { const r = await revision(); await act(); await page.waitForFunction(r => window.fortshell.pageRevision > r, r); };
  const swipe = (dx, held = 0, y = 0.5) => page.evaluate(async ({ dx, held, y }) => {
    const ws = document.getElementById('workspace'), x = innerWidth / 2, py = innerHeight * y;
    const send = (type, px) => ws.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch',
      clientX: px, clientY: py, bubbles: true, cancelable: true, isPrimary: true }));
    send('pointerdown', x);
    if (held) await new Promise(r => setTimeout(r, held));
    for (let i = 1; i <= 5; i++) send('pointermove', x + dx * i / 5);
    send('pointerup', x + dx);
  }, { dx, held, y });
  await open(page);
  await after(() => page.locator('[data-id=document-new]').click());
  await after(() => page.locator('[data-id=document-previous]').click());
  await after(() => page.locator('[data-id=next]').click());
  await after(() => page.locator('[data-id=previous]').click());
  await after(() => page.locator('[data-id=present]').click());
  await expect(page.locator('header')).toBeHidden();
  const box = await page.locator('#paper').boundingBox(), view = page.viewportSize();
  expect(Math.min(view.width - box.width, view.height - box.height)).toBeLessThan(2);
  await draw(page);
  expect(await page.evaluate(() => window.fortshell.module._fs_count())).toBe(1);
  await after(() => swipe(-200));
  expect(await page.evaluate(() => window.fortshell.module._fs_current())).toBe(2);
  await after(() => swipe(200));
  expect(await page.evaluate(() => window.fortshell.module._fs_current())).toBe(1);
  await after(() => swipe(-200, 700));
  expect(await page.evaluate(() => window.fortshell.module._fs_count())).toBe(0);
  await after(() => swipe(0, 0, 0.01));
  await expect(page.locator('header')).toBeVisible();
  await after(() => page.evaluate(() => window.fortshell.present(true)));
  await page.locator('#workspace').focus();
  await after(() => page.keyboard.press('Escape'));
  await expect(page.locator('header')).toBeVisible();
});

test('the pointer tool clicks PDF links: widgets open over the page, other links in a tab', async ({ page }) => {
  const widget = 'https://krystophny.github.io/fusion-skript/notebooks/slide-test.html';
  await page.route('https://krystophny.github.io/**', r => r.fulfill({ contentType: 'text/html', body: '<p id="w">live widget</p>' }));
  await page.route('https://example.org/**', r => r.fulfill({ contentType: 'text/html', body: 'paper' }));
  const pdf = await PDFDocument.create(), slide = pdf.addPage([600, 400]);
  const link = (rect, url) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect,
    Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } }));
  slide.node.set(PDFName.of('Annots'), pdf.context.obj([link([50, 250, 250, 350], widget), link([350, 50, 550, 150], 'https://example.org/paper')]));
  await open(page);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r, revision);
  await expect(page.locator('#links a')).toHaveCount(2);
  await expect(page.locator('[data-id=pen]')).toHaveAttribute('title', 'Pen');
  const box = await page.locator('#paper').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  // With the pen, a click on a link writes and opens nothing.
  await page.mouse.click(...at(0.25, 0.25));
  await page.waitForFunction(() => window.fortshell.module._fs_count() >= 1);
  await expect(page.locator('#widget')).toBeHidden();
  await page.locator('[data-id=pointer]').click();
  await expect(page.locator('body')).toHaveClass(/pointer/);
  await page.mouse.click(...at(0.25, 0.25));
  await expect(page.locator('#widget')).toBeVisible();
  await expect(page.frameLocator('#widget iframe').locator('#w')).toHaveText('live widget');
  expect(await page.evaluate(() => window.fortshell.module._fs_count())).toBe(1);
  await page.locator('#widget-close').click();
  await expect(page.locator('#widget')).toBeHidden();
  const [tab] = await Promise.all([page.waitForEvent('popup'), page.mouse.click(...at(0.75, 0.75))]);
  expect(tab.url()).toBe('https://example.org/paper');
  await expect(page.locator('#widget')).toBeHidden();
});

test('language parity and coalesced batch sizes', async ({ page }) => {
  await open(page);
  const report = await page.evaluate(() => {
    const M = window.fortshell.module, trace = new Float32Array(4 * 240);
    for (let i = 0; i < 240; i++) trace.set([i, 100 + 20 * Math.sin(i / 10), i / 240, 0.5], i * 4);
    const outputs = [];
    for (const batch of [1, 4, 16, 240]) {
      M._fi_reset(); const output = [];
      for (let i = 0; i < 240; i += batch) {
        const n = Math.min(batch, 240 - i);
        M.HEAPF32.set(trace.subarray(i * 4, (i + n) * 4), M._fi_input() / 4); M._fi_process(n, 0.65);
        output.push(...new Float32Array(M.HEAPU8.buffer, M._fi_output(), n * 3));
      }
      outputs.push(output);
    }
    return outputs;
  });
  for (const output of report) expect(output).toEqual(report[0]);
  await page.locator('#more summary').click(); await page.locator('#compare-toggle').click(); await page.locator('#engine').selectOption('js');
  await draw(page); expect(await darkPixels(page)).toBeGreaterThan(100);
});

test('WASM document growth preserves old strokes and long sample buffers', async ({ page }) => {
  await open(page);
  const valid = await page.evaluate(async () => {
    const f = window.fortshell, M = f.module;
    for (let id = 1; id <= 150; id++) {
      M._fs_begin(0.65, 0, 0);
      const trace = new Float32Array(500 * 4);
      for (let j = 0; j < 500; j++) trace.set([id, 20 + j * 0.1, j / 240, 0.5], j * 4);
      M.HEAPF32.set(trace, M._fs_input() / 4); M._fs_append(500); M._fs_finish(0);
    }
    M._fs_pages(100000); M._fs_page(100000); M._fs_next();
    if (M._fs_current() !== M._fs_pages(0)) return false;
    M._fs_page(1);
    await f.requestPage();
    return M._fs_count() === 150 && Array.from({ length: 150 }, (_, i) => i + 1).every(id => {
      const data = new Float32Array(M.HEAPU8.buffer, M._fs_data(id, 0), 500 * 4);
      return M._fs_size(id) === 500 && data[0] === id && data[499 * 4] === id;
    });
  });
  expect(valid).toBe(true); expect(await darkPixels(page)).toBeGreaterThan(1000);
});

test('reference ink survives reload, erasure and undo', async ({ page }) => {
  await open(page); await page.locator('#more summary').click(); await page.locator('#compare-toggle').click();
  await page.locator('#engine').selectOption('perfect'); await draw(page);
  expect(await darkPixels(page)).toBeGreaterThan(100);
  await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await page.evaluate(() => window.fortshell.snapshot().strokes[0].engine)).toBe(3);
  expect(await darkPixels(page)).toBeGreaterThan(100);
  await page.locator('[data-id=eraser]').click();
  const b = await page.locator('#active').boundingBox();
  await page.mouse.click(b.x + b.width * 0.45, b.y + b.height * 0.35);
  await expect.poll(() => darkPixels(page)).toBe(0);
  await page.locator('[data-id=undo]').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
});

test('eraser follows the visible arc between sparse pen samples', async ({ page }) => {
  await open(page);
  const probes = await page.evaluate(async () => {
    const center = 80, radius = 55, raw = Float32Array.from(Array.from({ length: 5 }, (_, i) =>
      [center + radius * Math.cos(i * Math.PI / 4), center + radius * Math.sin(i * Math.PI / 4), i / 16, 1]).flat());
    await window.fortshell.restore({ meta: { version: 1, pages: [[297, 210]], current: 1 },
      strokes: [{ id: 1, page: 1, width: 1.5, engine: 2, visible: true }], chunks: [{ key: [1, 0], data: raw }] });
    const c = document.querySelector('#committed'), box = c.getBoundingClientRect();
    const outer = [center + radius * Math.cos(Math.PI / 8), center + radius * Math.sin(Math.PI / 8)];
    const chord = outer.map(value => center + (value - center) * Math.cos(Math.PI / 8));
    const px = ([x, y]) => [box.left + x / 297 * box.width, box.top + y / 210 * box.height];
    const alpha = ([x, y]) => c.getContext('2d').getImageData(Math.floor(x / 297 * c.width),
      Math.floor(y / 210 * c.height), 1, 1).data[3];
    return { ink: px(outer), blank: px(chord), inkAlpha: alpha(outer), blankAlpha: alpha(chord) };
  });
  expect(probes.inkAlpha).toBeGreaterThan(0);
  expect(probes.blankAlpha).toBe(0);
  await page.locator('[data-id=eraser]').click();
  await page.mouse.click(...probes.blank);
  expect(await page.evaluate(() => window.fortshell.module._fs_visible(1))).toBe(1);
  await page.mouse.click(...probes.ink);
  expect(await page.evaluate(() => window.fortshell.module._fs_visible(1))).toBe(0);
});

for (const renderer of ['webgl', 'webgpu']) test(`${renderer} draws, resizes, and preserves ink`, async ({ page }, info) => {
  await open(page);
  if (renderer === 'webgpu') {
    const supported = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
    test.skip(!supported, 'No WebGPU adapter on this browser host');
  }
  await page.locator('#more summary').click(); await page.locator('#compare-toggle').click(); await page.locator('#renderer').selectOption(renderer);
  await expect.poll(() => page.evaluate(() => window.fortshell.renderer)).toBe(renderer);
  await page.waitForTimeout(300);
  await expect(page.locator('#error')).toBeHidden();
  await draw(page); expect(await darkPixels(page)).toBeGreaterThan(100);
  await page.locator('#zoom-in').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
});
test('stationary pen samples do not darken the antialiased edge', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const c = document.getElementById('active'), b = c.getBoundingClientRect();
    c.setPointerCapture = () => {}; c.hasPointerCapture = () => false;
    const send = (type, i, x = b.width * 0.4, y = b.height * 0.4) => {
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'pen',
        pointerId: 99, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: b.left + x, clientY: b.top + y, pressure: 0.5 });
      Object.defineProperty(e, 'timeStamp', { value: 1000 + i * 4 }); c.dispatchEvent(e);
    };
    send('pointerdown', 0);
    const ctx = c.getContext('2d'), before = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 1; i <= 200; i++) send('onpointerrawupdate' in c ? 'pointerrawupdate' : 'pointermove', i);
    const after = ctx.getImageData(0, 0, c.width, c.height).data;
    let changed = 0;
    for (let i = 3; i < after.length; i += 4) if (after[i] !== before[i]) changed++;
    send('pointerup', 201);
    return { changed, samples: window.fortshell.module._fs_size(1) };
  });
  expect(result.samples).toBeGreaterThan(100);
  expect(result.changed).toBe(0);
});

test('ink edges follow geometric pixel coverage', async ({ page }) => {
  await open(page);
  const rms = await page.evaluate(async () => {
    const f = window.fortshell, M = f.module, c = document.getElementById('committed');
    const sx = c.width / 297, sy = c.height / 210;
    const lines = [0.03, 0.08, 0.12, 0.21, 0.37, 0.58, 1, -1, 0.43, 0.64, 0.07, 0.12].map((slope, i) => {
      const centre = 22 + 14 * i + i / 21, first = Math.fround(centre - 13 * slope), last = Math.fround(centre + 13 * slope);
      M._fs_begin(0.74, 0, 2);
      M.HEAPF32.set([132, first, 0, 0.5, 158, last, 1, 0.5], M._fs_input() / 4);
      M.HEAPF32.set([132, first, 0.37, 158, last, 0.37], M._fs_output() / 4);
      M._fs_append(2); M._fs_finish(0);
      return [first, (last - first) / 26];
    });
    await f.requestPage();
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let error = 0, count = 0;
    for (const [first, slope] of lines) {
      const radius = 0.37 * sy * Math.hypot(1, slope);
      for (let x = Math.round(142 * sx); x < Math.round(148 * sx); x++) {
        const centre = sy * (first + slope * ((x + 0.5) / sx - 132));
        for (let y = Math.floor(centre - radius - 2); y < Math.ceil(centre + radius + 2); y++) {
          let coverage = 0;
          for (let i = 0; i < 128; i++) {
            const at = sy * (first + slope * ((x + (i + 0.5) / 128) / sx - 132));
            coverage += Math.max(0, Math.min(y + 1, at + radius) - Math.max(y, at - radius)) / 128;
          }
          if (coverage <= 0 || coverage >= 1) continue;
          error += (coverage - pixels[4 * (y * c.width + x) + 3] / 255) ** 2;
          count++;
        }
      }
    }
    return Math.sqrt(error / count);
  });
  expect(rms).toBeLessThan(0.04);
});

test('live curved ink keeps identical edge coverage at lift-off', async ({ page }) => {
  await open(page); await page.locator('#more summary').click(); await page.locator('#compare-toggle').click();
  await page.locator('#engine').selectOption('raw');
  const result = await page.evaluate(() => {
    const c = document.getElementById('active'), b = c.getBoundingClientRect();
    c.setPointerCapture = () => {}; c.hasPointerCapture = () => false;
    const send = (type, i) => {
      const t = i / 239, x = b.width * (0.5 + 0.3 * Math.sin(t * 4 * Math.PI)),
        y = b.height * (0.5 + 0.25 * Math.sin(t * 6 * Math.PI));
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'pen',
        pointerId: 99, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: b.left + x, clientY: b.top + y, pressure: 0.5 });
      Object.defineProperty(e, 'timeStamp', { value: 1000 + i * 4 }); c.dispatchEvent(e);
    };
    send('pointerdown', 0);
    for (let i = 1; i < 240; i++) send('onpointerrawupdate' in c ? 'pointerrawupdate' : 'pointermove', i);
    const before = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    send('pointerup', 239);
    const after = document.getElementById('committed').getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let differences = 0, fractional = 0;
    for (let i = 3; i < after.length; i += 4) {
      if (before[i] !== after[i]) differences++;
      if (after[i] > 0 && after[i] < 255) fractional++;
    }
    return { differences, fractional };
  });
  expect(result.fractional).toBeGreaterThan(100);
  expect(result.differences).toBe(0);
});

test('finishing a long predicted stroke repaints only its tip', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const canvas = document.getElementById('active'), box = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {}; canvas.hasPointerCapture = () => false;
    let curves = 0;
    const curve = Path2D.prototype.bezierCurveTo;
    Path2D.prototype.bezierCurveTo = function (...args) { curves++; return curve.apply(this, args); };
    const send = (type, i) => {
      const x = 20 + i * 0.18, y = 105 + 20 * Math.sin(i / 80);
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'pen',
        pointerId: 99, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: box.left + x / 297 * box.width, clientY: box.top + y / 210 * box.height, pressure: 0.5 });
      Object.defineProperty(e, 'timeStamp', { value: 1000 + i * 4 });
      if (type === 'pointermove') Object.defineProperty(e, 'getPredictedEvents', { value: () => [8, 16].map(dt => ({
        clientX: box.left + (x + dt) / 297 * box.width,
        clientY: box.top + y / 210 * box.height, timeStamp: 1000 + i * 4 + dt, pressure: 0.5 })) });
      canvas.dispatchEvent(e);
    };
    try {
      send('pointerdown', 0);
      const move = 'onpointerrawupdate' in canvas ? 'pointerrawupdate' : 'pointermove';
      for (let i = 1; i <= 1200; i++) send(move, i);
      if (move === 'pointerrawupdate') send('pointermove', 1200);
      curves = 0;
      // Clearing during input finishes the stroke while its forecast is still visible.
      document.getElementById('clear-page').click();
      return { curves, samples: window.fortshell.module._fs_size(1),
        visible: window.fortshell.snapshot().strokes.some(s => s.visible) };
    } finally { Path2D.prototype.bezierCurveTo = curve; }
  });
  expect(result.samples).toBe(1201); expect(result.visible).toBe(false);
  expect(result.curves).toBeLessThan(512);
});

test('ink fills a tight bend when the brush is wider than its radius', async ({ page }) => {
  await open(page);
  const covered = await page.evaluate(async () => {
    const f = window.fortshell, M = f.module, brush = 0.55, bend = 0.45;
    const points = [[102, 54], [103, 54], [104, 54]];
    for (let i = 1; i <= 70; i++) {
      const angle = 6 * i / 70;
      points.push([104 + bend * Math.sin(angle), 54 + bend * (1 - Math.cos(angle))]);
    }
    const [x, y] = points.at(-1);
    points.push([x + 0.4 * Math.cos(6), y + 0.4 * Math.sin(6)]);
    M._fs_begin(2 * brush, 0, points.length);
    M.HEAPF32.set(points.flatMap(([x, y], i) => [x, y, i / 240, 0.5]), M._fs_input() / 4);
    M.HEAPF32.set(points.flatMap(([x, y]) => [x, y, brush]), M._fs_output() / 4);
    M._fs_append(points.length); M._fs_finish(0);

    const probes = points.slice(2, 5).map(([x, y]) => [x, y + 0.8 * brush]);
    const ctx = document.createElement('canvas').getContext('2d'), hits = probes.map(() => false);
    const prototype = CanvasRenderingContext2D.prototype, fill = prototype.fill;
    prototype.fill = function (path, ...args) {
      if (path instanceof Path2D) {
        probes.forEach(([x, y], i) => { hits[i] ||= ctx.isPointInPath(path, x, y); });
      }
      return fill.call(this, path, ...args);
    };
    try { await f.requestPage(); }
    finally { prototype.fill = fill; }
    return hits;
  });
  expect(covered).toEqual([true, true, true]);
});

test('sparse vector PDF ink keeps its body width and tapered caps', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const f = window.fortshell, M = f.module;
    M._fs_begin(10, 0, 2);
    M.HEAPF32.set([50, 105, 0, 0.5, 247, 105, 1, 0.5], M._fs_input() / 4);
    M.HEAPF32.set([50, 105, 5, 247, 105, 5], M._fs_output() / 4);
    M._fs_append(2); M._fs_finish(0); await f.requestPage();
  });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id=export]').click()]);
  const revision = await page.evaluate(() => window.fortshell.pageRevision);
  await page.locator('#file').setInputFiles({ name: 'caps.pdf', mimeType: 'application/pdf', buffer: await readFile(await download.path()) });
  await page.waitForFunction(r => window.fortshell.pageRevision > r && !window.fortshell.busy, revision);
  const widths = await page.evaluate(() => {
    const c = document.getElementById('background'), ctx = c.getContext('2d');
    return [50, 55, 148, 242, 247].map(mm => {
      const column = ctx.getImageData(Math.round(mm / 297 * c.width), 0, 1, c.height).data;
      let ink = 0;
      for (let i = 0; i < column.length; i += 4) if (column[i] < 100) ink++;
      return ink * 210 / c.height;
    });
  });
  expect(widths[2]).toBeGreaterThan(9.4); expect(widths[2]).toBeLessThan(10.6);
  for (const shoulder of [widths[1], widths[3]]) {
    expect(shoulder).toBeGreaterThan(9); expect(shoulder).toBeLessThan(10);
  }
  for (const cap of [widths[0], widths[4]]) {
    expect(cap).toBeGreaterThan(7.5); expect(cap).toBeLessThan(8.5);
  }
});

test('clear page removes saved ink on this page and preserves other pages', async ({ page }) => {
  await open(page); await draw(page);
  await page.locator('[data-id=next]').click(); await draw(page);
  await page.locator('#more summary').click(); await page.locator('#clear-page').click();
  expect(await darkPixels(page)).toBe(0);
  await page.evaluate(() => window.fortshell.flush());
  await page.reload(); await page.waitForFunction(() => window.fortshell?.ready);
  expect(await darkPixels(page)).toBe(0);
  await page.locator('[data-id=previous]').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
});

test('predicted ink shares the pen taper and disappears when measurements replace it', async ({ page }) => {
  await open(page); await page.locator('#more summary').click(); await page.locator('#compare-toggle').click(); await page.locator('#engine').selectOption('raw');
  const result = await page.evaluate(async () => {
    const c = document.getElementById('active'), b = document.getElementById('paper').getBoundingClientRect();
    c.setPointerCapture = () => {}; c.hasPointerCapture = () => false;
    window.fortshell.module._fs_width(10);
    const x = 140, y = 105, scale = b.width / 297;
    const send = (type, i, mm, predicted = false) => {
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'pen',
        pointerId: 99, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: b.left + mm * scale, clientY: b.top + y / 210 * b.height, pressure: 0.5 });
      Object.defineProperty(e, 'timeStamp', { value: 1000 + i * 4 });
      if (predicted) Object.defineProperty(e, 'getPredictedEvents', { value: () => [8, 16].map((dt, j) => ({
        clientX: b.left + (x + 3 * (j + 1)) * scale, clientY: b.top + y / 210 * b.height,
        timeStamp: 1000 + i * 4 + dt, pressure: 0.5 })) });
      c.dispatchEvent(e);
    };
    const pixels = () => {
      const image = document.createElement('canvas'); image.width = c.width; image.height = c.height;
      const ctx = image.getContext('2d'); ctx.drawImage(c, 0, 0);
      const preview = document.getElementById('prediction'); if (preview) ctx.drawImage(preview, 0, 0);
      return { ctx, image };
    };
    send('pointerdown', 0, 100);
    const move = 'onpointerrawupdate' in c ? 'pointerrawupdate' : 'pointermove';
    for (let i = 1; i <= 100; i++) send(move, i, 100 + i * 0.4, move === 'pointermove' && i === 100);
    if (move === 'pointerrawupdate') send('pointermove', 100, x, true);
    const {ctx, image} = pixels(), widths = [135, 146].map(mm => {
      const data = ctx.getImageData(Math.round(mm / 297 * image.width), 0, 1, image.height).data;
      let coverage = 0; for (let i = 3; i < data.length; i += 4) coverage += data[i] / 255;
      return coverage;
    });
    send(move, 101, x);
    const replaced = pixels(), tail = replaced.ctx.getImageData(Math.ceil(144 / 297 * c.width), 0,
      Math.floor(c.width * 0.1), c.height).data;
    const remainingPrediction = tail.some((v, i) => i % 4 === 3 && v > 0);
    if (move === 'pointerrawupdate') send(move, 102, x);
    send('pointermove', 102, x, true);
    await new Promise(resolve => setTimeout(resolve, 40));
    const expired = pixels(), beyond = expired.ctx.getImageData(Math.ceil(144 / 297 * c.width), 0,
      Math.floor(c.width * 0.1), c.height).data;
    send('pointerup', 103, x);
    return { widths, remainingPrediction, expiredPrediction: beyond.some((v, i) => i % 4 === 3 && v > 0),
      maxSavedX: Math.max(...window.fortshell.snapshot().chunks[0].data.filter((_, i) => i % 4 === 0)) };
  });
  expect(result.widths[1]).toBeGreaterThan(0);
  expect(result.widths[1]).toBeLessThan(result.widths[0] * 0.85);
  expect(result.remainingPrediction).toBe(false); expect(result.expiredPrediction).toBe(false); expect(result.maxSavedX).toBeCloseTo(140, 4);
});

test('app update activates without closing the notebook and preserves unsaved ink', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' }), page = await context.newPage();
  const server = createNotebookServer(), handler = server.listeners('request')[0];
  let revision = 0;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url.split('?')[0] === '/sw.js') {
      void readFile(new URL('../../build/web/sw.js', import.meta.url), 'utf8').then(source => {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(source + `\n// update fixture ${revision}\n`);
      });
    } else handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fortshell?.ready && !!navigator.serviceWorker.controller);
    await expect(page.locator('#update-app')).toBeVisible();
    await draw(page);
    const samples = await page.evaluate(() => window.fortshell.module._fs_size(1));
    revision++;
    await Promise.all([page.waitForEvent('load'), page.locator('#update-app').click()]);
    await page.waitForFunction(() => window.fortshell?.ready);
    expect(await page.evaluate(() => window.fortshell.module._fs_size(1))).toBe(samples);
    expect(await darkPixels(page)).toBeGreaterThan(100);
    await expect(page.locator('#error')).toBeHidden();
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('pen colours, toggle state and ink past the page edge', async ({ page }) => {
  await open(page);
  await expect(page.locator('[data-id=pen]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-id=colour-0]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-id=colour-2]').click();
  await expect(page.locator('[data-id=colour-2]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-id=colour-0]')).toHaveAttribute('aria-pressed', 'false');
  await draw(page);
  const pixels = await page.evaluate(() => {
    const source = document.getElementById('committed'), canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    const c = canvas.getContext('2d'); c.drawImage(source, 0, 0);
    const data = c.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, black = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) {
      if (data[i] > 150 && data[i + 1] < 90) red++; else if (data[i] < 60) black++;
    }
    return { red, black };
  });
  expect(pixels.red).toBeGreaterThan(50);
  expect(pixels.black).toBe(0);
  expect(await page.evaluate(() => window.fortshell.module._fs_meta(1, 1))).toBe(2);
  await page.locator('[data-id=eraser]').click();
  await expect(page.locator('[data-id=eraser]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-id=colour-2]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-id=colour-1]').click();
  await expect(page.locator('[data-id=pen]')).toHaveAttribute('aria-pressed', 'true');
  const box = await page.locator('#active').boundingBox();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, box.y + box.height * 0.5, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => window.fortshell.module._fs_count() >= 2);
  const lastX = await page.evaluate(() => { const M = window.fortshell.module, id = M._fs_count();
    return new Float32Array(M.HEAPU8.buffer, M._fs_data(id, 0), M._fs_size(id) * 4).at(-4); });
  expect(lastX).toBeGreaterThan(297);
});

test('lasso moves strokes as one undo step and clear page undoes at once', async ({ page }) => {
  await open(page);
  await draw(page);
  const box = await page.locator('#active').boundingBox();
  const M = () => page.evaluate(() => { const M = window.fortshell.module;
    return Array.from({ length: M._fs_count() }, (_, i) => ({ id: i + 1, visible: M._fs_visible(i + 1),
      x: new Float32Array(M.HEAPU8.buffer, M._fs_data(i + 1, 0), 4)[0] })); });
  await page.locator('[data-id=lasso]').click();
  await expect(page.locator('[data-id=lasso]')).toHaveAttribute('aria-pressed', 'true');
  // Lasso around the whole stroke (drawn from 20 % to 70 % across, 30 % to 40 % down).
  const loop = [[0.1, 0.2], [0.8, 0.2], [0.8, 0.5], [0.1, 0.5], [0.1, 0.2]];
  await page.mouse.move(box.x + box.width * loop[0][0], box.y + box.height * loop[0][1]);
  await page.mouse.down();
  for (const [fx, fy] of loop.slice(1)) await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.35); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.75, { steps: 10 }); await page.mouse.up();
  let strokes = await M();
  expect(strokes.length).toBe(2);
  expect(strokes[0].visible).toBe(0); expect(strokes[1].visible).toBe(1);
  expect(strokes[1].x).toBeCloseTo(strokes[0].x, 3);
  await page.locator('[data-id=undo]').click();
  await expect.poll(async () => (await M()).map(s => s.visible)).toEqual([1, 0]);
  await page.locator('[data-id=pen]').click();
  await draw(page);
  await page.locator('#more summary').click(); await page.locator('#clear-page').click();
  expect((await M()).every(s => !s.visible)).toBe(true);
  await page.locator('[data-id=undo]').click();
  await expect.poll(async () => (await M()).map(s => s.visible)).toEqual([1, 0, 1]);
});

test('pen settings survive a reload', async ({ page }) => {
  await open(page);
  await page.locator('[data-id=colour-3]').click();
  await draw(page);
  await page.evaluate(() => window.fortshell.flush());
  await page.reload();
  await page.waitForFunction(() => window.fortshell?.ready);
  await expect(page.locator('[data-id=colour-3]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.fortshell.module._fs_colour(-1))).toBe(3);
});

test('two fingers pinch to zoom and never write', async ({ page }) => {
  await open(page);
  const before = await page.locator('#paper').boundingBox();
  await page.evaluate(({ x, y }) => {
    const ws = document.getElementById('workspace');
    const send = (type, id, px, py) => ws.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch',
      clientX: px, clientY: py, bubbles: true, cancelable: true, isPrimary: id === 1 }));
    send('pointerdown', 1, x - 50, y); send('pointerdown', 2, x + 50, y);
    for (let i = 1; i <= 10; i++) { send('pointermove', 1, x - 50 - 10 * i, y); send('pointermove', 2, x + 50 + 10 * i, y); }
    send('pointerup', 1, x - 150, y); send('pointerup', 2, x + 150, y);
  }, { x: before.x + before.width / 2, y: before.y + before.height / 2 });
  await expect.poll(async () => (await page.locator('#paper').boundingBox()).width).toBeGreaterThan(before.width * 1.5);
  expect(await page.evaluate(() => window.fortshell.module._fs_count())).toBe(0);
});
