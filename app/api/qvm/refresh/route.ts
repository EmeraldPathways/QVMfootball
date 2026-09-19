import { getDb } from "../../../../db";
import { syncTodayData } from "../../../../lib/qvm";

export async function POST() {
  try {
    // The primary refresh action is deliberately a combined source sync. Odds
    // and fixture/result data must be refreshed together so the model never
    // presents a new market surface against an old fixture snapshot.
    return Response.json(await syncTodayData(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live data synchronisation failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
