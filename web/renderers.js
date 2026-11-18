import { InkShape, INK_CHUNK, INK } from './geometry.js';

const colour = [0, 0, 0, 1];
export async function createRenderer(canvas, backend, width, height, view) {
  if (backend === 'canvas') return new CanvasRenderer(canvas, width, height, view);
  if (backend === 'webgl') return new GLRenderer(canvas, width, height);
  if (backend === 'webgpu') return GPUrenderer.create(canvas, width, height);
  throw new Error(`Unknown renderer: ${backend}`);
}

function union(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function intersects(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

function pixelBounds(bounds, { x, y, sx, sy }, canvas) {
  const left = Math.max(0, Math.floor(bounds[0] * sx - x) - 2);
  const top = Math.max(0, Math.floor(bounds[1] * sy - y) - 2);
  const right = Math.min(canvas.width, Math.ceil(bounds[2] * sx - x) + 2);
  const bottom = Math.min(canvas.height, Math.ceil(bounds[3] * sy - y) + 2);
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

function pageBounds([left, top, width, height], { x, y, sx, sy }) {
  return [(left + x) / sx, (top + y) / sy, (left + x + width) / sx, (top + y + height) / sy];
}

function prepare(renderer, points, first, width, live, predicted) {
  // Bound Canvas tip work without fragmenting mesh uploads.
  const chunkSize = live && renderer.ctx ? INK_CHUNK : 64;
  const shape = live ? (renderer.shape ||= new InkShape(chunkSize)) : new InkShape(chunkSize);
  const oldChunks = shape.chunks;
  const { canvas } = renderer;
  const view = renderer.raster || { x: 0, y: 0, sx: canvas.width / renderer.width, sy: canvas.height / renderer.height };
  const from = shape.update(points, first, width, predicted);
  let bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = from; i < oldChunks.length; i++) bounds = union(bounds, oldChunks[i].bounds);
  for (let i = from; i * chunkSize < shape.points.length; i++) {
    const start = i * chunkSize, end = Math.min(start + chunkSize, shape.points.length);
    const outline = shape.outline(start, end);
    // Keep an isolated tap legible even when it lands between display pixels.
    if (shape.points.length === 1) {
      const dot = outline.caps[0];
      dot[2] = Math.max(dot[2], 1 / Math.min(view.sx, view.sy));
    }
    const chunk = { bounds: shape.bounds(outline) };
    if (renderer.ctx) { chunk.path = new Path2D(); shape.path(chunk.path, outline); }
    else chunk.mesh = shape.meshOutline(outline, Math.max(view.sx, view.sy));
    shape.chunks[i] = chunk; bounds = union(bounds, chunk.bounds);
  }
  shape.chunks.length = Math.ceil(shape.points.length / chunkSize);
  const clip = pixelBounds(bounds, view, canvas);
  const dirty = pageBounds(clip, view);
  const chunks = shape.chunks.filter(c => intersects(c.bounds, dirty));
  return { chunks, clip };
}
function vertices(chunks) {
  const output = new Float32Array(chunks.reduce((n, c) => n + c.mesh.length, 0));
  let at = 0;
  for (const c of chunks) { output.set(c.mesh, at); at += c.mesh.length; }
  return output;
}

const COVERAGE_TILE = 128;

class CanvasRenderer {
  constructor(canvas, width, height, view) {
    this.canvas = canvas; this.width = width; this.height = height;
    this.ctx = canvas.getContext('2d', { alpha: true });
    if (!this.ctx) throw new Error('Canvas 2D unavailable');
    if (view) this.setView(view);
    else this.raster = { x: 0, y: 0, sx: canvas.width / width, sy: canvas.height / height };
  }
  setView(view) {
    const { canvas } = this, previous = this.raster;
    canvas.style.left = `${view.left}px`; canvas.style.top = `${view.top}px`;
    canvas.style.width = `${view.width / view.dpr}px`; canvas.style.height = `${view.height / view.dpr}px`;
    const changed = !previous || previous.x !== view.x || previous.y !== view.y || previous.sx !== view.sx ||
      previous.sy !== view.sy || canvas.width !== view.width || canvas.height !== view.height;
    if (!changed) return false;
    if (canvas.width !== view.width) canvas.width = view.width;
    if (canvas.height !== view.height) canvas.height = view.height;
    this.raster = view; this.clear();
    return true;
  }
  clear() {
    this.shape = null;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  draw(points, first = 0, width, live = false, predicted = []) {
    if (!points.length) return;
    const { chunks, clip } = prepare(this, points, first, width, live, predicted);
    this.paint(chunks, clip, live);
  }
  paint(chunks, [left, top, width, height], live) {
    if (!width || !height) return;
    const { ctx, raster: { x, y, sx, sy } } = this;
    if (!this.coverage) {
      const canvas = this.canvas.ownerDocument.createElement('canvas');
      canvas.width = canvas.height = COVERAGE_TILE * 2;
      this.coverage = canvas.getContext('2d');
    }
    const coverage = this.coverage;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (live) ctx.clearRect(left, top, width, height);
    for (let row = top; row < top + height; row += COVERAGE_TILE) {
      const h = Math.min(COVERAGE_TILE, top + height - row);
      for (let column = left; column < left + width; column += COVERAGE_TILE) {
        const w = Math.min(COVERAGE_TILE, left + width - column);
        const bounds = pageBounds([column, row, w, h], this.raster);
        const path = new Path2D();
        let visible = false;
        for (const chunk of chunks) if (intersects(chunk.bounds, bounds)) {
          path.addPath(chunk.path); visible = true;
        }
        if (!visible) continue;
        // Reuse a small surface to average adjacent samples at the display pixel grid.
        coverage.setTransform(1, 0, 0, 1, 0, 0);
        coverage.clearRect(0, 0, w * 2, h * 2);
        coverage.setTransform(2 * sx, 0, 0, 2 * sy, -2 * (x + column), -2 * (y + row));
        coverage.fillStyle = INK; coverage.fill(path);
        ctx.drawImage(coverage.canvas, 0, 0, w * 2, h * 2, column, row, w, h);
      }
    }
  }
  commit(target, points, width, drawn) {
    const tip = this.shape?.points.at(-1), at = points.length - 3;
    if (this.shape?.predicted || drawn !== points.length / 3 || !tip || tip[0] !== points[at] || tip[1] !== points[at + 1])
      this.draw(points, this.shape ? Math.min(drawn, points.length / 3 - 1) : 0, width, true);
    // Preserve the live coverage at lift-off instead of rasterizing it a second time.
    target.ctx.setTransform(1, 0, 0, 1, 0, 0);
    target.ctx.drawImage(this.canvas, 0, 0);
  }
  dispose() { this.clear(); }
}

class GLRenderer {
  constructor(canvas, width, height) {
    this.canvas = canvas; this.width = width; this.height = height;
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const program = gl.createProgram();
    const sources = [
      `#version 300 es
      in vec2 point; uniform vec2 page;
      void main() { gl_Position = vec4(point.x/page.x*2.-1.,1.-point.y/page.y*2.,0.,1.); }`,
      `#version 300 es
      precision highp float; out vec4 pixel;
      void main() { pixel = vec4(${colour.join(',')}); }`,
    ];
    for (let i = 0; i < 2; i++) {
      const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
      gl.shaderSource(shader, sources[i]); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, 'page'), width, height);
    this.program = program; this.buffer = gl.createBuffer(); this.capacity = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const loc = gl.getAttribLocation(program, 'point');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); canvas.dispatchEvent(new CustomEvent('renderer-lost', { bubbles: true }));
    });
    gl.viewport(0, 0, canvas.width, canvas.height); this.clear();
  }
  clear() { this.shape = null; this.gl.disable(this.gl.SCISSOR_TEST); this.gl.clearColor(0, 0, 0, 0); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
  draw(points, first = 0, width, live = false, predicted = []) {
    if (!points.length) return;
    const { chunks, clip } = prepare(this, points, first, width, live, predicted);
    const gl = this.gl, data = vertices(chunks);
    if (!data.length || !clip[2] || !clip[3]) return;
    gl.enable(gl.SCISSOR_TEST); gl.scissor(clip[0], this.canvas.height - clip[1] - clip[3], clip[2], clip[3]);
    if (live) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    if (data.byteLength > this.capacity) {
      this.capacity = Math.max(data.byteLength, this.capacity * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 2); gl.disable(gl.SCISSOR_TEST);
  }
  dispose() { this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); }
}

let sharedDevice;
async function device() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  if (!sharedDevice) sharedDevice = (async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const d = await adapter.requestDevice();
    d.lost.then(() => { sharedDevice = null; });
    return d;
  })().catch(e => { sharedDevice = null; throw e; });
  return sharedDevice;
}

class GPUrenderer {
  static async create(canvas, width, height) {
    const r = new GPUrenderer();
    r.canvas = canvas; r.width = width; r.height = height;
    r.device = await device();
    r.context = canvas.getContext('webgpu');
    if (!r.context) throw new Error('WebGPU canvas unavailable');
    const d = r.device, format = navigator.gpu.getPreferredCanvasFormat();
    r.context.configure({ device: d, format, alphaMode: 'premultiplied' });
    r.texture = d.createTexture({ size: [canvas.width, canvas.height], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    r.msaa = d.createTexture({ size: [canvas.width, canvas.height], format, sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    r.view = r.texture.createView(); r.msaaView = r.msaa.createView();
    const shader = d.createShaderModule({ code: `
      @vertex fn vertex(@location(0) point: vec2f) -> @builtin(position) vec4f {
        return vec4f(point.x/${width}*2.-1.,1.-point.y/${height}*2.,0.,1.);
      }
      @fragment fn fragment() -> @location(0) vec4f { return vec4f(${colour.join(',')}); }
    ` });
    r.pipeline = d.createRenderPipeline({ layout: 'auto',
      vertex: { module: shader, entryPoint: 'vertex', buffers: [{ arrayStride: 8,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }, multisample: { count: 4 } });
    const blit = d.createShaderModule({ code: `
      @group(0) @binding(0) var image: texture_2d<f32>;
      @vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
        return vec4f(p[i],0.,1.);
      }
      @fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
        return textureLoad(image, vec2i(p.xy), 0);
      }
      @fragment fn transparent() -> @location(0) vec4f { return vec4f(0.); }
    ` });
    r.blit = d.createRenderPipeline({ layout: 'auto', vertex: { module: blit, entryPoint: 'v' },
      fragment: { module: blit, entryPoint: 'f', targets: [{ format }] } });
    r.erase = d.createRenderPipeline({ layout: 'auto', vertex: { module: blit, entryPoint: 'v' },
      fragment: { module: blit, entryPoint: 'transparent', targets: [{ format }] }, multisample: { count: 4 } });
    r.binding = d.createBindGroup({ layout: r.blit.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: r.view }] });
    r.capacity = 0;
    d.lost.then(() => canvas.dispatchEvent(new CustomEvent('renderer-lost', { bubbles: true })));
    r.clear(); return r;
  }
  pass(encoder, clear) {
    return encoder.beginRenderPass({ colorAttachments: [{ view: this.msaaView,
      resolveTarget: this.view, loadOp: clear ? 'clear' : 'load', storeOp: 'store',
      clearValue: [0, 0, 0, 0] }] });
  }
  present(encoder) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
      clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(this.blit); pass.setBindGroup(0, this.binding); pass.draw(3); pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  clear() {
    this.shape = null;
    const encoder = this.device.createCommandEncoder(), pass = this.pass(encoder, true);
    pass.end(); this.present(encoder);
  }
  draw(points, first = 0, width, live = false, predicted = []) {
    if (!points.length) return;
    const { chunks, clip } = prepare(this, points, first, width, live, predicted), data = vertices(chunks);
    if (!clip[2] || !clip[3]) return;
    if (!data.length) return;
    const d = this.device;
    if (data.byteLength > this.capacity) {
      this.buffer?.destroy();
      this.capacity = Math.max(data.byteLength, this.capacity * 2, 4096);
      this.buffer = d.createBuffer({ size: this.capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    d.queue.writeBuffer(this.buffer, 0, data);
    const encoder = d.createCommandEncoder(), pass = this.pass(encoder, false);
    pass.setScissorRect(...clip);
    if (live) { pass.setPipeline(this.erase); pass.draw(3); }
    pass.setPipeline(this.pipeline); pass.setVertexBuffer(0, this.buffer);
    pass.draw(data.length / 2); pass.end(); this.present(encoder);
  }
  dispose() {
    this.buffer?.destroy(); this.texture.destroy(); this.msaa.destroy(); this.context.unconfigure();
  }
}
