import { Injectable } from '@nestjs/common';
import axios from 'axios';
import type { Readable } from 'stream';
import { VoiceConfig } from '../voice.config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatChunk {
  choices?: { delta?: { content?: string } }[];
}

const CHAT_TIMEOUT_MS = 120000;

@Injectable()
export class ModelRelayClient {
  constructor(private readonly config: VoiceConfig) {}

  /** Yields content deltas as the OpenAI-compatible SSE stream arrives. */
  async *streamChat(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.modelRelayApiKey) {
      headers.Authorization = `Bearer ${this.config.modelRelayApiKey}`;
    }

    const response = await axios.post<Readable>(
      `${this.config.modelRelayUrl}/v1/chat/completions`,
      {
        model: this.config.model,
        messages,
        stream: true,
        max_tokens: this.config.maxTokens,
      },
      { headers, responseType: 'stream', signal, timeout: CHAT_TIMEOUT_MS },
    );

    let buffered = '';
    for await (const chunk of response.data) {
      buffered += (chunk as Buffer).toString('utf8');

      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');

        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        const delta = parseDelta(payload);
        if (delta) yield delta;
      }
    }
  }
}

function parseDelta(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as ChatChunk;
    return parsed.choices?.[0]?.delta?.content || undefined;
  } catch {
    return undefined;
  }
}
