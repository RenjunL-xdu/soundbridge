// Acoustic channel simulator: room reverb, realistic noise spectrum, device
// frequency response and sample-clock drift.
//
// Noise is deliberately *not* flat. Real ambient noise is concentrated at low
// frequencies and falls away steeply toward ultrasound, which is the entire
// reason the silent band works at all. A white-noise model would make band
// selection look pointless, so it is modelled with a room-like spectrum.

import { fft, irfft, nextPow2 } from '../src/dsp/fft.js';

export const C_AIR = 343;

/**
 * Room impulse response at a given carrier frequency.
 * High frequencies lose ~0.8 dB/m to air absorption plus ~6 dB per surface
 * bounce, so long echoes are far weaker at 19 kHz than broadband intuition says.
 */
export function roomTaps(fs, directM, reflections, absorbDbPerM = 0.8) {
  const taps = [[0, 1]];
  for (const { pathM, bounces } of reflections) {
    const extra = pathM - directM;
    const dB = absorbDbPerM * extra + 20 * Math.log10(pathM / directM) + 6 * bounces;
    taps.push([Math.round((extra / C_AIR) * fs), Math.pow(10, -dB / 20)]);
  }
  return taps;
}

export const ROOMS = {
  desk:   { directM: 0.3, refl: [{ pathM: 0.9, bounces: 1 }, { pathM: 1.8, bounces: 1 }] },
  office: { directM: 1.5, refl: [{ pathM: 2.6, bounces: 1 }, { pathM: 4.2, bounces: 2 }, { pathM: 6.5, bounces: 2 }] },
  living: { directM: 3.0, refl: [{ pathM: 4.5, bounces: 1 }, { pathM: 7.0, bounces: 2 }, { pathM: 11.0, bounces: 3 }] },
  hall:   { directM: 5.0, refl: [{ pathM: 6.5, bounces: 1 }, { pathM: 9.0, bounces: 1 }, { pathM: 14.0, bounces: 2 }] },
};

export function roomFor(name, fs) {
  const r = ROOMS[name];
  if (!r) throw new Error(`unknown room ${name}`);
  return roomTaps(fs, r.directM, r.refl);
}

/** Relative ambient noise power spectral density, dB, at frequency f. */
export function noisePsdDb(f) {
  let db;
  if (f < 250) db = 0;
  else db = -18 * Math.log10(f / 250);
  if (f > 10000) db -= 20 * Math.log10(f / 10000) + 12; // rooms are very quiet up here
  return db;
}

/**
 * Typical phone/laptop speaker+mic response, dB, at frequency f.
 *
 * Deliberately smooth. An earlier version used hard dB steps at the band edges,
 * which made the simulated channel far harsher than reality: a discontinuous
 * frequency response has a very long impulse response, so it smeared energy past
 * the cyclic prefix and produced inter-symbol interference no real speaker
 * causes. Physical drivers and anti-aliasing filters roll off continuously.
 */
export function deviceResponseDb(f) {
  const hz = Math.max(f, 20);
  let db = 0;
  db -= 12 * Math.log2(1 + Math.pow(250 / hz, 2));        // small-driver bass rolloff
  db -= 6 * Math.log2(1 + Math.pow(hz / 16000, 4));       // speaker + mic treble rolloff
  db -= 6 * Math.log2(1 + Math.pow(hz / 20500, 8));       // anti-aliasing filter shoulder
  return db;
}

function filterSpectral(sig, fs, dbAt) {
  const n = nextPow2(sig.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(sig);
  fft(re, im);
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * fs) / n;
    const g = Math.pow(10, dbAt(f) / 20);
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < n / 2) { re[n - k] *= g; im[n - k] *= g; }
  }
  for (let k = n / 2 + 1; k < n; k++) { re[k] = 0; im[k] = 0; }
  const out = new Float64Array(n);
  irfft(re, im, out);
  return out.subarray(0, sig.length);
}

function gauss() {
  const u1 = Math.random() || 1e-12, u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Windowed-sinc resampling, used to model sample-clock mismatch.
 *
 * Linear interpolation is not good enough here and actively misleads. Its
 * response at 19 kHz against a 48 kHz rate is down about 5 dB with substantial
 * aliasing, which lands precisely on the near-ultrasonic band and made clock
 * drift look far more damaging than it is. A real ADC running slightly fast or
 * slow performs an ideal resampling, so the model has to approximate one.
 */
const SINC_HALF = 16;
function resample(src, ratio) {
  const n = Math.floor(src.length / ratio);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const frac = p - i0;
    let acc = 0;
    for (let j = -SINC_HALF + 1; j <= SINC_HALF; j++) {
      const idx = i0 + j;
      if (idx < 0 || idx >= src.length) continue;
      const x = j - frac;
      const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const t = (x + SINC_HALF) / (2 * SINC_HALF);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
      acc += src[idx] * s * w;
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Room-shaped ambient noise of the given broadband RMS.
 *
 * The shaped noise pool is generated and filtered once, then sampled at random
 * offsets. Regenerating and FFT-filtering fresh noise for every burst dominated
 * simulation time and bought nothing statistically.
 */
const noisePool = new Map();
function pool(fs) {
  if (noisePool.has(fs)) return noisePool.get(fs);
  const n = 1 << 20;                       // ~22 s at 48 kHz
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = gauss();
  const shaped = Float64Array.from(filterSpectral(w, fs, noisePsdDb));
  let e = 0;
  for (let i = 0; i < shaped.length; i++) e += shaped[i] * shaped[i];
  const cur = Math.sqrt(e / shaped.length) || 1e-12;
  for (let i = 0; i < shaped.length; i++) shaped[i] /= cur;   // unit RMS
  noisePool.set(fs, shaped);
  return shaped;
}

export function ambientNoise(n, fs, rmsLevel) {
  const p = pool(fs);
  const out = new Float64Array(n);
  const start = Math.floor(Math.random() * (p.length - 1));
  for (let i = 0; i < n; i++) out[i] = p[(start + i) % p.length] * rmsLevel;
  return out;
}

/**
 * Push a signal through the channel.
 * @param opts.room     key into ROOMS, or an explicit tap list
 * @param opts.noiseRms broadband RMS of ambient noise, relative to signal units
 * @param opts.ppm      sample-clock mismatch
 * @param opts.device   apply speaker/mic response (default true)
 * @param opts.padStart samples of silence prepended (so detection has to work)
 */
export function through(sig, fs, opts = {}) {
  const {
    room = 'office', noiseRms = 0.01, ppm = 0,
    device = true, padStart = 4000, padEnd = 4000,
  } = opts;

  let src = Float64Array.from(sig);

  if (device) src = Float64Array.from(filterSpectral(src, fs, deviceResponseDb));

  if (ppm) src = resample(src, 1 + ppm / 1e6);

  const taps = Array.isArray(room) ? room : roomFor(room, fs);
  const maxD = Math.max(...taps.map(t => t[0]));
  const body = new Float64Array(src.length + maxD);
  for (const [d, g] of taps)
    for (let i = 0; i < src.length; i++) body[i + d] += src[i] * g;

  const out = new Float64Array(padStart + body.length + padEnd);
  out.set(body, padStart);

  if (noiseRms > 0) {
    const noise = ambientNoise(out.length, fs, noiseRms);
    for (let i = 0; i < out.length; i++) out[i] += noise[i];
  }
  return { samples: out, offset: padStart };
}

/** In-band SNR actually delivered, for reporting. */
export function measureSnrDb(sig, noise, fs, fLo, fHi) {
  const band = (x) => {
    const n = nextPow2(x.length);
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(x); fft(re, im);
    let e = 0;
    const kLo = Math.floor((fLo * n) / fs), kHi = Math.ceil((fHi * n) / fs);
    for (let k = kLo; k <= kHi && k < n / 2; k++) e += re[k] * re[k] + im[k] * im[k];
    return e;
  };
  const s = band(sig), nz = band(noise);
  return 10 * Math.log10(s / Math.max(nz, 1e-30));
}
