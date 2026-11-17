import { perfectOutline, outlinePath } from './perfect.js';
let pdfjs;
const MM = 72 / 25.4;

export async function openPDF(bytes) {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';
  }
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false,
    cMapUrl: './cmaps/', cMapPacked: true, standardFontDataUrl: './standard_fonts/', wasmUrl: './wasm/' }).promise;
}

export async function renderPDF(pdf, number, canvas, pixelWidth) {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale: 1 });
  const scaled = page.getViewport({ scale: pixelWidth / viewport.width });
  canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
}

// Collinear samples with a stable radius do not need their own PDF primitives.
export function simplify(points, tolerance = 0.025) {
  const n = points.length / 3;
  if (n < 3) return points;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a * 3], ay = points[a * 3 + 1];
    const dx = points[b * 3] - ax, dy = points[b * 3 + 1] - ay, length2 = dx * dx + dy * dy;
    let worst = tolerance, at = -1;
    for (let i = a + 1; i < b; i++) {
      const u = length2 ? Math.max(0, Math.min(1,
        ((points[i * 3] - ax) * dx + (points[i * 3 + 1] - ay) * dy) / length2)) : (i - a) / (b - a);
      const distance = Math.hypot(points[i * 3] - ax - u * dx, points[i * 3 + 1] - ay - u * dy);
      const dr = Math.abs(points[i * 3 + 2] - (points[a * 3 + 2] * (1 - u) + points[b * 3 + 2] * u));
      if (distance + dr > worst) { worst = distance + dr; at = i; }
    }
    if (at >= 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const output = [];
  for (let i = 0; i < n; i++) if (keep[i]) output.push(...points.subarray(i * 3, i * 3 + 3));
  return new Float32Array(output);
}

export function svgInk(input) {
  const points = simplify(input), n = points.length / 3;
  const f = x => Number(x.toFixed(4));
  let path = '';
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], r = points[i * 3 + 2], k = r * 0.5522847498;
    path += `M${f(x + r)} ${f(y)}C${f(x + r)} ${f(y + k)} ${f(x + k)} ${f(y + r)} ${f(x)} ${f(y + r)}`
      + `C${f(x - k)} ${f(y + r)} ${f(x - r)} ${f(y + k)} ${f(x - r)} ${f(y)}`
      + `C${f(x - r)} ${f(y - k)} ${f(x - k)} ${f(y - r)} ${f(x)} ${f(y - r)}`
      + `C${f(x + k)} ${f(y - r)} ${f(x + r)} ${f(y - k)} ${f(x + r)} ${f(y)}Z`;
    if (!i) continue;
    const a = 3 * (i - 1), dx = x - points[a], dy = y - points[a + 1], len = Math.hypot(dx, dy);
    if (len < 1e-8) continue;
    const nx = -dy / len, ny = dx / len, pr = points[a + 2];
    path += `M${f(points[a] + nx * pr)} ${f(points[a + 1] + ny * pr)}`
      + `L${f(points[a] - nx * pr)} ${f(points[a + 1] - ny * pr)}`
      + `L${f(x - nx * r)} ${f(y - ny * r)}L${f(x + nx * r)} ${f(y + ny * r)}Z`;
  }
  return path;
}

export async function exportPDF(snapshot, strokes) {
  const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const original = snapshot.pdf ? await PDFDocument.load(snapshot.pdf) : null;
  if (original) {
    const pages = await doc.copyPages(original, original.getPageIndices());
    for (const page of pages) doc.addPage(page);
  }
  for (let i = 0; i < snapshot.meta.pages.length; i++) {
    const [w, h] = snapshot.meta.pages[i];
    if (i >= doc.getPageCount()) doc.addPage([w * MM, h * MM]);
    const page = doc.getPage(i);
    const { x, y, width, height } = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const transforms = { 0: [1, 0, 0, 1, x, y + height],
      90: [0, 1, -1, 0, x, y], 180: [-1, 0, 0, -1, x + width, y],
      270: [0, -1, 1, 0, x + width, y + height] };
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...transforms[rotation]));
    for (const stroke of strokes) {
      if (!stroke.visible || stroke.page !== i + 1 || !stroke.points.length) continue;
      const path = stroke.engine === 3 ? outlinePath(perfectOutline(stroke.raw, stroke.width)) : svgInk(stroke.points);
      page.drawSvgPath(path, { x: 0, y: 0, scale: MM,
        color: rgb(23 / 255, 33 / 255, 43 / 255), borderWidth: 0 });
    }
    page.pushOperators(popGraphicsState());
  }
  doc.setTitle(snapshot.meta.title || 'FortShell notebook');
  doc.setCreator('FortShell');
  return doc.save({ useObjectStreams: true });
}
