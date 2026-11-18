const TAU = 2 * Math.PI;
export const INK = '#17212b';
export const INK_CHUNK = 8;
const direction = (a, b) => {
  const x = b[0] - a[0], y = b[1] - a[1], d = Math.hypot(x, y);
  return d > 1e-7 ? [x / d, y / d] : null;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function station(input, i) {
  const p = [input[i], input[i + 1], input[i + 2]];
  if (i === 0 || i + 3 === input.length) return p;
  const a = [input[i - 3], input[i - 2]], b = [input[i + 3], input[i + 4]];
  const dx = b[0] - a[0], dy = b[1] - a[1], span = Math.hypot(dx, dy);
  if (span > 1.5) return p;
  const incoming = direction(a, p), outgoing = direction(p, b);
  if (!incoming || !outgoing || dot(incoming, outgoing) < 0.5) return p;
  // Limit the correction in page units so a small letter keeps its shape.
  const offset = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / span;
  const correction = Math.max(-0.12, Math.min(0.12, offset * 0.45));
  p[0] -= correction * dy / span;
  p[1] += correction * dx / span;
  return p;
}

function handle(before, at, after, along, length) {
  const a = before && direction(before, at), b = after && direction(at, after);
  if (!a || !b) return [along[0] * length, along[1] * length];
  // A zero tangent at a sharp turn keeps the interpolant inside the corner.
  if (dot(a, b) < 0.5) return [0, 0];
  return [(a[0] + b[0]) * length / 2, (a[1] + b[1]) * length / 2];
}

function edgeTangent(before, at, after) {
  const a = direction(before, at), b = direction(at, after);
  if (!a || !b || dot(a, b) < 0) return [0, 0];
  const x = a[0] + b[0], y = a[1] + b[1], length = Math.hypot(x, y);
  return [x / length, y / length];
}

function edgeCurve(a, b, start, end) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) / 3;
  return [a, [a[0] + length * start[0], a[1] + length * start[1]],
    [b[0] - length * end[0], b[1] - length * end[1]], b];
}

function offset(p, x, y) {
  return [[p[0] + x, p[1] + y], [p[0] - x, p[1] - y]];
}

function cubicAt([a, b, c, d], t) {
  const s = 1 - t, ab = 3 * s * s * t, bc = 3 * s * t * t;
  return [s ** 3 * a[0] + ab * b[0] + bc * c[0] + t ** 3 * d[0],
    s ** 3 * a[1] + ab * b[1] + bc * c[1] + t ** 3 * d[1]];
}

function curvatureBound([a, b, c, d]) {
  return Math.max(Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]),
    Math.hypot(b[0] - 2 * c[0] + d[0], b[1] - 2 * c[1] + d[1]));
}

// Distance, rather than time spent pressing, controls brush width transitions.
export class InkShape {
  constructor(chunkSize = INK_CHUNK) {
    this.chunkSize = chunkSize; this.points = []; this.distance = []; this.ends = []; this.chunks = [];
  }
  update(input, first = 0, width = input[2] * 2, predicted = []) {
    const oldLength = this.distance.at(-1) || 0;
    // A new measured sample can change the two preceding segments.
    first = Math.max(0, first - 2);
    if (first < this.ends.length) {
      this.points.length = first ? this.ends[first - 1] : 0;
      this.distance.length = this.points.length;
      this.ends.length = first;
    }
    this.width = width;
    const length = this.distance.at(-1) || 0;
    let changed = this.points.length - 1;
    while (changed > 0 && this.distance[changed] > length - width) changed--;
    changed = Math.max(0, changed - 2);
    if (Math.min(oldLength, length) < width * 2) changed = 0;
    const append = (x, y, radius, before, after) => {
      const previous = this.points.at(-1);
      const d = previous ? Math.hypot(x - previous[0], y - previous[1]) : 0;
      // A stationary pen leaves one deposit, including its fractional edge coverage.
      if (previous && d < 1e-7) { this.ends.push(this.points.length); return; }
      const r = previous ? Math.max(previous[2] - d * 0.25,
        Math.min(previous[2] + d * 0.25, radius)) : radius;
      // Sparse events and simplified PDFs still need stations inside the tapers.
      const steps = Math.max(1, Math.ceil(d / Math.max(0.05, width / 2)));
      let startHandle, endHandle;
      if (steps > 1 && (before || after)) {
        const point = [x, y], along = [(x - previous[0]) / d, (y - previous[1]) / d];
        if (before && before[0] === previous[0] && before[1] === previous[1]) before = null;
        if (after && after[0] === x && after[1] === y) after = null;
        startHandle = handle(before, previous, point, along, d);
        endHandle = handle(previous, point, after, along, d);
        const reflect = h => {
          const projection = 2 * dot(h, along);
          return [projection * along[0] - h[0], projection * along[1] - h[1]];
        };
        if (!before && dot(endHandle, along) > 0) startHandle = reflect(endHandle);
        if (!after && dot(startHandle, along) > 0) endHandle = reflect(startHandle);
      }
      for (let j = 1; j <= steps; j++) {
        const u = j / steps;
        let point = [x, y, r];
        if (j < steps) {
          const v = 1 - u;
          point = [v * previous[0] + u * x, v * previous[1] + u * y, v * previous[2] + u * r];
          if (startHandle) for (let k = 0; k < 2; k++) {
            const secant = (k === 0 ? x : y) - previous[k];
            point[k] += u * v * (v * (startHandle[k] - secant) - u * (endHandle[k] - secant));
          }
        }
        const last = this.points.at(-1);
        this.points.push(point);
        const advance = startHandle ? Math.hypot(point[0] - last[0], point[1] - last[1]) : d / steps;
        this.distance.push((this.distance.at(-1) || 0) + advance);
      }
      this.ends.push(this.points.length);
    };
    let before = first >= 2 ? station(input, (first - 2) * 3) : null;
    let previous = first ? station(input, (first - 1) * 3) : null;
    let point = first * 3 < input.length ? station(input, first * 3) : null;
    for (let i = first * 3; i < input.length; i += 3) {
      const after = i + 3 < input.length ? station(input, i + 3) : null;
      append(...point, before, after);
      before = previous;
      previous = point;
      point = after;
    }
    for (const p of predicted) append(...p);
    this.predicted = predicted.length;
    return Math.floor(changed / this.chunkSize);
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
    const outgoing = direction(p, after), a = direction(before, p) || outgoing || [1, 0], b = outgoing || a;
    const r = this.radius(i), alignment = dot(a, b);
    if (alignment < 0.5) {
      // Each leg meets the same round join without crossing the opposite edge.
      return { incoming: offset(p, -a[1] * r, a[0] * r), outgoing: offset(p, -b[1] * r, b[0] * r),
        incomingTangent: [a, a], outgoingTangent: [b, b], join: [p[0], p[1], r] };
    }
    const edge = offset(p, (-a[1] - b[1]) * r / (1 + alignment), (a[0] + b[0]) * r / (1 + alignment));
    const endTangent = i === 0 || i === this.points.length - 1 ? [a, a] : null;
    return { incoming: edge, outgoing: edge, incomingTangent: endTangent, outgoingTangent: endTangent };
  }
  outline(first = 0, end = this.points.length) {
    const last = this.points.length - 1, curves = [], caps = [];
    if (first === 0 && last >= 0) caps.push([...this.points[0].slice(0, 2), this.radius(0)]);
    if (last > 0 && end > last) caps.push([...this.points[last].slice(0, 2), this.radius(last)]);
    const stop = Math.min(end, last);
    if (first >= stop) return { curves, caps };

    const start = Math.max(0, first - 1), edges = [];
    for (let i = start; i <= Math.min(last, stop + 1); i++) edges.push(this.edge(i));
    const tangents = (index, edge) => {
      const before = edges[index - 1].outgoing, after = edges[index + 1].incoming;
      return [edgeTangent(before[0], edge[0], after[0]), edgeTangent(before[1], edge[1], after[1])];
    };
    const initial = edges[first - start];
    let a = initial.outgoing, ta = initial.outgoingTangent || tangents(first - start, a);
    for (let i = first; i < stop; i++) {
      const join = edges[i - start].join;
      if (join) caps.push(join);
      const next = edges[i + 1 - start], b = next.incoming;
      const tb = next.incomingTangent || tangents(i + 1 - start, b);
      curves.push([edgeCurve(a[0], b[0], ta[0], tb[0]), edgeCurve(a[1], b[1], ta[1], tb[1])]);
      a = next.outgoing;
      ta = next.outgoingTangent || tb;
    }
    return { curves, caps };
  }
  bounds({ curves, caps }) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const include = (x, y, r = 0) => {
      box[0] = Math.min(box[0], x - r); box[1] = Math.min(box[1], y - r);
      box[2] = Math.max(box[2], x + r); box[3] = Math.max(box[3], y + r);
    };
    for (const pair of curves) for (const curve of pair) for (const p of curve) include(...p);
    for (const cap of caps) include(...cap);
    return box;
  }
  path(ctx, { curves, caps } = this.outline()) {
    for (const [[a, b, c, d], [e, f, g, h]] of curves) {
      ctx.moveTo(...e); ctx.bezierCurveTo(...f, ...g, ...h);
      ctx.lineTo(...d); ctx.bezierCurveTo(...c, ...b, ...a); ctx.closePath();
    }
    for (const [x, y, r] of caps) {
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); ctx.closePath();
    }
  }
  mesh(first = 0, end = this.points.length, scale = 1) {
    return this.meshOutline(this.outline(first, end), scale);
  }
  meshOutline({ curves, caps }, scale) {
    const values = [];
    for (const [leftCurve, rightCurve] of curves) {
      const error = Math.max(curvatureBound(leftCurve), curvatureBound(rightCurve));
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(error * scale / 0.1))));
      let left = leftCurve[0], right = rightCurve[0];
      for (let j = 1; j <= steps; j++) {
        const l = cubicAt(leftCurve, j / steps), r = cubicAt(rightCurve, j / steps);
        values.push(...left, ...right, ...l, ...l, ...right, ...r); left = l; right = r;
      }
    }
    for (const [x, y, r] of caps) {
      const sides = Math.max(16, Math.min(128, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.1 / (r * scale))))));
      for (let j = 0; j < sides; j++) {
        const a = TAU * j / sides, b = TAU * (j + 1) / sides;
        values.push(x, y, x + r * Math.cos(a), y + r * Math.sin(a), x + r * Math.cos(b), y + r * Math.sin(b));
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
