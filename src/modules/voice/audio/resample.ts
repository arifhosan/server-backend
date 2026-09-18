/** Linear interpolation between rates. Good enough for 16k/24k speech. */
export function resamplePcm16(
  pcm: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;

  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const ratio = (inSamples - 1) / Math.max(1, outSamples - 1);

  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, inSamples - 1);
    const frac = pos - left;
    const value =
      pcm.readInt16LE(left * 2) * (1 - frac) +
      pcm.readInt16LE(right * 2) * frac;
    out.writeInt16LE(clamp(Math.round(value)), i * 2);
  }
  return out;
}

function clamp(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}
