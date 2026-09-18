import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { errorMessage } from '@/common/utils/error.util';
import { decodeWav, encodeWav } from '../audio/wav';
import { VoiceConfig } from '../voice.config';

export interface SynthesisResult {
  pcm: Buffer;
  sampleRate: number;
}

interface TranscriptionResponse {
  text: string;
  duration: number;
}

const STT_TIMEOUT_MS = 120000;
const TTS_TIMEOUT_MS = 180000;

@Injectable()
export class VoiceboxClient {
  private readonly logger = new Logger(VoiceboxClient.name);

  constructor(private readonly config: VoiceConfig) {}

  async transcribe(
    pcm: Buffer,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const form = new FormData();
    const wav = encodeWav(pcm, sampleRate);
    form.append(
      'file',
      new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      'utterance.wav',
    );
    form.append('language', this.config.language);
    if (this.config.sttModel) form.append('model', this.config.sttModel);

    const { data } = await axios.post<TranscriptionResponse>(
      `${this.config.voiceboxUrl}/transcribe`,
      form,
      { signal, timeout: STT_TIMEOUT_MS },
    );
    return data.text.trim();
  }

  /** Streams one sentence; voicebox returns a complete WAV body. */
  async synthesize(
    text: string,
    signal?: AbortSignal,
  ): Promise<SynthesisResult> {
    const response = await axios.post<ArrayBuffer>(
      `${this.config.voiceboxUrl}/generate/stream`,
      {
        profile_id: this.config.voiceboxProfileId,
        text,
        language: this.config.language,
        engine: this.config.ttsEngine,
      },
      { responseType: 'arraybuffer', signal, timeout: TTS_TIMEOUT_MS },
    );

    const body = Buffer.from(response.data);
    try {
      const wav = decodeWav(body);
      return { pcm: wav.pcm, sampleRate: wav.sampleRate };
    } catch (error: unknown) {
      this.logger.error(
        `voicebox returned ${body.length} bytes that are not WAV: ${errorMessage(error)}`,
      );
      throw error;
    }
  }
}
