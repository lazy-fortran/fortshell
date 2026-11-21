import { perfectOutline, outlinePath } from './perfect.js';
import { InkShape, LEGACY_GEOMETRY, inkRGB } from './geometry.js';
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

// Web links of a PDF page as rectangles in fractions of the page: [x, y, w, h, url].
export async function pdfLinks(pdf, number) {
  const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 }), links = [];
  for (const a of await page.getAnnotations({ intent: 'display' })) {
    if (a.subtype !== 'Link' || !/^https?:\/\//.test(a.url || '')) continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
    links.push([Math.min(x1, x2) / viewport.width, Math.min(y1, y2) / viewport.height,
      Math.abs(x2 - x1) / viewport.width, Math.abs(y2 - y1) / viewport.height, a.url]);
  }
  return links;
}

export function svgInk(input, width, revision = LEGACY_GEOMETRY) {
  const shape = new InkShape(undefined, revision); shape.update(input, 0, width);
  const f = x => Number(x.toFixed(4)), xy = values => values.map(f).join(' ');
  let path = '';
  shape.path({
    moveTo: (...p) => { path += `M${xy(p)}`; },
    lineTo: (...p) => { path += `L${xy(p)}`; },
    bezierCurveTo: (...p) => { path += `C${xy(p)}`; },
    closePath: () => { path += 'Z'; },
    arc: (x, y, r) => {
      const k = r * 0.5522847498;
      path += `C${xy([x + r, y + k, x + k, y + r, x, y + r])}`
        + `C${xy([x - k, y + r, x - r, y + k, x - r, y])}`
        + `C${xy([x - r, y - k, x - k, y - r, x, y - r])}`
        + `C${xy([x + k, y - r, x + r, y - k, x + r, y])}`;
    },
  }, undefined, true);
  return path;
}

export async function exportPDF(snapshot, strokes) {
  const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const original = snapshot.pdf ? await PDFDocument.load(snapshot.pdf) : null;
  const count = original ? original.getPageCount() : 0;
  const sources = snapshot.meta.sources || snapshot.meta.pages.map((_, i) => i < count ? i + 1 : 0);
  const used = sources.filter(k => k > 0 && k <= count).map(k => k - 1);
  const copies = original && used.length ? await doc.copyPages(original, used) : [];
  let next = 0;
  for (let i = 0; i < snapshot.meta.pages.length; i++) {
    const [w, h] = snapshot.meta.pages[i];
    if (sources[i] > 0 && sources[i] <= count) doc.addPage(copies[next++]);
    else doc.addPage([w * MM, h * MM]);
    const page = doc.getPage(i);
    const { x, y, width, height } = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const transforms = { 0: [1, 0, 0, 1, x, y + height],
      90: [0, 1, -1, 0, x, y], 180: [-1, 0, 0, -1, x + width, y],
      270: [0, -1, 1, 0, x + width, y + height] };
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...transforms[rotation]));
    for (const stroke of strokes) {
      if (!stroke.visible || stroke.page !== i + 1 || !stroke.points.length) continue;
      const path = stroke.engine === 3 ? outlinePath(perfectOutline(stroke.raw, stroke.width))
        : svgInk(stroke.points, stroke.width, stroke.geometry);
      page.drawSvgPath(path, { x: 0, y: 0, scale: MM,
        color: rgb(...inkRGB(stroke.colour)), borderWidth: 0 });
    }
    page.pushOperators(popGraphicsState());
  }
  doc.setTitle(snapshot.meta.title || 'FortShell notebook');
  doc.setCreator('FortShell');
  return doc.save({ useObjectStreams: true });
}
