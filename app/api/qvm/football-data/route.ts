import { getDb } from "../../../../db";
import { refreshFootballDataOrg } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await refreshFootballDataOrg(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "football-data.org synchronisation failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
