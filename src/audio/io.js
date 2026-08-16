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

/**
 * How much previously-returned audio to prepend to the next capture window.
 *
 * Must exceed the longest burst, or a burst straddling the boundary between two
 * windows is torn in half and lost by both. Duplicated audio is harmless: repeat
 * packets are idempotent at every layer above.
 */
export const CAPTURE_OVERLAP_SEC = 2.0;

export class AudioIO {
  constructor({ onLevel } = {}) {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    // Capture is continuous. Frames accumulate here from the moment the
    // microphone opens and are only drained by listen(), never discarded.
    //
    // The previous design captured for a fixed window, then threw away
    // everything that arrived while the DSP was running. Two independently
    // free-running devices then had to coincidentally align their transmit and
    // receive phases, which they do not. Worse, the microphone callback fires on
    // the main thread: if the main thread is mid-FFT the messages simply queue
    // and arrive later, so accumulating them loses nothing even when processing
    // overruns.
    this.pending = [];
    this.pendingLen = 0;
    this.tail = null;
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
      if (this.capturing) { this.pending.push(frame); this.pendingLen += frame.length; }
      if (this.onLevel) {
        let peak = 0;
        for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; }
        this.onLevel(peak);
      }
    };
    src.connect(this.node);
    this.capturing = true;   // start listening the moment the microphone opens
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

    // Stop listening while we talk, and discard the overlap: our own burst
    // leaks into it and would be decoded back as if the far end had sent it.
    this.capturing = false;
    this.pending = []; this.pendingLen = 0; this.tail = null;

    const done = new Promise(res => { src.onended = res; });
    src.start();
    await done;
    // let the room's reverb tail decay before trusting the microphone again
    await new Promise(r => setTimeout(r, 80));
    this.pending = []; this.pendingLen = 0;
    this.capturing = true;
  }

  /**
   * Return everything heard since the last call, waiting until at least
   * `seconds` of fresh audio has arrived.
   *
   * The returned window is deliberately longer than `seconds`: it carries an
   * overlap from the previous window so a burst spanning the join survives, and
   * it includes anything that piled up while the caller was busy decoding.
   */
  async listen(seconds) {
    this.capturing = true;
    const need = Math.round(seconds * this.sampleRate);
    while (this.pendingLen < need) {
      await new Promise(r => setTimeout(r, 25));
      if (!this.ctx) return new Float64Array(0);   // stopped mid-wait
    }

    const parts = this.pending;
    const fresh = this.pendingLen;
    this.pending = []; this.pendingLen = 0;

    const tailLen = this.tail ? this.tail.length : 0;
    const out = new Float64Array(tailLen + fresh);
    if (this.tail) out.set(this.tail, 0);
    let o = tailLen;
    for (const p of parts) { out.set(p, o); o += p.length; }

    const keep = Math.min(out.length, Math.round(CAPTURE_OVERLAP_SEC * this.sampleRate));
    this.tail = out.slice(out.length - keep);
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
