// 设备自检：播放频率扫描并听回来，测量扬声器、麦克风与房间的联合响应。

import { AudioIO } from '../audio/io.js';
import { linearChirp } from '../dsp/chirp.js';
import { fft, nextPow2 } from '../dsp/fft.js';
import { taperEdges } from '../dsp/window.js';
import { BANDS, buildPlan, bitLoadFor } from '../proto/bands.js';
import { goodputBps, DEFAULT_GAP_DB } from '../dsp/sounder.js';

const $ = (id) => document.getElementById(id);
const BAND_NAMES = { silent: '极静', discreet: '轻声', audible: '清晰', full: '极速' };
let toastTimer = null;

function toast(message, ms = 5200) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`;
}

function friendlyError(err) {
  if (err?.name === 'NotAllowedError') return '麦克风权限被拒绝。请允许页面使用麦克风后重试。';
  if (err?.name === 'NotFoundError') return '没有找到可用的麦克风。';
  if (err?.name === 'NotReadableError') return '麦克风正被其他应用占用。';
  if (!window.isSecureContext) return '麦克风需要 HTTPS 页面。请从 localhost 或 HTTPS 地址打开。';
  return err?.message || '测量过程中发生未知错误。';
}

const SWEEP_LO = 200;
const SWEEP_HI = 21000;
const SWEEP_SEC = 2.5;

/** Average power spectrum in dB on a fixed frequency grid. */
function spectrumDb(samples, fs, bins = 256) {
  const n = nextPow2(Math.min(samples.length, 1 << 16));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const take = Math.min(samples.length, n);
  for (let i = 0; i < take; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(take - 1, 1));
    re[i] = samples[i] * w;
  }
  fft(re, im);

  const out = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const fLo = (b / bins) * (fs / 2);
    const fHi = ((b + 1) / bins) * (fs / 2);
    const kLo = Math.max(1, Math.floor((fLo * n) / fs));
    const kHi = Math.min(n / 2 - 1, Math.ceil((fHi * n) / fs));
    let acc = 0;
    let count = 0;
    for (let k = kLo; k <= kHi; k++) {
      acc += re[k] * re[k] + im[k] * im[k];
      count++;
    }
    out[b] = 10 * Math.log10(Math.max(acc / Math.max(count, 1), 1e-20));
  }
  return out;
}

function draw(canvas, snr, noise, fs) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const colour = (name) => css.getPropertyValue(name).trim() || '#888';
  const W = canvas.width;
  const H = canvas.height;
  const pad = { l: 48, r: 14, t: 14, b: 30 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = colour('--surface-solid');
  ctx.fillRect(0, 0, W, H);

  const maxHz = fs / 2;
  const x = (hz) => pad.l + (hz / maxHz) * innerW;
  const lo = -12;
  const hi = 52;
  const y = (db) => pad.t + innerH - ((db - lo) / (hi - lo)) * innerH;

  ctx.strokeStyle = colour('--rule');
  ctx.lineWidth = 1;
  ctx.fillStyle = colour('--ink-3');
  ctx.font = '10px ui-monospace, monospace';
  for (let db = lo; db <= hi; db += 10) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(db));
    ctx.lineTo(W - pad.r, y(db));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(`${db}`, pad.l - 7, y(db) + 3);
  }
  ctx.textAlign = 'center';
  for (let hz = 0; hz <= maxHz; hz += 4000) {
    ctx.beginPath();
    ctx.moveTo(x(hz), pad.t);
    ctx.lineTo(x(hz), pad.t + innerH);
    ctx.stroke();
    ctx.fillText(hz === 0 ? '0' : `${hz / 1000}k`, x(hz), H - 9);
  }

  ctx.strokeStyle = colour('--ink-3');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, y(DEFAULT_GAP_DB));
  ctx.lineTo(W - pad.r, y(DEFAULT_GAP_DB));
  ctx.stroke();
  ctx.setLineDash([]);

  const plot = (values, colourValue, fill) => {
    ctx.beginPath();
    for (let b = 0; b < values.length; b++) {
      const hz = ((b + 0.5) / values.length) * maxHz;
      const py = Math.max(pad.t, Math.min(pad.t + innerH, y(values[b])));
      if (b === 0) ctx.moveTo(x(hz), py);
      else ctx.lineTo(x(hz), py);
    }
    ctx.strokeStyle = colourValue;
    ctx.lineWidth = 1.7;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(x(maxHz), pad.t + innerH);
      ctx.lineTo(pad.l, pad.t + innerH);
      ctx.closePath();
      ctx.globalAlpha = 0.11;
      ctx.fillStyle = colourValue;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };

  plot(noise, colour('--warn'), false);
  plot(snr, colour('--accent'), true);

  ctx.fillStyle = colour('--ink-3');
  ctx.textAlign = 'right';
  ctx.fillText('频率', W - pad.r, H - 9);
}

$('runBtn').addEventListener('click', async () => {
  const button = $('runBtn');
  button.disabled = true;
  $('results').hidden = false;
  $('bandTable').hidden = true;
  $('phase').textContent = '正在启动音频';
  $('verdict').textContent = '测量中';
  $('notes').textContent = '';

  let io = null;
  try {
    if (!window.isSecureContext) throw new Error('麦克风需要 HTTPS 页面。');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持麦克风访问。');

    io = new AudioIO();
    await io.start();
    const fs = io.sampleRate;
    $('sr').textContent = `${fs} Hz`;
    for (const note of io.diagnostics()) {
      if (/Sample rate/i.test(note)) toast('当前采样率偏低，可用的高频范围会受到限制。', 7000);
    }

    $('phase').textContent = '正在测量环境噪声';
    const quiet = await io.listen(1.2);
    const noiseDb = spectrumDb(quiet, fs);

    $('phase').textContent = '正在播放频率扫描';
    const sweep = linearChirp(SWEEP_LO, Math.min(SWEEP_HI, fs / 2 - 800), SWEEP_SEC, fs);
    taperEdges(sweep, Math.round(0.02 * fs));

    const collected = io.listen(SWEEP_SEC + 0.7);
    await io.send(sweep);
    const heard = await collected;
    const sweepDb = spectrumDb(heard, fs);

    const bins = noiseDb.length;
    const snr = new Float64Array(bins);
    for (let b = 0; b < bins; b++) snr[b] = sweepDb[b] - noiseDb[b];

    const noiseAverage = noiseDb.reduce((sum, value) => sum + value, 0) / bins;
    draw($('chart'), snr, noiseDb.map((value) => value - noiseAverage), fs);

    let topHz = 0;
    for (let b = bins - 1; b >= 0; b--) {
      if (snr[b] > DEFAULT_GAP_DB) {
        topHz = ((b + 0.5) / bins) * (fs / 2);
        break;
      }
    }
    $('top').textContent = topHz > 0 ? `${(topHz / 1000).toFixed(1)} kHz` : '不可用';

    const snrAt = (hz) => {
      const b = Math.max(0, Math.min(bins - 1, Math.round((hz / (fs / 2)) * bins - 0.5)));
      return snr[b];
    };

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

    $('bandRows').innerHTML = rows.map((row) => `
      <tr>
        <td>${BAND_NAMES[row.band.id] || row.band.name}</td>
        <td>${(row.band.fLo / 1000).toFixed(1)}–${(row.band.fHi / 1000).toFixed(0)} kHz</td>
        <td>${row.alloc.used} / ${row.plan.data.length}</td>
        <td>${row.bps > 0 ? `${Math.round(row.bps)} B/s` : '—'}</td>
        <td>${row.bps > 0 ? fmtDuration((10 * 1024 * 1024) / row.bps) : '—'}</td>
      </tr>`).join('');
    $('bandTable').hidden = false;

    const silent = rows.find((row) => row.band.id === 'silent');
    $('best').textContent = best && best.bps > 0 ? BAND_NAMES[best.band.id] || best.band.name : '无可用';
    $('speed').textContent = best && best.bps > 0 ? `${Math.round(best.bps)} B/s` : '—';

    const notes = [];
    if (topHz < 17000) {
      notes.push('这台设备对 17 kHz 以上频段的响应较弱，极静传输可能不可用；“清晰”和“极速”模式仍可工作。');
    } else if (silent?.alloc.used > 0) {
      notes.push('近超声频段可用，这台设备支持极静模式。');
    }
    if (fs < 44100) notes.push('采样率偏低，高频传输能力会受到限制。');
    if (!best || best.bps <= 0) {
      notes.push('没有检测到可用频段。请检查音量、麦克风权限，并确认没有连接蓝牙音频设备。');
    }
    notes.push('自检只代表当前音量、距离和房间环境。移动设备或改变角度后，结果可能变化。');
    $('notes').textContent = notes.join(' ');

    $('phase').textContent = '测量完成';
    const verdict = $('verdict');
    verdict.textContent = topHz >= 18500 ? '优秀' : topHz >= 17000 ? '良好' : topHz > 0 ? '仅可听频段' : '不可用';
    verdict.classList.toggle('audible', topHz < 17000);
  } catch (err) {
    $('phase').textContent = '测量失败';
    $('notes').textContent = friendlyError(err);
    $('verdict').textContent = '失败';
    $('verdict').classList.add('audible');
  } finally {
    if (io) await io.stop().catch(() => {});
    button.disabled = false;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
