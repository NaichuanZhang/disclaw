// ---------------------------------------------------------------------------
// Shared Anthropic client — singleton used by all modules
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic client configured from environment variables.
 * Reuses a single instance across the model router, reflection daemon and other callers.
 */
export const anthropicClient = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
});
