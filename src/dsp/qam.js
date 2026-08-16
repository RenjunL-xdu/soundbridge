// Gray-coded square QAM constellations.
//
// Supported orders are 1, 2, 4, 6 and 8 bits per subcarrier (BPSK, QPSK, 16-,
// 64-, 256-QAM). Odd orders above 1 would need cross-QAM shapes; the bit loader
// rounds down to these instead, which costs a little capacity and saves a lot of
// complexity. Every constellation is normalised to unit average energy so that
// mixing orders across subcarriers does not change per-carrier transmit power.

export const ORDERS = [0, 1, 2, 4, 6, 8];

/** Round an arbitrary bit count down to a supported constellation order. */
export function snapOrder(bits) {
  let best = 0;
  for (const o of ORDERS) if (o <= bits) best = o;
  return best;
}

function grayDecode(g) {
  let b = g;
  while (g >>= 1) b ^= g;
  return b;
}

const cache = new Map();

/**
 * Constellation table for `bits` bits/symbol.
 * Returns { pts: Float64Array[2*M] as [I0,Q0,I1,Q1,...], M, bits }.
 * Index into `pts` by the integer formed from `bits` bits, MSB first.
 */
export function constellation(bits) {
  if (cache.has(bits)) return cache.get(bits);
  if (bits === 0) throw new Error('constellation: 0 bits has no points');

  let pts;
  if (bits === 1) {
    pts = Float64Array.from([-1, 0, 1, 0]); // BPSK, already unit energy
  } else {
    const half = bits >> 1;             // bits per axis
    const L = 1 << half;                // levels per axis
    const M = 1 << bits;
    // average energy of an L-PAM with levels {+-1,+-3,...}: (L^2-1)/3, twice for I+Q
    const norm = Math.sqrt((2 * (L * L - 1)) / 3);
    pts = new Float64Array(2 * M);
    for (let s = 0; s < M; s++) {
      const gi = (s >> half) & (L - 1);  // MSB half -> I
      const gq = s & (L - 1);            // LSB half -> Q
      const bi = grayDecode(gi), bq = grayDecode(gq);
      pts[2 * s] = (2 * bi - (L - 1)) / norm;
      pts[2 * s + 1] = (2 * bq - (L - 1)) / norm;
    }
  }
  const t = { pts, M: 1 << bits, bits };
  cache.set(bits, t);
  return t;
}

/** Map an integer symbol value to a complex point. */
export function mapSymbol(bits, value) {
  const c = constellation(bits);
  const i = (value & (c.M - 1)) * 2;
  return [c.pts[i], c.pts[i + 1]];
}

/**
 * Nearest-neighbour demap. Hard decision, which is what the byte-oriented
 * Reed-Solomon layer above consumes anyway.
 * Returns the integer symbol value.
 */
export function demapSymbol(bits, re, im) {
  const c = constellation(bits);
  if (bits === 1) return re >= 0 ? 1 : 0;

  // square QAM decomposes per axis, so decide I and Q independently
  const half = bits >> 1;
  const L = 1 << half;
  const norm = Math.sqrt((2 * (L * L - 1)) / 3);
  const qi = quantAxis(re * norm, L);
  const qq = quantAxis(im * norm, L);
  return (grayEncode(qi) << half) | grayEncode(qq);
}

function quantAxis(v, L) {
  // levels are 2*b-(L-1) for b in [0,L-1]  =>  b = (v + L - 1)/2
  let b = Math.round((v + L - 1) / 2);
  if (b < 0) b = 0;
  if (b > L - 1) b = L - 1;
  return b;
}

function grayEncode(b) {
  return b ^ (b >> 1);
}

/**
 * Error-vector magnitude between a received point and its decision, in dB.
 * Used by the receiver to report live link quality to the UI.
 */
export function evmDb(bits, re, im) {
  const v = demapSymbol(bits, re, im);
  const [ir, ii] = mapSymbol(bits, v);
  const err = (re - ir) * (re - ir) + (im - ii) * (im - ii);
  const sig = ir * ir + ii * ii;
  if (err <= 0) return 60;
  return 10 * Math.log10(sig / err);
}
