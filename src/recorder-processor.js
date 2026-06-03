// AudioWorklet that captures microphone audio and ships it to the main thread
// in ~100 ms Float32 chunks. The AudioContext is created at 24 kHz, so these
// samples are already at the rate the Voice Agent API expects — no resampling.
//
// The main thread converts these Float32 chunks to base64 PCM16 and sends them
// as `input.audio` messages over the WebSocket.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // 24 kHz * 0.1 s = 2400 samples per ~100 ms chunk.
    this._targetSamples = 2400;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this._buffer.push(channel[i]);
      }
      if (this._buffer.length >= this._targetSamples) {
        this.port.postMessage(Float32Array.from(this._buffer));
        this._buffer = [];
      }
    }
    // Keep the processor alive.
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
