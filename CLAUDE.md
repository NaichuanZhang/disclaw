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

### Bot → Agent → Claude API Pipeline

Discord messages flow through `bot/messages.ts` (filter, session resolve, thread creation, voice transcription, artifact registration, context build) → `agent/agent.ts` (system prompt assembly, tool loop with duplicate detection) → Anthropic SDK. The agent accepts an optional `onToolCallProgress` callback that fires for each tool invocation (start + result phases); `messages.ts` uses this to send real-time tool call status messages to Discord as the agentic loop runs. The agent returns an `AgentResponse` with text, extracted images (from markdown `![](url)` syntax), and aggregated token usage. `messages.ts` renders images as Discord embeds (URLs) or attachments (local files), and stores usage data alongside the assistant message in SQLite. Tool progress messages are rate-limited (max 4 per 5s window) and batched to respect Discord limits.

Key constants in `agent/agent.ts`: `MAX_TOKENS = 16384`, `MAX_CONSECUTIVE_DUPES = 2` (breaks infinite tool loops). Model selection lives in `shared/models.ts` — see **Model Selection** below.

### Agent Tools

Tools are defined across multiple files and registered in `agent/agent.ts`:

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

The catalog comes from `GET {ANTHROPIC_BASE_URL}/v1/models` (LiteLLM/OpenAI-shaped), TTL-cached for 5 minutes, with `FALLBACK_MODEL_IDS` used when the proxy is unreachable so selection never presents an empty list. `warmModelCache()` runs (unawaited) at boot. `resolveModel()` is synchronous, never throws, and self-heals a model the proxy no longer advertises — but only against an already-warm cache, so it never blocks a message.

**Discord surface**: `/model` shows the active model and its source; `/model name:<id>` persists a bot-wide selection (validated against the catalog); `/model reset:true` (or `name:default`) clears it; `/model refresh:true` busts the cache. `/cron add model:<id>` and `/cron set-model <id> <model>` set a per-job override stored in `CronPayload.model`.

Autocomplete for these options is **cache-only** (`getCachedSelectableModelIds()`) and never awaits the network — Discord allows one response within ~3s and has no defer equivalent, while the catalog fetch timeout alone is 5s. A cold cache serves the fallback list and fires a background warm.

Voice (`VOICE_MODEL`) and the cycling coach (`COACH_MODEL`) are configured separately and are not affected by `/model`.

### Thread-Based Replies

In guild text channels, the bot always creates a new thread on the user's message and replies inside it (isolated context per conversation). Bot-created threads don't require @mention — thread ownership is tracked in a `Set<string>` with a fallback to `thread.ownerId`. DMs bypass threading. Monitored channels auto-respond without @mention. Thread names are auto-generated from the first line of the user's message.

### Voice System

`src/voice/` implements a full voice assistant pipeline: Discord audio → Opus decode → downsample to 16kHz mono (`receiver.ts`) → Silero VAD v4 (`vad.ts`, frame size 480 samples = 30ms) → EigenAI Whisper STT (`stt.ts`) → LLM agent (`agent.ts`) → EigenAI Chatterbox TTS (`tts.ts`) → playback.

Two LLM backends:
- **Anthropic** (default): `claude-sonnet-4-20250514` configurable via `VOICE_MODEL`. Full tool support with up to 5 tool rounds per utterance.
- **Eigen LLM** (`eigenllm.ts`): Set `VOICE_MODEL=eigen:<model>` (e.g., `eigen:qwen3-8b-fp8`). OpenAI-compatible streaming, pure text mode (no tools) for minimum latency.

Tool availability configurable via `VOICE_TOOLS_MODE`:
- `full` (default): memory, conversation history, Discord, skills, bash, file I/O — everything except evolution tools
- `minimal`: memory + conversation history only

`autoJoin.ts` tracks a configured user and auto-joins/leaves their voice channel. STT/TTS require `EIGENAI_API_KEY`. Voice cloning supported via `VOICE_REFERENCE_FILE` env var (or default `data/voice-reference.mp3`).

Key voice constants: `SILENCE_DURATION_MS = 800` (configurable via `VOICE_SILENCE_MS`), `MIN_UTTERANCE_MS = 500` (configurable via `VOICE_MIN_UTTERANCE_MS`), `IDLE_TIMEOUT_MS = 10min` (auto-leave), `VOICE_MAX_TOKENS = 512` (configurable via `VOICE_MAX_TOKENS`), `MAX_TOOL_ROUNDS = 5`, `MAX_VOICE_HISTORY = 10` turns. Streaming TTS pipelining enabled by default (disable with `VOICE_TTS_STREAM=0`).

Separate from voice chat: `audio/transcribe.ts` handles Discord voice message transcription (audio attachments) through a local-first backend chain — `audio/whispercpp-transcribe.ts` (whisper.cpp native binary, no Python required; set up via `scripts/setup-whispercpp.sh`), then `audio/local-transcribe.ts` (NeMo Parakeet, needs pip), then OpenAI's Whisper API if `OPENAI_API_KEY` is set. When all backends fail, `getLastTranscriptionFailureSummary()` returns a combined per-backend reason for logging.

### Voice Coach

`src/voice-coach/` implements an AI cycling coach that runs independently of the voice assistant. It auto-joins a dedicated voice channel when a tracked rider connects (via `voiceStateUpdate` listener).

**Pipeline**: Every 7 seconds, the orchestrator polls simulated cycling telemetry from `mock-server.ts` (power, heart rate, cadence, speed, elapsed time) → feeds data + rider speech messages to `coach-brain.ts` (LLM with team sport director persona, configurable via `COACH_MODEL`, default: `bedrock-claude-sonnet-4-1m`) → if coach has something to say → `elevenlabs-tts.ts` synthesizes speech → `player.ts` plays audio in the voice channel.

**Rider speech**: `listener.ts` reuses the voice assistant's receiver, VAD, and STT components. Rider audio is captured, speech boundaries detected via Silero VAD, transcribed via EigenAI Whisper, and queued as timestamped messages. The coach brain reads and flushes the queue each poll cycle.

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

There are two independent history readers, and they have different jobs. `bot/thread-history.ts` is the *automatic* one: it assembles the history that gets injected into the prompt before the model runs. The `get_channel_history` tool in `agent/tools.ts` is a *fallback* that fetches straight from Discord — it does not read or write the cache. Because the automatic history is invisible to the model, `buildSystemPrompt` reports `Messages already in context: N` so the model only reaches for the tool when N is 0, when it needs messages older than the loaded window, or when reading a different channel. The tool also honours the `/clear` cutoff and renders embed/attachment-only messages as text, matching the automatic reader. Messages are archived across sessions, queryable via `get_conversation_history` and `get_conversation_stats` tools (defined in `shared/conversation-history.ts`).

**Per-session locking** (`agent/session-lock.ts`): A mutex-style lock ensures only one message is processed at a time per session. If a second message arrives while the first is still processing, it queues and waits. This prevents interleaved responses, race conditions on session history, and duplicate API calls. The lock is acquired in `bot/messages.ts` after session resolution and released in a `finally` block. An `AbortSignal` is passed through to `agent/agent.ts` and checked between agentic loop turns and before each tool call — enabling graceful cancellation via the `/stop` command. The `/stop` slash command calls `abortAllSessions()` which triggers the abort signal on all active processing and rejects all queued waiters.

### Soul, Memory, and Skills

- **Soul**: Bot personality loaded from `data/SOUL.md` with filesystem watcher for hot-reload. Injected into every system prompt.
- **Memory**: Hybrid search — local markdown files in `data/` and `data/memory/` chunked and indexed into SQLite FTS5 (BM25-ranked), plus optional mem9 cloud memory (`src/memory/mem9.ts`). Both sources are queried in parallel on every `memory_search` call. mem9 config lives in `data/skills/mem9/auth.json`. When mem9 is configured, additional tools (`mem9_store`, `mem9_update`, `mem9_delete`) are dynamically registered. Graceful fallback if mem9 is unavailable.
- **Skills**: SKILL.md files with YAML frontmatter in `data/skills/`. Progressive loading — only metadata in system prompt; full content via `read_skill` tool. Installable from GitHub URLs.

### Cron Service

Scheduled tasks in `data/cron/jobs.json` (gitignored; seed file tracked). Three schedule types: one-shot (`at`), interval (`every`), cron expression. Two payload kinds: `agentTurn` (agent handles delivery via tools — creates threads, no duplicate top-level messages) and `systemEvent` (cron service delivers directly). Auto-disables after 3 consecutive failures. Hot-reloads `jobs.json` on each tick cycle (up to every 60s).

### Pilot Mode (experimental)

`src/pilot/` is a **second runtime**, not a refactor of the first. A channel with `settings.pilot = true` in `channel_configs` is routed in `bot/messages.ts` (step 7b, after voice transcription and **after** thread creation) to a Claude Agent SDK session instead of `agent/agent.ts`. Threads inherit pilot mode from their parent channel (`pilotConfigChannelId` in `pilot/session.ts`, same shape as `isMonitoredChannel`), so pilot channels behave like normal ones: top-level message → thread → one SDK session keyed to the thread id. Step 6e keeps only the empty-content bail-out, so we never create a thread we can't use. The normal path is untouched for every other channel.

- `session.ts` — one `query()` session per target (a thread in practice, keyed by `target.id`). The prompt is an async generator, so `submit()` can inject a new Discord message into a turn that is already running. Relays assistant text and tool-call lines to the channel (buffered per message; no message-edit streaming). Persists the SDK session id in `channel_configs.settings.pilotSessionId` (a row per thread, so resume is per-thread) and passes it as `resume` after a restart. Idle-reaped (`PILOT_IDLE_MS`), stopped by `/stop` (aborting the child kills its shell descendants), and orphaned children are swept at boot by matching `/proc/<pid>/cwd` against the pilot workspace. `interrupt()` / `interruptPilotSession(channelId)` wrap the SDK's native `Query.interrupt()` (streaming-input only, which is what we always use): the live `query()` handle is kept on `this.stream`, our own `this.queue` is dropped locally, and `still_queued` uuids from the receipt are surfaced only when the CLI advertised `interrupt_receipt_v1` in its `system/init` capabilities (feature-detect, never version-sniff). `cancel_queued` is in the SDK types but is not implemented in the shipped CLI, so we do not pass it. `/interrupt` is per-channel and keeps context; `/stop` is global and kills the child.
- `policy.ts` — the `canUseTool` gate, which is the security boundary. `permissionMode` is `default`; **never use `bypassPermissions` here**. Blocks `src/**`, `.env`, `.git/**`, `worktrees/**`, `migrations/`, `start.sh`, `~/.ssh`, `~/.config/gh`, `~/.claude/.credentials.json`, plus `git push`, `gh pr|auth|api`, `sudo`, package publishing and pipe-to-shell. Pure functions (`checkPilotPath`, `checkPilotCommand`, `evaluatePilotToolCall`) are unit-tested in `tests/integration/pilot-guards.test.ts`.
- `bridge.ts` — `createSdkMcpServer` re-exporting our own tools in-process. **Never add `evolve_*` here** — that would let a pilot session bypass the plan-approval gate.
- `env.ts` — the child inherits an explicit allowlist, not `process.env`, so `DISCORD_TOKEN`/`GH_TOKEN`/`ANTHROPIC_API_KEY` can't be read out with one `Bash` call.

Enabling/disabling pilot mode is a data change (a `channel_configs.settings` flag), not a code change. v1 does not handle image/document attachments and does not share session state with `/clear` or `/compact`.

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

### Reflection System

`src/reflection/` implements autonomous self-improvement discovery. Signal collection (`signals.ts`) passively records errors, tool failures, and duplicate loop patterns from `bot/messages.ts` and `agent/agent.ts`. The structured logging system (`src/logging/`) provides additional data: tool call statistics, error logs with stack traces, and performance metrics. The reflection daemon (`daemon.ts`) runs on a configurable interval (default: 6h), analyzes both signals and structured logs, and if an improvement is found, records an evolution idea and posts to Discord. Level 1 trust: never auto-implements.

### Gateway

Express server + WebSocket at `/ws/logs` for real-time log streaming. REST API at `/api/*` exposes CRUD for sessions, channels, config, soul, memory, skills, cron, artifacts, and evolutions. Artifact routes are mounted separately via `src/gateway/artifacts.ts`. Health check at `/api/health` (no auth). Auth middleware is currently disabled (TODO for cloud gateway). React SPA dashboard served from `dist/ui/`.

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
- **Shared utilities**: `src/shared/` contains extracted helpers used by both the main agent and the voice agent — `paths.ts` (project root resolution), `anthropic.ts` (SDK client factory), `discord-utils.ts` (channel/guild helpers), `conversation-history.ts` (cross-session message loading + conversation history tool definitions). Import from `shared/` when adding code that both pipelines need.
- **Watchdog daemon**: `src/daemon/index.ts` is a standalone process (zero imports from the main bot) that spawns the bot, monitors health, handles crash recovery with evolution rollback, and sends Discord webhook notifications. Exit code 100 from the bot triggers a deploy-restart (git pull + rebuild) rather than a simple respawn.
- **Signal collection is passive and non-blocking**: `recordSignal()` never throws — errors during recording are caught and logged.
- **Structured logging is non-blocking**: All `appLog()`, `errorLog()`, and `toolCallLog()` calls silently catch DB errors. Console output is always preserved for the daemon log buffer. Use `createLogger(category)` factory for scoped module loggers.
- **Token usage**: Aggregated across all API calls within a single user→response turn (including tool-use loops). Costs computed at query time (not stored) so pricing can be updated without migration.
- **Production deployment**: `start.sh` runs: kill existing → git pull → npm ci (if lockfile changed) → migrations → seed cron → build → start → health check (30s timeout) → auto-rollback on failure. Discord webhook notifications on success/failure.
- **Dynamic tool registration**: Some tools are conditionally registered based on config (e.g., mem9 tools only appear when `data/skills/mem9/auth.json` exists). Tool lists are built via functions (`getMemoryTools()`, `getAllTools()`, `getCronTools()`) rather than static arrays.
- **Voice coach independence**: The voice coach (`src/voice-coach/`) is a fully separate pipeline from the voice assistant (`src/voice/`). They share receiver/VAD/STT components but have independent connections, players, and LLM backends. The coach uses ElevenLabs TTS while the assistant uses EigenAI Chatterbox TTS.

## Skill vs Code Decision Guide

When adding new capabilities to the bot, use this decision tree:

1. **Needs new runtime plumbing?** (npm package, API client, Discord command, new tool, message pipeline change) → **Code evolution** via `evolve_start`
2. **Teachable via existing tools?** (bash, write_file, read_file, send_message, curl) → **Skill** — create `data/skills/<name>/SKILL.md`
3. **Personality/behavior/context change?** → **Soul/Memory** — update `data/SOUL.md` or `data/memory/`

Skills are preferred over code when possible: they're cheaper, safer, instantly available, don't require a restart, and are portable.

## Environment

Requires either `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (for proxy). `DISCORD_BOT_TOKEN` is always required. `OPENAI_API_KEY` is optional — enables voice message transcription via Whisper. `EIGENAI_API_KEY` is optional — enables voice assistant STT/TTS via EigenAI. `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` are optional — enable voice coach TTS. `COACH_MODEL` configures the coach brain LLM (default: `bedrock-claude-sonnet-4-1m`). `REFLECTION_CHANNEL_ID` is optional — sets the Discord channel where reflection daemon posts proposals. `GATEWAY_PORT` defaults to 3000. `GATEWAY_TOKEN` configures API auth (currently disabled). `GATEWAY_PUBLIC_URL` overrides the default localhost URL for artifact download links. `DAYTONA_API_KEY` is optional — enables Daytona sandbox CI for evolution validation (falls back to local if not set). `DAYTONA_API_URL` defaults to `https://app.daytona.io/api`. Voice tuning: `VOICE_MODEL` (supports `eigen:<model>` prefix for Eigen LLM), `VOICE_SILENCE_MS` (default 800), `VOICE_MIN_UTTERANCE_MS` (default 500), `VOICE_MAX_TOKENS` (default 512), `VOICE_DEBUG` (default on), `VOICE_TTS_STREAM` (default on), `VOICE_TOOLS_MODE` (`full` or `minimal`, default `full`), `VOICE_REFERENCE_FILE` (TTS voice cloning reference audio). Reflection tuning: `REFLECTION_INTERVAL_HOURS`, `REFLECTION_LOOKBACK_HOURS`, `REFLECTION_MIN_SIGNALS` (default 3), `REFLECTION_MODEL`. Pilot mode tuning: `PILOT_IDLE_MS` (default 1800000), `PILOT_INHERIT_MODEL_AUTH` (default on — pilot children inherit `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` and therefore spend the same model budget; `false` withholds them), `PILOT_ANTHROPIC_API_KEY`, `PILOT_ANTHROPIC_BASE_URL`, `PILOT_ANTHROPIC_MODEL`, `PILOT_ENV_EXTRA_ALLOW`. mem9 cloud memory: configured via `data/skills/mem9/auth.json` (contains `api_key`), not via `.env`. See `.env.example`.
