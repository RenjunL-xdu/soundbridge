// Fountain code: recovery under packet loss, and reception overhead.
import { FountainEncoder, FountainDecoder, planChunks, MAX_BLOCKS_PER_CHUNK } from '../src/fec/fountain.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

console.log('=== Fountain recovery vs packet loss ===');
console.log('  loss    trials  decoded   mean overhead   mean pkts');

for (const loss of [0, 0.1, 0.3, 0.5, 0.7, 0.85]) {
  const BLOCK = 512;
  const DATA = 200 * BLOCK;
  let decoded = 0, ovhSum = 0, pktSum = 0;
  const TRIALS = 25;

  for (let t = 0; t < TRIALS; t++) {
    const src = randBytes(DATA);
    const enc = new FountainEncoder(src, BLOCK);
    const dec = new FountainDecoder(enc.K, BLOCK, DATA);

    let esi = 0, sent = 0;
    const cap = enc.K * 30;
    while (!dec.complete && sent < cap) {
      const sym = enc.symbol(esi);
      if (Math.random() >= loss) dec.add(esi, sym);
      esi++; sent++;
    }
    if (dec.complete) {
      const out = dec.result();
      if (Buffer.compare(Buffer.from(out), Buffer.from(src)) === 0) {
        decoded++;
        ovhSum += dec.overhead;
        pktSum += sent;
      }
    }
  }
  const mo = decoded ? (ovhSum / decoded).toFixed(3) : '--';
  const mp = decoded ? Math.round(pktSum / decoded) : '--';
  console.log(`  ${(loss * 100).toFixed(0).padStart(3)}%   ${String(TRIALS).padStart(6)}  ${String(decoded).padStart(7)}   ${String(mo).padStart(13)}   ${String(mp).padStart(9)}`);
  ok(decoded === TRIALS, `loss ${loss}: only ${decoded}/${TRIALS} decoded`);
}

console.log('\n=== Systematic property (clean channel needs ~K packets) ===');
{
  const BLOCK = 512, K = 200;
  const src = randBytes(K * BLOCK);
  const enc = new FountainEncoder(src, BLOCK);
  const dec = new FountainDecoder(enc.K, BLOCK, src.length);
  let esi = 0;
  while (!dec.complete) { dec.add(esi, enc.symbol(esi)); esi++; }
  console.log(`  K=${enc.K}, decoded after ${esi} packets (overhead ${(esi / enc.K).toFixed(4)}x)`);
  ok(esi === enc.K, `systematic prefix should decode in exactly K, took ${esi}`);
}

console.log('\n=== Out-of-order and duplicate delivery ===');
{
  const BLOCK = 256, K = 120;
  const src = randBytes(K * BLOCK);
  const enc = new FountainEncoder(src, BLOCK);
  const dec = new FountainDecoder(enc.K, BLOCK, src.length);

  const ids = [];
  for (let i = 0; i < K * 3; i++) ids.push(i);
  for (let i = ids.length - 1; i > 0; i--) {   // shuffle
    const j = (Math.random() * (i + 1)) | 0;
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  let n = 0;
  for (const esi of ids) {
    dec.add(esi, enc.symbol(esi));
    if (Math.random() < 0.2) dec.add(esi, enc.symbol(esi));  // duplicate
    n++;
    if (dec.complete) break;
  }
  ok(dec.complete, 'out-of-order delivery failed to decode');
  ok(Buffer.compare(Buffer.from(dec.result()), Buffer.from(src)) === 0, 'out-of-order data mismatch');
  console.log(`  decoded from shuffled + duplicated stream after ${n} distinct ESIs`);
}

console.log('\n=== Chunk planning for a 10 MB file ===');
{
  const SIZE = 10 * 1024 * 1024, BLOCK = 512;
  const chunks = planChunks(SIZE, BLOCK);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  console.log(`  ${SIZE} B / ${BLOCK} B blocks -> ${chunks.length} chunks, max ${MAX_BLOCKS_PER_CHUNK} blocks each`);
  console.log(`  first chunk: ${chunks[0].blocks} blocks, ${chunks[0].length} B`);
  console.log(`  last  chunk: ${chunks[chunks.length - 1].blocks} blocks, ${chunks[chunks.length - 1].length} B`);
  ok(total === SIZE, `chunk lengths sum to ${total}, expected ${SIZE}`);
  ok(chunks.every(c => c.blocks <= MAX_BLOCKS_PER_CHUNK), 'a chunk exceeds the block cap');
}

console.log('\n=== Full 1 MB round trip at 25% loss ===');
{
  const BLOCK = 512;
  const src = randBytes(1024 * 1024);
  const chunks = planChunks(src.length, BLOCK);
  const out = new Uint8Array(src.length);
  let totalSent = 0;
  const t0 = Date.now();

  for (const ch of chunks) {
    const part = src.subarray(ch.offset, ch.offset + ch.length);
    const enc = new FountainEncoder(part, BLOCK);
    const dec = new FountainDecoder(enc.K, BLOCK, ch.length);
    let esi = 0;
    while (!dec.complete && esi < enc.K * 20) {
      if (Math.random() >= 0.25) dec.add(esi, enc.symbol(esi));
      esi++; totalSent++;
    }
    if (!dec.complete) { ok(false, `chunk ${ch.index} failed`); break; }
    out.set(dec.result(), ch.offset);
  }
  const dt = Date.now() - t0;
  ok(Buffer.compare(Buffer.from(out), Buffer.from(src)) === 0, '1 MB round trip mismatch');
  console.log(`  ${chunks.length} chunks, ${totalSent} packets sent, ${dt} ms encode+decode`);
  console.log(`  net expansion ${(totalSent * BLOCK / src.length).toFixed(3)}x vs 1.333x for 25% loss`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
