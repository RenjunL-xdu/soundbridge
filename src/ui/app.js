// UI wiring for send and receive.

import { AudioIO } from '../audio/io.js';
import { SenderSession, ReceiverSession } from '../proto/session.js';
import { BANDS, formatDuration } from '../proto/bands.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
};

let toastTimer = null;
function toast(msg, ms = 4200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.panel}`);
    });
  });
});

// ---------------------------------------------------------------- send panel
let chosenFile = null;

const dropEl = $('drop');
const fileEl = $('file');

dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('is-over'); });
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('is-over'));
dropEl.addEventListener('drop', e => {
  e.preventDefault();
  dropEl.classList.remove('is-over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileEl.addEventListener('change', () => { if (fileEl.files[0]) setFile(fileEl.files[0]); });

function setFile(f) {
  chosenFile = f;
  $('fileInfo').textContent = `${f.name} — ${fmtBytes(f.size)}`;
  $('sendBtn').disabled = false;
  if (f.size > 5 * 1024 * 1024) {
    toast('Large file: over sound this will take a while. The estimate appears once the room is measured.', 6000);
  }
}

const comfortEl = $('comfort');
function updateComfort() {
  const band = BANDS[+comfortEl.value];
  $('comfortLabel').textContent = band.name;
  $('comfortHint').textContent = band.blurb;
}
comfortEl.addEventListener('input', updateComfort);
updateComfort();

const budgetEl = $('budget');
function updateBudget() {
  const m = +budgetEl.value;
  $('budgetLabel').textContent = m === 1 ? '1 minute' : `${m} minutes`;
}
budgetEl.addEventListener('input', updateBudget);
updateBudget();

let sendIO = null, sendSession = null;

$('sendBtn').addEventListener('click', async () => {
  if (!chosenFile) return;
  $('sendBtn').disabled = true;
  $('sendStop').hidden = false;
  $('sendStatus').hidden = false;
  $('sendBar').style.width = '0%';
  $('sendNote').textContent = '';
  $('sendNote').className = 'note';

  try {
    sendIO = new AudioIO();
    await sendIO.start();
    for (const n of sendIO.diagnostics()) toast(n, 7000);

    const bytes = new Uint8Array(await chosenFile.arrayBuffer());
    let startedAt = Date.now();

    sendSession = new SenderSession(sendIO, {
      fs: sendIO.sampleRate,
      maxComfort: +comfortEl.value,
      budgetSec: +budgetEl.value * 60,
      onEvent: (e) => {
        if (e.type === 'handshake') {
          $('sendPhase').textContent = e.attempt === 0
            ? 'Looking for a receiver…'
            : `Looking for a receiver (try ${e.attempt + 1})…`;
        } else if (e.type === 'plan') {
          startedAt = Date.now();
          $('sendPhase').textContent = 'Sending';
          const chip = $('sendBand');
          chip.textContent = e.bandName;
          chip.classList.toggle('audible', !!e.audible);
          $('sendEta').textContent = e.etaText;
          $('sendRate').textContent = `${e.bytesPerSec.toFixed(0)} B/s`;
          $('sendChunks').textContent = `0 / ${e.chunks}`;
          if (!e.metBudget) {
            $('sendNote').textContent =
              'No band could meet your deadline, so the fastest one was chosen.';
            $('sendNote').className = 'note warn';
          } else if (e.audible) {
            $('sendNote').textContent = 'This band is audible. Keep the volume moderate.';
            $('sendNote').className = 'note warn';
          }
        } else if (e.type === 'progress') {
          const pct = Math.round(e.fraction * 100);
          $('sendBar').style.width = `${pct}%`;
          $('sendChunks').textContent = `${e.chunksDone} / ${e.chunks}`;
          $('sendElapsed').textContent = formatDuration(e.elapsed);
          if (e.fraction > 0.02) {
            const total = e.elapsed / e.fraction;
            $('sendEta').textContent = formatDuration(Math.max(0, total - e.elapsed));
          }
        } else if (e.type === 'timeout') {
          $('sendNote').textContent = 'The receiver stopped responding.';
          $('sendNote').className = 'note bad';
        } else if (e.type === 'complete') {
          $('sendBar').style.width = '100%';
          $('sendPhase').textContent = e.aborted ? 'Stopped' : 'Sent';
          $('sendElapsed').textContent = formatDuration(e.elapsed);
          if (!e.aborted) {
            $('sendNote').textContent = 'The receiver confirmed the file arrived intact.';
            $('sendNote').className = 'note good';
          }
        }
      },
    });

    await sendSession.send(bytes, { name: chosenFile.name, mime: chosenFile.type });
  } catch (err) {
    $('sendPhase').textContent = 'Could not send';
    $('sendNote').textContent = err.message;
    $('sendNote').className = 'note bad';
  } finally {
    if (sendIO) await sendIO.stop();
    sendIO = null; sendSession = null;
    $('sendBtn').disabled = false;
    $('sendStop').hidden = true;
  }
});

$('sendStop').addEventListener('click', () => {
  if (sendSession) sendSession.abort();
  $('sendPhase').textContent = 'Stopping…';
});

// ---------------------------------------------------------------- receive panel
let recvIO = null, recvSession = null, recvUrl = null;

$('recvBtn').addEventListener('click', async () => {
  $('recvBtn').disabled = true;
  $('recvStop').hidden = false;
  $('recvStatus').hidden = false;
  $('recvResult').hidden = true;
  $('meterWrap').hidden = false;
  $('recvBar').style.width = '0%';
  $('recvPhase').textContent = 'Listening…';
  $('recvNote').textContent = '';
  $('recvNote').className = 'note';
  if (recvUrl) { URL.revokeObjectURL(recvUrl); recvUrl = null; }

  try {
    recvIO = new AudioIO({
      onLevel: (peak) => {
        $('meterFill').style.width = `${Math.min(100, peak * 140).toFixed(0)}%`;
      },
    });
    await recvIO.start();
    for (const n of recvIO.diagnostics()) toast(n, 7000);

    recvSession = new ReceiverSession(recvIO, {
      fs: recvIO.sampleRate,
      onEvent: (e) => {
        if (e.type === 'found') {
          $('recvPhase').textContent = 'Sender found — measuring the room';
          $('recvName').textContent = e.name;
          $('recvSize').textContent = fmtBytes(e.size);
        } else if (e.type === 'plan') {
          const band = BANDS.find(b => b.id === e.band);
          $('recvPhase').textContent = 'Receiving';
          const chip = $('recvBand');
          chip.textContent = band ? band.name : e.band;
          chip.classList.toggle('audible', !!band?.audible);
          $('recvName').textContent = e.name;
          $('recvSize').textContent = fmtBytes(e.size);
        } else if (e.type === 'quality') {
          const q = e.evm < 0.15 ? 'excellent' : e.evm < 0.3 ? 'good' : e.evm < 0.5 ? 'marginal' : 'poor';
          $('recvQuality').textContent = q;
        } else if (e.type === 'progress') {
          $('recvBar').style.width = `${Math.round(e.fraction * 100)}%`;
          $('recvChunks').textContent = `${e.chunksDone} / ${e.chunks}`;
        } else if (e.type === 'timeout') {
          $('recvPhase').textContent = e.phase === 'discovery' ? 'No sender heard' : 'Transfer stalled';
          $('recvNote').textContent = e.phase === 'discovery'
            ? 'Nothing was picked up. Check the sending device is nearby with its volume up.'
            : 'The signal stopped part-way through.';
          $('recvNote').className = 'note bad';
        }
      },
    });

    const res = await recvSession.receive();
    if (!res) {
      $('recvPhase').textContent = 'Nothing received';
    } else {
      $('recvBar').style.width = '100%';
      $('recvPhase').textContent = 'Received';
      const blob = new Blob([res.bytes], { type: res.mime || 'application/octet-stream' });
      recvUrl = URL.createObjectURL(blob);
      const a = $('recvDownload');
      a.href = recvUrl;
      a.download = res.name || 'received.bin';
      $('recvResult').hidden = false;
      $('recvVerify').textContent = res.ok
        ? 'Checksum matches the sender. The file is intact.'
        : 'Warning: the checksum does not match. The file may be damaged.';
      $('recvVerify').className = res.ok ? 'note good' : 'note bad';
    }
  } catch (err) {
    $('recvPhase').textContent = 'Could not receive';
    $('recvNote').textContent = err.message;
    $('recvNote').className = 'note bad';
  } finally {
    if (recvIO) await recvIO.stop();
    recvIO = null; recvSession = null;
    $('recvBtn').disabled = false;
    $('recvStop').hidden = true;
    $('meterWrap').hidden = true;
  }
});

$('recvStop').addEventListener('click', () => {
  if (recvSession) recvSession.abort();
  $('recvPhase').textContent = 'Stopping…';
});

// ---------------------------------------------------------------- service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url)).catch(() => {});
  });
}
