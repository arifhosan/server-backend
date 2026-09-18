import { IcyStreamParser, parsePlaylist } from './icy-metadata.parser';

const METAINT = 16;

function metadataBlock(text: string): Buffer {
  const units = Math.ceil(text.length / 16);
  const block = Buffer.alloc(units * 16 + 1);
  block[0] = units;
  block.write(text, 1, 'latin1');
  return block;
}

function collect(metaint: number) {
  const audio: Buffer[] = [];
  const titles: string[] = [];

  const parser = new IcyStreamParser(
    metaint,
    (chunk) => audio.push(Buffer.from(chunk)),
    (title) => titles.push(title),
  );

  return {
    parser,
    audio: () => Buffer.concat(audio),
    titles: () => titles,
  };
}

describe('IcyStreamParser', () => {
  it('passes the body through untouched when no metadata is interleaved', () => {
    const sink = collect(0);
    sink.parser.push(Buffer.from('abcdef'));

    expect(sink.audio().toString()).toBe('abcdef');
    expect(sink.titles()).toEqual([]);
  });

  it('strips a metadata block and keeps the audio contiguous', () => {
    const sink = collect(METAINT);
    const first = Buffer.alloc(METAINT, 0xaa);
    const second = Buffer.alloc(METAINT, 0xbb);

    sink.parser.push(
      Buffer.concat([first, metadataBlock("StreamTitle='One';"), second]),
    );

    expect(sink.audio()).toEqual(Buffer.concat([first, second]));
    expect(sink.titles()).toEqual(['One']);
  });

  it('handles a metadata block split across chunk boundaries', () => {
    const sink = collect(METAINT);
    const block = metadataBlock("StreamTitle='Split';");
    const payload = Buffer.concat([
      Buffer.alloc(METAINT, 0xaa),
      block,
      Buffer.alloc(METAINT, 0xbb),
    ]);

    for (let offset = 0; offset < payload.length; offset += 3) {
      sink.parser.push(payload.subarray(offset, offset + 3));
    }

    expect(sink.audio()).toEqual(
      Buffer.concat([Buffer.alloc(METAINT, 0xaa), Buffer.alloc(METAINT, 0xbb)]),
    );
    expect(sink.titles()).toEqual(['Split']);
  });

  it('treats a zero length block as "nothing changed"', () => {
    const sink = collect(METAINT);
    const empty = Buffer.from([0]);

    sink.parser.push(
      Buffer.concat([
        Buffer.alloc(METAINT, 0xaa),
        empty,
        Buffer.alloc(METAINT, 0xbb),
      ]),
    );

    expect(sink.audio()).toHaveLength(METAINT * 2);
    expect(sink.titles()).toEqual([]);
  });

  it('keeps the audio grid aligned across many blocks', () => {
    const sink = collect(METAINT);

    for (let i = 0; i < 50; i++) {
      sink.parser.push(Buffer.alloc(METAINT, 0xaa));
      sink.parser.push(metadataBlock(`StreamTitle='Track ${i}';`));
    }

    const audio = sink.audio();
    expect(audio).toHaveLength(METAINT * 50);
    expect(audio.every((byte) => byte === 0xaa)).toBe(true);
    expect(sink.titles()).toHaveLength(50);
    expect(sink.titles()[49]).toBe('Track 49');
  });

  it('ignores padding and blocks without a StreamTitle', () => {
    const sink = collect(METAINT);

    sink.parser.push(Buffer.alloc(METAINT, 0xaa));
    sink.parser.push(metadataBlock("StreamUrl='http://example.com';"));

    expect(sink.titles()).toEqual([]);
  });
});

describe('parsePlaylist', () => {
  it('reads urls from an m3u body and skips comments', () => {
    const body = '#EXTM3U\n#EXTINF:-1,Station\nhttp://example.com/stream\n';

    expect(parsePlaylist(body)).toEqual(['http://example.com/stream']);
  });

  it('reads urls from a pls body', () => {
    const body =
      '[playlist]\r\nNumberOfEntries=2\r\nFile1=http://a.example/one\r\nFile2=https://b.example/two\r\n';

    expect(parsePlaylist(body)).toEqual([
      'http://a.example/one',
      'https://b.example/two',
    ]);
  });

  it('ignores lines that are not urls', () => {
    expect(parsePlaylist('Title1=Some Station\nLength1=-1\n')).toEqual([]);
  });
});
