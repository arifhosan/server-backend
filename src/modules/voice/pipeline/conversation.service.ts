import { Injectable } from '@nestjs/common';
import type { ChatMessage } from '../clients/modelrelay.client';
import { ModelRelayClient } from '../clients/modelrelay.client';
import { VoiceboxClient } from '../clients/voicebox.client';
import { VoiceConfig } from '../voice.config';
import { SentenceSplitter, speakableText } from './sentence-splitter';

export interface TurnCallbacks {
  onTranscript: (text: string) => void;
  onSentence: (text: string) => void;
  onAudio: (pcm: Buffer, sampleRate: number) => Promise<void>;
}

export interface AudioTurnRequest extends TurnCallbacks {
  history: ChatMessage[];
  pcm: Buffer;
  sampleRate: number;
  signal: AbortSignal;
}

export interface TextTurnRequest extends TurnCallbacks {
  history: ChatMessage[];
  text: string;
  signal: AbortSignal;
}

export interface TurnResult {
  userText: string;
  assistantText: string;
}

export class TurnAbortedError extends Error {
  override readonly name = 'TurnAbortedError';

  constructor() {
    super('Turn aborted');
  }
}

/**
 * Synthesis and playback run as two ordered chains, so sentence N+1 is being
 * generated while sentence N is still streaming to the device.
 */
class SentenceSpeaker {
  private synthTail: Promise<void> = Promise.resolve();
  private playTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly voicebox: VoiceboxClient,
    private readonly callbacks: TurnCallbacks,
    private readonly signal: AbortSignal,
  ) {}

  speak(sentence: string): void {
    const spoken = speakableText(sentence);
    if (!spoken) return;

    this.callbacks.onSentence(sentence);

    const synthesis = this.synthTail.then(() => {
      throwIfAborted(this.signal);
      return this.voicebox.synthesize(spoken, this.signal);
    });
    this.synthTail = synthesis.then(
      () => undefined,
      () => undefined,
    );

    this.playTail = this.playTail.then(async () => {
      const audio = await synthesis;
      throwIfAborted(this.signal);
      await this.callbacks.onAudio(audio.pcm, audio.sampleRate);
    });
  }

  done(): Promise<void> {
    return this.playTail;
  }
}

@Injectable()
export class ConversationService {
  constructor(
    private readonly config: VoiceConfig,
    private readonly voicebox: VoiceboxClient,
    private readonly modelRelay: ModelRelayClient,
  ) {}

  /** Microphone audio in, spoken answer out. */
  async runTurn(request: AudioTurnRequest): Promise<TurnResult> {
    throwIfAborted(request.signal);

    const userText = await this.voicebox.transcribe(
      request.pcm,
      request.sampleRate,
      request.signal,
    );
    request.onTranscript(userText);
    if (!userText) return { userText: '', assistantText: '' };

    return this.respond(userText, request, request.history, request.signal);
  }

  /** Same pipeline, but the transcript came from the device. */
  async runTextTurn(request: TextTurnRequest): Promise<TurnResult> {
    throwIfAborted(request.signal);
    request.onTranscript(request.text);
    if (!request.text) return { userText: '', assistantText: '' };

    return this.respond(request.text, request, request.history, request.signal);
  }

  private async respond(
    userText: string,
    callbacks: TurnCallbacks,
    history: ChatMessage[],
    signal: AbortSignal,
  ): Promise<TurnResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    const splitter = new SentenceSplitter();
    const speaker = new SentenceSpeaker(this.voicebox, callbacks, signal);
    let assistantText = '';

    for await (const delta of this.modelRelay.streamChat(messages, signal)) {
      assistantText += delta;
      for (const sentence of splitter.push(delta)) speaker.speak(sentence);
    }

    const remainder = splitter.flush();
    if (remainder) speaker.speak(remainder);

    await speaker.done();
    return { userText, assistantText: assistantText.trim() };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TurnAbortedError();
}
