import { InkModel } from 'fortink/model';
import { createRenderer } from './renderers.js';
import { getStroke } from 'perfect-freehand';

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const summary = values => ({ median_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Math.max(...values) });
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

export function trace(n = 1200, hz = 240) {
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    data.set([20 + i * 0.2, 105 + 35 * Math.sin(t * 5) + 2 * Math.sin(t * 41),
      t, 0.5 + 0.3 * Math.sin(t * 3)], i * 4);
  }
  return data;
}

export function wasmBatch(M, data, width = 0.65, batch = 4) {
  M._fi_reset();
  const out = new Float32Array(data.length / 4 * 3);
  for (let i = 0; i < data.length / 4; i += batch) {
    const n = Math.min(batch, data.length / 4 - i);
    M.HEAPF32.set(data.subarray(i * 4, (i + n) * 4), M._fi_input() / 4);
    M._fi_process(n, width);
    out.set(new Float32Array(M.HEAPU8.buffer, M._fi_output(), n * 3), i * 3);
  }
  return out;
}
export function jsBatch(data, width = 0.65, batch = 4) {
  const model = new InkModel(), out = new Float32Array(data.length / 4 * 3);
  for (let i = 0; i < data.length / 4; i += batch) {
    const n = Math.min(batch, data.length / 4 - i);
    model.batch(data.subarray(i * 4, (i + n) * 4), width, out.subarray(i * 3, (i + n) * 3));
  }
  return out;
}
function pairedInterval(pairs) {
  let seed = 123456789;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const means = [];
  for (let k = 0; k < 1000; k++) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) sum += pairs[Math.floor(random() * pairs.length)];
    means.push(sum / pairs.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

export async function runBenchmark(M, progress = () => {}) {
  let quantum = Infinity, previous = performance.now();
  const resolutionStart = previous;
  while (performance.now() - resolutionStart < 4) {
    const now = performance.now();
    if (now > previous) quantum = Math.min(quantum, now - previous);
    previous = now;
  }
  const report = { version: 1, timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency,
    timer_quantum_ms: Number.isFinite(quantum) ? quantum : null,
    units: 'milliseconds', physical_latency_measured: false,
    timing: 'CPU processing includes boundary copies. Rendering measures CPU submission and next animation frame, not photon latency.',
    processing: [], rendering: [], errors: [] };
  report.toolchain = await fetch('./toolchain.txt').then(r => r.text()).catch(e => e.message);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:130px 20px 120px;z-index:6;background:white;display:grid;place-items:center;pointer-events:none';
  document.body.append(overlay);
  try {
    for (const hz of [60, 120, 240]) for (const batch of [1, 4, 16]) {
      const data = trace(1200, hz), a = wasmBatch(M, data, 0.65, batch), b = jsBatch(data, 0.65, batch);
      let maxError = 0;
      for (let i = 0; i < a.length; i++) maxError = Math.max(maxError, Math.abs(a[i] - b[i]));
      if (maxError > 0.00003) throw new Error(`Language parity failed: ${maxError} mm`);
      for (let i = 0; i < 8; i++) { wasmBatch(M, data, 0.65, batch); jsBatch(data, 0.65, batch); }
      const wasm = [], js = [], differences = [], repetitions = 100;
      for (let i = 0; i < 40; i++) {
        const durations = {};
        for (const kind of i % 2 ? ['wasm', 'js'] : ['js', 'wasm']) {
          const begin = performance.now();
          for (let repeat = 0; repeat < repetitions; repeat++) {
            if (kind === 'wasm') wasmBatch(M, data, 0.65, batch); else jsBatch(data, 0.65, batch);
          }
          durations[kind] = (performance.now() - begin) / repetitions;
        }
        wasm.push(durations.wasm); js.push(durations.js);
        differences.push(durations.wasm - durations.js);
        if (i % 10 === 0) await nextFrame();
      }
      const interval = pairedInterval(differences), margin = 0.1;
      const verdict = interval[1] < -margin ? 'Fortran faster' : interval[0] > margin ? 'JavaScript faster'
        : interval[0] >= -margin && interval[1] <= margin ? 'equivalent within margin' : 'inconclusive';
      report.processing.push({ hz, batch, samples: 1200, repetitions_per_timing: repetitions, max_error_mm: maxError, wasm: summary(wasm), js: summary(js),
        paired_mean_difference_95ci_ms: interval, equivalence_margin_ms_per_trace: margin, verdict });
      progress(`${hz} samples/s, batch ${batch}: ${verdict}\n${report.processing.length}/9 processing comparisons`);
    }
    const data = trace(), reference = [];
    for (let i = 0; i < data.length; i += 4) reference.push([data[i], data[i + 1], data[i + 3]]);
    const perfectTimes = [];
    for (let i = 0; i < 40; i++) {
      const begin = performance.now(); getStroke(reference, { size: 0.65, simulatePressure: false });
      perfectTimes.push(performance.now() - begin);
    }
    report.perfect_freehand = { ...summary(perfectTimes), note: 'Different algorithm, includes outline generation.' };
    for (const backend of ['canvas', 'webgl', 'webgpu']) for (const processing of ['wasm', 'js']) {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 849;
      canvas.style.cssText = 'width:min(100%,900px);height:auto;background:white'; overlay.replaceChildren(canvas);
      let renderer;
      try {
        renderer = await createRenderer(canvas, backend, 297, 210);
        const points = processing === 'wasm' ? wasmBatch(M, data) : jsBatch(data);
        const submissions = [], intervals = [];
        for (let i = 0; i < 20; i++) {
          await nextFrame();
          const begin = performance.now(); renderer.clear(); renderer.draw(points, 0, 0.65);
          submissions.push(performance.now() - begin);
          await nextFrame(); intervals.push(performance.now() - begin);
        }
        renderer.clear();
        const incremental = [];
        for (let i = 0; i < 20; i++) {
          await nextFrame();
          const begin = performance.now();
          renderer.draw(points.subarray(0, (i + 1) * 12), i * 4, 0.65, true);
          incremental.push(performance.now() - begin);
        }
        report.rendering.push({ backend, processing, backing_pixels: [1200, 849],
          submit: summary(submissions), next_frame_proxy: summary(intervals),
          incremental_samples_per_frame: 4, incremental_submit: summary(incremental), status: 'measured' });
      } catch (e) { report.rendering.push({ backend, processing, status: 'unavailable', reason: e.message }); }
      finally { renderer?.dispose(); }
    }
    const ui = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      for (let repeat = 0; repeat < 25; repeat++) M._fortui_web_step();
      ui.push((performance.now() - start) / 25);
    }
    report.fortui_unchanged_step = summary(ui);
    const duration = ms => ms === 0 ? `<${(report.timer_quantum_ms || 1).toFixed(3)}` : ms.toFixed(3);
    progress(report.processing.map(x => `${x.hz} Hz / ${x.batch}: ${x.verdict}; JS ${x.js.median_ms.toFixed(3)} ms, Fortran ${x.wasm.median_ms.toFixed(3)} ms`).join('\n')
      + '\n' + report.rendering.map(x => `${x.processing}/${x.backend}: ${x.status}${x.submit ? `, full ${duration(x.submit.median_ms)} ms, incremental ${duration(x.incremental_submit.median_ms)} ms` : ` (${x.reason})`}`).join('\n')
      + '\nOptical Pencil-to-photon latency: not measured. Download Results for full measurements.');
    return report;
  } finally { overlay.remove(); }
}
