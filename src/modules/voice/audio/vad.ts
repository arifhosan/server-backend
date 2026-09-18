const WINDOW_MS = 20;

export interface VadResult {
  speechDetected: boolean;
  silenceMs: number;
}

/**
 * Energy gate for `auto`/`realtime` mode, where the device streams continuously
 * and the server decides when the utterance ended. The noise floor adapts from
 * the leading frames so a hissy microphone does not read as permanent speech.
 */
export class EnergyVad {
  private noiseFloor = 0;
  private calibrationWindows = 0;
  private speechDetected = false;
  private silenceMs = 0;
  private readonly samplesPerWindow: number;
  private pending = Buffer.alloc(0);

  constructor(
    private readonly sampleRate: number,
    private readonly calibrationWindowCount = 10,
  ) {
    this.samplesPerWindow = Math.round((sampleRate * WINDOW_MS) / 1000);
  }

  push(pcm: Buffer): VadResult {
    this.pending = Buffer.concat([this.pending, pcm]);
    const windowBytes = this.samplesPerWindow * 2;

    let offset = 0;
    while (offset + windowBytes <= this.pending.length) {
      this.consume(this.pending.subarray(offset, offset + windowBytes));
      offset += windowBytes;
    }
    this.pending = this.pending.subarray(offset);

    return { speechDetected: this.speechDetected, silenceMs: this.silenceMs };
  }

  private consume(window: Buffer): void {
    const rms = rmsOf(window);

    if (this.calibrationWindows < this.calibrationWindowCount) {
      this.calibrationWindows++;
      this.noiseFloor =
        this.noiseFloor + (rms - this.noiseFloor) / this.calibrationWindows;
      return;
    }

    const threshold = Math.max(this.noiseFloor * 3, 500);
    if (rms > threshold) {
      this.speechDetected = true;
      this.silenceMs = 0;
    } else {
      this.silenceMs += WINDOW_MS;
      if (!this.speechDetected) {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }
    }
  }
}

function rmsOf(pcm: Buffer): number {
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}
