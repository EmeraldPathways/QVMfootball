import { getDb } from "../../../../db";
import { getOverview } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getOverview(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Overview unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
