import { test, expect } from '@playwright/test';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
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
  expect(first.width).toBeGreaterThan(0.25); expect(first.visible).toBe(true);
  await page.mouse.up();
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
    await open(page); await page.locator('#compare-toggle').click();
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
    const failed = []; page.on('requestfailed', request => failed.push(request.url()));
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
  await page.locator('#compare-toggle').click(); await page.locator('#engine').selectOption('js');
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
  await open(page); await page.locator('#compare-toggle').click();
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

for (const renderer of ['webgl', 'webgpu']) test(`${renderer} draws, resizes, and preserves ink`, async ({ page }, info) => {
  await open(page);
  if (renderer === 'webgpu') {
    const supported = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
    test.skip(!supported, 'No WebGPU adapter on this browser host');
  }
  await page.locator('#compare-toggle').click(); await page.locator('#renderer').selectOption(renderer);
  await expect.poll(() => page.evaluate(() => window.fortshell.renderer)).toBe(renderer);
  await page.waitForTimeout(300);
  await expect(page.locator('#error')).toBeHidden();
  await draw(page); expect(await darkPixels(page)).toBeGreaterThan(100);
  await page.locator('#zoom-in').click();
  await expect.poll(() => darkPixels(page)).toBeGreaterThan(100);
});
