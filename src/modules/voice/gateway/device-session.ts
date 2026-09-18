import { Logger } from '@nestjs/common';
import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { errorMessage } from '@/common/utils/error.util';
import { OpusDecoder, OpusEncoder } from '../audio/opus.codec';
import { resamplePcm16 } from '../audio/resample';
import { EnergyVad } from '../audio/vad';
import type { ChatMessage } from '../clients/modelrelay.client';
import { ConversationService } from '../pipeline/conversation.service';
import type {
  AudioParams,
  ClientHello,
  ClientListen,
  ListenMode,
  ProtocolVersion,
  ServerMessage,
} from '../types/protocol.types';
import { DEFAULT_UPLINK, isClientMessage } from '../types/protocol.types';
import type { AudioFormat } from '../voice.config';
import { VoiceConfig } from '../voice.config';
import {
  FRAME_TYPE_AUDIO,
  FRAME_TYPE_JSON,
  decodeBinaryFrame,
  encodeBinaryFrame,
  toProtocolVersion,
} from './binary-frame';

export interface SessionContext {
  deviceId: string;
  clientId: string;
  headerVersion: number;
}

interface TurnCallbacks {
  onTranscript: (text: string) => void;
  onSentence: (text: string) => void;
  onAudio: (pcm: Buffer, sampleRate: number) => Promise<void>;
}

type SessionState = 'awaiting-hello' | 'idle' | 'listening' | 'processing';

/** Audio queued ahead of realtime, to ride out jitter without long buffers. */
const PREBUFFER_MS = 300;

export class DeviceSession {
  private readonly logger = new Logger(DeviceSession.name);
  readonly id = randomUUID();

  private state: SessionState = 'awaiting-hello';
  private version: ProtocolVersion = 1;
  private uplink: AudioParams = DEFAULT_UPLINK;
  private downlink: AudioParams = DEFAULT_UPLINK;
  private mode: ListenMode = 'manual';

  private decoder?: OpusDecoder;
  private encoder?: OpusEncoder;
  private vad?: EnergyVad;
  private utterance: Buffer[] = [];
  private utteranceBytes = 0;
  private turn?: AbortController;
  private history: ChatMessage[] = [];

  private helloTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly context: SessionContext,
    private readonly config: VoiceConfig,
    private readonly conversation: ConversationService,
  ) {}

  start(): void {
    this.socket.on('message', (data: RawData, isBinary: boolean) => {
      void this.onMessage(data, isBinary);
    });
    this.socket.on('close', () => this.dispose());
    this.socket.on('error', (error: Error) => {
      this.logger.warn(`${this.context.deviceId}: ${errorMessage(error)}`);
      this.dispose();
    });

    this.helloTimer = setTimeout(() => {
      if (this.state === 'awaiting-hello') {
        this.logger.warn(`${this.context.deviceId} never sent hello`);
        this.socket.close(1008, 'hello timeout');
      }
    }, this.config.helloTimeoutMs);

    this.touch();
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    this.touch();
    try {
      if (!isBinary) {
        this.handleControl(toBuffer(data).toString('utf8'));
        return;
      }

      const frame = decodeBinaryFrame(this.version, toBuffer(data));
      if (frame.frameType === FRAME_TYPE_JSON) {
        this.handleControl(frame.payload.toString('utf8'));
        return;
      }
      await this.handleAudio(frame.payload);
    } catch (error: unknown) {
      this.logger.error(`${this.context.deviceId}: ${errorMessage(error)}`);
      this.send({
        type: 'alert',
        session_id: this.id,
        status: 'Error',
        message: errorMessage(error),
      });
    }
  }

  private handleControl(raw: string): void {
    const parsed: unknown = JSON.parse(raw);
    if (!isClientMessage(parsed)) throw new Error('Control frame has no type');

    switch (parsed.type) {
      case 'hello':
        this.handleHello(parsed);
        return;
      case 'listen':
        this.handleListen(parsed);
        return;
      case 'abort':
        this.abortTurn();
        this.state = 'idle';
        return;
      case 'goodbye':
        this.send({ type: 'goodbye', session_id: this.id });
        this.socket.close(1000, 'goodbye');
        return;
      default:
        this.logger.debug(`Ignoring unsupported control frame`);
    }
  }

  private handleHello(message: ClientHello): void {
    clearTimeout(this.helloTimer);

    this.version = toProtocolVersion(
      message.version ?? this.context.headerVersion,
    );

    const requested = message.audio_params ?? {};
    const format = normaliseFormat(requested.format);
    this.uplink = {
      format,
      sample_rate: requested.sample_rate ?? DEFAULT_UPLINK.sample_rate,
      channels: 1,
      frame_duration: requested.frame_duration ?? DEFAULT_UPLINK.frame_duration,
    };
    this.downlink = {
      format,
      sample_rate: this.config.downlinkSampleRate,
      channels: 1,
      frame_duration: this.uplink.frame_duration,
    };

    if (format === 'opus') {
      this.decoder = new OpusDecoder(this.uplink.sample_rate);
      this.encoder = new OpusEncoder(
        this.downlink.sample_rate,
        this.downlink.frame_duration,
      );
    }

    this.state = 'idle';
    this.send({
      type: 'hello',
      transport: 'websocket',
      version: this.version,
      session_id: this.id,
      audio_params: this.downlink,
    });

    this.logger.log(
      `${this.context.deviceId} online: v${this.version} ${format} ` +
        `${this.uplink.sample_rate}->${this.downlink.sample_rate}Hz`,
    );
  }

  private handleListen(message: ClientListen): void {
    if (this.state === 'awaiting-hello') throw new Error('hello not received');

    if (message.state === 'start') {
      this.abortTurn();
      this.mode = message.mode ?? 'manual';
      this.resetUtterance();
      this.state = 'listening';
      return;
    }

    if (message.state === 'detect') {
      this.abortTurn();
      if (message.text) void this.runTextTurn(message.text);
      return;
    }

    if (this.state === 'listening') void this.finishUtterance();
  }

  private async handleAudio(payload: Buffer): Promise<void> {
    if (this.state !== 'listening' || payload.length === 0) return;

    const pcm = this.decoder ? this.decoder.decode(payload) : payload;
    this.utterance.push(pcm);
    this.utteranceBytes += pcm.length;

    if (this.durationMs() >= this.config.maxUtteranceMs) {
      await this.finishUtterance();
      return;
    }

    if (this.mode === 'manual') return;

    this.vad ??= new EnergyVad(this.uplink.sample_rate);
    const { speechDetected, silenceMs } = this.vad.push(pcm);
    if (speechDetected && silenceMs >= this.config.silenceMs) {
      await this.finishUtterance();
    }
  }

  private durationMs(): number {
    return (this.utteranceBytes / 2 / this.uplink.sample_rate) * 1000;
  }

  private async finishUtterance(): Promise<void> {
    const pcm = Buffer.concat(this.utterance);
    const durationMs = this.durationMs();
    this.resetUtterance();

    if (durationMs < this.config.minUtteranceMs) {
      this.state = 'idle';
      return;
    }

    await this.runTurn((signal, callbacks) =>
      this.conversation.runTurn({
        history: this.history,
        pcm,
        sampleRate: this.uplink.sample_rate,
        signal,
        ...callbacks,
      }),
    );
  }

  /** A device that recognised its wake word already carries the transcript. */
  private async runTextTurn(text: string): Promise<void> {
    await this.runTurn((signal, callbacks) =>
      this.conversation.runTextTurn({
        history: this.history,
        text,
        signal,
        ...callbacks,
      }),
    );
  }

  private async runTurn(
    run: (
      signal: AbortSignal,
      callbacks: TurnCallbacks,
    ) => Promise<{ userText: string; assistantText: string }>,
  ): Promise<void> {
    this.state = 'processing';
    const controller = new AbortController();
    this.turn = controller;

    let ttsStarted = false;

    try {
      const result = await run(controller.signal, {
        onTranscript: (text) => {
          this.send({ type: 'stt', session_id: this.id, text });
        },
        onSentence: (text) => {
          if (!ttsStarted) {
            ttsStarted = true;
            this.send({ type: 'tts', session_id: this.id, state: 'start' });
          }
          this.send({
            type: 'tts',
            session_id: this.id,
            state: 'sentence_start',
            text,
          });
        },
        onAudio: (pcm, sampleRate) => this.sendAudio(pcm, sampleRate),
      });

      if (result.userText && result.assistantText) {
        this.remember(result.userText, result.assistantText);
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        this.logger.error(
          `${this.context.deviceId} turn failed: ${errorMessage(error)}`,
        );
        this.send({
          type: 'alert',
          session_id: this.id,
          status: 'Error',
          message: 'The assistant is unavailable right now.',
          emotion: 'sad',
        });
      }
    } finally {
      if (this.turn === controller) {
        this.turn = undefined;
        if (ttsStarted) {
          this.send({ type: 'tts', session_id: this.id, state: 'stop' });
        }
        if (this.state === 'processing') this.state = 'idle';
      }
    }
  }

  /** Paces frames at realtime so a device with a small ring buffer keeps up. */
  private async sendAudio(pcm: Buffer, sampleRate: number): Promise<void> {
    const resampled = resamplePcm16(pcm, sampleRate, this.downlink.sample_rate);
    const frames = this.encoder
      ? this.encoder.encode(resampled)
      : chunkPcm(
          resampled,
          this.downlink.sample_rate,
          this.downlink.frame_duration,
        );

    const startedAt = Date.now();
    let sentMs = 0;

    for (const frame of frames) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      this.socket.send(
        encodeBinaryFrame(this.version, frame, FRAME_TYPE_AUDIO, sentMs),
        { binary: true },
      );

      sentMs += this.downlink.frame_duration;
      const wait = sentMs - PREBUFFER_MS - (Date.now() - startedAt);
      if (wait > 0) await sleep(wait);
    }
  }

  private remember(userText: string, assistantText: string): void {
    this.history.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    );
    const max = this.config.maxHistoryTurns * 2;
    if (this.history.length > max) this.history = this.history.slice(-max);
  }

  private abortTurn(): void {
    this.turn?.abort();
    this.turn = undefined;
  }

  private resetUtterance(): void {
    this.utterance = [];
    this.utteranceBytes = 0;
    this.vad = undefined;
  }

  private send(message: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    const json = JSON.stringify(message);
    if (this.version === 1) {
      this.socket.send(json);
      return;
    }
    this.socket.send(
      encodeBinaryFrame(this.version, Buffer.from(json), FRAME_TYPE_JSON),
      { binary: true },
    );
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.log(`${this.context.deviceId} idle, closing`);
      this.socket.close(1000, 'idle timeout');
    }, this.config.idleTimeoutMs);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.idleTimer);
    this.abortTurn();
    this.decoder?.close();
    this.encoder?.close();
  }
}

function chunkPcm(
  pcm: Buffer,
  sampleRate: number,
  frameDurationMs: number,
): Buffer[] {
  const bytes = Math.round((sampleRate * frameDurationMs) / 1000) * 2;
  const frames: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += bytes) {
    frames.push(pcm.subarray(offset, Math.min(offset + bytes, pcm.length)));
  }
  return frames;
}

function normaliseFormat(value: unknown): AudioFormat {
  return value === 'pcm' || value === 'pcm16' ? 'pcm' : 'opus';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'CanceledError' ||
      error.name === 'TurnAbortedError')
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
