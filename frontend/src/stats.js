export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// desvio padrao amostral (n-1), igual ao Flask
export function stdDev(a) {
  if (a.length < 2) return a.length ? 0 : null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export const minOf = (a) => (a.length ? Math.min(...a) : null);
export const maxOf = (a) => (a.length ? Math.max(...a) : null);

export function describe(values) {
  return { mean: mean(values), median: median(values), stdDev: stdDev(values), min: minOf(values), max: maxOf(values), count: values.length };
}

// tendencia (regressao linear) em unidade por hora; points = [{x: ms, y: valor}]
export function slopePerHour(points) {
  const n = points.length;
  if (n < 3) return null;
  const x0 = points[0].x;
  const xs = points.map((p) => (p.x - x0) / 3_600_000);
  const ys = points.map((p) => p.y);
  const mx = mean(xs);
  const my = mean(ys);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (den === 0) return null;
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den;
}

export function fmt(v, digits = 1, unit = '') {
  return v == null || Number.isNaN(v) ? '—' : `${v.toFixed(digits).replace('.', ',')}${unit ? ' ' + unit : ''}`;
}

export function outOfRange(value, limit) {
  if (value == null || !limit) return null;
  if (value < limit.min) return 'low';
  if (value > limit.max) return 'high';
  return null;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('pt-BR');
export const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
