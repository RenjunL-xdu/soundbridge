// Session state machines.
//
// Both devices have a speaker and a microphone, so the link is bidirectional but
// half duplex: they take turns. Control traffic (handshake, plan, acknowledgements)
// uses a dedicated 7-15 kHz band so hardware that rolls off above 17 kHz can
// still join while low-frequency room noise is avoided.
// Only bulk payload moves to the negotiated band, which can remain near-ultrasonic.
//
// The transport is abstracted so the whole flow can be exercised headlessly
// against the channel simulator with no audio hardware involved.

import { BANDS, bandById, buildPlan, selectBand, bitLoadFor, formatDuration } from './bands.js';
import {
  encodeBurst, decodeBurst, BurstDetector, burstCapacity,
  symbolsForDuration, symbolsForSlots, symbolsFor, burstLayout, soundingPreambleFor,
} from './burst.js';
import { trainingSymbol, estimateChannel } from '../dsp/ofdm.js';
import { taperEdges } from '../dsp/window.js';
import { DEFAULT_GAP_DB } from '../dsp/sounder.js';
import { FountainEncoder, FountainDecoder, planChunks } from '../fec/fountain.js';
import { sha256, toHex } from '../fec/crc.js';
import * as pkt from './packet.js';

export const CONTROL_BAND = 'control';
const CONTROL_BAND_SPEC = {
  id: CONTROL_BAND,
  name: 'Control',
  fLo: 7000,
  fHi: 15000,
  N: 2048,
  cp: 384,
  pilotEvery: 8,
  shaping: 0,
  audible: true,
  comfort: 0,
};
/** Payload bytes per fountain block; sized so a DATA packet fills one RS slot. */
export const BLOCK_SIZE = 208;

/** Cheap fingerprint of a bit-loading table, for verifying both ends agree. */
export function tableFingerprint(plan, bitLoad) {
  let h = 2166136261 >>> 0;
  for (const k of plan.data) {
    h ^= (k * 31 + (bitLoad[k] | 0)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

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

  const pre = soundingPreambleFor(wide);
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
  const plan = buildPlan(CONTROL_BAND_SPEC, fs);
  const bitLoad = new Int8Array(plan.N);
  for (const k of plan.data) bitLoad[k] = 1;   // BPSK: maximum robustness
  // One codeword per burst, not two.
  //
  // Sized by codewords rather than seconds so every control burst contains a
  // whole Reed-Solomon codeword. Multi-packet sends become multiple bursts;
  // sendControl handles that.
  const symbols = symbolsForSlots(plan, bitLoad, 1);
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
  const stats = { peaks: 0, tooLate: 0, failed: 0, ok: 0 };
  // Every preamble in arrival order, not just the loudest. A single capture
  // window routinely holds a control burst followed by several data bursts, and
  // taking only the strongest correlation silently discarded the earlier ones.
  // Real bursts cannot be closer together than one burst, so use that as the
  // peak separation rather than the preamble length.
  const hits = det.findAll(samples, { minSep: Math.floor(layout.total * 0.8) });
  stats.peaks = hits.length;
  for (const hit of hits) {
    if (hit.index + layout.total > samples.length) { stats.tooLate++; continue; }
    const res = decodeBurst(plan, bitLoad, samples, hit.index, symbols);
    if (!res) { stats.failed++; continue; }
    stats.ok++;
    for (const p of res.packets) out.push(p);
    if (onQuality) onQuality({ evm: res.evm, lost: res.lost, corrected: res.corrected, ratio: hit.ratio });
  }
  out.stats = stats;
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

    // --- handshake: announce, sound, wait for a report we can actually use ---
    //
    // Retried as a whole, because a report is not the same thing as a usable
    // report. If the sounding burst is the one that gets lost - someone talks
    // over it, a door slams - the receiver has nothing to measure, and a plan
    // built on that describes a channel that cannot carry a single bit. The
    // fountain code protects the payload from loss but nothing protected the
    // handshake, so one unlucky burst aborted the entire transfer. Treat an
    // unusable plan exactly like no answer at all and sound the channel again.
    let choice = null, plan = null, bitLoad = null, symbols = 0, cap = null;
    let sawReceiver = false;

    for (let attempt = 0; attempt < 12 && !choice && !this.abortFlag; attempt++) {
      this._emit('handshake', { attempt });
      await this.sendControl([pkt.buildHello(this.sessionId, data.length, name)]);
      await this.sendSounding();
      // Listen generously. The far end has to notice the announcement, measure
      // the channel and compose a reply, and none of that is instant on a phone.
      // A window narrower than that work simply misses the answer and burns
      // another attempt.
      const replies = await this.listenControl(3.0);
      const report = replies.find(r => r.type === pkt.TYPE.REPORT && r.sessionId === this.sessionId);
      if (!report) continue;
      sawReceiver = true;

      // The bit-loading table is derived from the receiver's own 32-band report,
      // never from anything measured locally. Both ends run the identical
      // allocation over the identical numbers, so both arrive at byte-for-byte
      // the same table. If they disagreed by even one carrier the receiver would
      // be unpacking a different number of bits per subcarrier and decode nothing.
      const c = selectBand(makeSnrLookup(report.snrBands), data.length, {
        fs: this.fs, maxComfort: this.maxComfort, budgetSec: this.budgetSec,
        gapDb: DEFAULT_GAP_DB,
      });
      if (!c) continue;

      const sym = symbolsFor(c.plan, c.alloc.bitLoad, 1.4, 1);
      if (sym <= 0) continue;
      const capacity = burstCapacity(c.plan, c.alloc.bitLoad, sym);
      if (capacity.slots < 1) continue;

      choice = c; plan = c.plan; bitLoad = c.alloc.bitLoad; symbols = sym; cap = capacity;
    }

    if (!choice) {
      throw new Error(sawReceiver
        ? 'the receiver answered but measured no usable subcarriers. Move the devices ' +
          'closer, raise the volume, or reduce background noise.'
        : 'no receiver answered');
    }

    const chunks = planChunks(data.length, BLOCK_SIZE);
    this._emit('plan', {
      band: plan.band.id, bandName: plan.band.name, audible: plan.band.audible,
      bytesPerSec: choice.bytesPerSec, eta: choice.seconds,
      etaText: formatDuration(choice.seconds), chunks: chunks.length,
      slotsPerBurst: cap.slots, metBudget: choice.metBudget,
      bitsPerSymbol: cap.bps, symbols, table: tableFingerprint(plan, bitLoad),
    });

    // Kept, not just sent: this pair is the only way the receiver learns how to
    // demodulate anything, and sending it once made it a single point of
    // failure. One dropped burst and the receiver sits deaf while the sender
    // happily streams a payload it cannot interpret. It is repeated below until
    // the receiver demonstrably has it.
    const planPackets = [
      pkt.buildPlan(this.sessionId, plan.band.id, BLOCK_SIZE, chunks.length, DEFAULT_GAP_DB),
      pkt.buildHeader(this.sessionId, {
        size: rawSize, compressedSize: data.length, compressed,
        blockSize: BLOCK_SIZE, totalChunks: chunks.length,
        sha256: digest, name, mime,
      }),
    ];
    await this.sendControl(planPackets);

    // --- stream fountain packets -------------------------------------------
    const encoders = chunks.map(c => new FountainEncoder(data.subarray(c.offset, c.offset + c.length), BLOCK_SIZE));
    const done = new Set();
    const esi = chunks.map(c => 0);
    let burstsSinceAck = 0;
    let sawAck = false;
    // How often to pause and collect acknowledgements.
    //
    // An acknowledgement round costs a control burst plus a listen — roughly
    // 3.8 s against 1.36 s for a data burst — so acknowledging every 8 bursts
    // adds about 35% overhead, which is the difference between two hours and
    // three on a large file. A fountain sender does not need frequent feedback:
    // its only uses are retiring finished chunks and knowing when to stop. With
    // many chunks in flight, retiring one late wastes very little, so large
    // transfers acknowledge rarely. Small ones still check often, because there
    // the only thing that matters is stopping promptly once the file is through.
    const ACK_EVERY = chunks.length <= 2 ? 6 : 24;
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
            sawAck = true;
            for (let i = 0; i < chunks.length; i++) {
              if (r.doneBitmap[i >> 3] & (0x80 >> (i & 7))) done.add(i);
            }
          } else if (r.type === pkt.TYPE.FIN) {
            sawAck = true;
            if (r.ok) { for (let i = 0; i < chunks.length; i++) done.add(i); }
          }
        }
        // Only an acknowledgement proves the receiver has the plan, because a
        // receiver still waiting for one keeps repeating its channel report.
        // Treating any reply as proof would stop the resends precisely when they
        // are needed. Until an ACK arrives, assume the plan went missing.
        if (!sawAck) await this.sendControl(planPackets);
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

    // Match the sounding's own down-chirp, so an ordinary up-sweeping burst
    // cannot be mistaken for it.
    const det = new BurstDetector(wide, { minRatio: 4, ref: soundingPreambleFor(wide) });
    const hit = det.find(audio, Math.max(1, audio.length - (layout.trainOffset + wide.symLen * 2)));
    if (!hit) return null;

    const t0 = hit.index + layout.trainOffset;
    if (t0 + wide.symLen * 2 > audio.length) return null;
    const s1 = audio.subarray(t0, t0 + wide.symLen);
    const s2 = audio.subarray(t0 + wide.symLen, t0 + wide.symLen * 2);
    const chan = estimateChannel(wide, s1, s2);

    // Sanity-check the result before believing it. A detection that landed in
    // the wrong place still yields numbers, and reporting those is worse than
    // reporting nothing: the sender builds a plan on them that carries no data.
    const finite = wide.carriers.map(k => chan.snrDb[k]).filter(isFinite).sort((a, b) => a - b);
    if (finite.length < wide.carriers.length / 2) return null;
    if (finite[finite.length >> 1] < 3) return null;

    // Condense to 32 coarse bands for the report packet.
    //
    // Each band covers ~26 carriers whose SNR can span several dB, and the
    // sender allocates bits to *every* carrier in the band from this single
    // number. Reporting the mean therefore over-promises: carriers at the
    // bottom of the spread get a constellation they cannot carry and fail every
    // burst. A low percentile means whatever is allocated is supportable by
    // essentially the whole band, which costs a little capacity and buys the
    // difference between working and not.
    const bands = [];
    const per = Math.max(1, Math.floor(wide.carriers.length / 32));
    for (let i = 0; i < 32; i++) {
      const slice = wide.carriers.slice(i * per, (i + 1) * per);
      if (!slice.length) { bands.push(-20); continue; }
      const vals = slice.map(k => chan.snrDb[k]).filter(isFinite).sort((a, b) => a - b);
      if (!vals.length) { bands.push(-20); continue; }
      bands.push(vals[Math.floor(vals.length * 0.2)]);
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
      // Short poll: capture is continuous underneath, so this only controls how
      // often we look, not how much we hear.
      const audio = await this.t.listen(1.2);
      const raw = harvest(cplan, cbits, csym, audio);
      // Report what the microphone actually produced, every cycle. Without this
      // a failed handshake is completely opaque: you cannot tell "heard nothing
      // at all" (wrong band, muted mic, Bluetooth) from "heard a burst but could
      // not decode it" (too far, too noisy, level too low), and those need
      // opposite fixes.
      this._emit('scan', {
        seconds: audio.length / this.fs,
        peaks: raw.stats.peaks,
        decoded: raw.stats.ok,
        failed: raw.stats.failed,
      });
      const packets = raw.map(pkt.parse).filter(Boolean);
      hello = packets.find(p => p.type === pkt.TYPE.HELLO);
      if (!hello) continue;
      this._emit('found', { name: hello.name, size: hello.fileSize });

      // If the sounding burst did not survive, say nothing and keep listening.
      // Answering with a fabricated flat estimate is worse than silence: the
      // sender builds a plan on it, that plan turns out to carry no data, and
      // the transfer aborts. Staying quiet makes the sender repeat its
      // announcement and sounding, which is exactly the recovery we want.
      const meas = this.measureWideband(audio);
      if (!meas) { hello = null; continue; }

      // Remember exactly what the sender will see: the values *after*
      // quantisation, not the raw measurements. The sender derives the shared
      // bit-loading table from the bytes on the wire, so keeping the originals
      // here would silently desynchronise the two tables on every carrier near
      // an allocation threshold. Every later retransmission repeats these same
      // numbers for the same reason.
      this.reportedBands = pkt.quantizeBands(meas.bands);
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
    this._emit('plan', {
      band: planMsg.bandId, name: header.name, size: header.size,
      compressedSize: header.compressedSize, compressed: header.compressed,
      blockSize: header.blockSize, chunks: header.totalChunks,
      bitsPerSymbol: burstCapacity(dplan, dbits, dsym).bps, symbols: dsym, table: tableFingerprint(dplan, dbits),
    });

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
      this._emit('window', {
        samples: audio.length, seconds: audio.length / this.fs,
        packets: raw.length, data: raw.filter(b => b[0] === pkt.TYPE.DATA).length, stats: raw.stats,
      });

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
