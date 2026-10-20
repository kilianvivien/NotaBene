/* global AudioWorkletProcessor, registerProcessor */
// Microphone samples stay in memory. Flush acknowledges the final partial block
// before the main thread closes the context and finishes the remote session.
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(4096);
    this.offset = 0;
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.finished = true;
        this.flush();
        this.port.postMessage('flushed');
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const samples = this.samples.slice(0, this.offset);
    this.port.postMessage(samples, [samples.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input) {
      for (const sample of input) {
        this.samples[this.offset++] = sample;
        if (this.offset === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('notabene-dictation', DictationProcessor);
