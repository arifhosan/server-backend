import type { ProtocolVersion } from '../types/protocol.types';

export const FRAME_TYPE_AUDIO = 0;
export const FRAME_TYPE_JSON = 1;

export interface BinaryFrame {
  frameType: number;
  timestamp: number;
  payload: Buffer;
}

const V2_HEADER_BYTES = 16;
const V3_HEADER_BYTES = 4;

/**
 * Version 1 is a bare payload; 2 and 3 prepend a header. All multi-byte
 * fields are network byte order, matching the ESP32 htons/htonl calls.
 */
export function encodeBinaryFrame(
  version: ProtocolVersion,
  payload: Buffer,
  frameType: number = FRAME_TYPE_AUDIO,
  timestamp = 0,
): Buffer {
  if (version === 1) return payload;

  if (version === 2) {
    const header = Buffer.alloc(V2_HEADER_BYTES);
    header.writeUInt16BE(version, 0);
    header.writeUInt16BE(frameType, 2);
    header.writeUInt32BE(0, 4);
    header.writeUInt32BE(timestamp >>> 0, 8);
    header.writeUInt32BE(payload.length, 12);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(V3_HEADER_BYTES);
  header.writeUInt8(frameType, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

export function decodeBinaryFrame(
  version: ProtocolVersion,
  data: Buffer,
): BinaryFrame {
  if (version === 1) {
    return { frameType: FRAME_TYPE_AUDIO, timestamp: 0, payload: data };
  }

  if (version === 2) {
    if (data.length < V2_HEADER_BYTES) {
      throw new Error('Binary frame shorter than the v2 header');
    }
    const frameType = data.readUInt16BE(2);
    const timestamp = data.readUInt32BE(8);
    const size = data.readUInt32BE(12);
    return {
      frameType,
      timestamp,
      payload: sliceExact(data, V2_HEADER_BYTES, size),
    };
  }

  if (data.length < V3_HEADER_BYTES) {
    throw new Error('Binary frame shorter than the v3 header');
  }
  const frameType = data.readUInt8(0);
  const size = data.readUInt16BE(2);
  return {
    frameType,
    timestamp: 0,
    payload: sliceExact(data, V3_HEADER_BYTES, size),
  };
}

function sliceExact(data: Buffer, offset: number, size: number): Buffer {
  const available = data.length - offset;
  if (size > available) {
    throw new Error(
      `Binary frame declares ${size} payload bytes but carries ${available}`,
    );
  }
  return data.subarray(offset, offset + size);
}

export function toProtocolVersion(value: unknown): ProtocolVersion {
  return value === 2 || value === 3 ? value : 1;
}
