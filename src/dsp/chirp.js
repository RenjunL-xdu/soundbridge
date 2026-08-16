// Chirp generation and matched-filter acquisition.
//
// The simulation behind docs/DESIGN.md showed this is the single most robust
// component in the system: a 40 ms linear sweep is acquired in 20/20 trials at
// -10 dB SNR with 0.19 ms timing accuracy. Sweeping spreads the energy so that
// correlation gain, not raw amplitude, does the work.

import { xcorrMag, nextPow2 } from './fft.js';
import { taperEdges } from './window.js';

/**
 * Linear frequency sweep f0 -> f1 over `dur` seconds.
 * Phase is the integral of instantaneous frequency: 2*pi*(f0*t + k*t^2/2).
 */
export function linearChirp(f0, f1, dur, fs) {
  const n = Math.round(dur * fs);
  const out = new Float64Array(n);
  const k = (f1 - f0) / dur;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    out[i] = Math.cos(2 * Math.PI * (f0 * t + (k * t * t) / 2));
  }
  taperEdges(out, Math.round(0.004 * fs)); // 4 ms edges: no click, minimal spectral splatter
  return out;
}

/** Down-sweep, used as the second half of a sync pair. */
export function inverseChirp(f0, f1, dur, fs) {
  return linearChirp(f1, f0, dur, fs);
}

/**
 * Locate `ref` inside `sig` by matched filtering.
 * Returns { index, peak, ratio } where ratio is peak-to-sidelobe — the
 * confidence measure the receiver uses to decide whether a frame is really there.
 */
export function findChirp(sig, ref, minRatio = 4) {
  const n = nextPow2(sig.length + ref.length);
  const mag = xcorrMag(sig, ref, n);

  const limit = Math.max(1, sig.length - Math.floor(ref.length / 2));
  let peak = -1, index = -1;
  for (let i = 0; i < limit; i++) {
    if (mag[i] > peak) { peak = mag[i]; index = i; }
  }

  // mean of everything outside a guard around the peak = sidelobe floor
  const guard = Math.max(8, Math.round(ref.length / 8));
  let acc = 0, cnt = 0;
  for (let i = 0; i < limit; i++) {
    if (Math.abs(i - index) <= guard) continue;
    acc += mag[i]; cnt++;
  }
  const floor = cnt > 0 ? acc / cnt : 1e-12;
  const ratio = peak / (floor || 1e-12);

  return { index, peak, ratio, ok: ratio >= minRatio };
}

/**
 * Every preamble in a window, in time order.
 *
 * `findChirp` returns only the strongest correlation peak, which is wrong for a
 * capture window holding several bursts: a later, louder burst wins and the
 * earlier ones are skipped entirely. A receiver draining one listen window has
 * to process bursts in the order they arrived, so peaks are collected against a
 * robust noise floor and returned sorted by position.
 */
export function findChirps(sig, ref, { minRatio = 5, maxPeaks = 128, minSep = null } = {}) {
  const n = nextPow2(sig.length + ref.length);
  const mag = xcorrMag(sig, ref, n);
  const limit = Math.max(1, sig.length - Math.floor(ref.length / 2));
  const sep = minSep ?? Math.floor(ref.length * 0.75);

  // median absolute level is a robust floor: unlike a mean it is not dragged
  // upward by the very peaks we are trying to find
  const sample = [];
  for (let i = 0; i < limit; i += Math.max(1, Math.floor(limit / 2048))) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const floor = sample[sample.length >> 1] || 1e-12;
  const threshold = floor * minRatio;

  const peaks = [];
  let i = 0;
  while (i < limit) {
    if (mag[i] < threshold) { i++; continue; }
    // walk to the top of this lobe
    let best = i, bestV = mag[i];
    const end = Math.min(limit, i + sep);
    for (let j = i; j < end; j++) if (mag[j] > bestV) { bestV = mag[j]; best = j; }
    peaks.push({ index: best, peak: bestV, ratio: bestV / floor });
    if (peaks.length >= maxPeaks) break;
    i = best + sep;
  }
  return peaks;
}

/**
 * Sub-sample peak refinement by parabolic interpolation on the correlation
 * magnitude. Worth doing: residual timing error becomes a phase ramp across
 * subcarriers, and at 19 kHz even half a sample is several degrees.
 */
export function refinePeak(mag, i) {
  if (i <= 0 || i >= mag.length - 1) return i;
  const a = mag[i - 1], b = mag[i], c = mag[i + 1];
  const d = a - 2 * b + c;
  if (Math.abs(d) < 1e-12) return i;
  return i + (0.5 * (a - c)) / d;
}

/**
 * Estimate sample-clock ratio between transmitter and receiver from the
 * measured spacing of two preambles a known number of samples apart.
 * Clock drift was the dominant impairment in simulation, so this feeds the
 * OFDM demodulator's per-symbol timing correction.
 */
export function estimateClockRatio(expectedSpacing, measuredSpacing) {
  if (!expectedSpacing || !measuredSpacing) return 1;
  const r = measuredSpacing / expectedSpacing;
  // reject nonsense; consumer crystals are within a few hundred ppm
  if (!isFinite(r) || Math.abs(r - 1) > 0.002) return 1;
  return r;
}
