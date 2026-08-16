// CRC-32 (IEEE) and CRC-16 (CCITT).
// Every packet carries a CRC so the fountain decoder can treat a corrupt packet
// as an erasure rather than poisoning the decode.

const TABLE32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE32[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc16(bytes, start = 0, end = bytes.length) {
  let c = 0xffff;
  for (let i = start; i < end; i++) {
    c ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c & 0xffff;
}

/** SHA-256 via WebCrypto, available in browsers and Node 18+. */
export async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
