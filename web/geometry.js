const TAU = 2 * Math.PI;
export const INK = '#17212b';

// Opaque capsule unions give dots and stationary input the same opacity.
export function mesh(points, first = 0) {
  const n = points.length / 3, values = [];
  for (let i = first; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], r = points[3 * i + 2];
    if (i > 0) {
      const a = 3 * (i - 1), dx = x - points[a], dy = y - points[a + 1];
      const length = Math.hypot(dx, dy);
      if (length > 1e-8) {
        const nx = -dy / length, ny = dx / length, pr = points[a + 2];
        const ax = points[a] + nx * pr, ay = points[a + 1] + ny * pr;
        const bx = points[a] - nx * pr, by = points[a + 1] - ny * pr;
        const cx = x + nx * r, cy = y + ny * r, ex = x - nx * r, ey = y - ny * r;
        values.push(ax, ay, bx, by, cx, cy, cx, cy, bx, by, ex, ey);
      }
    }
    // Sixteen sides keep the cap error below 0.02 r. Export uses exact arcs.
    for (let j = 0; j < 16; j++) {
      const a = TAU * j / 16, b = TAU * (j + 1) / 16;
      values.push(x, y, x + r * Math.cos(a), y + r * Math.sin(a),
        x + r * Math.cos(b), y + r * Math.sin(b));
    }
  }
  return new Float32Array(values);
}

export function capsulePath(ctx, points, first = 0) {
  const n = points.length / 3;
  for (let i = first; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], r = points[3 * i + 2];
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
    ctx.closePath();
    if (!i) continue;
    const a = 3 * (i - 1), dx = x - points[a], dy = y - points[a + 1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const nx = -dy / length, ny = dx / length, pr = points[a + 2];
    ctx.moveTo(points[a] + nx * pr, points[a + 1] + ny * pr);
    ctx.lineTo(points[a] - nx * pr, points[a + 1] - ny * pr);
    ctx.lineTo(x - nx * r, y - ny * r);
    ctx.lineTo(x + nx * r, y + ny * r);
    ctx.closePath();
  }
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
