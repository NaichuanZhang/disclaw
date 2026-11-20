# Voice (skeleton)

Live voice chat was removed in favour of a future **duplex** (speech-to-speech)
model. This folder keeps the seam, not the code:

- `types.ts` — `VoiceTransport` (Discord voice I/O) and `DuplexVoiceModel`
  (the model). Zero dependencies and not imported anywhere yet.

Voice-*message* transcription (audio attachments) is unrelated and still
works: `src/audio/transcribe.ts` → whisper.cpp. `transcribePcm16kWhisperCpp()`
in `src/audio/whispercpp-transcribe.ts` is the raw-PCM entry point v1 used and
is kept for a realtime pipeline.

## v1, archived

Everything is preserved at git tag **`archive/voice-v1`** (commit `e2f5681`):

```
git show archive/voice-v1:src/voice/connection.ts      # view one file
git checkout archive/voice-v1 -- src/voice/connection.ts src/voice/receiver.ts
```

| v1 file | Role | Reuse for duplex? |
|---|---|---|
| `src/voice/connection.ts` | join/leave, `VoiceConnection` lifecycle | **yes** — basis of a `VoiceTransport` |
| `src/voice/receiver.ts` | per-user Opus decode → 48 kHz stereo → 16 kHz mono PCM | **yes** |
| `src/voice-coach/player.ts` | audio playback into a channel | **yes** |
| `src/voice/autoJoin.ts` | follow a tracked user between voice channels | maybe |
| `src/voice/vad.ts` | Silero VAD v4 (onnxruntime) | no — duplex models do turn-taking |
| `src/voice/stt.ts` / `tts.ts` | whisper.cpp STT, ElevenLabs (streaming) TTS | no |
| `src/voice/agent.ts` | Anthropic tool loop per utterance | no — replaced by the model |
| `src/voice/index.ts` | orchestration + `/join` `/leave` | rewrite |
| `src/voice-coach/*` | cycling coach (mock telemetry) | no |

## To bring voice back

1. Re-add deps: `npm i @discordjs/voice @discordjs/opus libsodium-wrappers`
   (+ `-D @types/libsodium-wrappers`; `onnxruntime-node` only if you need VAD
   again, then restore `migrations/004-download-silero-vad-v4.sh` too).
2. Re-add `GatewayIntentBits.GuildVoiceStates` in `src/bot/client.ts`.
3. Implement `VoiceTransport` from the three reusable v1 files above and a
   `DuplexVoiceModel` for the chosen provider.
4. Wire init/shutdown in `src/index.ts`, re-add `/join` and `/leave` in
   `src/bot/commands.ts`, and declare `voice.*` paths in `src/metrics/registry.ts`.
5. Env vars v1 used (for reference): `VOICE_MODEL`, `VOICE_SILENCE_MS`,
   `VOICE_MIN_UTTERANCE_MS`, `VOICE_MAX_TOKENS`, `VOICE_DEBUG`,
   `VOICE_TTS_STREAM`, `VOICE_TOOLS_MODE`, `VOICE_TTS_VOICE_ID`,
   `VOICE_STT_REMOTE_FALLBACK`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
   `COACH_MODEL`.
