import { getStroke } from 'perfect-freehand';

export function perfectOutline(raw, width) {
  const input = [];
  for (let i = 0; i < raw.length; i += 4) input.push([raw[i], raw[i + 1], raw[i + 3]]);
  return getStroke(input, { size: width, thinning: 0.65, simulatePressure: false,
    smoothing: 0.5, streamline: 0.2, last: true });
}

export function outlinePath(outline) {
  return outline.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)} ${y.toFixed(4)}`).join('') + 'Z';
}
