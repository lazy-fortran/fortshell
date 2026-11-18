const TAU = 2 * Math.PI;
export const INK = '#000';
// Pen palette; strokes store an index. Matches FS_COLOURS in the document model.
export const INK_COLOURS = ['#000000', '#1a56c4', '#d32f2f', '#2e7d32', '#ef6c00', '#7b1fa2'];
export const inkColour = index => INK_COLOURS[index] ?? INK;
export const inkRGB = index => { const c = inkColour(index).replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255); };
export const INK_CHUNK = 8;
export const LEGACY_GEOMETRY = 1;
export const GEOMETRY_REVISION = 2;
const LOOKAHEAD = 2;
const direction = (a, b) => {
  const x = b[0] - a[0], y = b[1] - a[1], d = Math.hypot(x, y);
  return d > 1e-7 ? [x / d, y / d] : null;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function transverseFit(points, axis, origin) {
  const x = [], y = [];
  for (const p of points) {
    const dx = p[0] - origin[0], dy = p[1] - origin[1];
    x.push(dx * axis[0] + dy * axis[1]);
    y.push(dy * axis[0] - dx * axis[1]);
  }
  // Clustered events and reversals make the local interpolant ill-conditioned.
  const spacing = [x[1] - x[0], -x[1], x[2], x[3] - x[2]];
  if (Math.min(...spacing) < Math.max(...spacing) / 4) return null;

  // Keep constant curvature exact when the two outer samples agree on it.
  // The sagitta formula avoids subtracting two large radii near a straight line.
  const mid = (x[1] + x[2]) / 2, half = (x[2] - x[1]) / 2;
  const chordY = (y[1] + y[2]) / 2;
  const sagitta = i => {
    const rise = y[i] - chordY;
    if (Math.abs(rise) < 1e-9) return 0;
    const run = x[i] - mid;
    const center = (run * run - half * half + rise * rise) / (2 * rise);
    return x[1] * x[2] / (center + Math.sign(center) * Math.hypot(center, Math.sqrt(-x[1] * x[2])));
  };
  const left = sagitta(0), right = sagitta(3);
  if (Math.abs(left - right) < Math.max(0.003, 0.1 * Math.abs(left + right)))
    return chordY + (left + right) / 2;
  let offset = 0;
  for (let i = 0; i < x.length; i++) {
    let weight = 1;
    for (let j = 0; j < x.length; j++) if (j !== i) weight *= -x[j] / (x[i] - x[j]);
    offset += weight * y[i];
  }
  return offset;
}

function station(input, i) {
  const p = [input[i], input[i + 1], input[i + 2]];
  if (i === 0 || i + 3 === input.length) return p;
  const a = [input[i - 3], input[i - 2]], b = [input[i + 3], input[i + 4]];
  const dx = b[0] - a[0], dy = b[1] - a[1], span = Math.hypot(dx, dy);
  const incoming = direction(a, p), outgoing = direction(p, b);
  if (!incoming || !outgoing || dot(incoming, outgoing) < 0.7) return p;
  const axis = [dx / span, dy / span];
  let fit = null;
  if (i >= 6 && i + 6 < input.length) {
    const before = [input[i - 6], input[i - 5]], after = [input[i + 6], input[i + 7]];
    const entry = direction(before, a), exit = direction(b, after);
    if (entry && exit && dot(entry, incoming) >= 0.7 && dot(outgoing, exit) >= 0.7)
      fit = transverseFit([before, a, b, after], axis, p);
  }
  // A cubic fit retains low-frequency curvature while damping sample-to-sample bends.
  // The short fallback works next to endpoints or when a sample cluster cannot be fitted.
  const chordOffset = (p[0] - a[0]) * axis[1] - (p[1] - a[1]) * axis[0];
  const offset = fit === null ? (span <= 1.5 ? 0.45 * chordOffset : 0) : 0.375 * fit;
  const limit = Math.min(0.35, 0.12 * span);
  const correction = Math.max(-limit, Math.min(limit, offset));
  p[0] -= correction * axis[1];
  p[1] += correction * axis[0];
  return p;
}

function handle(before, at, after, along, length, revision) {
  const a = before && direction(before, at), b = after && direction(at, after);
  if (!a || !b) return [along[0] * length, along[1] * length];
  // A zero tangent at a sharp turn keeps the interpolant inside the corner.
  if (dot(a, b) < 0.5) return [0, 0];
  if (revision === 2) {
    // The local circumcircle gives the tangent even when sample spacing is uneven.
    const left = Math.hypot(at[0] - before[0], at[1] - before[1]);
    const chord = Math.hypot(after[0] - before[0], after[1] - before[1]);
    const curvature = (a[0] * b[1] - a[1] * b[0]) / chord;
    const sin = left * curvature, cos = Math.sqrt(Math.max(0, 1 - sin * sin));
    const arc = length * curvature;
    const scale = 2 * length / (1 + Math.sqrt(Math.max(0, 1 - arc * arc)));
    return [(a[0] * cos - a[1] * sin) * scale, (a[0] * sin + a[1] * cos) * scale];
  }
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
  constructor(chunkSize = INK_CHUNK, revision = GEOMETRY_REVISION) {
    this.chunkSize = chunkSize; this.points = []; this.distance = []; this.ends = []; this.chunks = [];
    this.revision = revision;
  }
  update(input, first = 0, width = input[2] * 2, predicted = []) {
    const oldLength = this.distance.at(-1) || 0;
    // This segment also uses the following fitted station for its end tangent.
    first = Math.max(0, first - LOOKAHEAD - 1);
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
      let steps = Math.max(1, Math.ceil(d / Math.max(0.05, width / 2)));
      let startHandle, endHandle;
      if ((steps > 1 || this.revision === 2 && d > 0.075) && (before || after)) {
        const point = [x, y], along = [(x - previous[0]) / d, (y - previous[1]) / d];
        if (before && before[0] === previous[0] && before[1] === previous[1]) before = null;
        if (after && after[0] === x && after[1] === y) after = null;
        startHandle = handle(before, previous, point, along, d, this.revision);
        endHandle = handle(previous, point, after, along, d, this.revision);
        const reflect = h => {
          const projection = 2 * dot(h, along);
          return [projection * along[0] - h[0], projection * along[1] - h[1]];
        };
        if (!before && dot(endHandle, along) > 0) startHandle = reflect(endHandle);
        if (!after && dot(startHandle, along) > 0) endHandle = reflect(startHandle);
        if (this.revision === 2) {
          const across = h => Math.abs(h[0] * along[1] - h[1] * along[0]);
          const deviation = Math.max(across(startHandle), across(endHandle)) / 3;
          steps = Math.max(steps, Math.ceil(Math.sqrt(deviation / 0.025)));
        }
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
    const taper = 0.75 * this.width;
    const u = Math.min(1, d / taper), strength = Math.min(1, total / (2 * taper));
    // A shallow taper rounds the tips without pinching short marks.
    return this.points[i][2] * (1 - 0.20 * strength * (1 - u * u * (3 - 2 * u)));
  }
  edge(i) {
    const p = this.points[i], before = this.points[Math.max(0, i - 1)],
      after = this.points[Math.min(this.points.length - 1, i + 1)];
    const outgoing = direction(p, after), a = direction(before, p) || outgoing || [1, 0], b = outgoing || a;
    const r = this.radius(i), alignment = dot(a, b);
    const cross = a[0] * b[1] - a[1] * b[0];
    const chordX = after[0] - before[0], chordY = after[1] - before[1];
    const bend = 2 * r * cross;
    if (alignment < 0.5 || bend * bend > chordX * chordX + chordY * chordY) {
      // The inner offset folds when the bend radius is smaller than the brush.
      return { incoming: offset(p, -a[1] * r, a[0] * r), outgoing: offset(p, -b[1] * r, b[0] * r),
        incomingTangent: [a, a], outgoingTangent: [b, b], join: [p[0], p[1], r] };
    }
    const edge = offset(p, (-a[1] - b[1]) * r / (1 + alignment), (a[0] + b[0]) * r / (1 + alignment));
    const endTangent = i === 0 || i === this.points.length - 1 ? [a, a] : null;
    return { incoming: edge, outgoing: edge, incomingTangent: endTangent, outgoingTangent: endTangent };
  }
  outline(first = 0, end = this.points.length, minimumDotRadius = 0) {
    const last = this.points.length - 1, curves = [], caps = [];
    if (first === 0 && last >= 0) caps.push([...this.points[0].slice(0, 2),
      Math.max(this.radius(0), last === 0 ? minimumDotRadius : 0)]);
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
  path(ctx, { curves, caps } = this.outline(), join = false) {
    for (let first = 0, end; first < curves.length; first = end) {
      end = first + 1;
      // Common cross-sections cancel exactly. Keep the original Bézier edges.
      while (join && end < curves.length && curves[end - 1][0][3] === curves[end][0][0]
          && curves[end - 1][1][3] === curves[end][1][0]) end++;
      ctx.moveTo(...curves[first][1][0]);
      for (let i = first; i < end; i++) ctx.bezierCurveTo(...curves[i][1][1], ...curves[i][1][2], ...curves[i][1][3]);
      ctx.lineTo(...curves[end - 1][0][3]);
      for (let i = end - 1; i >= first; i--) ctx.bezierCurveTo(...curves[i][0][2], ...curves[i][0][1], ...curves[i][0][0]);
      ctx.closePath();
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
