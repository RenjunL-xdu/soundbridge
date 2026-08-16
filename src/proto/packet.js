// Wire packet formats.
//
// Everything on the air is one of these, wrapped in Reed-Solomon and carried by
// an OFDM burst. Control traffic is deliberately tiny so it survives on the
// slowest, most robust band plan.

export const TYPE = {
  HELLO:   0x01,  // sender announces a transfer is available
  SOUND:   0x02,  // "measure me" marker; the training symbols do the real work
  REPORT:  0x03,  // receiver returns measured per-band SNR
  PLAN:    0x04,  // sender announces chosen band + bit loading digest
  HEADER:  0x05,  // file metadata
  DATA:    0x06,  // fountain-coded payload
  ACK:     0x07,  // chunks completed so far
  FIN:     0x08,  // receiver verified the hash; sender may stop
  ABORT:   0x09,
};

export const MAGIC = 0x5354; // "ST"

const enc = new TextEncoder();
const dec = new TextDecoder();

class Writer {
  constructor(size = 1024) { this.b = new Uint8Array(size); this.p = 0; }
  _need(n) {
    if (this.p + n <= this.b.length) return;
    const nb = new Uint8Array(Math.max(this.b.length * 2, this.p + n));
    nb.set(this.b); this.b = nb;
  }
  u8(v) { this._need(1); this.b[this.p++] = v & 0xff; return this; }
  u16(v) { this._need(2); this.b[this.p++] = (v >> 8) & 0xff; this.b[this.p++] = v & 0xff; return this; }
  u24(v) { this._need(3); this.b[this.p++] = (v >> 16) & 0xff; this.b[this.p++] = (v >> 8) & 0xff; this.b[this.p++] = v & 0xff; return this; }
  u32(v) { this._need(4); this.b[this.p++] = (v >>> 24) & 0xff; this.b[this.p++] = (v >>> 16) & 0xff; this.b[this.p++] = (v >>> 8) & 0xff; this.b[this.p++] = v & 0xff; return this; }
  bytes(a) { this._need(a.length); this.b.set(a, this.p); this.p += a.length; return this; }
  str(s) { const a = enc.encode(s); this.u16(a.length); return this.bytes(a); }
  done() { return this.b.subarray(0, this.p); }
}

class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  get left() { return this.b.length - this.p; }
  u8() { return this.b[this.p++]; }
  u16() { return (this.b[this.p++] << 8) | this.b[this.p++]; }
  u24() { return (this.b[this.p++] << 16) | (this.b[this.p++] << 8) | this.b[this.p++]; }
  u32() { return (((this.b[this.p++] << 24) >>> 0) + (this.b[this.p++] << 16) + (this.b[this.p++] << 8) + this.b[this.p++]) >>> 0; }
  bytes(n) { const a = this.b.subarray(this.p, this.p + n); this.p += n; return a; }
  str() { const n = this.u16(); return dec.decode(this.bytes(n)); }
}

export { Writer, Reader };

// ------------------------------------------------------------------ builders

export function buildHello(sessionId, fileSize, name) {
  return new Writer(128).u8(TYPE.HELLO).u32(sessionId).u32(fileSize).str(name).done();
}

/**
 * One-byte SNR quantisation, covering -20..+43 dB in quarter-dB steps.
 *
 * Exported because both ends must agree on the *quantised* values, not the
 * originals. The sender only ever sees what came down the wire, so a receiver
 * that kept its raw floats would allocate bits differently on any carrier
 * sitting near a threshold, and a bit-loading table that differs by even one
 * carrier decodes to nothing at all.
 */
export function quantizeSnrDb(s) {
  const q = Math.max(0, Math.min(255, Math.round((s + 20) * 4)));
  return q / 4 - 20;
}

export function quantizeBands(bands) {
  return Array.from(bands, quantizeSnrDb);
}

/** Receiver's channel report: 32 coarse band SNRs, quantised to one byte each. */
export function buildReport(sessionId, snrBands) {
  const w = new Writer(64).u8(TYPE.REPORT).u32(sessionId).u8(snrBands.length);
  for (const s of snrBands) {
    w.u8(Math.max(0, Math.min(255, Math.round((s + 20) * 4))));
  }
  return w.done();
}

export function parseReport(r) {
  const sessionId = r.u32();
  const n = r.u8();
  const snrBands = [];
  for (let i = 0; i < n; i++) snrBands.push(r.u8() / 4 - 20);
  return { sessionId, snrBands };
}

export function buildPlan(sessionId, bandId, blockSize, totalChunks, gapDb) {
  return new Writer(64).u8(TYPE.PLAN).u32(sessionId)
    .str(bandId).u16(blockSize).u16(totalChunks).u8(Math.round(gapDb * 4)).done();
}

export function parsePlan(r) {
  return {
    sessionId: r.u32(),
    bandId: r.str(),
    blockSize: r.u16(),
    totalChunks: r.u16(),
    gapDb: r.u8() / 4,
  };
}

export function buildHeader(sessionId, meta) {
  const w = new Writer(512).u8(TYPE.HEADER).u32(sessionId);
  w.u32(meta.size).u32(meta.compressedSize).u8(meta.compressed ? 1 : 0);
  w.u16(meta.blockSize).u16(meta.totalChunks);
  w.bytes(meta.sha256.subarray(0, 16));   // 128 bits is plenty for integrity here
  w.str(meta.name).str(meta.mime || '');
  return w.done();
}

export function parseHeader(r) {
  const sessionId = r.u32();
  const size = r.u32();
  const compressedSize = r.u32();
  const compressed = r.u8() === 1;
  const blockSize = r.u16();
  const totalChunks = r.u16();
  const sha256 = r.bytes(16);
  const name = r.str();
  const mime = r.str();
  return { sessionId, size, compressedSize, compressed, blockSize, totalChunks, sha256, name, mime };
}

/** DATA is the hot path, so its header is kept to 6 bytes. */
export function buildData(chunkIdx, esi, payload) {
  return new Writer(payload.length + 8)
    .u8(TYPE.DATA).u16(chunkIdx).u24(esi).bytes(payload).done();
}

export function parseData(r) {
  const chunkIdx = r.u16();
  const esi = r.u24();
  const payload = r.bytes(r.left);
  return { chunkIdx, esi, payload };
}

/** Bitmap of completed chunks so the sender can retire them. */
export function buildAck(sessionId, doneBitmap, needChunk) {
  return new Writer(doneBitmap.length + 16)
    .u8(TYPE.ACK).u32(sessionId).u16(needChunk).u16(doneBitmap.length)
    .bytes(doneBitmap).done();
}

export function parseAck(r) {
  const sessionId = r.u32();
  const needChunk = r.u16();
  const n = r.u16();
  return { sessionId, needChunk, doneBitmap: r.bytes(n) };
}

export function buildFin(sessionId, ok) {
  return new Writer(16).u8(TYPE.FIN).u32(sessionId).u8(ok ? 1 : 0).done();
}

/** Dispatch on the leading type byte. */
export function parse(bytes) {
  if (!bytes || bytes.length < 1) return null;
  const r = new Reader(bytes);
  const type = r.u8();
  switch (type) {
    case TYPE.HELLO:  return { type, sessionId: r.u32(), fileSize: r.u32(), name: r.str() };
    case TYPE.SOUND:  return { type, sessionId: r.u32() };
    case TYPE.REPORT: return { type, ...parseReport(r) };
    case TYPE.PLAN:   return { type, ...parsePlan(r) };
    case TYPE.HEADER: return { type, ...parseHeader(r) };
    case TYPE.DATA:   return { type, ...parseData(r) };
    case TYPE.ACK:    return { type, ...parseAck(r) };
    case TYPE.FIN:    return { type, sessionId: r.u32(), ok: r.u8() === 1 };
    case TYPE.ABORT:  return { type, sessionId: r.u32() };
    default: return null;
  }
}
