// Reed-Solomon over GF(256), primitive polynomial 0x11d.
//
// RS(255,223) corrects up to 16 corrupt bytes per codeword. Combined with the
// interleaver this is what turns a raw bit error rate of ~1e-3 into clean
// packets: without it, a 1 KB packet at that BER survives roughly 0.03% of the
// time and the fountain layer would never converge.
//
// Convention: the encoder works in descending-degree order (natural for
// synthetic division); the decoder works in ascending-degree order (natural for
// Berlekamp-Massey). Each is labelled where it matters.

const PRIM = 0x11d;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= PRIM; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
const inv = (a) => EXP[255 - LOG[a]];
const div = (a, b) => (a === 0) ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];

/** Descending-degree polynomial multiply. */
function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    for (let j = 0; j < q.length; j++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

/** Horner evaluation, descending-degree. */
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

const genCache = new Map();
function generatorPoly(nsym) {
  if (genCache.has(nsym)) return genCache.get(nsym);
  let g = Uint8Array.from([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.from([1, EXP[i]]));
  genCache.set(nsym, g);
  return g;
}

export const NSYM = 32;          // 2t, corrects t = 16 bytes
export const BLOCK = 255;
export const DATA = BLOCK - NSYM; // 223

/**
 * Systematic encode. Accepts messages shorter than DATA (shortened code) and
 * returns msg.length + nsym bytes.
 */
export function encode(msg, nsym = NSYM) {
  if (msg.length + nsym > 255) throw new Error('rs.encode: block too long');
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(msg); // synthetic division clobbered the systematic prefix
  return out;
}

function syndromes(r, nsym) {
  const s = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) s[i] = polyEval(r, EXP[i]);
  return s;
}

/** Berlekamp-Massey. Ascending-degree locator, C[0] === 1. */
function errorLocator(synd, nsym) {
  let C = [1], B = [1];
  let L = 0, m = 1, b = 1;
  for (let n = 0; n < nsym; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, synd[n - i]);
    if (d === 0) { m++; continue; }
    const scale = mul(d, inv(b));
    const T = C.slice();
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(scale, B[i]);
    if (2 * L <= n) { L = n + 1 - L; B = T; b = d; m = 1; }
    else m++;
  }
  return { C, L };
}

/** Chien search: byte positions (index into the codeword) that are in error. */
function findErrors(C, n) {
  const pos = [];
  for (let i = 0; i < n; i++) {
    // evaluate C at alpha^-i  (ascending-degree Horner)
    const x = EXP[(255 - (i % 255)) % 255];
    let y = 0, xp = 1;
    for (let j = 0; j < C.length; j++) { y ^= mul(C[j], xp); xp = mul(xp, x); }
    if (y === 0) pos.push(n - 1 - i);
  }
  return pos;
}

/**
 * Decode in place. Returns { ok, corrected, data } where data is the
 * systematic prefix (length = r.length - nsym).
 */
export function decode(received, nsym = NSYM) {
  const r = Uint8Array.from(received);
  const n = r.length;
  const synd = syndromes(r, nsym);

  let clean = true;
  for (let i = 0; i < nsym; i++) if (synd[i] !== 0) { clean = false; break; }
  if (clean) return { ok: true, corrected: 0, data: r.subarray(0, n - nsym) };

  const { C, L } = errorLocator(synd, nsym);
  if (L > nsym / 2) return { ok: false, corrected: 0, data: null };

  const pos = findErrors(C, n);
  if (pos.length !== L || pos.length === 0) return { ok: false, corrected: 0, data: null };

  // error evaluator: Omega(x) = S(x) * Lambda(x) mod x^nsym   (ascending order)
  const S = Array.from(synd);
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    let acc = 0;
    for (let j = 0; j <= i; j++) acc ^= mul(S[i - j], C[j] || 0);
    omega[i] = acc;
  }

  // formal derivative of Lambda keeps only odd-degree terms
  const dC = [];
  for (let i = 1; i < C.length; i += 2) dC.push(C[i]);

  for (const p of pos) {
    const i = n - 1 - p;                       // power of alpha at this position
    const xInv = EXP[(255 - (i % 255)) % 255]; // X^-1
    let ov = 0, xp = 1;
    for (let j = 0; j < omega.length; j++) { ov ^= mul(omega[j], xp); xp = mul(xp, xInv); }
    let dv = 0; xp = 1;
    const x2 = mul(xInv, xInv);
    for (let j = 0; j < dC.length; j++) { dv ^= mul(dC[j], xp); xp = mul(xp, x2); }
    if (dv === 0) return { ok: false, corrected: 0, data: null };
    // e = X * Omega(X^-1) / Lambda'(X^-1), with first syndrome root alpha^0
    const X = EXP[i % 255];
    r[p] ^= mul(X, div(ov, dv));
  }

  // verify: a decoder that "succeeds" on more errors than it can handle
  // produces garbage, so re-check the syndromes before trusting the result
  const check = syndromes(r, nsym);
  for (let i = 0; i < nsym; i++) if (check[i] !== 0) return { ok: false, corrected: 0, data: null };

  return { ok: true, corrected: pos.length, data: r.subarray(0, n - nsym) };
}

/**
 * Encode an arbitrary-length buffer as a sequence of RS codewords, then
 * interleave them so a burst of consecutive channel errors is spread one byte
 * per codeword instead of destroying a single codeword outright.
 */
export function encodeInterleaved(data, nsym = NSYM) {
  const k = BLOCK - nsym;
  const nBlocks = Math.ceil(data.length / k);
  const words = [];
  for (let i = 0; i < nBlocks; i++) {
    const chunk = data.subarray(i * k, Math.min((i + 1) * k, data.length));
    const padded = chunk.length === k ? chunk : (() => {
      const p = new Uint8Array(k); p.set(chunk); return p;
    })();
    words.push(encode(padded, nsym));
  }
  const out = new Uint8Array(nBlocks * BLOCK);
  for (let i = 0; i < BLOCK; i++)
    for (let j = 0; j < nBlocks; j++) out[i * nBlocks + j] = words[j][i];
  return { bytes: out, nBlocks, dataLen: data.length };
}

/** Number of payload bytes carried by one independently-decodable slot. */
export const SLOT_PAYLOAD = BLOCK - NSYM - 2;   // 221: two bytes hold the length

/**
 * Interleave a set of independent slots into one byte stream.
 *
 * Each slot becomes its own codeword, so slots succeed or fail independently and
 * the fountain layer above can treat a lost slot as a single lost packet. The
 * transpose still spreads a burst of consecutive channel errors one byte per
 * codeword, so both properties hold at once.
 *
 * The all-or-nothing alternative scales badly: a wideband burst carries ~14
 * codewords, and requiring every one to succeed turns a 20% codeword failure
 * rate into a 96% burst failure rate.
 */
export function encodeSlots(payloads, nsym = NSYM) {
  const words = payloads.map(p => {
    if (p.length > BLOCK - nsym - 2) throw new Error('encodeSlots: payload too large for a slot');
    const region = new Uint8Array(BLOCK - nsym);
    region[0] = (p.length >> 8) & 0xff;
    region[1] = p.length & 0xff;
    region.set(p, 2);
    return encode(region, nsym);
  });
  const n = words.length;
  const out = new Uint8Array(n * BLOCK);
  for (let i = 0; i < BLOCK; i++)
    for (let j = 0; j < n; j++) out[i * n + j] = words[j][i];
  return out;
}

/**
 * Inverse of encodeSlots. Returns one entry per slot; entries are null where
 * that codeword could not be recovered.
 */
export function decodeSlots(bytes, nSlots, nsym = NSYM) {
  const out = [];
  let corrected = 0, lost = 0;
  for (let j = 0; j < nSlots; j++) {
    const cw = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) cw[i] = bytes[i * nSlots + j];
    const res = decode(cw, nsym);
    if (!res.ok) { out.push(null); lost++; continue; }
    corrected += res.corrected;
    const len = (res.data[0] << 8) | res.data[1];
    if (len > res.data.length - 2) { out.push(null); lost++; continue; }
    out.push(res.data.subarray(2, 2 + len));
  }
  return { slots: out, corrected, lost };
}

/** Inverse of encodeInterleaved. Returns null if any codeword is unrecoverable. */
export function decodeInterleaved(bytes, nBlocks, dataLen, nsym = NSYM) {
  const k = BLOCK - nsym;
  if (bytes.length !== nBlocks * BLOCK) return null;
  const out = new Uint8Array(nBlocks * k);
  let totalCorrected = 0;
  for (let j = 0; j < nBlocks; j++) {
    const cw = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) cw[i] = bytes[i * nBlocks + j];
    const res = decode(cw, nsym);
    if (!res.ok) return null;
    totalCorrected += res.corrected;
    out.set(res.data, j * k);
  }
  return { data: out.subarray(0, dataLen), corrected: totalCorrected };
}

export const _internals = { mul, div, inv, EXP, LOG, polyEval, generatorPoly };
