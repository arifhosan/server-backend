const HEADER_BYTES = 44;

export interface DecodedWav {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
}

/** Wraps mono 16-bit PCM in a canonical RIFF header. */
export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  const out = Buffer.alloc(HEADER_BYTES + pcm.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, HEADER_BYTES);
  return out;
}

/**
 * Walks the chunk list rather than assuming a 44-byte header: encoders
 * routinely emit LIST/fact chunks before `data`.
 */
export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF file');
  }

  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const end = Math.min(body + size, buffer.length);
      if (bitsPerSample !== 16) {
        throw new Error(`Unsupported bit depth ${bitsPerSample}`);
      }
      const pcm = buffer.subarray(body, end);
      return { pcm: toMono(pcm, channels), sampleRate, channels: 1 };
    }

    offset = body + size + (size % 2);
  }

  throw new Error('WAV has no data chunk');
}

function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;

  const frames = Math.floor(pcm.length / (2 * channels));
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE((i * channels + c) * 2);
    }
    mono.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return mono;
}
