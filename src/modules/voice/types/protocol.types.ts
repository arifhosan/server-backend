import type { AudioFormat } from '../voice.config';

/** Binary framing revision, taken from the device hello `version` field. */
export type ProtocolVersion = 1 | 2 | 3;

export type ListenMode = 'auto' | 'manual' | 'realtime';

export interface AudioParams {
  format: AudioFormat;
  sample_rate: number;
  channels: number;
  frame_duration: number;
}

export interface ClientHello {
  type: 'hello';
  version?: number;
  transport?: string;
  features?: Record<string, boolean>;
  audio_params?: Partial<AudioParams>;
}

export interface ClientListen {
  type: 'listen';
  state: 'start' | 'stop' | 'detect';
  mode?: ListenMode;
  text?: string;
  session_id?: string;
}

export interface ClientAbort {
  type: 'abort';
  reason?: string;
  session_id?: string;
}

export interface ClientGoodbye {
  type: 'goodbye';
  session_id?: string;
}

export type ClientMessage =
  ClientHello | ClientListen | ClientAbort | ClientGoodbye;

export interface ServerHello {
  type: 'hello';
  transport: 'websocket';
  version: ProtocolVersion;
  session_id: string;
  audio_params: AudioParams;
}

export type ServerMessage =
  | ServerHello
  | { type: 'stt'; session_id: string; text: string }
  | { type: 'llm'; session_id: string; emotion: string; text: string }
  | {
      type: 'tts';
      session_id: string;
      state: 'start' | 'stop' | 'sentence_start';
      text?: string;
    }
  | {
      type: 'alert';
      session_id: string;
      status: 'Info' | 'Warning' | 'Error';
      message: string;
      emotion?: string;
    }
  | { type: 'goodbye'; session_id: string };

export const DEFAULT_UPLINK: AudioParams = {
  format: 'opus',
  sample_rate: 16000,
  channels: 1,
  frame_duration: 60,
};

export function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
