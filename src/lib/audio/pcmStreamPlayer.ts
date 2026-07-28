import { pcm16ToFloat32 } from './pcm';

/**
 * Small scheduled-buffer player for mono PCM. A bounded cursor avoids building
 * minutes of AudioBufferSourceNodes when inference runs ahead of playback.
 */
export class PcmStreamPlayer {
  private cursor = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly context: AudioContext,
    private readonly sampleRateHz = 24_000,
    private readonly startupBufferSeconds = 0.35,
    private readonly maxFutureSeconds = 4,
  ) {}

  get bufferedSeconds(): number {
    return Math.max(0, this.cursor - this.context.currentTime);
  }

  async enqueue(
    bytes: Uint8Array,
    playbackRate = 1,
    signal?: AbortSignal,
  ): Promise<void> {
    while (this.bufferedSeconds > this.maxFutureSeconds) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    const samples = pcm16ToFloat32(bytes);
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRateHz);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(this.context.destination);
    source.addEventListener('ended', () => this.sources.delete(source), { once: true });
    this.sources.add(source);

    if (this.cursor <= this.context.currentTime) {
      this.cursor = this.context.currentTime + this.startupBufferSeconds;
    }
    source.start(this.cursor);
    this.cursor += buffer.duration / playbackRate;
  }

  async drain(signal?: AbortSignal): Promise<void> {
    while (this.bufferedSeconds > 0.02 || this.sources.size > 0) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended between iteration and stop.
      }
    }
    this.sources.clear();
    this.cursor = 0;
  }
}
