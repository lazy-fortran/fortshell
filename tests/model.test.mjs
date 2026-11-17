import test from 'node:test';
import assert from 'node:assert/strict';
import { InkModel } from '../../fortink/web/model.js';
import { hitStroke, mesh } from '../web/geometry.js';

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
