import { getDb } from "../../../../db";
import { scanEdges } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await scanEdges(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Edge scan failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
