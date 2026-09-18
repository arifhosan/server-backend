import { SentenceSplitter, speakableText } from './sentence-splitter';

function feed(splitter: SentenceSplitter, text: string): string[] {
  const out: string[] = [];
  for (const char of text) out.push(...splitter.push(char));
  const tail = splitter.flush();
  if (tail) out.push(tail);
  return out;
}

describe('SentenceSplitter', () => {
  it('emits the first sentence early and later ones in longer chunks', () => {
    const splitter = new SentenceSplitter();
    const sentences = feed(
      splitter,
      'Sure. The weather in Aachen is mild today, around fifteen degrees.',
    );

    expect(sentences[0]).toBe('Sure.');
    expect(sentences).toHaveLength(2);
    expect(sentences[1]).toContain('fifteen degrees.');
  });

  it('does not split inside a decimal number', () => {
    const splitter = new SentenceSplitter();
    expect(feed(splitter, 'It costs 12.50 euros right now.')).toEqual([
      'It costs 12.50 euros right now.',
    ]);
  });

  it('drops think blocks that arrive one character at a time', () => {
    const splitter = new SentenceSplitter();
    const sentences = feed(
      splitter,
      '<think>The user wants the capital. It is Paris.</think>Paris.',
    );

    expect(sentences).toEqual(['Paris.']);
  });

  it('flushes a trailing fragment that never got punctuation', () => {
    const splitter = new SentenceSplitter();
    expect(feed(splitter, 'almost done')).toEqual(['almost done']);
  });

  it('breaks a run-on sentence at the hard limit', () => {
    const splitter = new SentenceSplitter();
    const sentences = feed(splitter, `${'word '.repeat(60)}end.`);

    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.length).toBeLessThanOrEqual(181);
    }
  });
});

describe('speakableText', () => {
  it('removes markup and emoji that TTS would read out', () => {
    expect(speakableText('**Great** 😀 see [the docs](http://x) now')).toBe(
      'Great see the docs now',
    );
  });

  it('drops fenced code entirely', () => {
    expect(speakableText('Run this:\n```\nnpm ci\n```\nThen restart.')).toBe(
      'Run this: Then restart.',
    );
  });
});
