import OpusScript from 'opusscript';

type OpusSampleRate = 8000 | 12000 | 16000 | 24000 | 48000;

const SUPPORTED_RATES: OpusSampleRate[] = [8000, 12000, 16000, 24000, 48000];

export function assertSupportedOpusRate(
  sampleRate: number,
): asserts sampleRate is OpusSampleRate {
  if (!SUPPORTED_RATES.includes(sampleRate as OpusSampleRate)) {
    throw new Error(
      `Opus supports ${SUPPORTED_RATES.join('/')} Hz, not ${sampleRate}`,
    );
  }
}

/** One decoder per stream: Opus is stateful and cannot be shared. */
export class OpusDecoder {
  private readonly decoder: OpusScript;

  constructor(private readonly sampleRate: number) {
    assertSupportedOpusRate(sampleRate);
    this.decoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
  }

  decode(packet: Buffer): Buffer {
    return this.decoder.decode(packet);
  }

  close(): void {
    this.decoder.delete();
  }
}

export class OpusEncoder {
  private readonly encoder: OpusScript;
  private readonly samplesPerFrame: number;
  private readonly bytesPerFrame: number;

  constructor(
    private readonly sampleRate: number,
    frameDurationMs: number,
  ) {
    assertSupportedOpusRate(sampleRate);
    this.encoder = new OpusScript(sampleRate, 1, OpusScript.Application.AUDIO);
    this.samplesPerFrame = Math.round((sampleRate * frameDurationMs) / 1000);
    this.bytesPerFrame = this.samplesPerFrame * 2;
  }

  /** Splits PCM into whole frames, zero-padding the tail. */
  encode(pcm: Buffer): Buffer[] {
    const packets: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += this.bytesPerFrame) {
      let frame = pcm.subarray(offset, offset + this.bytesPerFrame);
      if (frame.length < this.bytesPerFrame) {
        const padded = Buffer.alloc(this.bytesPerFrame);
        frame.copy(padded);
        frame = padded;
      }
      packets.push(this.encoder.encode(frame, this.samplesPerFrame));
    }
    return packets;
  }

  close(): void {
    this.encoder.delete();
  }
}
