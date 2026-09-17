import { getDb } from "../../../../db";
import { refreshSportmonks } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await refreshSportmonks(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Football data enrichment failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
