import { getDb } from "../../../../db";
import { desc } from "drizzle-orm";
import { modelRuns } from "../../../../db/schema";
import { ensureSeeded, runWalkForwardBacktest } from "../../../../lib/qvm";

export async function GET() {
  try {
    const db = await getDb();
    await ensureSeeded(db);
    const rows = await db
      .select()
      .from(modelRuns)
      .orderBy(desc(modelRuns.createdAt), desc(modelRuns.id))
      .limit(8);
    return Response.json({ latest: rows[0] ?? null, history: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}

export async function POST() {
  try {
    return Response.json(await runWalkForwardBacktest(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
