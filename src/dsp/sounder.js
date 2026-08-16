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
  const marginDb = opts.marginDb ?? 0;

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

/**
 * Flag subcarriers sitting under narrowband interference.
 *
 * Real rooms contain ultrasonic motion sensors, rodent repellers and switching
 * supplies that park a strong tone in one bin. Those carriers look fine to a
 * plain SNR test during a quiet moment and then fail constantly, so we compare
 * each bin against its neighbours and drop outliers.
 */
export function rejectInterferers(plan, noise, bitLoad, factorDb = 9) {
  const kill = [];
  const arr = plan.data;
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i];
    const neigh = [];
    for (let d = -4; d <= 4; d++) {
      if (d === 0) continue;
      const j = arr[i + d];
      if (j !== undefined && noise[j] > 0) neigh.push(noise[j]);
    }
    if (neigh.length < 3) continue;
    neigh.sort((a, b) => a - b);
    const med = neigh[neigh.length >> 1];
    if (med > 0 && noise[k] / med > Math.pow(10, factorDb / 10)) {
      bitLoad[k] = 0;
      kill.push(k);
    }
  }
  return kill;
}

/** Human-readable summary for the UI and the calibration page. */
export function describeChannel(plan, snrDb, alloc) {
  const bands = [];
  const step = Math.max(1, Math.floor(plan.carriers.length / 16));
  for (let i = 0; i < plan.carriers.length; i += step) {
    const slice = plan.carriers.slice(i, i + step);
    let acc = 0, n = 0;
    for (const k of slice) { if (isFinite(snrDb[k])) { acc += snrDb[k]; n++; } }
    bands.push({
      fLo: slice[0] * plan.binHz,
      fHi: slice[slice.length - 1] * plan.binHz,
      snrDb: n ? acc / n : -99,
    });
  }
  return {
    bands,
    used: alloc.used,
    dropped: alloc.dropped,
    medianSnr: alloc.medianSnr,
    bitsPerSymbol: alloc.totalBits,
    symbolRate: plan.symbolRate,
  };
}
