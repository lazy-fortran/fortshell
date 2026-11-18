import test from 'node:test';
import assert from 'node:assert/strict';
import { InkModel } from '../../fortink/web/model.js';
import { hitStroke, mesh, InkShape } from '../web/geometry.js';

test('stationary pressure has a fixed radius and no drift', () => {
  const model = new InkModel(), input = new Float32Array(4 * 500);
  for (let i = 0; i < 500; i++) input.set([10, 20, i / 240, 0.5], i * 4);
  const output = model.batch(input, 1);
  for (let i = 0; i < 500; i++) {
    assert.equal(output[i * 3], 10); assert.equal(output[i * 3 + 1], 20);
    assert.ok(Math.abs(output[i * 3 + 2] - 0.295) < 1e-7);
  }
});
test('coalescing does not change the model trajectory', () => {
  const input = new Float32Array(800);
  for (let i = 0; i < 200; i++) input.set([i, Math.sin(i / 5), i / 120, 0.6], i * 4);
  const whole = new InkModel().batch(input, 1), single = new InkModel(), output = new Float32Array(600);
  for (let i = 0; i < 200; i++) single.batch(input.subarray(i * 4, i * 4 + 4), 1, output.subarray(i * 3, i * 3 + 3));
  assert.deepEqual(output, whole);
});
test('eraser hits the segment between widely spaced samples', () => {
  const points = new Float32Array([0, 0, 0.5, 100, 0, 0.5]);
  assert.ok(hitStroke(points, 50, 0)); assert.ok(!hitStroke(points, 50, 10));
  assert.ok(mesh(points).length > 0); assert.ok(mesh(points).every(Number.isFinite));
});

test('brush caps taper without thinning dots or accumulating stationary pressure', () => {
  const shape = new InkShape(), points = new Float32Array([0, 0, 0.75, 5, 0, 0.75, 10, 0, 0.75]);
  shape.update(points, 0, 1.5);
  const middle = shape.points.findIndex(p => p[0] === 5);
  assert.equal(shape.radius(middle), 0.75);
  assert.ok(Math.abs(shape.radius(0) / shape.radius(middle) - 0.65) < 1e-12);
  assert.equal(shape.radius(shape.points.length - 1), shape.radius(0));
  const dot = new InkShape(); dot.update(new Float32Array([4, 8, 0.75, 4, 8, 1]), 0, 1.5);
  assert.equal(dot.points.length, 1); assert.equal(dot.radius(0), 0.75);
});

test('outline geometry is independent of coalesced batch size, including reversals', () => {
  const points = new Float32Array(720);
  for (let i = 0; i < 240; i++) points.set([20 + Math.sin(i / 10), 30 + Math.cos(i / 10), 0.5 + 0.2 * Math.sin(i / 30)], i * 3);
  const whole = new InkShape(); whole.update(points, 0, 1.5);
  for (const batch of [1, 4, 16, 240]) {
    const shape = new InkShape();
    for (let i = 0; i < 240; i += batch) shape.update(points.subarray(0, Math.min(240, i + batch) * 3), i, 1.5);
    assert.deepEqual(shape.mesh(), whole.mesh());
  }
  const reversal = mesh(new Float32Array([0, 0, 0.5, 10, 0, 0.5, 0, 0, 0.5]));
  assert.ok(reversal.every(Number.isFinite));
});

test('sparse straight strokes keep full body width between tapered caps', () => {
  const shape = new InkShape(); shape.update(new Float32Array([0, 0, 0.75, 30, 0, 0.75]), 0, 1.5);
  const middle = shape.points.findIndex(p => p[0] >= 14 && p[0] <= 16);
  assert.ok(middle >= 0);
  assert.equal(shape.radius(middle), 0.75);
  assert.equal(shape.points.at(-1)[0], 30);
});

test('close samples suppress transverse wobble while preserving ends and sharp turns', () => {
  const shape = new InkShape();
  const samples = Array.from({ length: 101 }, (_, i) => [i * 0.31, (i % 2 ? 1 : -1) * 0.06, 0.525]);
  shape.update(Float32Array.from(samples.flat()), 0, 1.5);
  assert.ok(shape.points.slice(1, -1).every(p => Math.abs(p[1]) < 0.012));
  assert.ok(Math.abs(shape.points[0][1] + 0.06) < 1e-7);
  assert.ok(Math.abs(shape.points.at(-1)[1] + 0.06) < 1e-7);

  shape.update(new Float32Array([0, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0, 0.5, 0.5]), 0, 1.5);
  assert.deepEqual(shape.points.map(p => p.slice(0, 2)), [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]);
});

test('sparse curves recover the arc without moving its endpoints', () => {
  const input = Float32Array.from(Array.from({ length: 5 }, (_, i) =>
    [12 * Math.cos(i * Math.PI / 8), 12 * Math.sin(i * Math.PI / 8), 0.525]).flat());
  const shape = new InkShape();
  shape.update(input, 0, 1.5);
  assert.ok(shape.points.every(p => Math.abs(Math.hypot(p[0], p[1]) - 12) < 0.012));
  assert.deepEqual(shape.points[0], Array.from(input.subarray(0, 3)));
  assert.deepEqual(shape.points.at(-1), Array.from(input.subarray(-3)));
  const original = shape.mesh();
  const dwell = new Float32Array([...input, ...input.subarray(-3)]);
  shape.update(dwell, input.length / 3, 1.5);
  assert.deepEqual(shape.mesh(), original);
});

test('the outside of a sparse circular stroke follows its geometric radius', () => {
  const radius = 6, brush = 0.75, shape = new InkShape();
  shape.update(Float32Array.from(Array.from({ length: 9 }, (_, i) => {
    const angle = i * Math.PI / 16;
    return [radius * Math.cos(angle), radius * Math.sin(angle), brush];
  }).flat()), 0, 2 * brush);
  let start, error = 0, count = 0;
  const measure = (...coordinates) => {
    const controls = [start];
    for (let i = 0; i < coordinates.length; i += 2) controls.push(coordinates.slice(i, i + 2));
    start = controls.at(-1);
    for (let sample = 0; sample <= 16; sample++) {
      const t = sample / 16;
      let points = controls;
      while (points.length > 1) points = points.slice(1).map(([x, y], i) =>
        [(1 - t) * points[i][0] + t * x, (1 - t) * points[i][1] + t * y]);
      const [x, y] = points[0], angle = Math.atan2(y, x), distance = Math.hypot(x, y);
      if (angle > 0.3 && angle < Math.PI / 2 - 0.3 && distance > radius) {
        error = Math.max(error, Math.abs(distance - radius - brush));
        count++;
      }
    }
  };
  const move = (x, y) => { start = [x, y]; };
  shape.path({ moveTo: move, lineTo: move, quadraticCurveTo: measure, bezierCurveTo: measure,
    closePath() {}, arc() {} });
  assert.ok(count > 0);
  assert.ok(error < 0.005, `Maximum outside error ${error} mm`);
});

test('replacing a forecast restores measured geometry across chunk boundaries', () => {
  const input = new Float32Array(130 * 3);
  for (let i = 0; i < 130; i++) input.set([i, Math.sin(i / 10), 0.5], i * 3);
  const shape = new InkShape();
  shape.update(input.subarray(0, 100 * 3), 0, 1.5, [[110, 20, 0.5], [120, 30, 0.5]]);
  shape.update(input, 100, 1.5);
  const measured = new InkShape(); measured.update(input, 0, 1.5);
  assert.deepEqual(shape.mesh(), measured.mesh());
  assert.equal(shape.ends.length, 130); assert.equal(shape.predicted, 0);
});
