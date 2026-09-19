import { getDb } from "../../../../db";
import { getResearchDashboard } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getResearchDashboard(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research dashboard unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
