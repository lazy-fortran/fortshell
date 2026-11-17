import { capsulePath, mesh, INK } from './geometry.js';

const colour = [23 / 255, 33 / 255, 43 / 255, 1];
export async function createRenderer(canvas, backend, width, height) {
  if (backend === 'canvas') return new CanvasRenderer(canvas, width, height);
  if (backend === 'webgl') return new GLRenderer(canvas, width, height);
  if (backend === 'webgpu') return GPUrenderer.create(canvas, width, height);
  throw new Error(`Unknown renderer: ${backend}`);
}

class CanvasRenderer {
  constructor(canvas, width, height) {
    this.canvas = canvas; this.width = width; this.height = height;
    this.ctx = canvas.getContext('2d', { alpha: true });
    if (!this.ctx) throw new Error('Canvas 2D unavailable');
  }
  clear() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  draw(points, first = 0) {
    const c = this.ctx;
    c.setTransform(this.canvas.width / this.width, 0, 0, this.canvas.height / this.height, 0, 0);
    c.beginPath(); capsulePath(c, points, first); c.fillStyle = INK; c.fill();
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
  clear() { this.gl.clearColor(0, 0, 0, 0); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
  draw(points, first = 0) {
    const gl = this.gl, data = mesh(points, first);
    if (!data.length) return;
    if (data.byteLength > this.capacity) {
      this.capacity = Math.max(data.byteLength, this.capacity * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 2);
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
    ` });
    r.blit = d.createRenderPipeline({ layout: 'auto', vertex: { module: blit, entryPoint: 'v' },
      fragment: { module: blit, entryPoint: 'f', targets: [{ format }] } });
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
    const encoder = this.device.createCommandEncoder(), pass = this.pass(encoder, true);
    pass.end(); this.present(encoder);
  }
  draw(points, first = 0) {
    const data = mesh(points, first);
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
    pass.setPipeline(this.pipeline); pass.setVertexBuffer(0, this.buffer);
    pass.draw(data.length / 2); pass.end(); this.present(encoder);
  }
  dispose() {
    this.buffer?.destroy(); this.texture.destroy(); this.msaa.destroy(); this.context.unconfigure();
  }
}
