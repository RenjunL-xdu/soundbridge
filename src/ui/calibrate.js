// Device check: measure what this speaker and microphone can actually reproduce.
//
// Real hardware varies far more than the theory suggests, especially above
// 17 kHz, so measuring beats assuming. This is the first thing worth running on
// a new pair of devices.

import { AudioIO } from '../audio/io.js';
import { linearChirp } from '../dsp/chirp.js';
import { fft, nextPow2 } from '../dsp/fft.js';
import { taperEdges } from '../dsp/window.js';
import { BANDS, buildPlan, bitLoadFor, formatDuration } from '../proto/bands.js';
import { goodputBps, DEFAULT_GAP_DB } from '../dsp/sounder.js';

const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg, ms = 5000) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const SWEEP_LO = 200, SWEEP_HI = 21000, SWEEP_SEC = 2.5;

/** Average power spectrum in dB, on a fixed frequency grid. */
function spectrumDb(samples, fs, bins = 256) {
  const n = nextPow2(Math.min(samples.length, 1 << 16));
  const re = new Float64Array(n), im = new Float64Array(n);
  const take = Math.min(samples.length, n);
  for (let i = 0; i < take; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (take - 1));
    re[i] = samples[i] * w;
  }
  fft(re, im);

  const out = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const fLo = (b / bins) * (fs / 2);
    const fHi = ((b + 1) / bins) * (fs / 2);
    const kLo = Math.max(1, Math.floor((fLo * n) / fs));
    const kHi = Math.min(n / 2 - 1, Math.ceil((fHi * n) / fs));
    let acc = 0, cnt = 0;
    for (let k = kLo; k <= kHi; k++) { acc += re[k] * re[k] + im[k] * im[k]; cnt++; }
    out[b] = 10 * Math.log10(Math.max(acc / Math.max(cnt, 1), 1e-20));
  }
  return out;
}

function draw(canvas, snr, noise, fs) {
  const ctx = canvas.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const col = (n) => cs.getPropertyValue(n).trim() || '#888';
  const W = canvas.width, H = canvas.height;
  const pad = { l: 42, r: 12, t: 12, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = col('--surface'); ctx.fillRect(0, 0, W, H);

  const maxHz = fs / 2;
  const x = (hz) => pad.l + (hz / maxHz) * iw;
  const lo = -10, hi = 50;
  const y = (db) => pad.t + ih - ((db - lo) / (hi - lo)) * ih;

  // grid
  ctx.strokeStyle = col('--rule'); ctx.lineWidth = 1;
  ctx.fillStyle = col('--ink-3'); ctx.font = '10px ui-monospace, monospace';
  for (let db = lo; db <= hi; db += 10) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(db)); ctx.lineTo(W - pad.r, y(db)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(`${db}`, pad.l - 6, y(db) + 3);
  }
  ctx.textAlign = 'center';
  for (let hz = 0; hz <= maxHz; hz += 4000) {
    ctx.beginPath(); ctx.moveTo(x(hz), pad.t); ctx.lineTo(x(hz), pad.t + ih); ctx.stroke();
    ctx.fillText(hz === 0 ? '0' : `${hz / 1000}k`, x(hz), H - 8);
  }

  // usable threshold
  ctx.strokeStyle = col('--ink-3'); ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(DEFAULT_GAP_DB)); ctx.lineTo(W - pad.r, y(DEFAULT_GAP_DB)); ctx.stroke();
  ctx.setLineDash([]);

  const plot = (arr, colour, fill) => {
    ctx.beginPath();
    for (let b = 0; b < arr.length; b++) {
      const hz = ((b + 0.5) / arr.length) * maxHz;
      const py = Math.max(pad.t, Math.min(pad.t + ih, y(arr[b])));
      b === 0 ? ctx.moveTo(x(hz), py) : ctx.lineTo(x(hz), py);
    }
    ctx.strokeStyle = colour; ctx.lineWidth = 1.6; ctx.stroke();
    if (fill) {
      ctx.lineTo(x(maxHz), pad.t + ih); ctx.lineTo(pad.l, pad.t + ih); ctx.closePath();
      ctx.globalAlpha = 0.12; ctx.fillStyle = colour; ctx.fill(); ctx.globalAlpha = 1;
    }
  };
  plot(noise, col('--warn'), false);
  plot(snr, col('--accent'), true);
}

$('runBtn').addEventListener('click', async () => {
  const btn = $('runBtn');
  btn.disabled = true;
  $('results').hidden = false;
  $('phase').textContent = 'Starting audio…';

  let io = null;
  try {
    io = new AudioIO();
    await io.start();
    const fs = io.sampleRate;
    $('sr').textContent = `${fs} Hz`;
    for (const n of io.diagnostics()) toast(n, 8000);

    // 1. ambient noise floor with nothing playing
    $('phase').textContent = 'Measuring the room…';
    const quiet = await io.listen(1.2);
    const noiseDb = spectrumDb(quiet, fs);

    // 2. sweep
    $('phase').textContent = 'Playing the sweep…';
    const sweep = linearChirp(SWEEP_LO, Math.min(SWEEP_HI, fs / 2 - 800), SWEEP_SEC, fs);
    taperEdges(sweep, Math.round(0.02 * fs));

    const captured = [];
    const collect = io.listen(SWEEP_SEC + 0.7);
    await io.send(sweep);
    const heard = await collect;
    const sweepDb = spectrumDb(heard, fs);

    // 3. SNR per band
    const bins = noiseDb.length;
    const snr = new Float64Array(bins);
    for (let b = 0; b < bins; b++) snr[b] = sweepDb[b] - noiseDb[b];

    // normalise: a flat sweep has equal energy per bin, so the shape is the
    // combined speaker and microphone response
    draw($('chart'), snr, noiseDb.map((d, i) => d - noiseDb.reduce((a, c) => a + c, 0) / bins), fs);

    // highest frequency still comfortably above the usable threshold
    let topHz = 0;
    for (let b = bins - 1; b >= 0; b--) {
      if (snr[b] > DEFAULT_GAP_DB) { topHz = ((b + 0.5) / bins) * (fs / 2); break; }
    }
    $('top').textContent = topHz > 0 ? `${(topHz / 1000).toFixed(1)} kHz` : 'none';

    const snrAt = (hz) => {
      const b = Math.max(0, Math.min(bins - 1, Math.round((hz / (fs / 2)) * bins - 0.5)));
      return snr[b];
    };

    // 4. what each band would deliver
    const rows = [];
    let best = null;
    for (const band of BANDS) {
      let plan;
      try { plan = buildPlan(band, fs); } catch { continue; }
      const alloc = bitLoadFor(plan, snrAt, DEFAULT_GAP_DB);
      const bps = goodputBps(plan, alloc.totalBits);
      rows.push({ band, plan, alloc, bps });
      if (!best || bps > best.bps) best = { band, bps };
    }

    $('bandRows').innerHTML = rows.map(r => `
      <tr>
        <td>${r.band.name}</td>
        <td>${(r.band.fLo / 1000).toFixed(1)}–${(r.band.fHi / 1000).toFixed(0)} kHz</td>
        <td>${r.alloc.used} / ${r.plan.data.length}</td>
        <td>${r.bps > 0 ? r.bps.toFixed(0) + ' B/s' : '—'}</td>
        <td>${r.bps > 0 ? formatDuration((10 * 1024 * 1024) / r.bps) : '—'}</td>
      </tr>`).join('');
    $('bandTable').hidden = false;

    const silent = rows.find(r => r.band.id === 'silent');
    $('best').textContent = best && best.bps > 0 ? best.band.name : 'none';
    $('speed').textContent = best && best.bps > 0 ? `${best.bps.toFixed(0)} B/s` : '—';

    const notes = [];
    if (topHz < 17000) {
      notes.push('This device does not reproduce much above 17 kHz, so silent transfers are not available. Audible bands will still work.');
    } else if (silent && silent.alloc.used > 0) {
      notes.push('Near-ultrasonic works here: silent transfers are available.');
    }
    if (fs < 44100) notes.push(`The sample rate is only ${fs} Hz, which puts the upper band out of reach.`);
    if (!best || best.bps <= 0) {
      notes.push('No band came through usably. Check the volume is up, that output is not going to a Bluetooth device, and that the microphone is not muted.');
    }
    $('notes').textContent = notes.join(' ');
    $('phase').textContent = 'Done';
    const v = $('verdict');
    v.textContent = topHz >= 18500 ? 'Excellent' : topHz >= 17000 ? 'Good' : topHz > 0 ? 'Audible only' : 'Problem';
    v.classList.toggle('audible', topHz < 17000);

  } catch (err) {
    $('phase').textContent = 'Check failed';
    $('notes').textContent = err.message;
  } finally {
    if (io) await io.stop();
    btn.disabled = false;
  }
});
