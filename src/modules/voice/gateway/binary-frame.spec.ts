import {
  FRAME_TYPE_AUDIO,
  FRAME_TYPE_JSON,
  decodeBinaryFrame,
  encodeBinaryFrame,
  toProtocolVersion,
} from './binary-frame';

const payload = Buffer.from([1, 2, 3, 4, 5]);

describe('binary framing', () => {
  it('leaves version 1 payloads untouched', () => {
    const encoded = encodeBinaryFrame(1, payload);
    expect(encoded).toEqual(payload);
    expect(decodeBinaryFrame(1, encoded).payload).toEqual(payload);
  });

  it('round-trips a version 2 frame with its timestamp', () => {
    const encoded = encodeBinaryFrame(2, payload, FRAME_TYPE_AUDIO, 1234);
    expect(encoded).toHaveLength(16 + payload.length);

    const frame = decodeBinaryFrame(2, encoded);
    expect(frame).toEqual({
      frameType: FRAME_TYPE_AUDIO,
      timestamp: 1234,
      payload,
    });
  });

  it('round-trips a version 3 json frame', () => {
    const body = Buffer.from(JSON.stringify({ type: 'hello' }));
    const frame = decodeBinaryFrame(
      3,
      encodeBinaryFrame(3, body, FRAME_TYPE_JSON),
    );

    expect(frame.frameType).toBe(FRAME_TYPE_JSON);
    expect(frame.payload.toString()).toBe('{"type":"hello"}');
  });

  it('writes multi-byte fields in network order', () => {
    const encoded = encodeBinaryFrame(3, payload, FRAME_TYPE_AUDIO);
    expect(encoded.readUInt16BE(2)).toBe(payload.length);
  });

  it('rejects a frame that claims more payload than it carries', () => {
    const encoded = encodeBinaryFrame(3, payload);
    expect(() => decodeBinaryFrame(3, encoded.subarray(0, 6))).toThrow(
      /carries/,
    );
  });

  it('falls back to version 1 for anything unrecognised', () => {
    expect(toProtocolVersion(2)).toBe(2);
    expect(toProtocolVersion(3)).toBe(3);
    expect(toProtocolVersion(99)).toBe(1);
    expect(toProtocolVersion(undefined)).toBe(1);
  });
});
