// Session state machines.
//
// Both devices have a speaker and a microphone, so the link is bidirectional but
// half duplex: they take turns. Control traffic (handshake, plan, acknowledgements)
// always rides the Silent band, which is the slowest and most robust rung and is
// inaudible; only bulk payload moves to a faster, possibly audible band.
//
// The transport is abstracted so the whole flow can be exercised headlessly
// against the channel simulator with no audio hardware involved.

import { BANDS, bandById, buildPlan, selectBand, bitLoadFor, formatDuration } from './bands.js';
import {
  encodeBurst, decodeBurst, BurstDetector, burstCapacity,
  symbolsForDuration, symbolsForSlots, symbolsFor, burstLayout, preambleFor,
} from './burst.js';
import { trainingSymbol, estimateChannel } from '../dsp/ofdm.js';
import { taperEdges } from '../dsp/window.js';
import { DEFAULT_GAP_DB } from '../dsp/sounder.js';
import { FountainEncoder, FountainDecoder, planChunks } from '../fec/fountain.js';
import { crc32, sha256, toHex } from '../fec/crc.js';
import * as pkt from './packet.js';

export const CONTROL_BAND = 'silent';
/** Payload bytes per fountain block; sized so a DATA packet fills one RS slot. */
export const BLOCK_SIZE = 208;
const DATA_HEADER = 6;    // type + chunkIdx(2) + esi(3)

export function makeSessionId() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Training symbols carried in the sounding probe. */
export const SOUNDING_SYMBOLS = 4;

/**
 * Wideband channel probe: a chirp preamble followed by known training symbols.
 *
 * The preamble matters. An earlier version emitted bare training symbols and
 * asked the receiver to find them by scanning correlations, which regularly
 * locked onto the wrong offset and produced a channel estimate so poor that the
 * bit loader allocated zero bits to every carrier. Reusing the same matched
 * filter that finds ordinary bursts makes alignment exact.
 */
export function buildSounding(fs) {
  const wide = buildPlan(BANDS[BANDS.length - 1], fs);
  const layout = burstLayout(wide, SOUNDING_SYMBOLS);
  const out = new Float64Array(layout.total);

  const t = trainingSymbol(wide);
  let te = 0;
  for (let i = 0; i < t.length; i++) te += t[i] * t[i];
  const symRms = Math.sqrt(te / t.length) || 1e-12;

  const pre = preambleFor(wide);
  let pe = 0;
  for (let i = 0; i < pre.length; i++) pe += pre[i] * pre[i];
  const preRms = Math.sqrt(pe / pre.length) || 1e-12;
  const g = (symRms * 1.5) / preRms;
  for (let i = 0; i < pre.length; i++) pre[i] *= g;
  out.set(pre, 0);

  // training pairs sit where a normal burst keeps them, plus extras for averaging
  for (let i = 0; i < 2 + SOUNDING_SYMBOLS; i++) {
    const off = layout.trainOffset + i * wide.symLen;
    if (off + t.length <= out.length) out.set(t, off);
  }

  taperEdges(out, Math.min(Math.round(0.003 * fs), layout.tailLen));
  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.8 / peak;
  return out;
}

/** Control-band plan and a conservative fixed bit loading for it. */
export function controlSetup(fs) {
  const plan = buildPlan(bandById(CONTROL_BAND), fs);
  const bitLoad = new Int8Array(plan.N);
  for (const k of plan.data) bitLoad[k] = 1;   // BPSK: maximum robustness
  // Sized by codewords, not seconds: BPSK here is slow enough that a
  // duration-based burst would not hold a single complete codeword.
  const symbols = symbolsForSlots(plan, bitLoad, 2);
  return { plan, bitLoad, symbols };
}

/** Compress if the browser offers it and the result is actually smaller. */
export async function maybeCompress(bytes) {
  if (typeof CompressionStream === 'undefined') return { data: bytes, compressed: false };
  try {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    if (out.length < bytes.length * 0.95) return { data: out, compressed: true };
  } catch { /* fall through */ }
  return { data: bytes, compressed: false };
}

export async function maybeDecompress(bytes, compressed) {
  if (!compressed) return bytes;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Collect every packet from every burst found in a block of audio.
 * A window may contain several bursts, and each burst several slots.
 */
export function harvest(plan, bitLoad, symbols, samples, onQuality) {
  const det = new BurstDetector(plan);
  const layout = burstLayout(plan, symbols);
  const out = [];
  // Every preamble in arrival order, not just the loudest. A single capture
  // window routinely holds a control burst followed by several data bursts, and
  // taking only the strongest correlation silently discarded the earlier ones.
  for (const hit of det.findAll(samples)) {
    if (hit.index + layout.total > samples.length) continue;
    const res = decodeBurst(plan, bitLoad, samples, hit.index, symbols);
    if (!res) continue;
    for (const p of res.packets) out.push(p);
    if (onQuality) onQuality({ evm: res.evm, lost: res.lost, corrected: res.corrected, ratio: hit.ratio });
  }
  return out;
}

// ------------------------------------------------------------------- sender

export class SenderSession {
  /**
   * @param transport { send(Float64Array), listen(seconds) -> Float64Array }
   * @param opts { fs, maxComfort, budgetSec, onEvent }
   */
  constructor(transport, opts = {}) {
    this.t = transport;
    this.fs = opts.fs ?? 48000;
    this.maxComfort = opts.maxComfort ?? 3;
    this.budgetSec = opts.budgetSec ?? 600;
    this.onEvent = opts.onEvent ?? (() => {});
    this.sessionId = makeSessionId();
    this.ctl = controlSetup(this.fs);
    this.abortFlag = false;
  }

  abort() { this.abortFlag = true; }
  _emit(type, detail) { this.onEvent({ type, ...detail }); }

  async sendControl(packets) {
    const { plan, bitLoad, symbols } = this.ctl;
    const cap = burstCapacity(plan, bitLoad, symbols);
    for (let i = 0; i < packets.length; i += cap.slots) {
      const group = packets.slice(i, i + cap.slots);
      await this.t.send(encodeBurst(plan, bitLoad, group, symbols));
    }
  }

  async listenControl(seconds) {
    const { plan, bitLoad, symbols } = this.ctl;
    const audio = await this.t.listen(seconds);
    return harvest(plan, bitLoad, symbols, audio).map(pkt.parse).filter(Boolean);
  }

  /** Emit training symbols across the widest band so the far end can measure it. */
  async sendSounding() {
    await this.t.send(buildSounding(this.fs));
  }

  async send(fileBytes, meta = {}) {
    const name = meta.name ?? 'file.bin';
    const mime = meta.mime ?? '';
    const rawSize = fileBytes.length;

    const { data, compressed } = await maybeCompress(fileBytes);
    const digest = await sha256(fileBytes);
    this._emit('prepared', { rawSize, size: data.length, compressed });

    // --- handshake: announce, sound, wait for the receiver's report ---------
    let report = null;
    for (let attempt = 0; attempt < 12 && !report && !this.abortFlag; attempt++) {
      this._emit('handshake', { attempt });
      await this.sendControl([pkt.buildHello(this.sessionId, data.length, name)]);
      await this.sendSounding();
      const replies = await this.listenControl(2.0);
      report = replies.find(r => r.type === pkt.TYPE.REPORT && r.sessionId === this.sessionId);
    }
    if (!report) throw new Error('no receiver answered');

    // --- choose a band from what the receiver actually measured -------------
    // The bit-loading table is derived from the receiver's own 32-band report,
    // never from anything measured locally. Both ends run the identical
    // allocation over the identical numbers, so both arrive at byte-for-byte the
    // same table. If they disagreed by even one carrier the receiver would be
    // unpacking a different number of bits per subcarrier and decode nothing.
    const snrByHz = makeSnrLookup(report.snrBands);
    const choice = selectBand(snrByHz, data.length, {
      fs: this.fs, maxComfort: this.maxComfort, budgetSec: this.budgetSec,
      gapDb: DEFAULT_GAP_DB,
    });
    if (!choice) throw new Error('no usable band');

    const plan = choice.plan;
    const bitLoad = choice.alloc.bitLoad;
    const symbols = symbolsFor(plan, bitLoad, 1.4, 1);
    const cap = symbols > 0 ? burstCapacity(plan, bitLoad, symbols) : { slots: 0 };
    if (symbols <= 0 || cap.slots < 1) {
      throw new Error(
        'the link is too weak to carry data: the receiver measured no usable ' +
        'subcarriers. Move the devices closer, raise the volume, or reduce background noise.');
    }

    const chunks = planChunks(data.length, BLOCK_SIZE);
    this._emit('plan', {
      band: plan.band.id, bandName: plan.band.name, audible: plan.band.audible,
      bytesPerSec: choice.bytesPerSec, eta: choice.seconds,
      etaText: formatDuration(choice.seconds), chunks: chunks.length,
      slotsPerBurst: cap.slots, metBudget: choice.metBudget,
    });

    await this.sendControl([
      pkt.buildPlan(this.sessionId, plan.band.id, BLOCK_SIZE, chunks.length, DEFAULT_GAP_DB),
      pkt.buildHeader(this.sessionId, {
        size: rawSize, compressedSize: data.length, compressed,
        blockSize: BLOCK_SIZE, totalChunks: chunks.length,
        sha256: digest, name, mime,
      }),
    ]);

    // --- stream fountain packets -------------------------------------------
    const encoders = chunks.map(c => new FountainEncoder(data.subarray(c.offset, c.offset + c.length), BLOCK_SIZE));
    const done = new Set();
    const esi = chunks.map(c => 0);
    let burstsSinceAck = 0;
    const ACK_EVERY = 8;
    const t0 = Date.now();
    // A fountain sender would otherwise transmit forever if every ACK is lost.
    const hardDeadline = t0 + (this.budgetSec * 4 + 120) * 1000;

    while (done.size < chunks.length && !this.abortFlag) {
      if (Date.now() > hardDeadline) {
        this._emit('timeout', { phase: 'stream', chunksDone: done.size, chunks: chunks.length });
        break;
      }
      // fill one burst with packets drawn round-robin from unfinished chunks
      const packets = [];
      const pending = chunks.map((c, i) => i).filter(i => !done.has(i));
      if (!pending.length) break;
      for (let s = 0; s < cap.slots; s++) {
        const ci = pending[s % pending.length];
        const body = encoders[ci].symbol(esi[ci]);
        packets.push(pkt.buildData(ci, esi[ci], body));
        esi[ci]++;
      }
      await this.t.send(encodeBurst(plan, bitLoad, packets, symbols));
      burstsSinceAck++;

      if (burstsSinceAck >= ACK_EVERY) {
        burstsSinceAck = 0;
        const replies = await this.listenControl(1.4);
        for (const r of replies) {
          if (r.sessionId !== this.sessionId) continue;
          if (r.type === pkt.TYPE.ACK) {
            for (let i = 0; i < chunks.length; i++) {
              if (r.doneBitmap[i >> 3] & (0x80 >> (i & 7))) done.add(i);
            }
          } else if (r.type === pkt.TYPE.FIN) {
            if (r.ok) { for (let i = 0; i < chunks.length; i++) done.add(i); }
          }
        }
        const elapsed = (Date.now() - t0) / 1000;
        this._emit('progress', {
          chunksDone: done.size, chunks: chunks.length,
          elapsed, fraction: done.size / chunks.length,
        });
      }
    }

    const elapsed = (Date.now() - t0) / 1000;
    this._emit('complete', { elapsed, aborted: this.abortFlag });
    return { elapsed, aborted: this.abortFlag };
  }
}

// ----------------------------------------------------------------- receiver

export class ReceiverSession {
  constructor(transport, opts = {}) {
    this.t = transport;
    this.fs = opts.fs ?? 48000;
    this.onEvent = opts.onEvent ?? (() => {});
    this.ctl = controlSetup(this.fs);
    this.abortFlag = false;
  }

  abort() { this.abortFlag = true; }
  _emit(type, detail) { this.onEvent({ type, ...detail }); }

  async sendControl(packets) {
    const { plan, bitLoad, symbols } = this.ctl;
    const cap = burstCapacity(plan, bitLoad, symbols);
    for (let i = 0; i < packets.length; i += cap.slots) {
      await this.t.send(encodeBurst(plan, bitLoad, packets.slice(i, i + cap.slots), symbols));
    }
  }

  /** Measure the wideband channel from the sender's sounding burst. */
  measureWideband(audio) {
    const wide = buildPlan(BANDS[BANDS.length - 1], this.fs);
    const layout = burstLayout(wide, SOUNDING_SYMBOLS);
    if (audio.length < layout.trainOffset + wide.symLen * 2) return null;

    const det = new BurstDetector(wide, { minRatio: 4 });
    const hit = det.find(audio, Math.max(1, audio.length - (layout.trainOffset + wide.symLen * 2)));
    if (!hit) return null;

    const t0 = hit.index + layout.trainOffset;
    if (t0 + wide.symLen * 2 > audio.length) return null;
    const s1 = audio.subarray(t0, t0 + wide.symLen);
    const s2 = audio.subarray(t0 + wide.symLen, t0 + wide.symLen * 2);
    const chan = estimateChannel(wide, s1, s2);

    // condense to 32 coarse bands for the report packet
    const bands = [];
    const per = Math.max(1, Math.floor(wide.carriers.length / 32));
    for (let i = 0; i < 32; i++) {
      const slice = wide.carriers.slice(i * per, (i + 1) * per);
      if (!slice.length) { bands.push(-20); continue; }
      let acc = 0, n = 0;
      for (const k of slice) if (isFinite(chan.snrDb[k])) { acc += chan.snrDb[k]; n++; }
      bands.push(n ? acc / n : -20);
    }
    return { chan, bands, plan: wide };
  }

  /**
   * @param opts.discoverTimeoutSec how long to wait for a sender before giving up
   * @param opts.stallTimeoutSec abort if no new chunk completes for this long
   */
  async receive(opts = {}) {
    const discoverTimeout = opts.discoverTimeoutSec ?? 120;
    const stallTimeout = opts.stallTimeoutSec ?? 90;
    const { plan: cplan, bitLoad: cbits, symbols: csym } = this.ctl;

    // --- wait for a sender, measure the channel, report back ---------------
    // Bounded: an unbounded wait here means a receiver started by accident, or
    // one whose sender walked away, spins forever with nothing to show for it.
    let hello = null, header = null, planMsg = null;
    const discoverUntil = Date.now() + discoverTimeout * 1000;
    while (!hello && !this.abortFlag) {
      if (Date.now() > discoverUntil) {
        this._emit('timeout', { phase: 'discovery' });
        return null;
      }
      const audio = await this.t.listen(2.5);
      const packets = harvest(cplan, cbits, csym, audio).map(pkt.parse).filter(Boolean);
      hello = packets.find(p => p.type === pkt.TYPE.HELLO);
      if (!hello) continue;
      this._emit('found', { name: hello.name, size: hello.fileSize });

      // Remember exactly what we reported. Every later retransmission must
      // repeat these same numbers, because the sender derives the shared
      // bit-loading table from them and a differing retry would desynchronise it.
      const meas = this.measureWideband(audio);
      this.reportedBands = meas ? meas.bands : new Array(32).fill(6);
      await this.sendControl([pkt.buildReport(hello.sessionId, this.reportedBands)]);
    }
    if (this.abortFlag) return null;

    // --- wait for the plan and header --------------------------------------
    for (let attempt = 0; attempt < 12 && !header && !this.abortFlag; attempt++) {
      const audio = await this.t.listen(2.5);
      const packets = harvest(cplan, cbits, csym, audio).map(pkt.parse).filter(Boolean);
      for (const p of packets) {
        if (p.sessionId !== hello.sessionId) continue;
        if (p.type === pkt.TYPE.PLAN) planMsg = p;
        if (p.type === pkt.TYPE.HEADER) header = p;
      }
      if (!header) await this.sendControl([pkt.buildReport(hello.sessionId, this.reportedBands)]);
    }
    if (!header || !planMsg) throw new Error('never received a transfer plan');

    const dplan = buildPlan(bandById(planMsg.bandId), this.fs);
    // Re-derive the sender's exact table from the report we sent and the gap it
    // echoed back, rather than measuring independently.
    const dbits = bitLoadFor(dplan, makeSnrLookup(this.reportedBands), planMsg.gapDb).bitLoad;
    const dsym = symbolsFor(dplan, dbits, 1.4, 1);
    if (dsym <= 0) throw new Error('negotiated band carries no usable subcarriers');
    this._emit('plan', { band: planMsg.bandId, name: header.name, size: header.size });

    // --- receive payload ----------------------------------------------------
    const chunks = planChunks(header.compressedSize, header.blockSize);
    const decoders = chunks.map(c => new FountainDecoder(
      Math.ceil(c.length / header.blockSize), header.blockSize, c.length));
    const doneBitmap = new Uint8Array(Math.ceil(chunks.length / 8));
    let complete = 0;
    const t0 = Date.now();
    let lastProgress = Date.now();
    // Progress is counted in recovered fountain blocks, not completed chunks.
    // A transfer that fits in one chunk makes no chunk-level progress at all
    // until the very end, so a chunk-based stall detector aborts healthy
    // transfers that are simply still running.
    let blocksSeen = 0;
    const totalBlocks = () => decoders.reduce((a, d) => a + d.recovered, 0);

    while (complete < chunks.length && !this.abortFlag) {
      if (Date.now() - lastProgress > stallTimeout * 1000) {
        this._emit('timeout', { phase: 'transfer', chunksDone: complete, chunks: chunks.length });
        throw new Error(
          `transfer stalled after recovering ${blocksSeen} blocks ` +
          `(${complete}/${chunks.length} chunks complete)`);
      }
      const audio = await this.t.listen(3.0);
      const raw = harvest(dplan, dbits, dsym, audio, q => this._emit('quality', q));
      for (const b of raw) {
        const p = pkt.parse(b);
        if (!p || p.type !== pkt.TYPE.DATA) continue;
        const d = decoders[p.chunkIdx];
        if (!d || d.complete) continue;
        if (d.add(p.esi, p.payload)) {
          doneBitmap[p.chunkIdx >> 3] |= 0x80 >> (p.chunkIdx & 7);
          complete++;
          this._emit('chunk', { index: p.chunkIdx, complete, total: chunks.length });
        }
      }

      const nowBlocks = totalBlocks();
      if (nowBlocks > blocksSeen) { blocksSeen = nowBlocks; lastProgress = Date.now(); }

      const wantBlocks = chunks.reduce((a, c) => a + Math.ceil(c.length / header.blockSize), 0);
      this._emit('progress', {
        chunksDone: complete, chunks: chunks.length,
        blocks: blocksSeen, totalBlocks: wantBlocks,
        fraction: wantBlocks > 0 ? blocksSeen / wantBlocks : 0,
        elapsed: (Date.now() - t0) / 1000,
      });

      await this.sendControl([pkt.buildAck(hello.sessionId, doneBitmap, complete)]);
    }

    // --- reassemble and verify ---------------------------------------------
    const body = new Uint8Array(header.compressedSize);
    for (let i = 0; i < chunks.length; i++) {
      const r = decoders[i].result();
      if (!r) throw new Error(`chunk ${i} incomplete`);
      body.set(r, chunks[i].offset);
    }
    const plainBytes = await maybeDecompress(body, header.compressed);
    const digest = await sha256(plainBytes);
    const ok = toHex(digest.subarray(0, 16)) === toHex(header.sha256);

    await this.sendControl([pkt.buildFin(hello.sessionId, ok)]);
    this._emit('done', {
      ok, name: header.name, size: plainBytes.length,
      elapsed: (Date.now() - t0) / 1000,
    });

    return { ok, bytes: plainBytes, name: header.name, mime: header.mime };
  }

}

/** Interpolate the 32-band report back into a per-frequency SNR lookup. */
export function makeSnrLookup(bands, fLo = 400, fHi = 20000) {
  const n = bands.length;
  return (hz) => {
    const t = (hz - fLo) / (fHi - fLo);
    if (t <= 0) return bands[0];
    if (t >= 1) return bands[n - 1];
    const x = t * (n - 1);
    const i = Math.floor(x), f = x - i;
    return bands[i] * (1 - f) + bands[Math.min(n - 1, i + 1)] * f;
  };
}
