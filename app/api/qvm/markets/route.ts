import { getDb } from "../../../../db";
import { getMarkets } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getMarkets(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Markets unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
