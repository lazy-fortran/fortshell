const TAU = 2 * Math.PI;
export const INK = '#17212b';
export const INK_CHUNK = 64;
const mix = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Distance, rather than time spent pressing, controls brush width transitions.
export class InkShape {
  constructor() { this.points = []; this.distance = []; this.ends = []; this.chunks = []; }
  update(input, first = 0, width = input[2] * 2, predicted = []) {
    const oldLength = this.distance.at(-1) || 0;
    if (!first) { this.points = []; this.distance = []; this.ends = []; this.chunks = []; }
    else if (first < this.ends.length) {
      this.points.length = this.ends[first - 1]; this.distance.length = this.points.length;
      this.ends.length = first;
    }
    this.width = width;
    const length = this.distance.at(-1) || 0;
    let changed = this.points.length - 1;
    while (changed > 0 && this.distance[changed] > length - width) changed--;
    changed = Math.max(0, changed - 2);
    if (Math.min(oldLength, length) < width * 2) changed = 0;
    const append = (x, y, radius) => {
      const previous = this.points.at(-1);
      const d = previous ? Math.hypot(x - previous[0], y - previous[1]) : 0;
      // A stationary pen leaves one deposit, including its fractional edge coverage.
      if (previous && d < 1e-7) { this.ends.push(this.points.length); return; }
      const r = previous ? Math.max(previous[2] - d * 0.25,
        Math.min(previous[2] + d * 0.25, radius)) : radius;
      const start = this.distance.at(-1) || 0;
      // Sparse events and simplified PDFs still need stations inside the tapers.
      const steps = Math.max(1, Math.ceil(d / Math.max(0.05, width / 2)));
      for (let j = 1; j <= steps; j++) {
        const u = j / steps;
        this.points.push(j === steps ? [x, y, r] : [
          previous[0] + u * (x - previous[0]), previous[1] + u * (y - previous[1]),
          previous[2] + u * (r - previous[2])]);
        this.distance.push(start + u * d);
      }
      this.ends.push(this.points.length);
    };
    for (let i = first * 3; i < input.length; i += 3) append(input[i], input[i + 1], input[i + 2]);
    for (const p of predicted) append(...p);
    this.predicted = predicted.length;
    return Math.floor(changed / INK_CHUNK);
  }
  radius(i) {
    const total = this.distance.at(-1), d = Math.min(this.distance[i], total - this.distance[i]);
    const u = Math.min(1, d / this.width), strength = Math.min(1, total / (2 * this.width));
    // Short marks stay round. Longer strokes have softly rounded, narrower ends.
    return this.points[i][2] * (1 - 0.35 * strength * (1 - u * u * (3 - 2 * u)));
  }
  edge(i) {
    const p = this.points[i], before = this.points[Math.max(0, i - 1)],
      after = this.points[Math.min(this.points.length - 1, i + 1)];
    const unit = (a, b) => {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return d ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : null;
    };
    const a = unit(before, p) || unit(p, after) || [1, 0], b = unit(p, after) || a;
    const nx = -a[1] - b[1], ny = a[0] + b[0], length = Math.hypot(nx, ny);
    const r = this.radius(i), miter = Math.min(1.5, 2 / Math.max(1e-6, length));
    const ox = length > 1e-6 ? nx / length * r * miter : -a[1] * r;
    const oy = length > 1e-6 ? ny / length * r * miter : a[0] * r;
    return [[p[0] + ox, p[1] + oy], [p[0] - ox, p[1] - oy]];
  }
  patch(i) {
    const edge = this.edge(i), previous = i ? this.edge(i - 1) : edge,
      next = i + 1 < this.points.length ? this.edge(i + 1) : edge;
    return [mix(previous[0], edge[0]), edge[0], mix(edge[0], next[0]),
      mix(previous[1], edge[1]), edge[1], mix(edge[1], next[1])];
  }
  bounds(first, end) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = Math.max(0, first - 1); i < Math.min(this.points.length, end + 1); i++) {
      const [x, y, r] = this.points[i];
      box[0] = Math.min(box[0], x - 2 * r); box[1] = Math.min(box[1], y - 2 * r);
      box[2] = Math.max(box[2], x + 2 * r); box[3] = Math.max(box[3], y + 2 * r);
    }
    return box;
  }
  path(ctx, first = 0, end = this.points.length) {
    for (let i = first; i < end; i++) {
      const [a, b, c, d, e, f] = this.patch(i);
      ctx.moveTo(...d); ctx.quadraticCurveTo(...e, ...f);
      ctx.lineTo(...c); ctx.quadraticCurveTo(...b, ...a); ctx.closePath();
      if (i === 0 || i === this.points.length - 1) {
        const [x, y] = this.points[i], r = this.radius(i);
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); ctx.closePath();
      }
    }
  }
  mesh(first = 0, end = this.points.length, scale = 1) {
    const values = [], at = (a, b, c, t) => [
      (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0],
      (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1]];
    for (let i = first; i < end; i++) {
      const [a, b, c, d, e, f] = this.patch(i);
      const error = Math.max(Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]),
        Math.hypot(d[0] - 2 * e[0] + f[0], d[1] - 2 * e[1] + f[1]));
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(error * scale / 0.4))));
      let left = a, right = d;
      for (let j = 1; j <= steps; j++) {
        const l = at(a, b, c, j / steps), r = at(d, e, f, j / steps);
        values.push(...left, ...right, ...l, ...l, ...right, ...r); left = l; right = r;
      }
      if (i === 0 || i === this.points.length - 1) {
        const [x, y] = this.points[i], r = this.radius(i);
        const sides = Math.max(16, Math.min(128, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.1 / (r * scale))))));
        for (let j = 0; j < sides; j++) {
          const a = TAU * j / sides, b = TAU * (j + 1) / sides;
          values.push(x, y, x + r * Math.cos(a), y + r * Math.sin(a), x + r * Math.cos(b), y + r * Math.sin(b));
        }
      }
    }
    return new Float32Array(values);
  }
}

export function mesh(points, first = 0) {
  const shape = new InkShape(); shape.update(points); return shape.mesh(first);
}

export function hitStroke(points, x, y, tolerance = 1.5) {
  for (let i = 0; i < points.length; i += 3) {
    if (Math.hypot(x - points[i], y - points[i + 1]) <= tolerance + points[i + 2]) return true;
    if (i === 0) continue;
    const ax = points[i - 3], ay = points[i - 2];
    const dx = points[i] - ax, dy = points[i + 1] - ay, d = dx * dx + dy * dy;
    const u = d ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / d)) : 0;
    if (Math.hypot(x - ax - u * dx, y - ay - u * dy)
        <= tolerance + Math.max(points[i + 2], points[i - 1])) return true;
  }
  return false;
}
