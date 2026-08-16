// Capture worklet: ships raw microphone frames to the main thread.
// Runs on the audio render thread, so it does no work beyond copying.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.enabled && input && input[0]) {
      // slice() because the render quantum buffer is reused between callbacks
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('sonar-recorder', RecorderProcessor);
