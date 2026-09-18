const META_UNIT_BYTES = 16;
const STREAM_TITLE_PATTERN = /StreamTitle='(.*?)';/;

/** Splits `[metaint audio][len][len*16 meta]...` into audio and track titles. */
export class IcyStreamParser {
  private audioRemaining: number;
  private metaRemaining = 0;
  private inMetadata = false;
  private metaChunks: Buffer[] = [];

  constructor(
    private readonly metaint: number,
    private readonly onAudio: (chunk: Buffer) => void,
    private readonly onTitle: (title: string) => void,
  ) {
    this.audioRemaining = metaint;
  }

  push(chunk: Buffer): void {
    if (this.metaint <= 0) {
      this.onAudio(chunk);
      return;
    }

    let offset = 0;

    while (offset < chunk.length) {
      if (this.inMetadata) {
        offset = this.consumeMetadata(chunk, offset);
        continue;
      }

      if (this.audioRemaining > 0) {
        const take = Math.min(this.audioRemaining, chunk.length - offset);
        this.onAudio(chunk.subarray(offset, offset + take));
        this.audioRemaining -= take;
        offset += take;
        continue;
      }

      const lengthUnits = chunk[offset];
      offset += 1;
      this.metaRemaining = lengthUnits * META_UNIT_BYTES;

      if (this.metaRemaining === 0) {
        this.audioRemaining = this.metaint;
      } else {
        this.inMetadata = true;
        this.metaChunks = [];
      }
    }
  }

  private consumeMetadata(chunk: Buffer, offset: number): number {
    const take = Math.min(this.metaRemaining, chunk.length - offset);
    this.metaChunks.push(chunk.subarray(offset, offset + take));
    this.metaRemaining -= take;

    if (this.metaRemaining > 0) return offset + take;

    this.emitTitle(Buffer.concat(this.metaChunks));
    this.metaChunks = [];
    this.inMetadata = false;
    this.audioRemaining = this.metaint;
    return offset + take;
  }

  private emitTitle(block: Buffer): void {
    const text = block.toString('utf8').replace(/\0+$/, '');
    const title = STREAM_TITLE_PATTERN.exec(text)?.[1]?.trim();

    if (title) this.onTitle(title);
  }
}

export function parsePlaylist(body: string): string[] {
  const urls: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const value = line.includes('=') ? line.slice(line.indexOf('=') + 1) : line;
    if (/^https?:\/\//i.test(value)) urls.push(value);
  }

  return urls;
}
