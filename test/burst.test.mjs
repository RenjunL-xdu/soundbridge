// End-to-end burst: encode -> acoustic channel -> detect -> decode.
// This is the integration test that matters; if this holds, the modem works.

import { BANDS, buildPlan } from '../src/proto/bands.js';
import {
  encodeBurst, decodeBurst, BurstDetector, burstCapacity,
  symbolsForDuration, burstLayout, preambleFor,
} from '../src/proto/burst.js';
import { trainingSymbol, estimateChannel } from '../src/dsp/ofdm.js';
import { allocateBits, goodputBps } from '../src/dsp/sounder.js';
import { through, roomFor, ambientNoise } from './channel.js';

const FS = 48000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

/**
 * Sound the channel the way the real receiver does: send two training symbols
 * through the simulated room and estimate SNR per carrier from what comes back.
 */
function soundChannel(plan, chanOpts) {
  const train = trainingSymbol(plan);
  const probe = new Float64Array(plan.symLen * 2);
  probe.set(train, 0);
  probe.set(train, plan.symLen);
  const { samples, offset } = through(probe, plan.fs, { ...chanOpts, padStart: 2000, padEnd: 2000 });
  const s1 = samples.subarray(offset, offset + plan.symLen);
  const s2 = samples.subarray(offset + plan.symLen, offset + plan.symLen * 2);
  return estimateChannel(plan, s1, s2);
}

console.log('=== Preamble detection through the channel ===');
{
  const plan = buildPlan(BANDS[0], FS);
  const det = new BurstDetector(plan);
  console.log('  noiseRms   room     found   err(samples)   ratio');
  for (const noiseRms of [0.002, 0.01, 0.05, 0.15]) {
    for (const room of ['desk', 'office', 'hall']) {
      let found = 0, worstErr = 0, ratioAcc = 0;
      const N = 8;
      for (let t = 0; t < N; t++) {
        const pre = preambleFor(plan);
        const sig = new Float64Array(pre.length + 8000);
        sig.set(pre, 0);
        const { samples, offset } = through(sig, FS, { room, noiseRms, ppm: 30, padStart: 6000 });
        const r = det.find(samples, 20000);
        if (r) {
          found++;
          const err = Math.abs(r.index - offset);
          worstErr = Math.max(worstErr, err);
          ratioAcc += r.ratio;
        }
      }
      console.log(`  ${String(noiseRms).padStart(8)}   ${room.padEnd(7)}  ${found}/${N}    ${String(worstErr).padStart(10)}   ${(ratioAcc / Math.max(found, 1)).toFixed(1).padStart(6)}`);
      if (noiseRms <= 0.05) ok(found === N, `detection failed at noise ${noiseRms} in ${room}`);
    }
  }
}

console.log('\n=== Channel sounding + bit loading per band ===');
const soundings = {};
for (const band of BANDS) {
  const plan = buildPlan(band, FS);
  const chan = soundChannel(plan, { room: 'office', noiseRms: 0.01, ppm: 30 });
  const alloc = allocateBits(plan, chan.snrDb);
  const bps = goodputBps(plan, alloc.totalBits);
  soundings[band.id] = { plan, chan, alloc, bps };
  console.log(
    `  ${band.name.padEnd(14)} carriers ${String(alloc.used).padStart(4)}/${String(plan.data.length).padEnd(4)} ` +
    `medianSNR ${alloc.medianSnr.toFixed(1).padStart(5)}dB  ` +
    `${String(alloc.totalBits).padStart(5)} bits/sym  ${bps.toFixed(0).padStart(6)} B/s  ` +
    `10MB in ${(10485760 / bps / 60).toFixed(1)}min`
  );
  ok(alloc.used > 0, `${band.id}: no usable carriers`);
}

console.log('\n=== Burst round trip (multi-slot) ===');
for (const band of BANDS) {
  const { plan, alloc } = soundings[band.id];
  const symbols = symbolsForDuration(plan, 1.2);
  const cap = burstCapacity(plan, alloc.bitLoad, symbols);
  if (cap.slots < 1) { console.log(`  ${band.name}: burst too small, skipped`); continue; }

  // one distinct packet per slot, so we can count exactly which survive
  const packets = [];
  for (let i = 0; i < cap.slots; i++) packets.push(randBytes(cap.slotPayload));
  const burst = encodeBurst(plan, alloc.bitLoad, packets, symbols);

  let delivered = 0, expected = 0, wrong = 0;
  const N = 6;
  for (let t = 0; t < N; t++) {
    const { samples } = through(burst, FS, { room: 'office', noiseRms: 0.01, ppm: 30, padStart: 5000 });
    const det = new BurstDetector(plan);
    const hit = det.find(samples, 12000);
    expected += cap.slots;
    if (!hit) continue;
    const res = decodeBurst(plan, alloc.bitLoad, samples, hit.index, symbols);
    if (!res) continue;
    res.slots.forEach((s, i) => {
      if (!s) return;
      if (Buffer.compare(Buffer.from(s), Buffer.from(packets[i])) === 0) delivered++;
      else wrong++;
    });
  }
  const dur = burstLayout(plan, symbols).total / FS;
  const rate = delivered / expected;
  console.log(
    `  ${band.name.padEnd(14)} ${cap.slots} slots x ${cap.slotPayload} B, ${symbols} sym, ${dur.toFixed(2)}s  ` +
    `-> ${(rate * 100).toFixed(1)}% slots delivered${wrong ? `, ${wrong} CORRUPT` : ''}`
  );
  ok(rate > 0.9, `${band.id}: only ${(rate * 100).toFixed(1)}% of slots delivered`);
  ok(wrong === 0, `${band.id}: ${wrong} slots decoded to wrong data`);
}

console.log('\n=== Robustness sweep (Full spectrum band, office) ===');
{
  const band = BANDS[3];
  const plan = buildPlan(band, FS);
  console.log('  noiseRms   ppm    alloc bits/sym   recovered');
  for (const noiseRms of [0.003, 0.01, 0.03, 0.08]) {
    for (const ppm of [0, 50, 150]) {
      const chanOpts = { room: 'office', noiseRms, ppm };
      const chan = soundChannel(plan, chanOpts);
      const alloc = allocateBits(plan, chan.snrDb);
      const symbols = symbolsForDuration(plan, 1.0);
      const cap = burstCapacity(plan, alloc.bitLoad, symbols);
      if (cap.slots < 1) { console.log(`  ${String(noiseRms).padStart(8)}   ${String(ppm).padStart(3)}    (no capacity)`); continue; }

      const packets = [];
      for (let i = 0; i < cap.slots; i++) packets.push(randBytes(cap.slotPayload));
      const burst = encodeBurst(plan, alloc.bitLoad, packets, symbols);
      let delivered = 0, expected = 0;
      const N = 5;
      for (let t = 0; t < N; t++) {
        const { samples } = through(burst, FS, { ...chanOpts, padStart: 5000 });
        const det = new BurstDetector(plan);
        const hit = det.find(samples, 12000);
        expected += cap.slots;
        if (!hit) continue;
        const res = decodeBurst(plan, alloc.bitLoad, samples, hit.index, symbols);
        if (!res) continue;
        res.slots.forEach((s, i) => {
          if (s && Buffer.compare(Buffer.from(s), Buffer.from(packets[i])) === 0) delivered++;
        });
      }
      const pct = (delivered / expected * 100).toFixed(0);
      console.log(`  ${String(noiseRms).padStart(8)}   ${String(ppm).padStart(3)}    ${String(alloc.totalBits).padStart(12)}   ${String(pct).padStart(3)}% of ${cap.slots} slots`);
    }
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
