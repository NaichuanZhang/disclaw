// ---------------------------------------------------------------------------
// Invocation metrics — path registry
// ---------------------------------------------------------------------------
//
// Counting invocations alone cannot find dead code: you only ever see the
// paths that DID run. So every instrumented site is also *declared* here (or
// declared dynamically at boot from an existing manifest — commands, tools,
// routes, skills). Declared paths are seeded into `invocation_metrics` with
// count 0, so "declared but never incremented" is the dead-code signal.
//
// Path ids are dotted and stable: `<subsystem>.<thing>[.<variant>]`.
// Renaming one orphans its history, so treat them as an append-only vocabulary.
// ---------------------------------------------------------------------------

export type PathKind =
  /** Discord slash command (or `command.<name>.<subcommand>`) */
  | "command"
  /** Agent tool exposed to Claude */
  | "tool"
  /** Gateway HTTP route */
  | "route"
  /** Installed skill, counted when its SKILL.md is read */
  | "skill"
  /** A user-facing feature or subsystem entry point */
  | "feature"
  /** A conditional branch inside a feature (fallbacks, guards, recovery) */
  | "branch";

export interface PathSpec {
  /** Stable dotted id */
  path: string;
  kind: PathKind;
  /** What running this path means — shown in the report */
  description: string;
  /**
   * Set when a zero count is expected rather than suspicious: error handlers,
   * fallbacks, and recovery branches are supposed to be idle. The report
   * separates these from real dead-code candidates so nobody deletes the
   * crash-recovery path because it never fired.
   */
  rare?: boolean;
}

// ---------------------------------------------------------------------------
// Hand-instrumented paths
// ---------------------------------------------------------------------------
//
// Commands, tools, routes and skills are declared dynamically at boot from
// their own manifests (see declareCommandPaths etc. in counters.ts) — they
// never go stale. Everything below is instrumented by hand.

export const P = {
  // Agent pipeline
  agentTurnInteractive: "agent.turn.interactive",
  agentTurnCron: "agent.turn.cron",
  agentLoopDuplicateBreak: "agent.loop.duplicate_break",
  agentImagesExtracted: "agent.images.extracted",

  // Pilot mode
  pilotTurnSubmit: "pilot.turn.submit",
  pilotSessionInterrupt: "pilot.session.interrupt",
  pilotSessionStop: "pilot.session.stop",

  // Memory
  memorySearchLocal: "memory.search.local",
  memoryGetLines: "memory.get_lines",
  memoryMem9Search: "memory.mem9.search",
  memoryMem9Store: "memory.mem9.store",
  memoryMem9Update: "memory.mem9.update",
  memoryMem9Delete: "memory.mem9.delete",

  // Audio transcription backends
  audioTranscribeDispatch: "audio.transcribe.dispatch",
  audioTranscribeWhisperCpp: "audio.transcribe.whispercpp",
  audioTranscribeLocalNemo: "audio.transcribe.local_nemo",

  // Voice assistant + coach
  voiceSessionStart: "voice.session.start",
  voiceSessionStop: "voice.session.stop",
  voiceSttTranscribe: "voice.stt.transcribe",
  voiceTtsSynthesize: "voice.tts.synthesize",
  voiceTtsSynthesizeStream: "voice.tts.synthesize_stream",
  voiceCoachInit: "voice.coach.init",
  voiceCoachDestroy: "voice.coach.destroy",

  // Model selection
  modelsListFetch: "models.list.fetch",
  modelsCacheWarm: "models.cache.warm",
  modelsCacheInvalidate: "models.cache.invalidate",

  // Cron
  cronJobRun: "cron.job.run",
  cronJobForceRun: "cron.job.force_run",

  // Skills
  skillsRead: "skills.read",
} as const;

export const FEATURE_PATHS: PathSpec[] = [
  // --- Agent pipeline ---
  {
    path: P.agentTurnInteractive,
    kind: "feature",
    description: "Interactive agent turn (Discord message → Claude)",
  },
  {
    path: P.agentTurnCron,
    kind: "feature",
    description: "Agent turn triggered by a cron job",
  },
  {
    path: P.agentLoopDuplicateBreak,
    kind: "branch",
    description: "Tool loop broken after repeated identical calls",
    rare: true,
  },
  {
    path: P.agentImagesExtracted,
    kind: "branch",
    description: "Agent reply contained markdown images that were rendered",
  },

  // --- Pilot mode ---
  { path: P.pilotTurnSubmit, kind: "feature", description: "Message submitted to a pilot session" },
  {
    path: P.pilotSessionInterrupt,
    kind: "feature",
    description: "Pilot session turn interrupted (/interrupt)",
  },
  { path: P.pilotSessionStop, kind: "feature", description: "Pilot session stopped" },

  // --- Memory ---
  { path: P.memorySearchLocal, kind: "feature", description: "Local FTS5 memory search" },
  { path: P.memoryGetLines, kind: "feature", description: "Read lines from a local memory file" },
  { path: P.memoryMem9Search, kind: "feature", description: "mem9 cloud memory search" },
  { path: P.memoryMem9Store, kind: "feature", description: "mem9 cloud memory write" },
  { path: P.memoryMem9Update, kind: "feature", description: "mem9 cloud memory update" },
  { path: P.memoryMem9Delete, kind: "feature", description: "mem9 cloud memory delete" },

  // --- Audio transcription ---
  {
    path: P.audioTranscribeDispatch,
    kind: "feature",
    description: "Attachment transcription requested (backend-agnostic entry)",
  },
  {
    path: P.audioTranscribeWhisperCpp,
    kind: "branch",
    description: "Transcription served by whisper.cpp",
  },
  {
    path: P.audioTranscribeLocalNemo,
    kind: "branch",
    description: "Transcription served by the local NeMo/Parakeet backend",
  },

  // --- Voice ---
  { path: P.voiceSessionStart, kind: "feature", description: "Voice assistant joined a channel" },
  { path: P.voiceSessionStop, kind: "feature", description: "Voice assistant left / stopped" },
  { path: P.voiceSttTranscribe, kind: "feature", description: "Voice STT on a captured utterance" },
  { path: P.voiceTtsSynthesize, kind: "feature", description: "Voice TTS (buffered synthesis)" },
  {
    path: P.voiceTtsSynthesizeStream,
    kind: "feature",
    description: "Voice TTS (streaming synthesis)",
  },
  { path: P.voiceCoachInit, kind: "feature", description: "Voice coach subsystem initialised" },
  { path: P.voiceCoachDestroy, kind: "feature", description: "Voice coach subsystem torn down" },

  // --- Models ---
  { path: P.modelsListFetch, kind: "feature", description: "Model list fetched from the proxy" },
  { path: P.modelsCacheWarm, kind: "branch", description: "Model cache warmed at boot" },
  {
    path: P.modelsCacheInvalidate,
    kind: "branch",
    description: "Model cache invalidated (/model refresh)",
  },

  // --- Cron ---
  { path: P.cronJobRun, kind: "feature", description: "Scheduled cron job fired" },
  { path: P.cronJobForceRun, kind: "feature", description: "Cron job run on demand (/cron run)" },

  // --- Skills ---
  { path: P.skillsRead, kind: "feature", description: "A skill's file was read by the agent" },
];

/** Path id for a slash command, optionally scoped to a subcommand. */
export function commandPath(name: string, subcommand?: string): string {
  return subcommand ? `command.${name}.${subcommand}` : `command.${name}`;
}

/** Path id for an agent tool. */
export function toolPath(name: string): string {
  return `tool.${name}`;
}

/** Path id for a gateway route. */
export function routePath(method: string, path: string): string {
  return `route.${method.toUpperCase()} ${path}`;
}

/** Path id for an installed skill. */
export function skillPath(name: string): string {
  return `skill.${name}`;
}
