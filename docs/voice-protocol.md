# Voice protocol

The `voice` module is a xiaozhi-style voice assistant backend: an ESP32 opens
one WebSocket, streams microphone audio up, and receives synthesised speech
back on the same socket. Control is JSON, audio is binary, both multiplexed
over that one connection.

This document is the contract. Implement the firmware against it, not against
the TypeScript.

## Pipeline

```
ESP32 ──mic audio──▶ server ──WAV──▶ voicebox /transcribe ──▶ text
                        │
                        ├──── text + history ──▶ modelrelay /v1/chat/completions
                        │                              │ (SSE deltas)
                        │                        split into sentences
                        │                              │
                        └──speech frames──◀── voicebox /generate/stream ◀──┘
```

Sentences are synthesised and streamed one at a time: sentence _n+1_ is
generated while sentence _n_ is still playing, so the speaker starts talking
before the model has finished writing.

Everything is per-connection and in memory. Conversation history lives on the
session and dies with the socket; nothing is written to the database.

## 1. Boot — `POST /voice/ota`

The first call a device makes. Send whatever the firmware knows about itself;
unknown fields are accepted and logged rather than rejected.

```http
POST /voice/ota
Device-Id: aa:bb:cc:dd:ee:ff
Client-Id: 9f1c...              # stable UUID generated once per device
Content-Type: application/json

{"application": {"version": "0.1.0"}, "board": {"type": "esp32s3", "mac": "aa:bb:cc:dd:ee:ff"}}
```

```json
{
  "server_time": { "timestamp": 1758193200000, "timezone_offset": 120 },
  "firmware": { "version": "1.0.0", "url": "" },
  "websocket": { "url": "wss://host/voice/ws", "token": "…", "version": 1 },
  "activation": null
}
```

`websocket.url` is derived from the request host (honouring
`X-Forwarded-Proto`) unless `VOICE_PUBLIC_WS_URL` is set. `token` is present
only when `VOICE_AUTH_TOKEN` is configured. `firmware.url` is empty — this
server does not serve OTA images.

## 2. Connect — `GET /voice/ws`

```
Authorization: Bearer <token>       # only when VOICE_AUTH_TOKEN is set
Protocol-Version: 1
Device-Id: aa:bb:cc:dd:ee:ff
Client-Id: 9f1c...
```

Browsers cannot set headers on a WebSocket, so the same values are accepted as
query parameters: `?token=…&device=…&client=…`. Prefer headers on the device.

An unauthorised upgrade is answered with `401` and the socket is destroyed.

## 3. Handshake

The device sends `hello` first. It has **10 seconds** (`VOICE_HELLO_TIMEOUT_MS`)
before the server closes with code `1008`.

```json
{
  "type": "hello",
  "version": 1,
  "transport": "websocket",
  "features": { "mcp": false, "aec": true },
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

The server replies with the parameters **it will send**, which is what the
device must configure its decoder and I2S output for:

```json
{
  "type": "hello",
  "transport": "websocket",
  "version": 1,
  "session_id": "3d333d45-…",
  "audio_params": {
    "format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

Negotiation rules:

| Field           | Who decides | Notes                                                        |
| --------------- | ----------- | ------------------------------------------------------------ |
| `format`        | device      | `opus` (default) or `pcm`. Applies to **both** directions.    |
| `sample_rate`   | device up   | Uplink is whatever the device says. Opus: 8/12/16/24/48 kHz.  |
| `sample_rate`   | server down | `VOICE_DOWNLINK_SAMPLE_RATE`, 24000 by default.               |
| `frame_duration`| device      | Used for both directions. 60 ms is the xiaozhi default.       |
| `channels`      | —           | Always 1. Stereo input is downmixed.                          |
| `version`       | device      | Binary framing revision, see §5. Falls back to 1.             |

`format: "pcm"` means signed 16-bit little-endian mono, which is what the
browser test client uses. It costs ~19× the bandwidth of Opus — bring the
firmware up on `pcm`, then switch to `opus` once audio flows.

## 4. Messages

### Device → server

```json
{"type": "listen", "state": "start", "mode": "manual"}
{"type": "listen", "state": "stop"}
{"type": "listen", "state": "detect", "text": "hey assistant"}
{"type": "abort", "reason": "wake_word_detected"}
{"type": "goodbye"}
```

`mode` is one of:

- **`manual`** — push-to-talk. The turn runs when the device sends
  `listen stop`. No server-side voice detection.
- **`auto`** / **`realtime`** — the device streams continuously and the server
  runs an energy VAD: the turn runs after `VOICE_SILENCE_MS` (900 ms) of
  silence following detected speech. `listen stop` still works.

`listen detect` skips speech-to-text: the device already recognised its wake
word and supplies the transcript, so the server goes straight to the model.

`abort` cancels whatever the server is doing — transcription, generation or
mid-sentence playback — and returns the session to idle. Send it the moment
the wake word fires during playback.

Audio frames are only accepted between `listen start` and the end of the turn.
Anything arriving while the server is thinking or speaking is discarded, so a
device without echo cancellation will not hear itself.

### Server → device

```json
{"type": "stt",  "session_id": "…", "text": "what is the capital of france"}
{"type": "tts",  "session_id": "…", "state": "start"}
{"type": "tts",  "session_id": "…", "state": "sentence_start", "text": "The capital of France is Paris."}
{"type": "tts",  "session_id": "…", "state": "stop"}
{"type": "alert","session_id": "…", "status": "Error", "message": "…", "emotion": "sad"}
{"type": "goodbye", "session_id": "…"}
```

Ordering guarantee: `stt` arrives first, then `tts start`, then each
`sentence_start` immediately **before** the audio frames for that sentence,
then `tts stop` once the last frame has been handed to the socket. `stt` with
an empty `text` means nothing was heard and no `tts` follows.

`sentence_start.text` is the display string; it may contain punctuation and
casing that the synthesised audio does not.

## 5. Binary framing

The framing revision comes from `hello.version`. Multi-byte fields are network
byte order, so `htons`/`htonl` on the device.

**Version 1 (default).** No header. The whole binary message is one audio
payload — an Opus packet or a PCM chunk. JSON goes in text frames.

**Version 2.** 16-byte header:

```c
struct {
  uint16_t version;       // 2
  uint16_t type;          // 0 = audio, 1 = json
  uint32_t reserved;      // 0
  uint32_t timestamp;     // ms into the current utterance
  uint32_t payload_size;
  uint8_t  payload[];
}
```

**Version 3.** 4-byte header:

```c
struct {
  uint8_t  type;          // 0 = audio, 1 = json
  uint8_t  reserved;      // 0
  uint16_t payload_size;
  uint8_t  payload[];
}
```

On versions 2 and 3 the server sends control messages as binary frames with
`type = 1`; on version 1 it sends them as WebSocket text frames. The server
accepts JSON either way.

A frame whose `payload_size` exceeds the bytes actually present is rejected and
answered with an `alert`.

## 6. Downlink pacing

Speech is sent frame by frame at realtime, with a 300 ms head start. A device
therefore needs roughly `300 ms + a few frames` of playout buffer, not a whole
utterance. At the defaults that is about 15 KB of PCM, or under 1 KB of Opus.

If the socket closes mid-sentence the server stops sending immediately.

## 7. Session lifetime

```
open ──▶ awaiting-hello ──hello──▶ idle ──listen start──▶ listening
             │                      ▲                        │
             │ 10 s timeout         │                        │ listen stop,
             ▼                      │                        │ VAD silence,
        close 1008                  │                        │ or 15 s cap
                                    │                        ▼
                                    └──tts stop / abort── processing
```

- Utterances are capped at `VOICE_MAX_UTTERANCE_MS` (15 s); the turn runs
  automatically at the cap.
- Anything shorter than `VOICE_MIN_UTTERANCE_MS` (400 ms) is dropped silently.
- A socket with no traffic for `VOICE_IDLE_TIMEOUT_MS` (5 min) is closed.
- History keeps the last `VOICE_MAX_HISTORY_TURNS` (8) exchanges.

## 8. Latency

Measured against the live services with a 2.4 s question, from `listen stop` to
the first audio frame:

| Stage                                    | Time   |
| ---------------------------------------- | ------ |
| `voicebox /transcribe`                   | ~7 s   |
| `modelrelay` first token                 | ~0.3 s |
| `voicebox /generate/stream`, 1st sentence| ~2 s   |
| **total to first audio**                 | ~9.5 s |

Speech-to-text dominates, and it is a property of the voicebox deployment, not
this server — that box reports `gpu_available: false` and runs the CPU backend.
A GPU there is the single change that would matter most. The sentence-level
streaming already hides most of the synthesis cost on longer answers.

## 9. Testing without hardware

`GET /voice/client` serves a browser page that speaks this exact protocol over
`pcm`: hold the button, talk, hear the answer. Use it to confirm the server
side works before debugging I2S.

`GET /voice/health` reports the live session count and the negotiated defaults.
