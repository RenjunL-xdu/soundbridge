// Band plans and automatic selection.
//
// Four rungs from silent to fast. The system sounds the channel once across the
// widest band, then picks the *quietest* plan that still finishes the file in
// the user's time budget — so a 2 KB payload stays inaudible and only a 10 MB
// one reaches into the audible spectrum, and only as far as it needs to.

import { makeCarrierPlan, applyGainMask } from '../dsp/ofdm.js';
import { loudnessMask } from '../dsp/psycho.js';
import { allocateBits, goodputBps } from '../dsp/sounder.js';

/**
 * Cyclic prefix is never shorter than ~5.3 ms at 48 kHz. The simulation showed
 * a 2.7 ms prefix leaves an error floor that no extra transmit power can fix,
 * because the first strong room reflection arrives 3-5 ms after the direct path.
 */
export const BANDS = [
  {
    id: 'silent',
    name: 'Silent',
    blurb: 'Near-ultrasonic. Inaudible to essentially all adults.',
    fLo: 17500, fHi: 20000,
    N: 2048, cp: 512, pilotEvery: 8,
    shaping: 0,          // nothing here is audible, so no shaping needed
    audible: false,
    comfort: 0,
  },
  {
    id: 'discreet',
    name: 'Discreet',
    blurb: 'Extends down to 14 kHz. Most adults hear nothing; children may.',
    fLo: 14000, fHi: 20000,
    N: 2048, cp: 384, pilotEvery: 8,
    shaping: 0.5,
    audible: true,
    comfort: 1,
  },
  {
    id: 'audible',
    name: 'Audible',
    blurb: 'From 4 kHz up. Clearly audible as a soft hiss.',
    fLo: 4000, fHi: 20000,
    N: 2048, cp: 320, pilotEvery: 8,
    shaping: 0.75,
    audible: true,
    comfort: 2,
  },
  {
    id: 'full',
    name: 'Full spectrum',
    blurb: 'The whole usable range. Sounds like a dial-up modem. Fastest.',
    fLo: 400, fHi: 20000,
    N: 2048, cp: 256, pilotEvery: 8,
    shaping: 0.8,
    audible: true,
    comfort: 3,
  },
];

export function bandById(id) {
  return BANDS.find(b => b.id === id) || BANDS[0];
}

/** Build a carrier plan for a band at a given sample rate, with shaping applied. */
export function buildPlan(band, fs) {
  // Above ~20 kHz consumer hardware filters hard regardless of sample rate.
  const fHi = Math.min(band.fHi, fs / 2 - 1200);
  const plan = makeCarrierPlan({
    fs, N: band.N, cp: band.cp,
    fLo: band.fLo, fHi,
    pilotEvery: band.pilotEvery,
  });
  if (band.shaping > 0) {
    applyGainMask(plan, f => loudnessMask(f, band.shaping));
  }
  plan.band = band;
  return plan;
}

/**
 * Score every band against a measured channel and pick one.
 *
 * @param snrByHz  function(hz) -> measured SNR dB, from the wideband sounding
 * @param fileSize bytes to move
 * @param opts.fs
 * @param opts.maxComfort  highest comfort level the user will accept (0-3)
 * @param opts.budgetSec   preferred completion time; we escalate to reach it
 * @param opts.gapDb       SNR gap; must match on both ends of the link
 */
export function bitLoadFor(plan, snrByHz, gapDb) {
  const snrDb = new Float64Array(plan.N).fill(-99);
  for (const k of plan.carriers) snrDb[k] = snrByHz(k * plan.binHz);
  return allocateBits(plan, snrDb, gapDb === undefined ? {} : { gapDb });
}

export function selectBand(snrByHz, fileSize, opts = {}) {
  const fs = opts.fs ?? 48000;
  const maxComfort = opts.maxComfort ?? 3;
  const budgetSec = opts.budgetSec ?? 300;
  const gapDb = opts.gapDb;

  const candidates = [];
  for (const band of BANDS) {
    if (band.comfort > maxComfort) continue;
    let plan;
    try { plan = buildPlan(band, fs); } catch { continue; }

    const snrDb = new Float64Array(plan.N).fill(-99);
    for (const k of plan.carriers) snrDb[k] = snrByHz(k * plan.binHz);

    const alloc = allocateBits(plan, snrDb, gapDb === undefined ? {} : { gapDb });
    const bps = goodputBps(plan, alloc.totalBits);
    const seconds = bps > 0 ? fileSize / bps : Infinity;

    candidates.push({ band, plan, alloc, bytesPerSec: bps, seconds });
  }

  if (!candidates.length) return null;

  // quietest option that lands inside the budget; otherwise simply the fastest
  const inBudget = candidates.filter(c => c.seconds <= budgetSec);
  const chosen = inBudget.length
    ? inBudget.sort((a, b) => a.band.comfort - b.band.comfort)[0]
    : candidates.sort((a, b) => a.seconds - b.seconds)[0];

  return { ...chosen, alternatives: candidates, metBudget: inBudget.length > 0 };
}

export function formatDuration(sec) {
  if (!isFinite(sec)) return '--';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
