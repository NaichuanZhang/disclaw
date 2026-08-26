// ---------------------------------------------------------------------------
// Small display formatters shared by the two runtimes
//
// Both the main agent path (bot/messages.ts) and pilot mode post a `-# 📊`
// usage footer. Keeping the number formatting here means the two lines can't
// drift apart.
// ---------------------------------------------------------------------------

/** Format token count: 1234 → "1.2k", 123456 → "123.5k" */
export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format duration in seconds: 45200 → "45.2s", 125000 → "2m 5s" */
export function fmtDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  return `${mins}m ${remainSecs}s`;
}
