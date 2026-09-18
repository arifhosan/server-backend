import { decodeWav, encodeWav } from './wav';
import { resamplePcm16 } from './resample';

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

describe('wav', () => {
  it('round-trips mono 16-bit audio', () => {
    const source = pcm([0, 1000, -1000, 32767, -32768]);
    const decoded = decodeWav(encodeWav(source, 16000));

    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.pcm).toEqual(source);
  });

  it('finds the data chunk past a LIST chunk', () => {
    const canonical = encodeWav(pcm([5, 6]), 24000);
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0);
    list.writeUInt32LE(4, 4);

    const withList = Buffer.concat([
      canonical.subarray(0, 36),
      list,
      canonical.subarray(36),
    ]);
    withList.writeUInt32LE(withList.length - 8, 4);

    expect(decodeWav(withList).pcm).toEqual(pcm([5, 6]));
  });

  it('downmixes stereo to mono', () => {
    const stereo = encodeWav(pcm([100, 300, 0, 200]), 16000);
    stereo.writeUInt16LE(2, 22);

    expect(decodeWav(stereo).pcm).toEqual(pcm([200, 100]));
  });

  it('rejects a buffer that is not RIFF', () => {
    expect(() => decodeWav(Buffer.from('not audio at all'))).toThrow(/RIFF/);
  });
});

describe('resamplePcm16', () => {
  it('returns the input untouched when rates match', () => {
    const source = pcm([1, 2, 3]);
    expect(resamplePcm16(source, 16000, 16000)).toBe(source);
  });

  it('scales the sample count by the rate ratio', () => {
    const source = pcm(Array.from<number>({ length: 1600 }).fill(0));
    const upsampled = resamplePcm16(source, 16000, 24000);

    expect(upsampled.length / 2).toBe(2400);
  });

  it('preserves the endpoints of a ramp', () => {
    const source = pcm([0, 8000, 16000, 24000]);
    const upsampled = resamplePcm16(source, 16000, 24000);

    expect(upsampled.readInt16LE(0)).toBe(0);
    expect(upsampled.readInt16LE(upsampled.length - 2)).toBe(24000);
  });
});
