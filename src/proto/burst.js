// Burst assembly and recovery.
//
// A burst is the smallest self-contained thing we put on the air:
//
//   [ chirp preamble ][ guard ][ training x2 ][ data symbols x S ]
//
// The preamble sweeps only the plan's own band, so a burst on the silent plan
// stays inaudible end to end. The guard lets room reverb from the preamble decay
// before the training symbols measure the channel. Two identical training
// symbols give H[k] and the noise floor in one shot.

import { linearChirp, findChirp, findChirps } from '../dsp/chirp.js';
import {
  bitsPerSymbol, modulateBits, trainingSymbol, estimateChannel,
  demodulateSymbol, symbolRms, BitReader, BitWriter,
} from '../dsp/ofdm.js';
import { encodeSlots, decodeSlots, BLOCK, NSYM, SLOT_PAYLOAD } from '../fec/reedsolomon.js';
import { taperEdges } from '../dsp/window.js';

export const PREAMBLE_SEC = 0.040;
export const GUARD_SEC = 0.012;
/** Preamble RMS as a multiple of OFDM symbol RMS. */
export const PREAMBLE_LEVEL = 1.5;
/**
 * Silence after the last symbol. The output ramp has to land somewhere, and it
 * must not be inside a data symbol: tapering the tail of the final symbol
 * corrupted it outright and put a hard floor of ~8e-3 on the bit error rate
 * regardless of SNR, which looked exactly like clock drift and was not.
 */
export const TAIL_SEC = 0.008;

export function burstLayout(plan, symbols) {
  const pre = Math.round(PREAMBLE_SEC * plan.fs);
  const guard = Math.round(GUARD_SEC * plan.fs);
  const tail = Math.round(TAIL_SEC * plan.fs);
  return {
    preambleLen: pre,
    guardLen: guard,
    trainOffset: pre + guard,
    trainLen: plan.symLen * 2,
    dataOffset: pre + guard + plan.symLen * 2,
    dataLen: plan.symLen * symbols,
    tailLen: tail,
    total: pre + guard + plan.symLen * (2 + symbols) + tail,
    symbols,
  };
}

/**
 * How much a burst of `symbols` data symbols can carry.
 * `slots` independently-decodable packets of up to SLOT_PAYLOAD bytes each.
 */
export function burstCapacity(plan, bitLoad, symbols) {
  const bps = bitsPerSymbol(plan, bitLoad);
  const rawBytes = Math.floor((symbols * bps) / 8);
  const slots = Math.floor(rawBytes / BLOCK);
  return { slots, slotPayload: SLOT_PAYLOAD, payload: slots * SLOT_PAYLOAD, bps };
}

/** Pick a symbol count giving roughly `seconds` of data per burst. */
export function symbolsForDuration(plan, seconds = 1.5) {
  return Math.max(4, Math.round((seconds * plan.fs) / plan.symLen));
}

/**
 * Symbols needed to carry `slots` whole RS codewords.
 *
 * Sizing a burst purely by duration silently produces zero-capacity bursts on
 * slow configurations: BPSK on the narrow control band fits only ~197 bytes in
 * 0.9 s, short of the 255 a single codeword needs.
 */
export function symbolsForSlots(plan, bitLoad, slots = 1) {
  const bps = bitsPerSymbol(plan, bitLoad);
  // A table that allocates nothing has no finite answer. Returning Infinity here
  // silently propagated into buffer sizes; callers must treat 0 as "unusable".
  if (bps <= 0) return 0;
  return Math.max(4, Math.ceil((slots * BLOCK * 8) / bps));
}

/**
 * Symbols for a target duration, but never fewer than `minSlots` will fit.
 * Returns 0 when the bit-loading table carries no data at all.
 */
export function symbolsFor(plan, bitLoad, seconds, minSlots = 1) {
  const need = symbolsForSlots(plan, bitLoad, minSlots);
  if (need === 0) return 0;
  return Math.max(symbolsForDuration(plan, seconds), need);
}

export function preambleFor(plan) {
  return linearChirp(plan.band?.fLo ?? plan.kLo * plan.binHz,
                     plan.band?.fHi ?? plan.kHi * plan.binHz,
                     PREAMBLE_SEC, plan.fs);
}

/**
 * Build a complete burst carrying `packetBytes`.
 * Returns Float64Array of samples, peak-limited and edge-tapered.
 */
export function encodeBurst(plan, bitLoad, packets, symbols) {
  const cap = burstCapacity(plan, bitLoad, symbols);
  if (cap.slots < 1) throw new Error('encodeBurst: burst too small for one slot');

  const list = Array.isArray(packets) ? packets : [packets];
  if (list.length > cap.slots)
    throw new Error(`encodeBurst: ${list.length} packets exceeds ${cap.slots} slots`);

  // Unused slots are filled with empty payloads so the frame stays a fixed size
  // and the receiver always knows how many codewords to expect.
  const filled = list.slice();
  while (filled.length < cap.slots) filled.push(new Uint8Array(0));

  const coded = { bytes: encodeSlots(filled) };     // -> slots * 255 bytes

  // pad out to a whole number of OFDM symbols
  const totalBits = symbols * cap.bps;
  const bitBuf = new Uint8Array(Math.ceil(totalBits / 8));
  bitBuf.set(coded.bytes.subarray(0, Math.min(coded.bytes.length, bitBuf.length)));

  const reader = new BitReader(bitBuf, totalBits);
  const dataSyms = modulateBits(plan, bitLoad, reader, symbols);

  const layout = burstLayout(plan, symbols);
  const out = new Float64Array(layout.total);

  // Level-match the preamble to the payload.
  //
  // A raw chirp swings +-1 while an OFDM symbol sits around 0.007 RMS, so an
  // unscaled preamble is ~100x louder and sets the peak all by itself. Peak
  // normalising then drives the actual data ~40 dB below full scale and throws
  // away most of the available SNR. A chirp's crest factor is only ~1.41
  // against ~2.8 for a clipped OFDM symbol, so the preamble can sit a little
  // hotter than the payload without costing any headroom at all.
  const symRms = symbolRms(plan);
  const pre = preambleFor(plan);
  let pe = 0;
  for (let i = 0; i < pre.length; i++) pe += pre[i] * pre[i];
  const preRms = Math.sqrt(pe / pre.length) || 1e-12;
  const preGain = (symRms * PREAMBLE_LEVEL) / preRms;
  for (let i = 0; i < pre.length; i++) pre[i] *= preGain;
  out.set(pre, 0);

  const train = trainingSymbol(plan);
  out.set(train, layout.trainOffset);
  out.set(train, layout.trainOffset + plan.symLen);

  let p = layout.dataOffset;
  for (const s of dataSyms) { out.set(s, p); p += s.length; }

  // Only the outer edges are tapered, and the trailing ramp falls entirely in
  // the silent tail so it never touches a data symbol. PAPR reduction already
  // happened per symbol inside modulateSymbol, where the FFT block lines up
  // with the symbol body; running it across the assembled burst would smear the
  // preamble into the training symbols and destroy the channel estimate.
  taperEdges(out, Math.min(Math.round(0.003 * plan.fs), layout.tailLen));

  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 0) { const g = 0.85 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }

  return out;
}

/**
 * Recover a burst whose preamble starts at `start` in `samples`.
 * Returns { bytes, chan, snrDb, evm } or null if the codewords were unrecoverable.
 */
export function decodeBurst(plan, bitLoad, samples, start, symbols) {
  const layout = burstLayout(plan, symbols);
  const cap = burstCapacity(plan, bitLoad, symbols);
  if (cap.slots < 1) return null;

  const t0 = start + layout.trainOffset;
  const sym1 = samples.subarray(t0, t0 + plan.symLen);
  const sym2 = samples.subarray(t0 + plan.symLen, t0 + plan.symLen * 2);
  if (sym2.length < plan.symLen) return null;

  const chan = estimateChannel(plan, sym1, sym2);

  const writer = new BitWriter(symbols * cap.bps);
  const state = { cpe: 0, slope: 0, evm: 0, timingErr: 0 };
  let evmAcc = 0;
  for (let s = 0; s < symbols; s++) {
    const off = start + layout.dataOffset + s * plan.symLen;
    if (off + plan.symLen > samples.length) return null;
    demodulateSymbol(plan, samples, off, chan, bitLoad, state, writer);
    evmAcc += state.evm;
  }

  const bytes = writer.bytes();
  const need = cap.slots * BLOCK;
  if (bytes.length < need) return null;

  const dec = decodeSlots(bytes.subarray(0, need), cap.slots);
  // Slots that failed come back null; a burst is still useful as long as any
  // slot survived, because each one is an independent fountain packet.
  const packets = dec.slots.filter(s => s !== null && s.length > 0);
  if (packets.length === 0) return null;

  return {
    packets,
    slots: dec.slots,
    lost: dec.lost,
    chan,
    corrected: dec.corrected,
    evm: evmAcc / symbols,
  };
}

/**
 * Streaming preamble detector.
 *
 * Feeds a sliding window to the matched filter and reports burst starts. The
 * peak-to-sidelobe ratio is the confidence gate: it is what lets a receiver sit
 * idle in a noisy room without constantly firing on nothing.
 */
export class BurstDetector {
  constructor(plan, { minRatio = 5 } = {}) {
    this.plan = plan;
    this.ref = preambleFor(plan);
    this.minRatio = minRatio;
    this.lastIndex = -1;
  }

  /**
   * @param samples window of audio
   * @param searchLen how much of the window to search (rest is lookahead)
   * @returns { index, ratio } or null
   */
  find(samples, searchLen) {
    const win = samples.subarray(0, Math.min(samples.length, searchLen + this.ref.length));
    const r = findChirp(win, this.ref, this.minRatio);
    if (!r.ok || r.index < 0 || r.index > searchLen) return null;
    return { index: r.index, ratio: r.ratio };
  }

  /**
   * Every preamble in the window, in arrival order.
   *
   * `minSep` should be close to a whole burst: two real bursts can never overlap,
   * so anything nearer than that is a sidelobe. Separating only by the preamble
   * length instead let a packed window generate hundreds of spurious peaks,
   * which then exhausted the peak cap before any genuine burst was reached.
   */
  findAll(samples, { maxPeaks = 64, minSep = null } = {}) {
    return findChirps(samples, this.ref, { minRatio: this.minRatio, maxPeaks, minSep });
  }
}
