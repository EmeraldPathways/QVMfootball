type OddsRuntime = { ODDS_API_KEY?: string | null };

export function normaliseOddsApiKey(runtime: OddsRuntime) {
  const key = typeof runtime.ODDS_API_KEY === "string" ? runtime.ODDS_API_KEY.trim() : "";
  return key || null;
}

export function describeOddsApiFailure(status: number, body: string) {
  let detail = "";
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const candidate = [payload.message, payload.error, payload.error_description].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (candidate) detail = candidate.trim();
  } catch {
    // Keep provider HTML or malformed responses out of the user-facing error.
  }
  detail = detail
    .replace(/apiKey\s*[=:]\s*[^\s,;]+/gi, "apiKey=[redacted]")
    .replace(/[.]+$/, "")
    .slice(0, 240);
  return `The Odds API returned HTTP ${String(status)}${detail ? `: ${detail}` : ""}.`;
}
