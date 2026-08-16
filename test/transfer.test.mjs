// Full file transfer: two sessions, one simulated room, no audio hardware.
// This is the test that proves the whole stack.

import { SenderSession, ReceiverSession } from '../src/proto/session.js';
import { Air } from './air.js';

const FS = 48000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}
function textBytes(n) {
  const words = ['sonar', 'transfer', 'acoustic', 'ofdm', 'fountain', 'chirp', 'ultrasonic'];
  let s = '';
  while (s.length < n) s += words[(Math.random() * words.length) | 0] + ' ';
  return new TextEncoder().encode(s.slice(0, n));
}

async function runTransfer(label, payload, chanOpts, opts = {}) {
  const air = new Air(chanOpts, { fs: FS, dropRate: opts.dropRate ?? 0 });
  let planEv = null;

  const tx = new SenderSession(air.endpoint('a'), {
    fs: FS,
    maxComfort: opts.maxComfort ?? 3,
    budgetSec: opts.budgetSec ?? 600,
    onEvent: e => { if (e.type === 'plan') planEv = e; },
  });
  const rx = new ReceiverSession(air.endpoint('b'), { fs: FS, onEvent: () => {} });

  const t0 = Date.now();
  const [, got] = await Promise.all([
    tx.send(payload, { name: 'payload.bin', mime: 'application/octet-stream' })
      .catch(e => { console.log('    sender:', e.message); }),
    rx.receive({ discoverTimeoutSec: 90, stallTimeoutSec: 90 })
      .catch(e => { console.log('    receiver:', e.message); return null; }),
  ]);
  const wall = (Date.now() - t0) / 1000;

  const match = !!got && Buffer.compare(Buffer.from(got.bytes), Buffer.from(payload)) === 0;
  const airtime = air.airtimeSec;
  const goodput = airtime > 0 ? payload.length / airtime : 0;

  console.log(
    `  ${label.padEnd(30)} ${match ? 'OK  ' : 'FAIL'}  ` +
    `band=${(planEv?.band ?? '?').padEnd(9)} ` +
    `airtime=${airtime.toFixed(1).padStart(6)}s  ${goodput.toFixed(0).padStart(5)} B/s  ` +
    `hash=${got?.ok ? 'ok' : '--'}  wall=${wall.toFixed(0)}s`
  );
  return { match, goodput, planEv, got, airtime };
}

console.log('=== Full transfers through a simulated room ===');
console.log('  scenario                       result  band       airtime   goodput');

{
  const r = await runTransfer('2 KB, office', randBytes(2048),
    { room: 'office', noiseRms: 0.006, ppm: 25 });
  ok(r.match, '2 KB office transfer mismatched');
  ok(r.got?.ok, '2 KB hash verification failed');
  ok(r.planEv?.band === 'silent', `small file should stay silent, got ${r.planEv?.band}`);
}
{
  const r = await runTransfer('12 KB text, office', textBytes(12288),
    { room: 'office', noiseRms: 0.01, ppm: 30 });
  ok(r.match, '12 KB text transfer mismatched');
}
{
  const r = await runTransfer('12 KB random, desk', randBytes(12288),
    { room: 'desk', noiseRms: 0.004, ppm: 20 });
  ok(r.match, '12 KB desk transfer mismatched');
}
{
  const r = await runTransfer('12 KB, noisy hall', randBytes(12288),
    { room: 'hall', noiseRms: 0.05, ppm: 60 });
  ok(r.match, '12 KB noisy hall transfer mismatched');
}
{
  const r = await runTransfer('8 KB, silent forced', randBytes(8192),
    { room: 'office', noiseRms: 0.008, ppm: 25 }, { maxComfort: 0 });
  ok(r.match, 'silent-band transfer mismatched');
  ok(r.planEv?.band === 'silent', `expected silent, got ${r.planEv?.band}`);
}

console.log('\n=== Band escalation: tight deadline should go louder ===');
{
  const r = await runTransfer('48 KB, 30 s budget', randBytes(48 * 1024),
    { room: 'office', noiseRms: 0.008, ppm: 30 }, { budgetSec: 30 });
  ok(r.match, '48 KB transfer mismatched');
  ok(r.planEv && r.planEv.band !== 'silent',
     `a tight budget should escalate past silent, got ${r.planEv?.band}`);
  if (r.goodput > 0) {
    const tenMb = (10 * 1024 * 1024) / r.goodput;
    console.log(`\n  measured end-to-end goodput : ${r.goodput.toFixed(0)} B/s on the ${r.planEv?.band} band`);
    console.log(`  that rate implies 10 MB in  : ${(tenMb / 60).toFixed(0)} minutes`);
    console.log('  (includes handshake and acknowledgement airtime; long transfers amortise it,');
    console.log('   and compressible files go proportionally faster since gzip runs first)');
  }
}

console.log('\n=== Resilience: a quarter of all bursts destroyed in flight ===');
{
  const r = await runTransfer('12 KB, 25% bursts dropped', randBytes(12288),
    { room: 'office', noiseRms: 0.01, ppm: 30 }, { dropRate: 0.25 });
  ok(r.match, '25% burst loss was not recovered');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
