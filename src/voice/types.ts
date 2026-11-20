// ---------------------------------------------------------------------------
// Voice — interface skeleton for a future duplex (speech-to-speech) pipeline.
//
// Nothing imports this yet and it has zero dependencies on purpose: it fixes
// the seam between "Discord voice I/O" and "the model" so a duplex model can
// be dropped in without re-deciding the shape. See ./README.md for the v1
// pipeline (archived at tag `archive/voice-v1`) and what to restore.
// ---------------------------------------------------------------------------

/** 16-bit signed little-endian mono PCM at `sampleRate` Hz. */
export interface PcmChunk {
  data: Int16Array;
  sampleRate: number;
  /** Capture time (ms since epoch) of the first sample. */
  timestamp: number;
}

/**
 * Discord side of a voice call: joins a channel, yields each speaker's audio,
 * plays audio back. v1 implemented this across connection.ts / receiver.ts /
 * (the coach's) player.ts on top of @discordjs/voice.
 */
export interface VoiceTransport {
  join(guildId: string, channelId: string): Promise<void>;
  leave(): Promise<void>;
  readonly connected: boolean;
  /** Per-user inbound audio (decoded Opus, downsampled to the model's rate). */
  onAudio(handler: (userId: string, chunk: PcmChunk) => void): () => void;
  /** Queue outbound audio; resolves when it has been handed to the player. */
  play(chunk: PcmChunk): Promise<void>;
  /** Drop anything queued or playing — used for barge-in. */
  stopPlayback(): void;
}

/** Events a duplex model emits back to the pipeline. */
export type DuplexEvent =
  | { type: "audio"; chunk: PcmChunk }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  /** The model detected the user talking over it; the transport should stop playback. */
  | { type: "interrupted" }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "error"; error: Error }
  | { type: "closed" };

/**
 * A full-duplex speech model: audio streams in continuously while audio
 * streams out, with turn-taking and barge-in handled by the model rather than
 * by a VAD → STT → LLM → TTS chain as in v1.
 */
export interface DuplexVoiceModel {
  readonly name: string;
  /** Sample rate the model consumes; the transport resamples to this. */
  readonly inputSampleRate: number;
  open(opts: { systemPrompt: string; voiceId?: string }): Promise<void>;
  sendAudio(userId: string, chunk: PcmChunk): void;
  /** Answer a `tool_call` event. */
  sendToolResult(id: string, result: string, isError?: boolean): void;
  onEvent(handler: (event: DuplexEvent) => void): () => void;
  close(): Promise<void>;
}
