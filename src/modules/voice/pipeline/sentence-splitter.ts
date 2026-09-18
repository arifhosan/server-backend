const TERMINATORS = new Set(['.', '!', '?', ';', '\n', '。', '！', '？', '；']);

/** Short first chunk so the speaker starts talking sooner. */
const FIRST_MIN_CHARS = 4;
const SUBSEQUENT_MIN_CHARS = 30;
const HARD_LIMIT_CHARS = 180;

/** Characters that may legitimately follow a sentence terminator. */
const BOUNDARY_AFTER = /[\s"'”’)\]}]/;

/**
 * Cuts a streaming completion into speakable sentences and drops the
 * `<think>` blocks reasoning models emit, which must never reach TTS.
 */
export class SentenceSplitter {
  private buffer = '';
  private thinking = false;
  private emittedCount = 0;

  push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];

    for (;;) {
      this.dropThinkBlocks();
      const cut = this.findCut();
      if (cut === -1) break;

      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) {
        sentences.push(sentence);
        this.emittedCount++;
      }
    }

    return sentences;
  }

  flush(): string | undefined {
    this.dropThinkBlocks();
    const remainder = this.buffer.trim();
    this.buffer = '';
    if (!remainder || this.thinking) return undefined;
    this.emittedCount++;
    return remainder;
  }

  private findCut(): number {
    if (this.thinking) return -1;

    const minChars =
      this.emittedCount === 0 ? FIRST_MIN_CHARS : SUBSEQUENT_MIN_CHARS;
    const openTag = this.buffer.indexOf('<think');
    const limit = openTag === -1 ? this.buffer.length : openTag;

    for (let i = 0; i < limit; i++) {
      if (!TERMINATORS.has(this.buffer[i])) continue;
      if (i + 1 < minChars) continue;
      if (this.buffer[i] === '\n') return i + 1;

      // A terminator only ends a sentence once the next character proves it
      // is not '12.50' or 'v1.2'. Without the lookahead a character-by-character
      // stream cuts on every decimal point.
      const next: string | undefined = this.buffer[i + 1];
      if (next === undefined) break;
      if (BOUNDARY_AFTER.test(next)) return i + 1;
    }

    if (limit > HARD_LIMIT_CHARS) {
      const space = this.buffer.lastIndexOf(' ', HARD_LIMIT_CHARS);
      return space > minChars ? space + 1 : HARD_LIMIT_CHARS;
    }
    return -1;
  }

  private dropThinkBlocks(): void {
    for (;;) {
      if (this.thinking) {
        const close = this.buffer.indexOf('</think>');
        if (close === -1) {
          // Keep nothing; the tail may still hold a partial closing tag.
          this.buffer = this.buffer.slice(-8);
          if (!this.buffer.includes('</think>')) return;
          continue;
        }
        this.buffer = this.buffer.slice(close + '</think>'.length);
        this.thinking = false;
        continue;
      }

      const open = this.buffer.indexOf('<think>');
      if (open === -1) return;
      this.buffer =
        this.buffer.slice(0, open) + this.buffer.slice(open + '<think>'.length);
      this.thinking = true;
    }
  }
}

/** Strips markup and emoji that a TTS engine would read out literally. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
