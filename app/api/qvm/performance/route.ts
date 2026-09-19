import { getDb } from "../../../../db";
import { getPerformance } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getPerformance(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Performance unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
