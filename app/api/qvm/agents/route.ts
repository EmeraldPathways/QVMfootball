import { getDb } from "../../../../db";
import { getAgentDashboard } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getAgentDashboard(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent status unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
