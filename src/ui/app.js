// 声桥界面：发送端、接收端、安装提示与移动端生命周期管理。
// 声学调制和文件重组由 proto/session.js 提供。

import { AudioIO } from '../audio/io.js';
import { SenderSession, ReceiverSession } from '../proto/session.js';
import { BANDS } from '../proto/bands.js';

const $ = (id) => document.getElementById(id);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

const BAND_NAMES = {
  silent: '极静',
  discreet: '轻声',
  audible: '清晰',
  full: '极速',
};

const COMFORT_HINTS = [
  '只使用 17.5–20 kHz 的近超声频段。最安静，也最挑设备。',
  '从 14 kHz 起使用频谱。大多数成年人几乎听不到，传输速度适中。',
  '从 4 kHz 起使用更宽的频谱，听起来像轻柔的白噪声。',
  '使用 0.8–20 kHz 的完整可用频段，速度最快，声音也最明显。',
];

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};

const fmtRate = (bps) => {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
};

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  if (s < 1) return '不足 1 秒';
  if (s < 60) return `${Math.ceil(s)} 秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = Math.round(s % 60);
    return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function friendlyError(err) {
  const message = String(err?.message || err || '');
  if (err?.name === 'NotAllowedError' || /permission denied/i.test(message)) {
    return '麦克风权限被拒绝。请允许当前页面使用麦克风，然后重试。';
  }
  if (err?.name === 'NotFoundError' || /requested device not found/i.test(message)) {
    return '没有找到可用的麦克风。请检查系统声音输入设置。';
  }
  if (err?.name === 'NotReadableError') {
    return '麦克风正被其他应用占用，请关闭通话或录音应用后重试。';
  }
  if (err?.name === 'SecurityError' || /secure context/i.test(message)) {
    return '浏览器只允许 HTTPS 页面访问麦克风。请通过 HTTPS 地址打开声桥。';
  }
  if (/no receiver answered/i.test(message)) {
    return '没有收到接收端的回应。请确认另一台设备已经点击“开始监听”，并让两台设备靠近。';
  }
  if (/receiver answered but measured no usable subcarriers/i.test(message)) {
    return '接收端听到了声音，但可用频段太少。请靠近设备、提高音量，或改用“清晰 / 极速”模式。';
  }
  if (/never received a transfer plan/i.test(message)) {
    return '接收端没有收到传输参数。请让两台设备保持不动，然后重新发送。';
  }
  if (/transfer stalled/i.test(message)) {
    return '传输中途停止了。请靠近设备、保持环境安静，然后重新开始。';
  }
  if (/AudioIO\.start\(\) first/i.test(message)) {
    return '音频系统还没有启动，请重新点击开始。';
  }
  return message || '发生未知错误，请刷新页面后重试。';
}

function friendlyDiagnostic(note) {
  if (/Echo cancellation/i.test(note)) {
    return '浏览器仍开启了回声消除，可能阻碍声波解码。请关闭系统通话增强或换一个浏览器。';
  }
  if (/Noise suppression/i.test(note)) {
    return '浏览器仍开启了噪声抑制，高频载波可能被移除。请在麦克风设置中关闭。';
  }
  if (/Automatic gain control/i.test(note)) {
    return '浏览器仍开启了自动增益，信号强度可能漂移。请尝试关闭该选项。';
  }
  if (/Sample rate is only/i.test(note)) {
    return '当前采样率偏低，高频传输能力会受到限制。';
  }
  return note;
}

let toastTimer = null;
function toast(message, ms = 4400) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------- tabs
function activatePanel(name, updateHash = true) {
  if (!['send', 'receive', 'about'].includes(name)) name = 'send';
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.panel === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (updateHash) history.replaceState(null, '', `#${name}`);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
});
activatePanel(location.hash.slice(1) || 'send', false);

// --------------------------------------------------------- install prompt
let installPrompt = null;
const installBtn = $('installBtn');

if (!isStandalone && (isIos || window.matchMedia('(display-mode: browser)').matches)) {
  installBtn.hidden = false;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    installBtn.hidden = true;
    return;
  }
  if (isIos) {
    toast('在 Safari 底部的“分享”菜单里选择“添加到主屏幕”，即可像 App 一样使用。', 7500);
  } else {
    toast('打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。', 6000);
  }
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  toast('声桥已安装，可以离线打开。');
});

// ------------------------------------------------------- screen wake lock
let wakeLock = null;
let wakeRequested = false;

async function keepAwake() {
  wakeRequested = true;
  if (!('wakeLock' in navigator)) return;
  try {
    if (!wakeLock || wakeLock.released) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    // 不支持或省电模式禁止时静默降级，不影响传输。
  }
}

async function releaseWakeLock() {
  wakeRequested = false;
  if (wakeLock) {
    try { await wakeLock.release(); } catch { /* noop */ }
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeRequested) keepAwake();
});

// ------------------------------------------------------------- send setup
let chosenFile = null;
let comfortValue = 2;
let budgetMinutes = 5;
let sendIO = null;
let sendSession = null;
let sendStopped = false;
let sendTimer = null;
let transferStartedAt = 0;

const dropEl = $('drop');
const fileEl = $('file');
const sendBtn = $('sendBtn');

dropEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropEl.classList.add('is-over');
});
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('is-over'));
dropEl.addEventListener('drop', (event) => {
  event.preventDefault();
  dropEl.classList.remove('is-over');
  if (event.dataTransfer.files[0]) setFile(event.dataTransfer.files[0]);
});
fileEl.addEventListener('change', () => {
  if (fileEl.files[0]) setFile(fileEl.files[0]);
});

function setFile(file) {
  chosenFile = file;
  dropEl.classList.add('has-file');
  $('dropMain').textContent = file.name;
  $('fileInfo').textContent = `${fmtBytes(file.size)} · ${file.type || '未知类型'}`;
  $('dropAction').textContent = '点击更换';
  sendBtn.disabled = false;
  if (file.size > 5 * 1024 * 1024) {
    toast('文件较大，声音传输需要较长时间。开始后界面会显示实时速度与剩余时间。', 6500);
  }
}

document.querySelectorAll('#comfortChoices .choice').forEach((button) => {
  button.addEventListener('click', () => {
    comfortValue = Number(button.dataset.value);
    document.querySelectorAll('#comfortChoices .choice').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-checked', String(active));
    });
    $('comfortHint').textContent = COMFORT_HINTS[comfortValue];
  });
});

document.querySelectorAll('#budgetChoices .pill').forEach((button) => {
  button.addEventListener('click', () => {
    budgetMinutes = Number(button.dataset.budget);
    document.querySelectorAll('#budgetChoices .pill').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-checked', String(active));
    });
  });
});

function startSendTimer() {
  clearInterval(sendTimer);
  transferStartedAt = Date.now();
  $('sendElapsed').textContent = '0 秒';
  sendTimer = setInterval(() => {
    if (!transferStartedAt) return;
    $('sendElapsed').textContent = fmtDuration((Date.now() - transferStartedAt) / 1000);
  }, 1000);
}

function setProgress(barId, percentId, fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  $(barId).style.width = `${pct}%`;
  $(percentId).textContent = `${pct}%`;
  return pct;
}

sendBtn.addEventListener('click', async () => {
  if (!chosenFile || sendSession) return;
  sendStopped = false;
  sendBtn.disabled = true;
  sendBtn.classList.add('is-busy');
  $('sendStop').hidden = false;
  $('sendStop').disabled = false;
  $('sendStatus').hidden = false;
  $('sendPercent').textContent = '0%';
  $('sendBar').style.width = '0%';
  $('sendPhase').textContent = '正在启动音频';
  $('sendBand').textContent = '搜索中';
  $('sendBand').classList.remove('audible');
  $('sendElapsed').textContent = '0 秒';
  $('sendEta').textContent = '—';
  $('sendRate').textContent = '—';
  $('sendChunks').textContent = '—';
  $('sendNote').textContent = '正在打开麦克风，并用声音寻找接收端。';
  $('sendNote').className = 'note';
  $('sendWave').classList.add('is-live');
  keepAwake();

  try {
    if (!window.isSecureContext) {
      throw new Error('麦克风需要 HTTPS 页面。请从 localhost 或 HTTPS 地址打开声桥。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个浏览器不支持麦克风访问，请使用最新版 Chrome、Edge 或 Safari。');
    }

    sendIO = new AudioIO();
    await sendIO.start();
    sendIO.diagnostics().forEach((note) => toast(friendlyDiagnostic(note), 8000));

    const bytes = new Uint8Array(await chosenFile.arrayBuffer());
    sendSession = new SenderSession(sendIO, {
      fs: sendIO.sampleRate,
      maxComfort: comfortValue,
      budgetSec: budgetMinutes * 60,
      onEvent: (event) => {
        if (event.type === 'prepared') {
          if (event.compressed) {
            $('sendNote').textContent = `压缩后从 ${fmtBytes(event.rawSize)} 降至 ${fmtBytes(event.size)}，可减少播放时间。`;
          }
        } else if (event.type === 'handshake') {
          $('sendPhase').textContent = event.attempt === 0 ? '正在寻找接收端' : `重新寻找接收端 · ${event.attempt + 1}`;
          $('sendBand').textContent = '搜索中';
          $('sendNote').textContent = '请确认接收端已经点击“开始监听”，并让两台设备保持靠近。';
          $('sendNote').className = 'note';
        } else if (event.type === 'plan') {
          startSendTimer();
          $('sendPhase').textContent = '文件正在穿过声音';
          $('sendBand').textContent = BAND_NAMES[event.band] || event.bandName;
          $('sendBand').classList.toggle('audible', !!event.audible);
          $('sendEta').textContent = fmtDuration(event.eta);
          $('sendRate').textContent = fmtRate(event.bytesPerSec);
          $('sendChunks').textContent = `0 / ${event.chunks}`;
          if (!event.metBudget) {
            $('sendNote').textContent = '当前房间达不到所选时间目标，已自动使用最快可用方案。';
            $('sendNote').className = 'note warn';
          } else if (event.audible) {
            $('sendNote').textContent = '传输正在进行。请保持音量适中，环境安静，两台设备不要移动。';
            $('sendNote').className = 'note';
          }
        } else if (event.type === 'progress') {
          setProgress('sendBar', 'sendPercent', event.fraction);
          $('sendElapsed').textContent = fmtDuration(event.elapsed);
          $('sendChunks').textContent = `${event.chunksDone} / ${event.chunks}`;
          if (event.fraction > 0.01) {
            $('sendEta').textContent = fmtDuration(Math.max(0, event.elapsed / event.fraction - event.elapsed));
          }
        } else if (event.type === 'timeout') {
          $('sendPhase').textContent = '传输超时';
          $('sendNote').textContent = '接收端长时间没有确认进度，请靠近设备后重新发送。';
          $('sendNote').className = 'note bad';
          $('sendWave').classList.remove('is-live');
        } else if (event.type === 'complete') {
          clearInterval(sendTimer);
          sendTimer = null;
          $('sendWave').classList.remove('is-live');
          $('sendBand').textContent = sendStopped || event.aborted ? '已停止' : '已完成';
          $('sendPhase').textContent = sendStopped || event.aborted ? '发送已停止' : '发送完成';
          $('sendElapsed').textContent = fmtDuration(event.elapsed);
          if (!(sendStopped || event.aborted)) {
            setProgress('sendBar', 'sendPercent', 1);
            $('sendNote').textContent = '接收端已确认文件完整到达。';
            $('sendNote').className = 'note good';
          }
        }
      },
    });

    await sendSession.send(bytes, { name: chosenFile.name, mime: chosenFile.type });
  } catch (err) {
    clearInterval(sendTimer);
    sendTimer = null;
    $('sendWave').classList.remove('is-live');
    if (sendStopped) {
      $('sendPhase').textContent = '发送已停止';
      $('sendBand').textContent = '已停止';
      $('sendNote').textContent = '本次声音播放已经结束，可以重新开始。';
      $('sendNote').className = 'note';
    } else {
      $('sendPhase').textContent = '发送失败';
      $('sendNote').textContent = friendlyError(err);
      $('sendNote').className = 'note bad';
    }
  } finally {
    clearInterval(sendTimer);
    sendTimer = null;
    if (sendIO) await sendIO.stop().catch(() => {});
    sendIO = null;
    sendSession = null;
    sendBtn.disabled = false;
    sendBtn.classList.remove('is-busy');
    $('sendStop').hidden = true;
    releaseWakeLock();
  }
});

$('sendStop').addEventListener('click', () => {
  if (!sendSession) return;
  sendStopped = true;
  sendSession.abort();
  $('sendStop').disabled = true;
  $('sendPhase').textContent = '正在停止';
  $('sendNote').textContent = '正在结束当前音频片段，请稍候。';
  $('sendNote').className = 'note';
});

// ---------------------------------------------------------- receive setup
let recvIO = null;
let recvSession = null;
let recvStopped = false;
let recvUrl = null;
let lastResult = null;
let recvScanTimer = null;

const recvBtn = $('recvBtn');
const receiveStage = $('receiveStage');

function resetReceiverView() {
  if (recvUrl) {
    URL.revokeObjectURL(recvUrl);
    recvUrl = null;
  }
  lastResult = null;
  $('recvResult').hidden = true;
  $('recvStatus').hidden = false;
  $('recvPercent').textContent = '0%';
  $('recvBar').style.width = '0%';
  $('recvPhase').textContent = '正在聆听';
  $('recvBand').textContent = '等待信号';
  $('recvBand').classList.remove('audible');
  $('recvName').textContent = '—';
  $('recvSize').textContent = '—';
  $('recvChunks').textContent = '扫描 0';
  $('recvQuality').textContent = '—';
  $('recvNote').textContent = '保持安静，让两台设备保持不动。';
  $('recvNote').className = 'note';
  $('recvShare').hidden = true;
}

recvBtn.addEventListener('click', async () => {
  if (recvSession) return;
  recvStopped = false;
  resetReceiverView();
  recvBtn.disabled = true;
  recvBtn.setAttribute('aria-label', '正在监听');
  $('recvBtnLabel').textContent = '正在监听';
  $('recvStop').hidden = false;
  $('recvStop').disabled = false;
  $('meterWrap').hidden = false;
  receiveStage.classList.add('is-listening');
  keepAwake();

  let scans = 0;
  let heardPeaks = 0;

  try {
    if (!window.isSecureContext) {
      throw new Error('麦克风需要 HTTPS 页面。请从 localhost 或 HTTPS 地址打开声桥。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个浏览器不支持麦克风访问，请使用最新版 Chrome、Edge 或 Safari。');
    }

    recvIO = new AudioIO({
      onLevel: (peak) => {
        const level = Math.min(1, peak * 5.5);
        receiveStage.style.setProperty('--level', level.toFixed(3));
        $('meterFill').style.width = `${Math.min(100, peak * 180).toFixed(0)}%`;
      },
    });
    await recvIO.start();
    recvIO.diagnostics().forEach((note) => toast(friendlyDiagnostic(note), 8000));

    recvSession = new ReceiverSession(recvIO, {
      fs: recvIO.sampleRate,
      onEvent: (event) => {
        if (event.type === 'scan') {
          scans++;
          heardPeaks += event.peaks;
          $('recvBand').textContent = heardPeaks ? '检测到声音' : '等待信号';
          $('recvChunks').textContent = `扫描 ${scans}`;
          $('recvQuality').textContent = heardPeaks === 0
            ? '尚无信号'
            : `${heardPeaks} 次信号`;
          if (scans === 6 && heardPeaks === 0) {
            $('recvNote').textContent = '还没有听到发送端。请确认另一台设备已经开始发送，音量已打开，并且没有使用蓝牙耳机。';
            $('recvNote').className = 'note warn';
          } else if (heardPeaks > 0 && event.decoded === 0 && scans > 4) {
            $('recvNote').textContent = '听到了声音，但暂时无法解码。请把设备再靠近一些，并调高发送端音量。';
            $('recvNote').className = 'note warn';
          }
        } else if (event.type === 'found') {
          $('recvPhase').textContent = '已找到发送端 · 正在测量房间';
          $('recvName').textContent = event.name || '未命名文件';
          $('recvSize').textContent = fmtBytes(event.size);
          $('recvNote').textContent = '发送端已连接，正在用一段听不见的扫描音测量可用频段。';
          $('recvNote').className = 'note good';
        } else if (event.type === 'plan') {
          $('recvPhase').textContent = '正在接收文件';
          $('recvBand').textContent = BAND_NAMES[event.band] || event.band;
          const band = BANDS.find((item) => item.id === event.band);
          $('recvBand').classList.toggle('audible', !!band?.audible);
          $('recvName').textContent = event.name || '未命名文件';
          $('recvSize').textContent = fmtBytes(event.size);
          $('recvChunks').textContent = `0 / ${event.chunks}`;
          $('recvNote').textContent = '文件正在通过声音传过来。请保持页面打开，并让设备保持不动。';
          $('recvNote').className = 'note';
        } else if (event.type === 'quality') {
          $('recvQuality').textContent = event.evm < 0.15
            ? '极佳'
            : event.evm < 0.3
              ? '良好'
              : event.evm < 0.5 ? '边缘' : '较差';
        } else if (event.type === 'progress') {
          setProgress('recvBar', 'recvPercent', event.fraction);
          $('recvChunks').textContent = `${event.chunksDone} / ${event.chunks}`;
        } else if (event.type === 'done') {
          $('recvPhase').textContent = '文件已完整接收';
        } else if (event.type === 'timeout') {
          $('recvPhase').textContent = event.phase === 'discovery' ? '没有听到发送端' : '传输已停止';
          $('recvNote').textContent = event.phase === 'discovery'
            ? '超过两分钟没有检测到发送端。请检查设备距离、音量和发送端状态。'
            : '声音信号中断了。请靠近设备，并让发送端重新开始。';
          $('recvNote').className = 'note bad';
        }
      },
    });

    const result = await recvSession.receive();
    if (!result) {
      $('recvPhase').textContent = recvStopped ? '监听已停止' : '没有收到文件';
      $('recvNote').textContent = recvStopped
        ? '本次聆听已经结束，可以点击上方按钮重新开始。'
        : '接收端已停止监听，可以点击上方按钮重新尝试。';
      $('recvNote').className = 'note';
    } else {
      lastResult = result;
      setProgress('recvBar', 'recvPercent', 1);
      $('recvPhase').textContent = result.ok ? '文件已完整接收' : '文件收到，但校验失败';
      $('recvBand').textContent = result.ok ? '校验通过' : '需要重试';

      const blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });
      recvUrl = URL.createObjectURL(blob);
      $('recvDownload').href = recvUrl;
      $('recvDownload').download = result.name || 'received.bin';
      $('recvResultName').textContent = result.name || 'received.bin';
      $('recvFileGlyph').textContent = fileGlyph(result.name);
      $('recvVerify').textContent = result.ok ? 'SHA-256 校验通过 · 文件完整' : '校验不匹配 · 建议重新接收';
      $('recvVerify').className = result.ok ? 'note good' : 'note bad';
      $('recvResult').hidden = false;

      let shareable = false;
      try {
        shareable = typeof File !== 'undefined'
          && typeof navigator.canShare === 'function'
          && navigator.canShare({
            files: [new File(
              [result.bytes],
              result.name || 'received.bin',
              { type: result.mime || 'application/octet-stream' },
            )],
          });
      } catch {
        shareable = false;
      }
      $('recvShare').hidden = !shareable;
    }
  } catch (err) {
    if (recvStopped) {
      $('recvPhase').textContent = '监听已停止';
      $('recvNote').textContent = '本次聆听已经结束，可以点击上方按钮重新开始。';
      $('recvNote').className = 'note';
    } else {
      $('recvPhase').textContent = '接收失败';
      $('recvNote').textContent = friendlyError(err);
      $('recvNote').className = 'note bad';
    }
  } finally {
    if (recvIO) await recvIO.stop().catch(() => {});
    recvIO = null;
    recvSession = null;
    recvBtn.disabled = false;
    recvBtn.setAttribute('aria-label', '开始监听');
    $('recvBtnLabel').textContent = '开始监听';
    $('recvStop').hidden = true;
    $('meterWrap').hidden = true;
    receiveStage.classList.remove('is-listening');
    receiveStage.style.setProperty('--level', '0');
    releaseWakeLock();
  }
});

$('recvStop').addEventListener('click', () => {
  if (!recvSession) return;
  recvStopped = true;
  recvSession.abort();
  $('recvStop').disabled = true;
  $('recvPhase').textContent = '正在停止';
  $('recvNote').textContent = '正在结束本次监听，请稍候。';
  $('recvNote').className = 'note';
});

$('recvAgain').addEventListener('click', () => {
  if (!recvSession && !recvBtn.disabled) recvBtn.click();
});

$('recvShare').addEventListener('click', async () => {
  if (!lastResult) return;
  const file = new File(
    [lastResult.bytes],
    lastResult.name || 'received.bin',
    { type: lastResult.mime || 'application/octet-stream' },
  );
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('系统分享不可用，请使用“保存文件”。');
  }
});

function fileGlyph(name = '') {
  const ext = String(name).includes('.') ? String(name).split('.').pop().replace(/[^a-z0-9]/gi, '').slice(0, 4) : '';
  return ext ? ext.toUpperCase() : 'FILE';
}

// ---------------------------------------------------------- page lifecycle
window.addEventListener('beforeunload', (event) => {
  if (!sendSession && !recvSession) return;
  event.preventDefault();
  event.returnValue = '';
});

if (!window.isSecureContext) {
  setTimeout(() => {
    toast('当前页面不是 HTTPS。播放可继续，但手机浏览器不会开放麦克风。', 8500);
  }, 700);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 本地 file:// 预览或浏览器策略阻止时不影响主功能。
    });
  });
}
