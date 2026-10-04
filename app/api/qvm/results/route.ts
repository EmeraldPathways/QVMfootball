import { getDb } from "../../../../db";
import { refreshFootballDataOrg, refreshResultsFromTheOddsAPI, refreshResultsFromTheSportsDB, refreshSportmonks, settleCompletedBets } from "../../../../lib/qvm";

export async function POST(request: Request) {
  const db = await getDb();
  const body = await request.json().catch(() => null) as { requestId?: unknown } | null;
  const requestId = body?.requestId ?? request.headers.get("X-QVM-Request-ID");
  const sources: Array<{ source: string; result?: unknown; error?: string }> = [];

  // Run both result-capable feeds. A failure in one provider must not prevent
  // the other provider from updating fixtures or prevent already-resolved
  // paper bets from being settled.
  for (const [source, refresh] of [
    ["football-data.org", refreshFootballDataOrg],
    ["Sportmonks", refreshSportmonks],
    ["The Odds API scores", refreshResultsFromTheOddsAPI],
    ["TheSportsDB scores", refreshResultsFromTheSportsDB],
  ] as const) {
    try {
      sources.push({ source, result: await refresh(db) });
    } catch (error) {
      sources.push({ source, error: error instanceof Error ? error.message : "Result synchronisation failed." });
    }
  }

  try {
    const settlement = await settleCompletedBets(db, requestId);
    const failed = sources.filter((item) => item.error);
    return Response.json({
      status: failed.length === sources.length ? "ERROR" : failed.length ? "PARTIAL" : "READY",
      sources,
      settlement,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement failed.";
    return Response.json({ status: "ERROR", sources, error: message }, { status: 503 });
  }
}
