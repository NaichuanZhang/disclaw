// ---------------------------------------------------------------------------
// Tool metric path declaration
//
// Usage counters are only useful if a tool that is never invoked shows up as
// unused rather than as absent, so every registered tool name is declared once
// at boot. This is the one place that knows the full set — the tool handlers
// themselves are wired up per runtime (see sdk/bridge.ts and voice/agent.ts).
// ---------------------------------------------------------------------------

import { conversationHistoryTools } from "../shared/conversation-history.js";
import { getMemoryTools } from "../memory/tools.js";
import { discordTools } from "./tools.js";
import { skillTools } from "../skills/tools.js";
import { dangerousTools } from "./dangerous-tools.js";
import { evolutionTools } from "../evolution/tools.js";
import { declareToolPaths } from "../metrics/counters.js";

/** Seed usage metrics with every registered tool name. Called once at boot. */
export function declareAgentToolPaths(): void {
  declareToolPaths([
    ...conversationHistoryTools,
    ...getMemoryTools(),
    ...discordTools,
    ...skillTools,
    ...dangerousTools,
    ...evolutionTools,
  ] as ReadonlyArray<{ name: string; description?: string }>);
}
