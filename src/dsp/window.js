// Window functions and raised-cosine edge tapering.

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function hamming(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Raised-cosine ramp applied to the first and last `edge` samples in place.
 * Used on every burst we emit: an abrupt onset produces a broadband click that
 * is both audible and spectrally messy, which matters a lot when part of the
 * point is staying inaudible.
 */
export function taperEdges(buf, edge) {
  const n = buf.length;
  const e = Math.min(edge, n >> 1);
  for (let i = 0; i < e; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / e);
    buf[i] *= w;
    buf[n - 1 - i] *= w;
  }
  return buf;
}

/** Peak-normalise to `peak` (default 0.9) to leave headroom before clipping. */
export function normalizePeak(buf, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  if (m > 0) { const g = peak / m; for (let i = 0; i < buf.length; i++) buf[i] *= g; }
  return buf;
}

export function rms(buf) {
  let e = 0;
  for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
  return Math.sqrt(e / buf.length);
}
