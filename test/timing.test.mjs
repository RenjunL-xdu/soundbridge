// Burst durations against capture windows.
//
// This suite exists because of a bug that every other test passed straight
// through: the control burst was 2.513 s while the receiver captured 2.500 s
// windows, so a complete burst could never fit inside one and discovery was
// impossible on real hardware. The channel simulator hid it by handing over
// whole transmissions regardless of length.
//
// These are pure arithmetic checks. They need no audio, no channel and no
// hardware, and they would have caught it immediately.

import { controlSetup, SOUNDING_SYMBOLS, buildSounding } from '../src/proto/session.js';
import { BANDS, buildPlan, bitLoadFor } from '../src/proto/bands.js';
import { burstLayout, burstCapacity, symbolsFor } from '../src/proto/burst.js';
import { CAPTURE_OVERLAP_SEC } from '../src/audio/io.js';

const FS = 48000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// The shortest window any receiver actually assembles: one poll plus the
// overlap carried from the previous poll.
const SHORTEST_POLL = 1.2;
const WINDOW = SHORTEST_POLL + CAPTURE_OVERLAP_SEC;
// A burst must fit with room to spare, not merely fit.
const MIN_SLACK = 0.5;

console.log('=== Burst durations vs capture window ===');
console.log(`  shortest assembled window: ${WINDOW.toFixed(2)} s ` +
            `(${SHORTEST_POLL} s poll + ${CAPTURE_OVERLAP_SEC} s overlap)`);
console.log(`  required slack: ${MIN_SLACK} s\n`);
console.log('  burst                        duration   slack');

function check(label, seconds) {
  const slack = WINDOW - seconds;
  const flag = slack >= MIN_SLACK ? '' : '   <-- TOO LONG';
  console.log(`  ${label.padEnd(28)} ${seconds.toFixed(3)} s  ${slack.toFixed(3)} s${flag}`);
  ok(slack >= MIN_SLACK,
     `${label} is ${seconds.toFixed(3)} s, leaving only ${slack.toFixed(3)} s in a ${WINDOW.toFixed(2)} s window`);
}

// control burst — the one that broke
{
  const c = controlSetup(FS);
  const lay = burstLayout(c.plan, c.symbols);
  const cap = burstCapacity(c.plan, c.bitLoad, c.symbols);
  check('control (BPSK, 1 slot)', lay.total / FS);
  ok(cap.slots >= 1, 'control burst must carry at least one slot');
  ok(cap.slotPayload >= 64, `control slot payload ${cap.slotPayload} B is too small for a header`);
}

// wideband sounding probe
{
  const wide = buildPlan(BANDS[BANDS.length - 1], FS);
  const lay = burstLayout(wide, SOUNDING_SYMBOLS);
  check('wideband sounding', lay.total / FS);
  ok(buildSounding(FS).length === lay.total, 'sounding length disagrees with its layout');
}

// data bursts on every band, at a realistic and at a poor channel
for (const snr of [24, 12]) {
  for (const band of BANDS) {
    const plan = buildPlan(band, FS);
    const alloc = bitLoadFor(plan, () => snr, 11);
    const sym = symbolsFor(plan, alloc.bitLoad, 1.4, 1);
    if (sym <= 0) { console.log(`  ${(band.name + ' @ ' + snr + ' dB').padEnd(28)} (no capacity)`); continue; }
    check(`${band.name} data @ ${snr} dB`, burstLayout(plan, sym).total / FS);
  }
}

console.log('\n=== Sender and receiver windows are mutually reachable ===');
{
  // The receiver must be able to answer inside the sender's listening window,
  // and vice versa, or the handshake relies on luck.
  const c = controlSetup(FS);
  const reply = burstLayout(c.plan, c.symbols).total / FS;
  const senderListens = 3.0;
  console.log(`  reply burst ${reply.toFixed(2)} s into a ${senderListens.toFixed(1)} s window ` +
              `-> ${(senderListens - reply).toFixed(2)} s of slack for the receiver's own processing`);
  ok(senderListens - reply >= 1.0,
     `only ${(senderListens - reply).toFixed(2)} s for the receiver to detect, measure and reply`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
