import { getDb } from "../../../../db";
import { syncTodayData } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await syncTodayData(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Today's data synchronisation failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
