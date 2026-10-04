import { getDb } from "../../../../db";
import { getResearchDashboard } from "../../../../lib/qvm";
import { getHostedOnlineCycleStatus } from "../../../../lib/online-cycle";

export async function GET() {
  try {
    const db = await getDb();
    const [research, onlineCycle] = await Promise.all([
      getResearchDashboard(db),
      getHostedOnlineCycleStatus(db),
    ]);
    return Response.json({ ...research, onlineCycle });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research dashboard unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
