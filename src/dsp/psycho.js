// Psychoacoustic shaping and peak control.
//
// Once we are allowed to use audible frequencies, "don't hurt ears" becomes an
// engineering constraint rather than a nicety. Three things do the work:
//
//  1. Spectral shaping. The ear's sensitivity peaks sharply around 3-4 kHz.
//     The same electrical amplitude is far more piercing there than at 200 Hz
//     or 15 kHz, so we weight transmit power by the absolute threshold of
//     hearing and push energy toward where the ear is dull.
//  2. Peak control. OFDM with hundreds of subcarriers has a crest factor of
//     10-12 dB. Left alone you either clip (harsh, broadband, unpleasant) or
//     run the average far too low to be heard at all. Clip-and-filter fixes it.
//  3. Ramps. Every burst is edge-tapered elsewhere in the codebase; abrupt
//     onsets are the clicks that actually make people flinch.

import { fft, irfft } from './fft.js';

/**
 * Terhardt's approximation of the absolute threshold of hearing, dB SPL.
 * Low value = ear is sensitive here = we should transmit less here.
 * @param {number} f frequency in Hz
 */
export function thresholdOfHearingDb(f) {
  const k = Math.max(0.02, f / 1000);
  return 3.64 * Math.pow(k, -0.8)
       - 6.5 * Math.exp(-0.6 * Math.pow(k - 3.3, 2))
       + 1e-3 * Math.pow(k, 4);
}

/**
 * Per-frequency transmit gain (linear) that equalises *perceived* loudness.
 * `strength` 0 = flat, 1 = fully follow the hearing threshold.
 * Clamped so we never boost or cut so hard that the channel estimate suffers.
 */
export function loudnessMask(f, strength = 0.7, maxBoostDb = 10, maxCutDb = 16) {
  const tRef = thresholdOfHearingDb(1000);
  let db = (thresholdOfHearingDb(f) - tRef) * strength;
  if (db > maxBoostDb) db = maxBoostDb;
  if (db < -maxCutDb) db = -maxCutDb;
  return Math.pow(10, db / 20);
}

/**
 * Rough A-weighted level of a shaped spectrum, relative units.
 * Used to show the user a "how loud will this be" indicator before starting,
 * and to compare candidate band plans on annoyance rather than just speed.
 */
export function perceivedLoudness(freqs, gains) {
  let acc = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < 20 || f > 20000) continue;
    // sensitivity is the inverse of threshold, floored so ultrasound counts ~0
    const sens = Math.pow(10, -thresholdOfHearingDb(f) / 20);
    acc += gains[i] * gains[i] * sens * sens;
  }
  return Math.sqrt(acc);
}

/**
 * Clip-and-filter PAPR reduction for a single OFDM symbol body.
 *
 * Repeatedly soft-clips, then projects back onto the occupied subcarriers so the
 * clipping distortion that would otherwise splatter into audible frequencies is
 * removed each pass. Typically buys 4-6 dB of average power for the same peak,
 * which is a direct SNR gain.
 *
 * This operates on exactly one N-sample body, never on a whole burst. The FFT
 * here is a circular operation, and an OFDM symbol body is precisely the block
 * that is circular; running it over arbitrary windows of an assembled burst
 * smears energy across the preamble, guard and symbol boundaries and corrupts
 * the frame.
 */
// targetCrest 4.0 measured as costing no usable in-band SNR, while 2.8 capped it
// at ~30 dB - enough to hurt 64-QAM for no real headroom benefit.
export function reduceSymbolPapr(body, plan, targetCrest = 4.0, iterations = 4) {
  const { N } = plan;
  if (body.length !== N) throw new Error('reduceSymbolPapr: body must be exactly N samples');
  const out = Float64Array.from(body);
  const inBand = new Uint8Array(N);
  for (const k of plan.carriers) { inBand[k] = 1; inBand[N - k] = 1; }

  for (let it = 0; it < iterations; it++) {
    let e = 0;
    for (let i = 0; i < N; i++) e += out[i] * out[i];
    const rms = Math.sqrt(e / N) || 1e-12;
    const limit = targetCrest * rms;

    let clipped = false;
    for (let i = 0; i < N; i++) {
      if (out[i] > limit) { out[i] = limit; clipped = true; }
      else if (out[i] < -limit) { out[i] = -limit; clipped = true; }
    }
    if (!clipped) break;

    const re = new Float64Array(N), im = new Float64Array(N);
    re.set(out);
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) if (!inBand[k]) { re[k] = 0; im[k] = 0; }
    for (let k = N / 2 + 1; k < N; k++) { re[k] = 0; im[k] = 0; } // irfft rebuilds the mirror
    irfft(re, im, out);
  }
  return out;
}

export function crestFactor(sig) {
  let e = 0, peak = 0;
  for (let i = 0; i < sig.length; i++) {
    const a = Math.abs(sig[i]);
    if (a > peak) peak = a;
    e += sig[i] * sig[i];
  }
  const rms = Math.sqrt(e / sig.length) || 1e-12;
  return peak / rms;
}
