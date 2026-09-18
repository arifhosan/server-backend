import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Wire format the device may negotiate for both directions of the stream. */
export type AudioFormat = 'opus' | 'pcm';

@Injectable()
export class VoiceConfig {
  constructor(private readonly config: ConfigService) {}

  private str(key: string, fallback: string): string {
    return this.config.get<string>(key)?.trim() || fallback;
  }

  private num(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  get voiceboxUrl(): string {
    return this.str(
      'VOICEBOX_URL',
      'https://voicebox.server.arifhosan.me',
    ).replace(/\/+$/, '');
  }

  get voiceboxProfileId(): string {
    return this.str(
      'VOICEBOX_PROFILE_ID',
      '660fa6cc-0d56-4e28-9260-d130548a75be',
    );
  }

  get ttsEngine(): string {
    return this.str('VOICEBOX_TTS_ENGINE', 'kokoro');
  }

  get language(): string {
    return this.str('VOICE_LANGUAGE', 'en');
  }

  /** Optional override; voicebox picks its configured default when empty. */
  get sttModel(): string | undefined {
    return this.config.get<string>('VOICEBOX_STT_MODEL')?.trim() || undefined;
  }

  get modelRelayUrl(): string {
    return this.str(
      'MODELRELAY_URL',
      'https://modelrelay.server.arifhosan.me',
    ).replace(/\/+$/, '');
  }

  get modelRelayApiKey(): string | undefined {
    return this.config.get<string>('MODELRELAY_API_KEY')?.trim() || undefined;
  }

  get model(): string {
    return this.str('MODELRELAY_MODEL', 'auto-fastest');
  }

  get systemPrompt(): string {
    return this.str(
      'VOICE_SYSTEM_PROMPT',
      'You are a voice assistant on a small speaker. Answer in one or two short ' +
        'spoken sentences. Never use markdown, lists, emoji or code blocks.',
    );
  }

  get maxTokens(): number {
    return this.num('VOICE_MAX_TOKENS', 200);
  }

  get wsPath(): string {
    const path = this.str('VOICE_WS_PATH', '/voice/ws');
    return path.startsWith('/') ? path : `/${path}`;
  }

  /** Shared bearer secret. Unset disables device authentication entirely. */
  get authToken(): string | undefined {
    return this.config.get<string>('VOICE_AUTH_TOKEN')?.trim() || undefined;
  }

  /** Advertised to devices by the OTA endpoint when behind a proxy. */
  get publicWsUrl(): string | undefined {
    return this.config.get<string>('VOICE_PUBLIC_WS_URL')?.trim() || undefined;
  }

  get downlinkSampleRate(): number {
    return this.num('VOICE_DOWNLINK_SAMPLE_RATE', 24000);
  }

  get maxHistoryTurns(): number {
    return this.num('VOICE_MAX_HISTORY_TURNS', 8);
  }

  /** Hard cap on a single utterance, so a stuck device cannot stream forever. */
  get maxUtteranceMs(): number {
    return this.num('VOICE_MAX_UTTERANCE_MS', 15000);
  }

  get silenceMs(): number {
    return this.num('VOICE_SILENCE_MS', 900);
  }

  get minUtteranceMs(): number {
    return this.num('VOICE_MIN_UTTERANCE_MS', 400);
  }

  get helloTimeoutMs(): number {
    return this.num('VOICE_HELLO_TIMEOUT_MS', 10000);
  }

  get idleTimeoutMs(): number {
    return this.num('VOICE_IDLE_TIMEOUT_MS', 300000);
  }
}
