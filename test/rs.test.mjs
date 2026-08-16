// Reed-Solomon correctness: correct up to t errors, and reliably *fail* beyond t.
import { encode, decode, encodeInterleaved, decodeInterleaved, NSYM, BLOCK, DATA } from '../src/fec/reedsolomon.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };

function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

console.log('=== RS(255,223) ===');

// clean round trip
{
  const msg = randBytes(DATA);
  const cw = encode(msg);
  ok(cw.length === BLOCK, `codeword length ${cw.length} != ${BLOCK}`);
  const r = decode(cw);
  ok(r.ok && r.corrected === 0, 'clean decode failed');
  ok(Buffer.compare(Buffer.from(r.data), Buffer.from(msg)) === 0, 'clean data mismatch');
}

// exactly t errors, many trials
{
  const t = NSYM / 2;
  let good = 0;
  for (let trial = 0; trial < 300; trial++) {
    const msg = randBytes(DATA);
    const cw = encode(msg);
    const pos = new Set();
    while (pos.size < t) pos.add((Math.random() * BLOCK) | 0);
    for (const p of pos) cw[p] ^= 1 + ((Math.random() * 255) | 0);
    const r = decode(cw);
    if (r.ok && Buffer.compare(Buffer.from(r.data), Buffer.from(msg)) === 0) good++;
  }
  ok(good === 300, `t=${t} errors: corrected ${good}/300`);
  console.log(`  corrected exactly ${t} errors in ${good}/300 trials`);
}

// sweep error counts
{
  console.log('  errors -> success rate:');
  for (const e of [0, 4, 8, 12, 16, 17, 20]) {
    let good = 0;
    const N = 200;
    for (let trial = 0; trial < N; trial++) {
      const msg = randBytes(DATA);
      const cw = encode(msg);
      const pos = new Set();
      while (pos.size < e) pos.add((Math.random() * BLOCK) | 0);
      for (const p of pos) cw[p] ^= 1 + ((Math.random() * 255) | 0);
      const r = decode(cw);
      if (r.ok && Buffer.compare(Buffer.from(r.data), Buffer.from(msg)) === 0) good++;
    }
    const mark = e <= 16 ? (good === N ? 'OK' : 'BAD') : 'expected to fail';
    console.log(`    ${String(e).padStart(2)} -> ${String(good).padStart(3)}/${N}  ${mark}`);
    if (e <= 16) ok(good === N, `${e} errors should always correct, got ${good}/${N}`);
  }
}

// miscorrection: beyond t the decoder must report failure, not silent garbage
{
  let silentGarbage = 0, detected = 0;
  for (let trial = 0; trial < 500; trial++) {
    const msg = randBytes(DATA);
    const cw = encode(msg);
    const pos = new Set();
    while (pos.size < 24) pos.add((Math.random() * BLOCK) | 0);
    for (const p of pos) cw[p] ^= 1 + ((Math.random() * 255) | 0);
    const r = decode(cw);
    if (!r.ok) detected++;
    else if (Buffer.compare(Buffer.from(r.data), Buffer.from(msg)) !== 0) silentGarbage++;
  }
  console.log(`  24 errors (beyond t): ${detected}/500 reported failure, ${silentGarbage} silent miscorrections`);
  ok(silentGarbage < 25, `too many silent miscorrections: ${silentGarbage}`);
}

// shortened codewords
{
  const msg = randBytes(100);
  const cw = encode(msg);
  ok(cw.length === 132, `shortened length ${cw.length}`);
  cw[5] ^= 0xff; cw[60] ^= 0x0f;
  const r = decode(cw);
  ok(r.ok && Buffer.compare(Buffer.from(r.data), Buffer.from(msg)) === 0, 'shortened decode failed');
}

console.log('\n=== Interleaved multi-block ===');
{
  const data = randBytes(2000);
  const enc = encodeInterleaved(data);
  console.log(`  ${data.length} B -> ${enc.bytes.length} B in ${enc.nBlocks} codewords (rate ${(data.length / enc.bytes.length).toFixed(3)})`);
  const dec = decodeInterleaved(enc.bytes, enc.nBlocks, enc.dataLen);
  ok(dec && Buffer.compare(Buffer.from(dec.data), Buffer.from(data)) === 0, 'interleaved clean round trip failed');

  // burst error: interleaving should spread it across codewords
  const burst = Uint8Array.from(enc.bytes);
  const t = NSYM / 2;
  const burstLen = enc.nBlocks * t;   // exactly t bytes per codeword
  for (let i = 0; i < burstLen; i++) burst[300 + i] ^= 0xa5;
  const dec2 = decodeInterleaved(burst, enc.nBlocks, enc.dataLen);
  ok(dec2 && Buffer.compare(Buffer.from(dec2.data), Buffer.from(data)) === 0,
     `burst of ${burstLen} consecutive bytes not corrected`);
  console.log(`  burst of ${burstLen} consecutive bytes corrected: ${dec2 ? 'yes' : 'no'}` +
              (dec2 ? ` (${dec2.corrected} byte fixes)` : ''));

  // random errors at a realistic channel BER
  for (const ber of [1e-4, 1e-3, 3e-3]) {
    let good = 0;
    const N = 60;
    for (let trial = 0; trial < N; trial++) {
      const b = Uint8Array.from(enc.bytes);
      for (let i = 0; i < b.length; i++) {
        for (let bit = 0; bit < 8; bit++) if (Math.random() < ber) b[i] ^= 1 << bit;
      }
      const d = decodeInterleaved(b, enc.nBlocks, enc.dataLen);
      if (d && Buffer.compare(Buffer.from(d.data), Buffer.from(data)) === 0) good++;
    }
    console.log(`  BER ${ber.toExponential(0)} -> ${good}/${N} packets recovered`);
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
