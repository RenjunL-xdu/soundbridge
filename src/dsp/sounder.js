// Channel sounding and adaptive bit loading.
//
// This is what makes the system pick its own settings. The receiver measures
// SNR on every subcarrier from the training symbols, allocates bits by the
// classic gap approximation, and reports the table back over the acoustic
// back-channel. The transmitter then uses exactly the carriers that work.

import { snapOrder } from './qam.js';

/**
 * SNR gap for square QAM, in dB.
 *
 * The textbook uncoded gap is ~9.2 dB for a 1e-6 symbol error rate. An earlier
 * default of 6.5 dB assumed Reed-Solomon would contribute ~5 dB of coding gain;
 * hard-decision RS actually gives 2-3 dB, and the remainder has to cover
 * channel-estimation error from only two training symbols, residual timing and
 * phase error, and clipping. Measured end to end, nothing below 10 dB decoded at
 * all and 10 dB upward decoded every time, so 11 dB is the reliable choice with
 * a little margin.
 */
export const DEFAULT_GAP_DB = 11;

/**
 * Allocate bits per subcarrier from measured SNR.
 *
 * @param plan       carrier plan
 * @param snrDb      per-bin SNR from estimateChannel()
 * @param opts.gapDb SNR gap (higher = more conservative)
 * @param opts.maxBits cap per carrier
 * @param opts.marginDb extra safety margin subtracted from every carrier
 * @returns { bitLoad, totalBits, used, dropped, medianSnr }
 */
export function allocateBits(plan, snrDb, opts = {}) {
  const gapDb = opts.gapDb ?? DEFAULT_GAP_DB;
  // 256-QAM needs ~28 dB of genuinely reliable SNR. Over a real acoustic path
  // the channel estimate is never that trustworthy, so 64-QAM is the ceiling.
  const maxBits = opts.maxBits ?? 6;
  // The sounding and the payload bursts see independent noise, so a table fitted
  // exactly to one instant's measurement over-allocates the marginal carriers.
  // A couple of dB absorbs that estimation error.
  const marginDb = opts.marginDb ?? 2;

  const bitLoad = new Int8Array(plan.N);
  let totalBits = 0, used = 0, dropped = 0;
  const snrs = [];

  for (const k of plan.data) {
    const s = snrDb[k] - gapDb - marginDb;
    snrs.push(snrDb[k]);
    if (!isFinite(s) || s <= 0) { bitLoad[k] = 0; dropped++; continue; }
    const lin = Math.pow(10, s / 10);
    const raw = Math.log2(1 + lin);
    const b = Math.min(maxBits, snapOrder(Math.floor(raw)));
    bitLoad[k] = b;
    if (b > 0) { used++; totalBits += b; } else dropped++;
  }

  snrs.sort((a, b) => a - b);
  const medianSnr = snrs.length ? snrs[snrs.length >> 1] : -99;

  return { bitLoad, totalBits, used, dropped, medianSnr };
}

/**
 * Net application throughput in bytes/sec for a bit-loading table.
 *
 * `burstEfficiency` is the fraction of airtime carrying data rather than
 * preamble, guard, training symbols and tail - about 0.88 for a 1.2 s burst.
 * Leaving it out overstates throughput by roughly 12%.
 */
export function goodputBps(plan, totalBits, {
  codeRate = 223 / 255,
  fountainOverhead = 1.06,
  burstEfficiency = 0.88,
} = {}) {
  const rawBps = totalBits * plan.symbolRate;
  return (rawBps * codeRate * burstEfficiency) / fountainOverhead / 8;
}
