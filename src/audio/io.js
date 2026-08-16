// Browser audio transport.
//
// Provides the { send, listen } interface the session state machines expect,
// backed by a real speaker and microphone. Half duplex: capture is muted while
// we transmit, so we never decode our own burst.

const WORKLET_URL = new URL('./recorder-worklet.js', import.meta.url);

/**
 * Microphone constraints.
 *
 * These three flags are the single most important lines in the whole project.
 * Browsers enable echo cancellation, noise suppression and automatic gain
 * control by default, and every one of them is specifically designed to remove
 * steady tonal content - which is exactly what this system transmits. Leave
 * them on and the receiver hears silence, with no error anywhere to explain it.
 */
export const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export class AudioIO {
  constructor({ onLevel } = {}) {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.buffer = [];
    this.capturing = false;
    this.onLevel = onLevel;
    this.gain = 0.7;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  /** Must be called from a user gesture; iOS will not start audio otherwise. */
  async start() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });

    // Report what we actually got: some platforms silently ignore the request.
    const track = this.stream.getAudioTracks()[0];
    this.settings = track.getSettings ? track.getSettings() : {};

    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'sonar-recorder', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    this.node.port.onmessage = (e) => {
      const frame = e.data;
      if (this.capturing) this.buffer.push(frame);
      if (this.onLevel) {
        let peak = 0;
        for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; }
        this.onLevel(peak);
      }
    };
    src.connect(this.node);
  }

  async stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = null; this.stream = null; this.node = null;
  }

  /** Warn about conditions that make the link impossible. */
  diagnostics() {
    const notes = [];
    const s = this.settings || {};
    if (s.echoCancellation) notes.push('Echo cancellation is still on; the browser overrode the request.');
    if (s.noiseSuppression) notes.push('Noise suppression is still on; high-frequency carriers will be removed.');
    if (s.autoGainControl) notes.push('Automatic gain control is still on; levels will drift during transfer.');
    if (this.sampleRate < 44100) notes.push(`Sample rate is only ${this.sampleRate} Hz; the upper band is unavailable.`);
    return notes;
  }

  /** Play a Float64Array of samples and resolve when playback finishes. */
  async send(samples) {
    const ctx = this.ctx;
    if (!ctx) throw new Error('AudioIO.start() first');

    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = Math.max(-1, Math.min(1, samples[i] * this.gain));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    this.setCapture(false);
    const done = new Promise(res => { src.onended = res; });
    src.start();
    await done;
    // let the room's reverb tail decay before we trust the microphone again
    await new Promise(r => setTimeout(r, 60));
    this.setCapture(true);
  }

  setCapture(on) {
    this.capturing = on;
    if (this.node) this.node.port.postMessage({ enabled: true });
    if (on) this.buffer = [];
  }

  /** Capture for `seconds` and return the samples as a Float64Array. */
  async listen(seconds) {
    this.buffer = [];
    this.capturing = true;
    await new Promise(r => setTimeout(r, seconds * 1000));
    const parts = this.buffer;
    this.buffer = [];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Float64Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Play a bare waveform without any session wrapping (used by calibration). */
export async function playRaw(ctx, samples, gain = 0.6) {
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const done = new Promise(res => { src.onended = res; });
  src.start();
  await done;
}
