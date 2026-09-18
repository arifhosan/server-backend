import { ConversationService, TurnAbortedError } from './conversation.service';
import type {
  ChatMessage,
  ModelRelayClient,
} from '../clients/modelrelay.client';
import type { VoiceboxClient } from '../clients/voicebox.client';
import type { VoiceConfig } from '../voice.config';

const config = { systemPrompt: 'be brief' } as VoiceConfig;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  service: ConversationService;
  streamChat: jest.Mock<AsyncGenerator<string>, [ChatMessage[], AbortSignal?]>;
  events: string[];
  played: string[];
  sentences: string[];
}

function harness(deltas: string[], transcript = 'hello there'): Harness {
  const events: string[] = [];
  const played: string[] = [];
  const sentences: string[] = [];

  const voicebox = {
    transcribe: jest.fn().mockResolvedValue(transcript),
    synthesize: jest.fn(async (text: string) => {
      events.push(`synth:start:${text}`);
      await sleep(20);
      events.push(`synth:end:${text}`);
      return { pcm: Buffer.from(text), sampleRate: 24000 };
    }),
  } as unknown as VoiceboxClient;

  const streamChat = jest.fn<
    AsyncGenerator<string>,
    [ChatMessage[], AbortSignal?]
  >(async function* () {
    for (const delta of deltas) {
      await sleep(1);
      yield delta;
    }
  });
  const modelRelay = { streamChat } as unknown as ModelRelayClient;

  return {
    service: new ConversationService(config, voicebox, modelRelay),
    streamChat,
    events,
    played,
    sentences,
  };
}

describe('ConversationService', () => {
  it('plays sentences in order while synthesising the next one', async () => {
    const { service, events, played, sentences } = harness([
      'One. ',
      'Two is a considerably longer sentence for the splitter. ',
      'Three is also long enough to be split off cleanly. ',
    ]);

    await service.runTurn({
      history: [],
      pcm: Buffer.alloc(0),
      sampleRate: 16000,
      signal: new AbortController().signal,
      onTranscript: () => undefined,
      onSentence: (text) => sentences.push(text),
      onAudio: async (pcm) => {
        events.push(`play:start:${pcm.toString()}`);
        await sleep(30);
        events.push(`play:end:${pcm.toString()}`);
        played.push(pcm.toString());
      },
    });

    expect(sentences).toHaveLength(3);
    expect(played).toEqual(sentences);

    // Sentence 2 is synthesised before sentence 1 has finished playing.
    const secondSynthStart = events.indexOf(`synth:start:${sentences[1]}`);
    const firstPlayEnd = events.indexOf(`play:end:${sentences[0]}`);
    expect(secondSynthStart).toBeLessThan(firstPlayEnd);
  });

  it('skips the model entirely when nothing was transcribed', async () => {
    const { service } = harness(['ignored'], '');
    const onSentence = jest.fn();

    const result = await service.runTurn({
      history: [],
      pcm: Buffer.alloc(0),
      sampleRate: 16000,
      signal: new AbortController().signal,
      onTranscript: () => undefined,
      onSentence,
      onAudio: () => Promise.resolve(),
    });

    expect(result).toEqual({ userText: '', assistantText: '' });
    expect(onSentence).not.toHaveBeenCalled();
  });

  it('stops playback once the turn is aborted', async () => {
    const { service, played } = harness([
      'First sentence here. ',
      'Second sentence that is long enough to split. ',
    ]);
    const controller = new AbortController();

    const turn = service.runTextTurn({
      history: [],
      text: 'question',
      signal: controller.signal,
      onTranscript: () => undefined,
      onSentence: () => undefined,
      onAudio: async (pcm) => {
        played.push(pcm.toString());
        controller.abort();
        await sleep(5);
      },
    });

    await expect(turn).rejects.toBeInstanceOf(TurnAbortedError);
    expect(played).toHaveLength(1);
  });

  it('prepends the system prompt and prior history', async () => {
    const { service, streamChat } = harness(['Fine.']);
    const history = [
      { role: 'user' as const, content: 'earlier' },
      { role: 'assistant' as const, content: 'answer' },
    ];

    await service.runTextTurn({
      history,
      text: 'now',
      signal: new AbortController().signal,
      onTranscript: () => undefined,
      onSentence: () => undefined,
      onAudio: () => Promise.resolve(),
    });

    expect(streamChat.mock.calls[0][0]).toEqual([
      { role: 'system', content: 'be brief' },
      ...history,
      { role: 'user', content: 'now' },
    ]);
  });
});
