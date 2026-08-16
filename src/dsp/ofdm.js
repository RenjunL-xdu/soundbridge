// OFDM modem with adaptive per-subcarrier bit loading.
//
// Design notes that came out of the feasibility simulation:
//
//  * Sample-clock drift between two independent crystals, not noise, is the
//    dominant impairment. It appears as a phase ramp across subcarriers. We
//    estimate its slope from scattered pilots every symbol and rotate it out,
//    which is what makes constellations above QPSK usable at all.
//  * The cyclic prefix must clear the first strong room reflection (3-5 ms).
//    Band plans below never go under 5.3 ms at 48 kHz.
//  * Two identical training symbols give us H[k] and the per-carrier noise
//    floor in one shot, so channel estimation and channel sounding are the
//    same operation.

import { fft, irfft } from './fft.js';
import { constellation, mapSymbol, demapSymbol, snapOrder } from './qam.js';
import { reduceSymbolPapr } from './psycho.js';

/** Deterministic +-1 sequence; both ends derive pilots and training from this. */
export function prbs(n, seed = 0x9e3779b9) {
  let s = seed >>> 0;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = (s & 1) ? 1 : -1;
  }
  return out;
}

/**
 * Which FFT bins carry what.
 * @returns plan with carriers[], pilots[], data[], and a per-carrier gain mask.
 */
export function makeCarrierPlan({ fs, N, cp, fLo, fHi, pilotEvery = 8 }) {
  const binHz = fs / N;
  const kLo = Math.max(1, Math.ceil(fLo / binHz));
  const kHi = Math.min(N / 2 - 1, Math.floor(fHi / binHz));
  if (kHi <= kLo) throw new Error('makeCarrierPlan: empty band');

  const carriers = [];
  for (let k = kLo; k <= kHi; k++) carriers.push(k);

  const pilots = [], data = [];
  carriers.forEach((k, i) => (i % pilotEvery === 0 ? pilots : data).push(k));

  const ref = prbs(N);           // training + pilot values, indexed by bin
  const gain = new Float64Array(N).fill(1);

  return {
    fs, N, cp, binHz, kLo, kHi, carriers, pilots, data, ref, gain,
    symLen: N + cp,
    symbolRate: fs / (N + cp),
    cpMs: (cp / fs) * 1000,
  };
}

/** Apply a per-carrier transmit gain mask (used for psychoacoustic shaping). */
export function applyGainMask(plan, maskFn) {
  for (const k of plan.carriers) plan.gain[k] = maskFn(k * plan.binHz);
  return plan;
}

/** Total data bits carried by one OFDM symbol under a bit-loading table. */
export function bitsPerSymbol(plan, bitLoad) {
  let t = 0;
  for (const k of plan.data) t += bitLoad[k] | 0;
  return t;
}

// ---------------------------------------------------------------- modulator

/**
 * Build one OFDM symbol (CP + body) from complex values keyed by bin.
 * PAPR reduction runs on the body before the cyclic prefix is taken, so the
 * prefix stays an exact copy of the tail.
 */
export function modulateSymbol(plan, valuesRe, valuesIm, papr = true) {
  const { N, cp, ref, gain } = plan;
  const re = new Float64Array(N), im = new Float64Array(N);

  for (const k of plan.pilots) { re[k] = ref[k] * gain[k]; im[k] = 0; }
  for (const k of plan.data) {
    re[k] = (valuesRe[k] || 0) * gain[k];
    im[k] = (valuesIm[k] || 0) * gain[k];
  }

  let body = new Float64Array(N);
  irfft(re, im, body);
  if (papr) body = reduceSymbolPapr(body, plan);

  const out = new Float64Array(N + cp);
  out.set(body.subarray(N - cp), 0);   // cyclic prefix
  out.set(body, cp);
  return out;
}

/**
 * Two identical known symbols: channel estimate + noise floor in one shot.
 * Left un-clipped so the channel estimate is not biased by clipping distortion.
 */
export function trainingSymbol(plan) {
  const { N, ref, gain } = plan;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (const k of plan.carriers) { re[k] = ref[k] * gain[k]; im[k] = 0; }
  const body = new Float64Array(N);
  irfft(re, im, body);
  const out = new Float64Array(N + plan.cp);
  out.set(body.subarray(N - plan.cp), 0);
  out.set(body, plan.cp);
  return out;
}

/** RMS of one OFDM symbol, used to level-match the preamble to the payload. */
export function symbolRms(plan) {
  const s = trainingSymbol(plan);
  let e = 0;
  for (let i = 0; i < s.length; i++) e += s[i] * s[i];
  return Math.sqrt(e / s.length);
}

/** Encode a bit source into OFDM symbols under a bit-loading table. */
export function modulateBits(plan, bitLoad, reader, maxSymbols = Infinity) {
  const out = [];
  const vr = new Float64Array(plan.N), vi = new Float64Array(plan.N);
  let produced = 0;
  while (produced < maxSymbols && !reader.exhausted()) {
    vr.fill(0); vi.fill(0);
    for (const k of plan.data) {
      const b = bitLoad[k] | 0;
      if (b === 0) continue;
      const v = reader.read(b);
      const [pr, pi] = mapSymbol(b, v);
      vr[k] = pr; vi[k] = pi;
    }
    out.push(modulateSymbol(plan, vr, vi));
    produced++;
  }
  return out;
}

// -------------------------------------------------------------- demodulator

/**
 * Channel estimate from two received training symbols.
 * Returns { hr, hi, noise, snrDb } indexed by bin.
 */
export function estimateChannel(plan, sym1, sym2) {
  const { N, cp, ref } = plan;
  const r1 = new Float64Array(N), i1 = new Float64Array(N);
  const r2 = new Float64Array(N), i2 = new Float64Array(N);
  for (let i = 0; i < N; i++) { r1[i] = sym1[cp + i] || 0; r2[i] = sym2[cp + i] || 0; }
  fft(r1, i1); fft(r2, i2);

  const hr = new Float64Array(N), hi = new Float64Array(N);
  const raw = new Float64Array(N);
  const noise = new Float64Array(N), snrDb = new Float64Array(N).fill(-99);

  for (const k of plan.carriers) {
    const t = ref[k];                       // +-1, so dividing by it is multiplying
    hr[k] = ((r1[k] + r2[k]) / 2) * t;
    hi[k] = ((i1[k] + i2[k]) / 2) * t;
    // difference cancels the signal and leaves 2x noise power
    const dr = r1[k] - r2[k], di = i1[k] - i2[k];
    raw[k] = (dr * dr + di * di) / 2;
  }

  // Smooth the noise estimate along frequency before using it for anything.
  //
  // Per carrier this is a chi-squared estimate with 2 degrees of freedom, so
  // individual bins scatter by an order of magnitude. Feeding that straight to
  // the bit loader made it allocate 256-QAM to carriers that happened to draw a
  // low noise sample, and those carriers then failed every single burst.
  // Ambient noise varies slowly with frequency, so averaging a window of
  // neighbours is both safe and a huge variance reduction.
  const W = 8;
  const cs = plan.carriers;
  for (let i = 0; i < cs.length; i++) {
    let acc = 0, n = 0;
    for (let d = -W; d <= W; d++) {
      const j = cs[i + d];
      if (j !== undefined) { acc += raw[j]; n++; }
    }
    noise[cs[i]] = n ? acc / n : raw[cs[i]];
  }

  for (const k of plan.carriers) {
    const np = noise[k];
    // H itself carries averaged noise of variance np/2; removing that bias
    // stops SNR being overstated on weak carriers.
    const sp = Math.max(0, hr[k] * hr[k] + hi[k] * hi[k] - np / 2);
    snrDb[k] = np > 0 ? 10 * Math.log10(Math.max(sp, 1e-30) / np) : 60;
    if (snrDb[k] > 45) snrDb[k] = 45;   // beyond this the estimate is not trustworthy
  }
  return { hr, hi, noise, snrDb };
}

/**
 * Demodulate one symbol.
 *
 * `state` carries the running timing/phase estimate between symbols so drift is
 * tracked continuously rather than re-acquired.
 */
export function demodulateSymbol(plan, samples, offset, chan, bitLoad, state, writer) {
  const { N, cp, ref } = plan;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = samples[offset + cp + i] || 0;
  fft(re, im);

  // --- pilot-derived common phase error and timing slope -------------------
  // Residual timing offset tau shows up as phase(k) = -2*pi*k*tau/N. Fitting a
  // line through the pilot phase errors separates it from the constant term.
  let sxx = 0, sx = 0, sy = 0, sxy = 0, n = 0;
  const kMid = (plan.kLo + plan.kHi) / 2;
  let prevPh = 0, unwrapped = 0;
  const phases = [];

  for (const k of plan.pilots) {
    const er = chan.hr[k], ei = chan.hi[k];
    const den = er * er + ei * ei;
    if (den <= 0) continue;
    // received / (H * pilot)
    const t = ref[k];
    const nr = (re[k] * er + im[k] * ei) / den * t;
    const ni = (im[k] * er - re[k] * ei) / den * t;
    phases.push([k, Math.atan2(ni, nr)]);
  }
  // unwrap along frequency so the slope fit is not destroyed by 2*pi jumps
  for (let i = 0; i < phases.length; i++) {
    let ph = phases[i][1];
    if (i === 0) { unwrapped = ph; }
    else {
      let d = ph - prevPh;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      unwrapped += d;
    }
    prevPh = ph;
    const x = phases[i][0] - kMid;
    sx += x; sy += unwrapped; sxx += x * x; sxy += x * unwrapped; n++;
  }

  let cpe = 0, slope = 0;
  if (n >= 2) {
    const d = n * sxx - sx * sx;
    if (Math.abs(d) > 1e-9) {
      slope = (n * sxy - sx * sy) / d;
      cpe = (sy - slope * sx) / n;
    }
  }
  state.cpe = cpe;
  state.slope = slope;
  state.timingErr = (-slope * N) / (2 * Math.PI); // in samples

  // --- equalise and demap --------------------------------------------------
  let evmAcc = 0, evmN = 0;
  for (const k of plan.data) {
    const b = bitLoad[k] | 0;
    if (b === 0) continue;
    const er = chan.hr[k], ei = chan.hi[k];
    const den = er * er + ei * ei;
    if (den <= 0) { writer.write(b, 0); continue; }

    let xr = (re[k] * er + im[k] * ei) / den;
    let xi = (im[k] * er - re[k] * ei) / den;

    // undo common phase error + timing ramp
    const corr = -(cpe + slope * (k - kMid));
    const cr = Math.cos(corr), ci = Math.sin(corr);
    const yr = xr * cr - xi * ci;
    const yi = xr * ci + xi * cr;

    const v = demapSymbol(b, yr, yi);
    writer.write(b, v);

    const [ir, ii] = mapSymbol(b, v);
    const e = (yr - ir) * (yr - ir) + (yi - ii) * (yi - ii);
    evmAcc += e; evmN++;
  }
  state.evm = evmN ? Math.sqrt(evmAcc / evmN) : 1;
  return state;
}

// ------------------------------------------------------------- bit plumbing

export class BitWriter {
  constructor(capacityBits) {
    this.buf = new Uint8Array(Math.ceil(capacityBits / 8));
    this.pos = 0;
  }
  /** Append the low `n` bits of `v`, MSB first. */
  write(n, v) {
    for (let i = n - 1; i >= 0; i--) {
      const bit = (v >> i) & 1;
      if (bit) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
  bytes() { return this.buf.subarray(0, Math.ceil(this.pos / 8)); }
}

export class BitReader {
  constructor(bytes, totalBits) {
    this.buf = bytes;
    this.pos = 0;
    this.total = totalBits ?? bytes.length * 8;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.pos < this.total
        ? (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1
        : 0;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v;
  }
  exhausted() { return this.pos >= this.total; }
  remaining() { return Math.max(0, this.total - this.pos); }
}
