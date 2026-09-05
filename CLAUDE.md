# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start bot + gateway (tsx src/index.ts)
npm run build        # TypeScript compile + Vite build dashboard
npm run build:ui     # Build dashboard SPA only
npm run typecheck    # tsc --noEmit
npm test             # Run integration tests (vitest run)
npm run test:watch   # Run tests in watch mode
npx vitest run tests/integration/foo.test.ts  # Run a single test file
npm run daemon       # Start watchdog daemon (spawns bot, health checks, crash recovery)
npx tsx scripts/metrics-report.ts  # Invocation metrics: dead code, low-use features, busiest paths
./start.sh           # Production: git pull → migrate → build → start → health check → rollback
```

The dashboard SPA lives at `src/gateway/ui/` and builds to `dist/ui/`. Vite dev server proxies `/api` and `/ws` to localhost:3000. The UI is excluded from `tsconfig.json` — it's built by Vite with its own React plugin.

## Testing

Integration tests live in `tests/integration/` and use **vitest**. They validate the critical boot path without calling external APIs:

- **Database**: Schema init, table existence, CRUD operations
- **Soul**: Loading from `data/SOUL.md`
- **Memory**: FTS5 indexing, search queries
- **Skills**: Service init, prompt section generation
- **Image extraction**: Pure function — markdown parsing for URL/file images
- **Tool registration**: All tool arrays export correctly with unique names

Tests run automatically as a quality gate in the evolution engine — `finalizeEvolution()` runs both `tsc --noEmit` and `vitest run` before allowing a PR to be created. If either fails, the PR is blocked.

To add new tests, create files matching `tests/**/*.test.ts`.

## Architecture

This is a Discord bot that uses Claude as its AI backend. The system has major subsystems that initialize sequentially in `src/index.ts`: dotenv → database → soul → memory FTS5 indexing → skills → `gh` CLI check → voice coach → voice assistant → cron → Discord client → gateway server → health check → evolution sync → session cleanup → reflection daemon.

### Bot → Session → Claude Pipeline

Discord messages flow through `bot/messages.ts` (filter, session resolve, thread creation, voice transcription, artifact registration, attachment download) → `submitToSdkSession` → a Claude Agent SDK child process. There is one runtime and it is the SDK; `messages.ts` owns the Discord side of a turn and nothing else. The tool loop, context compaction, duplicate-call handling and token accounting are the SDK's. Assistant text, tool-progress lines and the `-# 📊` usage footer are relayed back through `sdk/relay-queue.ts`, and `sdk/session.ts#logTurn()` writes one assistant row per turn into SQLite. Model selection lives in `shared/models.ts` — see **Model Selection** below.

### Agent Tools

Tools are defined across multiple files and bridged into every session as an in-process MCP server by `sdk/bridge.ts` (so the model sees them as `mcp__discordclaw__<name>`):

| File | Tools | Purpose |
|------|-------|---------|
| `agent/tools.ts` | send_message, send_file, add_reaction, get_channel_history, create_thread, ask_user | Discord channel operations |
| `agent/questions.ts` | ask_user question registry | Creates pending questions, blocks the agent turn until a button/select/free-text answer arrives or it times out (max 300s). Pending questions are expired at boot. |
| `agent/dangerous-tools.ts` | bash, read_file, write_file | System access |
| `shared/conversation-history.ts` | get_conversation_history, get_conversation_stats | Cross-session conversation replay |
| `memory/tools.ts` | memory_search, memory_get, mem9_store, mem9_update, mem9_delete | Hybrid search: local BM25 FTS5 + mem9 cloud memory |
| `memory/mem9.ts` | (internal) | mem9 cloud memory API client |
| `skills/tools.ts` | read_skill, list_skill_files | Progressive skill loading |
| `evolution/tools.ts` | evolve_start, evolve_read, evolve_write, evolve_bash, evolve_propose, evolve_suggest, evolve_cancel, evolve_review, evolve_merge | Self-modification via PRs |

**mem9 tools** (`mem9_store`, `mem9_update`, `mem9_delete`) are only registered when mem9 is configured via `data/skills/mem9/auth.json`. The `memory_search` tool always queries both local FTS5 and mem9 cloud in parallel (graceful fallback if mem9 is unavailable).

### Model Selection

`src/shared/models.ts` owns the model catalog, the persisted selection, and the resolution order. Everything that calls the Anthropic API goes through `resolveModel(override?)`.

**Precedence**: per-cron-job override → persisted `/model` selection (`config.selected_model`) → `ANTHROPIC_MODEL` env → `DEFAULT_MODEL` (`bedrock-claude-opus-5-1m`). The DB deliberately outranks the env var so a runtime `/model` choice isn't defeated by a stale deploy-time value.

**Model router** (`src/shared/model-router.ts`) sits *between* the `/model` selection and the env var for **interactive SDK sessions only**, so the full order a new Discord thread sees is: `SDK_ANTHROPIC_MODEL` env pin → `/model` selection → router (default on) → `ANTHROPIC_MODEL` env → `DEFAULT_MODEL`. Cron `agentTurn`s are untouched (per-job override, then the normal chain). An SDK child keeps its model for life, so the router decides once, when `bot/messages.ts` is about to create the session: `classifyHeuristic()` (code fences, paths, stack traces, coding vocabulary, code attachments → `coding`; "smarter/better model", "use fable/opus" → `escalate`; nothing → `common`; one weak signal → `ambiguous`) and only an ambiguous message pays for the LLM judge (`ROUTER_MODEL_JUDGE`, 5 output tokens, 3 s timeout, never throws — a failure falls back along `ROUTER_BIAS=cheap|balanced|strong`). Tiers: `ROUTER_MODEL_CODING` (default `bedrock-claude-fable-5-1`) and `ROUTER_MODEL_COMMON` (default `bedrock-claude-sonnet-5`). The pick is passed as `modelOverride` to `submitToSdkSession` and announced in-channel as `-# 🧭 <model> (<tier>, <source>)`. Mid-thread, the only trigger is an explicit `escalate`: `messages.ts` calls `stopSdkSession()` and resubmits with the stronger model, so the new child resumes the same transcript (the existing bad-resume path announces the rare failure). An explicit `/model name:<id>` is a human decision and the router stands down while it is set (`/model reset:true` hands control back); `/model router:true|false` toggles it (`config.model_router`); `/model` shows the tier models, bias and current state. Every branch — route, escalate, and each skip reason (`sdk_env_pin`, `model_pin`, `disabled`, `live_session`, `empty`) — is written to `application_log` under category `router` with channel, tier, source, heuristic hits and judge latency; judge failures go to `error_log`; counters live under `router.*` in the metrics registry.

The catalog comes from `GET {ANTHROPIC_BASE_URL}/v1/models` (LiteLLM/OpenAI-shaped), TTL-cached for 5 minutes, with `FALLBACK_MODEL_IDS` used when the proxy is unreachable so selection never presents an empty list. `warmModelCache()` runs (unawaited) at boot. `resolveModel()` is synchronous, never throws, and self-heals a model the proxy no longer advertises — but only against an already-warm cache, so it never blocks a message.

**Discord surface**: `/model` shows the active model and its source; `/model name:<id>` persists a bot-wide selection (validated against the catalog); `/model reset:true` (or `name:default`) clears it; `/model refresh:true` busts the cache. `/cron add model:<id>` and `/cron set-model <id> <model>` set a per-job override stored in `CronPayload.model`.

Autocomplete for these options is **cache-only** (`getCachedSelectableModelIds()`) and never awaits the network — Discord allows one response within ~3s and has no defer equivalent, while the catalog fetch timeout alone is 5s. A cold cache serves the fallback list and fires a background warm.

**Which model is actually running** is reported from the SDK child, not from any of the above. `session.ts` reads `model` off the `system/init` handshake into `SdkSession.activeModel` (reset to `null` every time a child spawns, so a resume or escalate-restart can never show a stale value) and every indicator reads that field only: a `-# 🟣 running on \`fable-5-1\`` line per child start, a model-family reaction on each user message (🟣 fable/mythos · 🔵 opus · 🟢 sonnet · ⚪ haiku · ⚫ other · ❔ before the handshake — `modelFamilyEmoji()` in `shared/model-router.ts`; a message submitted before the first handshake has its reaction parked in `pendingModelReacts` and applied when `init` lands), the `Sessions` field of `/ping`, and `GET /api/sessions/live` (`activeSdkSessions()`, registered above `/sessions/:id` so the literal path is not swallowed). None of these consult `resolveModel()`, the `config` table or the env — if the CLI ever omits `init.model` they say `unknown`/`pending` rather than echo what was configured.

Voice (`VOICE_MODEL`) and the cycling coach (`COACH_MODEL`) are configured separately and are not affected by `/model`.

### Thread-Based Replies

In guild text channels, the bot always creates a new thread on the user's message and replies inside it (isolated context per conversation). Bot-created threads don't require @mention — thread ownership is tracked in a `Set<string>` with a fallback to `thread.ownerId`. DMs bypass threading. Monitored channels auto-respond without @mention. Thread names are auto-generated from the first line of the user's message.

### Voice System

`src/voice/` implements a full voice assistant pipeline: Discord audio → Opus decode → downsample to 16kHz mono (`receiver.ts`) → Silero VAD v4 (`vad.ts`, frame size 480 samples = 30ms) → local whisper.cpp STT (`stt.ts`) → LLM agent (`agent.ts`) → ElevenLabs TTS (`tts.ts`) → playback.

Two LLM backends:
- **Anthropic** (default): `claude-sonnet-4-20250514` configurable via `VOICE_MODEL`. Full tool support with up to 5 tool rounds per utterance.

Tool availability configurable via `VOICE_TOOLS_MODE`:
- `full` (default): memory, conversation history, Discord, skills, bash, file I/O — everything except evolution tools
- `minimal`: memory + conversation history only

`autoJoin.ts` tracks a configured user and auto-joins/leaves their voice channel. STT is local (whisper.cpp — no key, no network); TTS requires `ELEVENLABS_API_KEY`. Pick the assistant's voice with `VOICE_TTS_VOICE_ID`, else `ELEVENLABS_VOICE_ID`.

Key voice constants: `SILENCE_DURATION_MS = 800` (configurable via `VOICE_SILENCE_MS`), `MIN_UTTERANCE_MS = 500` (configurable via `VOICE_MIN_UTTERANCE_MS`), `IDLE_TIMEOUT_MS = 10min` (auto-leave), `VOICE_MAX_TOKENS = 512` (configurable via `VOICE_MAX_TOKENS`), `MAX_TOOL_ROUNDS = 5`, `MAX_VOICE_HISTORY = 10` turns. Streaming TTS pipelining enabled by default (disable with `VOICE_TTS_STREAM=0`).

Separate from voice chat: `audio/transcribe.ts` handles Discord voice message transcription (audio attachments) through a local-first backend chain — `audio/whispercpp-transcribe.ts` (whisper.cpp native binary, no Python required; set up via `scripts/setup-whispercpp.sh`), then `audio/local-transcribe.ts` (NeMo Parakeet, needs pip), then OpenAI's Whisper API if `OPENAI_API_KEY` is set. When all backends fail, `getLastTranscriptionFailureSummary()` returns a combined per-backend reason for logging.

### Voice Coach

`src/voice-coach/` implements an AI cycling coach that runs independently of the voice assistant. It auto-joins a dedicated voice channel when a tracked rider connects (via `voiceStateUpdate` listener).

**Pipeline**: Every 7 seconds, the orchestrator polls simulated cycling telemetry from `mock-server.ts` (power, heart rate, cadence, speed, elapsed time) → feeds data + rider speech messages to `coach-brain.ts` (LLM with team sport director persona, configurable via `COACH_MODEL`, default: `bedrock-claude-sonnet-4-1m`) → if coach has something to say → `elevenlabs-tts.ts` synthesizes speech → `player.ts` plays audio in the voice channel.

**Rider speech**: `listener.ts` reuses the voice assistant's receiver, VAD, and STT components. Rider audio is captured, speech boundaries detected via Silero VAD, transcribed locally via whisper.cpp, and queued as timestamped messages. The coach brain reads and flushes the queue each poll cycle.

**Key files**:
- `index.ts` — Orchestrator: `initVoiceCoach()`, `setVoiceCoachClient()`, auto-join/leave on `voiceStateUpdate`, 7s poll loop
- `coach-brain.ts` — LLM decision engine: system prompt with German-accented team radio persona, maintains rolling telemetry + coach history, responds with coaching text or `[SILENCE]`
- `elevenlabs-tts.ts` — ElevenLabs TTS client for coach voice synthesis
- `player.ts` — Voice channel connection management + audio playback (separate from voice assistant's player)
- `listener.ts` — Rider speech capture via VAD+STT, queued for coach brain consumption
- `mock-server.ts` — Simulated cycling telemetry generator

Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. The coach channel ID and tracked user ID are currently hardcoded in `src/index.ts`.

### Artifacts

`src/artifacts/index.ts` provides persistent file storage for tracking session inputs (uploaded files) and outputs (generated files). Files are stored on disk at `data/artifacts/<sessionId>/` with metadata in SQLite.

**Key functions**: `registerArtifactFromBuffer()`, `registerArtifactFromFile()`, `updateArtifactDiscordInfo()`, `getSessionArtifacts()`, `getArtifact()`, `getAllSessionsWithArtifacts()`.

**Gateway integration**: `src/gateway/artifacts.ts` exposes REST API routes (`/api/artifacts`, `/api/artifacts/:sessionId`, `/api/artifacts/:sessionId/:artifactId`) and file serving. Dashboard Artifacts page (`src/gateway/ui/pages/Artifacts.tsx`) provides per-session browsing. Uses `GATEWAY_PUBLIC_URL` for generating download URLs in production.

**Message pipeline integration**: `bot/messages.ts` calls `registerArtifactFromBuffer()` to track file attachments uploaded by users.

### Session Management

Sessions are keyed by thread/channel/user/DM combination. `agent/sessions.ts` resolves the correct session and loads history from SQLite. Sessions auto-expire based on `SESSION_TTL_HOURS`. Thread-based sessions use the `thread:<threadId>` key format. For threads, history is assembled by `bot/thread-history.ts`, which merges the Discord `messages.fetch()` result with an in-memory per-thread cache and the durable DB rows for `thread:<threadId>` (live + archived), so context survives Discord API failures, restarts, session expiry, and threads longer than the fetch window. `/clear` in a thread also clears that cache and sets a cutoff timestamp (readable via `getThreadClearCutoff()`).

History is the session's own: the SDK child keeps the conversation it has seen, so nothing is injected into the prompt ahead of a turn. `get_channel_history` in `agent/tools.ts` fetches straight from Discord for what the session *hasn't* seen — messages from before it started, older than its window, or in a different channel — and honours the `/clear` cutoff (`getThreadClearCutoff` in `bot/thread-history.ts`, which is also what `/clear` writes) so a cleared conversation cannot be read back in. It renders embed/attachment-only messages as text. Messages are archived across sessions, queryable via `get_conversation_history` and `get_conversation_stats` tools (defined in `shared/conversation-history.ts`).

**No per-session lock.** There used to be a mutex serialising messages per session; the SDK's streaming input made it counterproductive. A message arriving mid-turn is *injected* into the running turn instead of queueing behind it (see **Agent Runtime**), so ordering is the session's concern and `bot/messages.ts` just submits. `/stop` kills the child processes (which takes their shell descendants with them) and `/interrupt` calls the SDK's native `Query.interrupt()`; neither needs an `AbortSignal` threaded through our own code.

### Soul, Memory, and Skills

- **Soul**: Bot personality loaded from `data/SOUL.md` with filesystem watcher for hot-reload. Injected into every system prompt.
- **Memory**: Hybrid search — local markdown files in `data/` and `data/memory/` chunked and indexed into SQLite FTS5 (BM25-ranked), plus optional mem9 cloud memory (`src/memory/mem9.ts`). Both sources are queried in parallel on every `memory_search` call. mem9 config lives in `data/skills/mem9/auth.json`. When mem9 is configured, additional tools (`mem9_store`, `mem9_update`, `mem9_delete`) are dynamically registered. Graceful fallback if mem9 is unavailable.
- **Skills**: SKILL.md files with YAML frontmatter in `data/skills/`. Progressive loading — only metadata in system prompt; full content via `read_skill` tool. Installable from GitHub URLs.

### Cron Service

Scheduled tasks in `data/cron/jobs.json` (gitignored; seed file tracked). Three schedule types: one-shot (`at`), interval (`every`), cron expression. Two payload kinds: `agentTurn` (agent handles delivery via tools — creates threads, no duplicate top-level messages; always executed by a Claude Agent SDK session, see below) and `systemEvent` (cron service delivers directly). Auto-disables after 3 consecutive failures. Hot-reloads `jobs.json` on each tick cycle (up to every 60s).

### Agent Runtime (Claude Agent SDK)

`src/sdk/` is the only agent runtime. Every Discord message that survives the filter, and every cron `agentTurn`, is handed to a Claude Agent SDK session — one child process per target, keyed by thread / DM / channel id. `bot/messages.ts` dispatches after voice transcription and **after** thread creation, so a top-level message becomes thread → one session keyed to that thread, and each thread is an isolated context. Step 6b keeps only the empty-content bail-out, so we never create a thread we can't use.

- `session.ts` — one `query()` session per target (a thread in practice, keyed by `target.id`). The prompt is an async generator, so `submit()` can inject a new Discord message into a turn that is already running. That injection is made visible: when a message lands after the turn has already produced output (`sawTurnOutput`), `markSteer()` reacts ↩️ on it and posts a `-#` marker line naming the tool that was in flight (`lastToolName`, the last tool *relayed*, which can lag the one actually executing) plus a per-turn steer count. Messages fired back-to-back *before* any output are genuinely batched input and are deliberately not marked. The per-turn markers, `turnActive` and the typing indicator are reset together in `endTurn()`, called from the `result` branch, `interrupt()` and the run-loop `finally`. Relays assistant text and tool-call lines to the channel through `relay-queue.ts` (no message-edit streaming), posts a `-# 📊` usage footer per `result` (tokens from the per-turn `usage`, cost as the delta of the *cumulative* `total_cost_usd`, model from the busiest `modelUsage` entry) and a `-# ⚠️ <tool> failed` line for any `tool_result` with `is_error` (labelled from a bounded `tool_use` id → name map, since a silently-swallowed tool error otherwise leaves a gap in the transcript). Persists the SDK session id in `channel_configs.settings.sdkSessionId` and passes it as `resume` after a restart; `loadSdkSessionId` also reads the pre-rename `pilotSessionId`, so a session live at deploy time resumes whether or not migration 007 has run yet. A stored id can go stale (the CLI prunes its own transcripts), which fails *before* the `system/init` handshake — so `run()` treats "errored with `resume` set and no `sawInit`" as a bad resume exactly once: it clears the stored id, replays the messages the CLI never answered (`pendingReplay`, capped at `REPLAY_LIMIT`, with the waker dropped so the abandoned generator can't steal them), says so in the channel, and starts fresh. Without this, one pruned transcript bricks a thread permanently. Loads project settings (`settingSources: ['project']`), which is what makes the workspace `CLAUDE.md` and `.claude/settings.json` apply at all — the SDK reads neither otherwise; `'user'` stays omitted so the operator's own `~/.claude` is not inherited. Idle-reaped (`SDK_IDLE_MS`, which posts a `-# 💤` notice via `stop(reason, notice)` so the silence explains itself), stopped by `/stop` (aborting the child kills its shell descendants), and orphaned children are swept at boot by matching `/proc/<pid>/cwd` against the workspace. `interrupt()` / `interruptSdkSession(channelId)` wrap the SDK's native `Query.interrupt()` (streaming-input only, which is what we always use): the live `query()` handle is kept on `this.stream`, our own `this.queue` is dropped locally, and `still_queued` uuids from the receipt are surfaced only when the CLI advertised `interrupt_receipt_v1` in its `system/init` capabilities (feature-detect, never version-sniff). `cancel_queued` is in the SDK types but is not implemented in the shipped CLI, so we do not pass it. `/interrupt` is per-channel and keeps context; `/stop` is global and kills the child. A per-turn watchdog (`SDK_TURN_TIMEOUT_MS`, default 15 min) is armed by `beginTurn()` and cleared in `endTurn()`/`stop()`; on expiry it says so and calls `interrupt()`, **not** `stop()`, so a wedged turn costs the turn and not the session. `SDK_TURN_MAX_COST_USD` (default `0` = off) appends a `-# 💸` over-soft-cap line to the usage footer. `resetSdkSession(channelId)` = stop + clear the stored session id. Because sessions key to threads while slash commands are typed in the parent, the registry also exposes a *scope* walk — `sdkSessionChannelIdsUnder(channelId)` (the channel itself plus every live session whose `parentId` is it) and the `interruptSdkSessionsUnder` / `stopSdkSessionsUnder` / `resetSdkSessionScope` wrappers over it, which is what `/clear` and `/stop` use so they cannot report success while a thread session keeps streaming one level down. A session also carries an optional `modelOverride` (from `SdkIncomingMessage`), captured only while `!this.started` and applied as an `ANTHROPIC_MODEL` entry in `buildSdkEnv({overrides})`; `SDK_ANTHROPIC_MODEL` still wins, and a running child keeps the model it started with.
- Env names: `pickSdkEnv(source, name)` reads `SDK_<name>` and falls back to the pre-rename `PILOT_<name>`, so an operator `.env` written before the rename keeps working. Every knob above goes through it. Same reasoning for `data/sdk/`, which is renamed from `data/pilot/` on first boot if the old directory is the one that exists.
- `relay-queue.ts` — the outbound half of the relay, and the reason the runtime no longer trips Discord's rate limit. `push()` sends promptly; `pushCoalescing()` (tool markers, failure lines) merges consecutive entries into one message on a ~1.2 s debounce, capped at 1900 chars. A token bucket (5 sends / 5 s) *waits* rather than dropping, and everything drains through one promise chain so channel order matches SDK order. `endTurn()` flushes it — a debounce must never outlive the turn — and `stop()` closes it after the notice is queued. Clock and sleep are injectable, so the throttle is tested without fake timers.
- **No tool-call policy.** Sessions run with `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, so `canUseTool` never fires and tool calls are entirely unguarded — they can reach `src/**`, `.env`, `git push`, anything the bot user can do, in **every** channel and DM. `policy.ts` used to hold pure rule functions (protected paths + denied shell commands) that were kept and unit-tested but never consulted; it was deleted by operator request. To re-add a gate, restore `canUseTool` or add a `PreToolUse` hook (which still fires in bypass mode).
- `bridge.ts` — `createSdkMcpServer` re-exporting our own tools in-process: Discord (`send_message`, `send_file`, `add_reaction`, `ask_user`), memory, skills (`read_skill`, `list_skill_files`, thin wrappers over `skills/tools.ts`), context reads (`get_channel_history` and `create_thread` over `agent/tools.ts`, `get_conversation_history` and `get_conversation_stats` over `shared/conversation-history.ts` — channel-scoped ones default to the session's channel), and the full evolution set (`evolve_start/read/write/bash/propose/suggest/cancel/review/merge`, thin wrappers over `evolution/tools.ts`). Each evolve wrapper calls `setEvolutionContext(channelId, getUserId?.())` immediately before dispatching, because that context is module-global. `SdkBridgeOptions.getUserId` is a *getter*, not a string: the MCP server is built once per session in `buildOptions()`, so a captured value froze `ask_user` mentions and every `evolve_*` attribution on whoever spoke first. The plan-approval gate is enforced in `evolution/tools.ts` (`evolve_start` refuses a plan under 80 chars or `plan_approved !== true`), and the prompt text lives in `evolution/instructions.ts` so the rules can be read and changed without touching the session. Skills reach the model the same way: `session.ts#buildSkillsPrompt()` appends `getSkillService().buildSkillsPromptSection()` to the system prompt, and a skill is loaded on demand via the MCP-prefixed `mcp__discordclaw__read_skill`. `buildEvolutionPrompt()` does the same for `EVOLUTION_INSTRUCTIONS` plus the `mcp__discordclaw__evolve_*` name mapping and an instruction not to edit `src/` with the native Write tool.
- Prompt fragments: `session.ts#buildIdentityPrompt()` prepends `getSoul()` and `MEMORY_RECALL_INSTRUCTIONS` (from `shared/prompt-fragments.ts`) and `buildCavemanPrompt()` appends `buildCavemanInstructions(level)` when the channel has `settings.cavemanLevel`. `buildChannelPrompt()` appends the channel's own `settings.systemPrompt` under a `## Channel Instructions` heading, so `/config set-prompt` reaches the session. The fragments live in `shared/` because the slash commands read the same definitions — a level set by `/caveman` has to mean the same thing in the prompt and in the reply that confirms it. Channel settings are read through `channelSettings(read)`, which tries the session's own channel and falls back to `parentId`: the session lives on a thread while `/caveman` and `/config set-prompt` write to the parent, so without the fallback a thread session silently ignored both. Either way the read happens once, when the SDK child starts: a level or prompt changed mid-session applies from the next session (idle reap, `/clear` or `/stop`), which is what the `-# 🧪` footnote on those replies says. Turn failures call `recordSignal({type:"error"})` so the reflection daemon sees them.
- `cron-route.ts` — the pure half of "where should a cron `agentTurn` run". *Whether* it runs on the SDK is not a question; `planSdkCronRoute` only answers where the session lives — the channel the session keys to, and whether the caller must create a thread first (never for a thread or a DM). It returns null only when there is no delivery channel to host a session, and `runCronAgentTurn` in `index.ts` then throws so the cron run record shows the failure instead of dropping it: there is no second runtime to fall back to. The Discord calls stay in `index.ts`, which is what makes the rules testable.
- `session-dirs.ts` — the folder each session owns: `sessions/<id>/`, or `sessions/<parentId>/threads/<id>/` when `parentId` is set. Nested, not concatenated — the session key is the thread's *own* snowflake (`target.id`) and snowflakes are globally unique, so `<parent>-<child>` would buy no collision safety while making the id harder to paste back into a Discord URL; the parent id is used for hierarchy, matching the thread-then-parent resolution `channelSettings()` and `sdkSessionChannelIdsUnder()` already do. Segments go through an allowlist (`[A-Za-z0-9_-]`, everything else → `_`, empty → `unknown`), which both blocks `..` traversal and keeps non-snowflake ids distinct — a digits-only sanitiser would collapse `chan-1` and `dm-1` onto one folder. `ensureSdkSessionDir()` is called on every `run()` and seeds a `CLAUDE.md` only when absent, because that file is the durable record once the CLI prunes its transcript. Like `attachments.ts`, `SDK_SESSIONS_DIR` is derived from `DATA_DIR` rather than imported from `session.ts` — here the reason is the db module graph, which would otherwise be pulled into a test worker and race `initDb()`; a test keeps the two paths in agreement. **That folder is also the session's cwd** (`cwd: this.sessionDir()`), so artifacts land in it by default rather than by discipline, and `CLAUDE.md` discovery walks up from it — the session's own file, the workspace one and the repo one all load. `sdkSessionInboxDir()` puts attachments inside it too, passed from `bot/messages.ts` as `inboxDir` (the constant in `attachments.ts` is now only a fallback). Two things had to move with cwd. **Transcripts**: the CLI keys them by cwd (`~/.claude/projects/<abs-cwd-with-/-as->/<session-id>.jsonl`), so an id stored while every session shared the workspace root points at a directory the CLI no longer reads — `claudeProjectKey()`/`claudeProjectDir()` derive the new location and `migrateTranscript()` **copies** (never moves) the `.jsonl` plus the sibling `<session-id>/` subagent directory into it before a resume. Copy, because the key rule was confirmed by observation rather than from a documented contract: the worst case must be a duplicated file, and reverting the cwd change must still resume. It finds the source by scanning `~/.claude/projects/*/` rather than replicating the sanitiser, no-ops when the destination already has it, returns `source-missing` when the CLI has already pruned it (`run()`'s existing bad-resume path then takes over), and never throws. `session.ts#checkTranscriptLocation()` compares the derived directory against `transcript_path` from the `system/init` handshake and logs loudly on a mismatch, so a CLI change surfaces instead of silently costing history. **The orphan sweep**: `isInsideDir()` replaces the exact cwd compare with a `root + path.sep` prefix, since every session cwd is now *below* the workspace root and an exact match would catch none of them — the separator is what keeps a sibling like `<workspace>-old` from matching. It lives here rather than in `session.ts` for the same db-graph reason.
- `attachments.ts` — a session takes plain text and has its own `Read`, so an attachment is downloaded to `<session-folder>/inbox/<messageId>/<name>` and the *absolute path* is appended to the message text rather than turned into a content block. Names are sanitised to `[A-Za-z0-9._-]` from the basename only (so `../../etc/passwd` becomes `passwd` and `.env` becomes `env`), collisions get `-1`, `-2`, downloads are capped by `SDK_ATTACHMENT_MAX_BYTES` (default 25 MB, checked against the declared size *and* the real body length), and the inbox is pruned on every save past `SDK_INBOX_MAX_AGE_MS` (default 24 h). Nothing throws: a failed or oversized attachment is listed back to the model with its reason. `SDK_INBOX_DIR` (`<workspace>/inbox`) is derived from `DATA_DIR`, not imported from `session.ts` — that import cycle evaluated to `undefined` at module-eval time; a test keeps the two paths in agreement. It is now only the *fallback*: live traffic passes a per-session `inboxDir` from `sdkSessionInboxDir()`, so `saveSdkAttachments` needed no change beyond being given one — it already honoured the option and already returned absolute paths.
- Conversation logging: the runtime writes the same `messages` rows as before. `bot/messages.ts` resolves a session row for the thread, logs the user message (with the attachment block included, so history shows what the session actually saw) and broadcasts it to the log viewer; `session.ts#logTurn()` accumulates the assistant text it relayed and writes **one** row per turn. `logTurn()` is called from `endTurn()`, not from the `result` branch, so an interrupted or errored turn still records what it said. Both sides are wrapped — a logging failure can't kill a turn.
- `env.ts` — the child inherits **all** of `process.env`, by operator request. `DISCORD_BOT_TOKEN`, `GH_TOKEN` and every provider key are readable from inside a session with one `Bash` call. The secret-stripping allowlist that used to live here was removed; only the runtime marker and the `SDK_ANTHROPIC_*` overrides remain. Filter `source` here to restore the boundary.

There is no per-channel runtime flag any more, and no `/pilot` command: migration 007 drops `settings.pilot`, promoting any channel that had it to `settings.monitor = true` — the flag carried a hidden second meaning (answer every message without a mention) that `monitor` is the real home for, so without the promotion those channels would go quiet after the deploy. The same migration renames `pilotSessionId` → `sdkSessionId` and carries the `pilot.*` invocation-metric counts over to `sdk.*`, so the dead-code report doesn't show three features vanishing and three appearing. `/clear` is routed to `resetSdkSessionScope` — our conversation rows are not what the SDK session reads, so clearing only those looked like a no-op, and the scope form catches the thread sessions under the channel — and it still clears our own rows and the thread-history cache, because `/history` and the archive read them. There is no `/compact` command in this codebase at all. `/restart` stops every child (`stopAllSdkSessions()`) before `process.exit(100)`, which runs neither `SIGTERM` nor `beforeExit` and so used to orphan them until the next boot sweep; `/stop` falls back to the channel scope when no session matches the exact channel; `/ping` and `/config show` report the live session count; and `/caveman`, `/config set-prompt` and `/skills add-github|add-file|remove` append a `-# 🧪` note saying a running session keeps the prompt (or skill list) it started with. Those notes are two helpers in `bot/commands.ts` — `sessionPromptNote(channelId)` (channel-keyed) and `sessionSkillsNote()` (keyed on live sessions, since skills are global) — and both return `""` when nothing is live. `skills/tools.ts` refuses a disabled skill in `read_skill` *and* `list_skill_files`, so `/skills disable` binds on the bridged tools too. For cron, `cron/service.ts` hands the callback a `CronAgentTurnContext` (delivery channel + job identity) and `runCronAgentTurn` plans the route with `sdk/cron-route.ts` (pure: thread→parent inheritance read from the client *cache*, so there is no extra fetch, and no nested thread when the target already is one), then does `ensureThread` + `submitToSdkSession`. Submission is fire-and-forget, so the run record only says where it went and the cron per-job timeout no longer bounds the work (the turn watchdog does). A per-job `model` override *is* honoured: it is passed as `modelOverride` and the session starts its child on it, and `/cron list|show|add|set-model` annotate agent jobs. Remaining gaps: no message-edit streaming, and sessions are entirely unguarded (no tool-call policy, full env inheritance) in every channel and DM.

### Evolution Engine

Self-modification via GitHub PRs. `src/evolution/engine.ts` manages git worktrees at `worktrees/<evolution-id>/`, runs validation, pushes branches, creates PRs via `gh` CLI. A single user can have multiple active evolutions concurrently, each on its own isolated worktree. Evolution status flow: `idea` → `proposing` → `proposed` (PR open) → `deployed` (merged). Also: `cancelled`, `rejected`, `rolled_back`. On startup, `syncDeployedEvolutions()` checks if proposed PRs were merged.

**Human-in-the-loop moved to plan time (no diff review):** `evolve_start` requires `plan` (min 80 chars, stored in the `evolutions.plan` column and embedded in the PR body) and `plan_approved: true`. The agent must post the build plan and get explicit user approval before any code is written. `finalizeEvolution()` then auto-calls `mergeEvolution()` once all gates pass — squash merge, deployment thread, restart (deferred 5s so tool results/messages flush). `isAutoMergeEnabled()` reads `EVOLUTION_AUTO_MERGE` (default `true`; set to `false` for the legacy manual `evolve_review` + `evolve_merge` flow). If auto-merge throws, the PR stays open, the evolution stays `proposed`, the failure is reported to Discord, and `evolve_merge` is the manual fallback.

**Quality gates in `finalizeEvolution()`:**
1. Local pre-flight `tsc --noEmit` (fast, catches syntax errors before pushing)
2. Commit + push branch to GitHub
3. **Daytona Sandbox CI** (preferred): Spins up an ephemeral sandbox via `@daytona/sdk`, clones the branch, runs `npm ci`, `tsc --noEmit`, and `vitest run` in full isolation. See `src/evolution/sandbox.ts`.
4. **Local fallback**: If `DAYTONA_API_KEY` is not set or sandbox infrastructure fails, falls back to running typecheck + tests in the local worktree (symlinked `node_modules`).
5. Both typecheck and tests must pass before the PR is created.
6. PR created → auto-merge + deploy (unless `EVOLUTION_AUTO_MERGE=false`).

The sandbox approach provides true CI isolation — clean `npm ci` install, no symlinked `node_modules`, no interference with the running bot.

### Structured Logging

`src/logging/` provides a lightweight structured logging system with three SQLite-backed log streams:

| Table | Purpose | Retention |
|-------|---------|-----------|
| `application_log` | General operational events (info, warn, debug) | 7 days |
| `error_log` | Errors & exceptions with stack traces | 30 days |
| `tool_call_log` | Every tool invocation with input, result, timing, success/failure | 7 days |

**Key files:**
- `logging/logger.ts` — Core logging functions: `appLog()`, `errorLog()`, `toolCallLog()`, plus `createLogger(category)` factory for scoped module loggers
- `logging/queries.ts` — Read-side queries: `getAppLogs()`, `getErrorLogs()`, `getToolCallLogs()`, `getToolCallStats()`, `getSlowestToolCalls()`, `getErrorCountsByCategory()`, `pruneLogs()`

**Usage pattern:**
```typescript
import { createLogger, toolCallLog } from "../logging/logger.js";
const log = createLogger("agent");
log.info("Processing message", { userId: "123" });
log.error("Failed to process", someError, { channelId: "456" });
```

All logging functions are **non-blocking and never throw** — errors during log persistence are silently caught. Console output is always preserved for the daemon's log buffer. DB persistence respects a configurable minimum log level (default: `info`).

The reflection daemon automatically consumes structured logs alongside signals, providing tool call statistics, error breakdowns by category, and slowest tool calls as additional context for self-improvement analysis. Log pruning happens during each reflection cycle.

### Invocation Metrics

`src/metrics/` counts how often each instrumented code path runs, so unused features and dead code are identifiable from data instead of guesswork.

The key design point: **counting alone cannot find dead code** — you only see paths that did run. So every instrumented site is also *declared*, and declared paths are seeded into `invocation_metrics` with `count = 0`. "Declared but never counted" is the dead-code signal.

- `metrics/registry.ts` — `P` (stable dotted path ids) and `FEATURE_PATHS` (specs for hand-instrumented paths). A spec marked `rare: true` is an error/fallback path that is *supposed* to be idle, so the report never flags it as dead. Path ids are an append-only vocabulary: renaming one orphans its history.
- `metrics/counters.ts` — `count(path)` bumps an in-memory Map (one hash lookup, no I/O); a batched flush folds deltas into SQLite every 60s and on shutdown. `declareCommandPaths()`, `declareToolPaths()`, `declareRoutePaths()` and `declareSkillPaths()` derive their paths from the existing manifests at boot (the slash-command array, `getAllTools()`, the Express router stack, the skill list), so those four surfaces can never go stale.
- `metrics/report.ts` — `getDeadPaths()`, `getLowUsePaths()`, `getStalePaths()`, `getMetrics()`, `getMetricsSummary()`, `getObservationWindow()`.

Instrumented surfaces: slash commands (+ subcommands), every agent tool, every gateway route, skill reads, memory backends (local FTS vs mem9), transcription backends, voice/voice-coach entry points, model cache paths, cron runs, interactive vs cron agent turns.

Read it via `npx tsx scripts/metrics-report.ts` (`--kind=tool`, `--threshold=N`, `--stale-days=N`, `--top=N`) or the API endpoints below.

Two caveats when acting on the numbers: a zero count only means "not observed since instrumentation landed" — always check `getObservationWindow()` before concluding a feature is dead, and remember a rarely-hit path may be a critical recovery branch rather than dead weight. Like logging, every metrics write is wrapped and can never crash the bot.

### Reflection System

`src/reflection/` implements autonomous self-improvement discovery. Signal collection (`signals.ts`) passively records errors, tool failures, and duplicate loop patterns from `bot/messages.ts` and `agent/agent.ts`. The structured logging system (`src/logging/`) provides additional data: tool call statistics, error logs with stack traces, and performance metrics. The reflection daemon (`daemon.ts`) runs on a configurable interval (default: 6h), analyzes both signals and structured logs, and if an improvement is found, records an evolution idea and posts to Discord. Level 1 trust: never auto-implements.

### Gateway

Express server + WebSocket at `/ws/logs` for real-time log streaming. REST API at `/api/*` exposes CRUD for sessions, channels, config, soul, memory, skills, cron, artifacts, and evolutions. Usage metrics are at `/api/metrics/invocations`, `/api/metrics/dead` and `/api/metrics/low-use` (the last also returns stale paths via `?staleDays=`); a router-level middleware counts route hits on response finish, so unmatched 404s are correctly not counted. Artifact routes are mounted separately via `src/gateway/artifacts.ts`. Health check at `/api/health` (no auth). Auth middleware is currently disabled (TODO for cloud gateway). React SPA dashboard served from `dist/ui/`.

### Database Schema

SQLite with WAL mode, FKs enabled. Key tables in `src/db/index.ts`:
- `sessions` — keyed by discord_key (thread/channel/user combo), tracks agent_session_id and last_active
- `messages` — conversation history per session, includes per-API-call token usage columns (model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
- `channel_configs` — per-channel settings and system prompts
- `config` — global key-value store
- `memory_fts` — FTS5 virtual table for memory search
- `evolutions` — PR tracking (status, branch, pr_url, files_changed)
- `signals` — reflection event collection (type, source, detail, metadata JSON)
- `reflection_runs` — reflection daemon run history
- `message_history` — archived messages from deleted/expired sessions (preserves conversation history across cleanup)
- `artifacts` — file tracking (session_id, direction, filename, mime_type, disk_path, discord_url, size_bytes, metadata)
- `application_log` — structured application log entries (level, category, message, metadata)
- `error_log` — structured error log entries with stack traces
- `tool_call_log` — tool invocation records with input, result, timing, success/failure status
- `invocation_metrics` — one row per instrumented code path (path, kind, description, rare, count, first_seen, last_seen); rows are seeded at count 0 when declared, so unused paths are visible as dead code

### Migrations

Shell scripts in `migrations/` run by `start.sh` before build. All idempotent (`CREATE TABLE IF NOT EXISTS`). Completion tracked via `data/.migrations/{name}.done` marker files. Current migrations: evolution table, signals/reflection tables, usage columns on messages, Silero VAD v4 model download.

## Key Patterns

- **ESM throughout**: `"type": "module"` in package.json. All internal imports use `.js` extensions (NodeNext module resolution). Use `import.meta.url` / `fileURLToPath` for `__dirname`.
- **Singleton services**: `getDb()`, `getSoul()`, `getSkillService()` are module-level singletons. The Discord client reference is passed via setter functions (`setDiscordClient`, `setMessageClient`) to avoid circular deps.
- **Shared restart trigger**: `src/restart.ts` holds a callback set by `index.ts` and called by `commands.ts` / `api.ts` — avoids circular dependency between entry point and command handlers.
- **DM dedup**: `bot/client.ts` uses both `messageCreate` and a raw gateway event fallback for DMs, with a Set-based dedup mechanism (discord.js v14 sometimes misses DM events for uncached channels).
- **All runtime data** lives in `data/` (gitignored): SQLite DB, SOUL.md, memory files, cron store, skills, artifacts, migration markers.
- **Evolution isolation**: `worktrees/<id>/` are git worktrees (gitignored). Each evolution gets its own isolated worktree. A user can have multiple concurrent evolutions. The running bot's source is never modified directly — all changes go through PRs.
- **Cron delivery separation**: `agentTurn` jobs let the agent handle all delivery. `systemEvent` jobs have results delivered by cron service directly. This prevents duplicate messages outside threads.
- **Skill vs Code guardrail**: The evolution system prompt includes a mandatory pre-flight decision tree. Before starting code evolution, the agent must evaluate whether the capability can be a skill or soul/memory change. See `EVOLUTION_INSTRUCTIONS` in `src/agent/agent.ts`.
- **Shared utilities**: `src/shared/` contains extracted helpers used by the agent runtime, the voice agents and the slash commands — `paths.ts` (project root resolution), `anthropic.ts` (SDK client factory), `discord-utils.ts` (channel/guild helpers), `conversation-history.ts` (cross-session message loading + conversation history tool definitions), `format.ts` (token/duration formatting for the `-# 📊` footer), `prompt-fragments.ts` (memory-recall + caveman prompt text shared by the session's system prompt and the slash commands). Import from `shared/` when adding code that both pipelines need — anything a *second* runtime needs to say identically belongs in `prompt-fragments.ts` rather than in one runtime's prompt builder.
- **Watchdog daemon**: `src/daemon/index.ts` is a standalone process (zero imports from the main bot) that spawns the bot, monitors health, handles crash recovery with evolution rollback, and sends Discord webhook notifications. Exit code 100 from the bot triggers a deploy-restart (git pull + rebuild) rather than a simple respawn.
- **Signal collection is passive and non-blocking**: `recordSignal()` never throws — errors during recording are caught and logged.
- **Metrics counting is non-blocking**: `count(path)` only touches an in-memory Map; persistence is batched and try/catch'd. Add a path to `metrics/registry.ts` *and* count it at the call site — declaring without counting reports the path as dead forever, counting without declaring loses the zero-count baseline.
- **Structured logging is non-blocking**: All `appLog()`, `errorLog()`, and `toolCallLog()` calls silently catch DB errors. Console output is always preserved for the daemon log buffer. Use `createLogger(category)` factory for scoped module loggers.
- **Token usage**: Aggregated across all API calls within a single user→response turn (including tool-use loops). Costs computed at query time (not stored) so pricing can be updated without migration.
- **Production deployment**: `start.sh` runs: kill existing → git pull → npm ci (if lockfile changed) → migrations → seed cron → build → start → health check (30s timeout) → auto-rollback on failure. Discord webhook notifications on success/failure.
- **Dynamic tool registration**: Some tools are conditionally registered based on config (e.g., mem9 tools only appear when `data/skills/mem9/auth.json` exists). Tool lists are built via functions (`getMemoryTools()`, `getAllTools()`, `getCronTools()`) rather than static arrays.
- **Voice coach independence**: The voice coach (`src/voice-coach/`) is a fully separate pipeline from the voice assistant (`src/voice/`). They share receiver/VAD/STT components but have independent connections, players, and LLM backends. Both now synthesize through ElevenLabs, but via separate clients — the coach only needs one-shot synthesis, the assistant also streams.

## Skill vs Code Decision Guide

When adding new capabilities to the bot, use this decision tree:

1. **Needs new runtime plumbing?** (npm package, API client, Discord command, new tool, message pipeline change) → **Code evolution** via `evolve_start`
2. **Teachable via existing tools?** (bash, write_file, read_file, send_message, curl) → **Skill** — create `data/skills/<name>/SKILL.md`
3. **Personality/behavior/context change?** → **Soul/Memory** — update `data/SOUL.md` or `data/memory/`

Skills are preferred over code when possible: they're cheaper, safer, instantly available, don't require a restart, and are portable.

## Environment

Requires either `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (for proxy). `DISCORD_BOT_TOKEN` is always required. `OPENAI_API_KEY` is optional — enables voice message transcription via Whisper. `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` are optional — enable TTS for both the voice coach and the voice assistant. Voice assistant STT needs no key: it runs whisper.cpp locally. `COACH_MODEL` configures the coach brain LLM (default: `bedrock-claude-sonnet-4-1m`). `REFLECTION_CHANNEL_ID` is optional — sets the Discord channel where reflection daemon posts proposals. `GATEWAY_PORT` defaults to 3000. `GATEWAY_TOKEN` configures API auth (currently disabled). `GATEWAY_PUBLIC_URL` overrides the default localhost URL for artifact download links. `DAYTONA_API_KEY` is optional — enables Daytona sandbox CI for evolution validation (falls back to local if not set). `DAYTONA_API_URL` defaults to `https://app.daytona.io/api`. Voice tuning: `VOICE_MODEL`, `VOICE_SILENCE_MS` (default 800), `VOICE_MIN_UTTERANCE_MS` (default 500), `VOICE_MAX_TOKENS` (default 512), `VOICE_DEBUG` (default on), `VOICE_TTS_STREAM` (default on), `VOICE_TOOLS_MODE` (`full` or `minimal`, default `full`), `VOICE_TTS_VOICE_ID` (assistant voice override), `VOICE_STT_REMOTE_FALLBACK` (default off). Reflection tuning: `REFLECTION_INTERVAL_HOURS`, `REFLECTION_LOOKBACK_HOURS`, `REFLECTION_MIN_SIGNALS` (default 3), `REFLECTION_MODEL`. Model router: `ROUTER_MODEL_CODING` (default `bedrock-claude-fable-5-1`), `ROUTER_MODEL_COMMON` (default `bedrock-claude-sonnet-5`), `ROUTER_MODEL_JUDGE` (default `bedrock-claude-sonnet-5`), `ROUTER_BIAS` (`cheap|balanced|strong`, default `balanced`); the on/off switch is `/model router:`, stored in the DB, not env. Session tuning: `SDK_IDLE_MS` (default 1800000), `SDK_TURN_TIMEOUT_MS` (default 900000), `SDK_TURN_MAX_COST_USD` (default 0 = no warning), `SDK_ATTACHMENT_MAX_BYTES`, `SDK_INBOX_MAX_AGE_MS`, `SDK_ANTHROPIC_API_KEY`, `SDK_ANTHROPIC_BASE_URL`, `SDK_ANTHROPIC_MODEL` — each also readable under its pre-rename `PILOT_*` spelling. Session children inherit the whole bot environment (including model auth), so they spend the same model budget unless an `SDK_ANTHROPIC_*` override points them elsewhere. mem9 cloud memory: configured via `data/skills/mem9/auth.json` (contains `api_key`), not via `.env`. See `.env.example`.
