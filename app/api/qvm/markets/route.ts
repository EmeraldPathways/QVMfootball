import { getDb } from "../../../../db";
import { getMarkets } from "../../../../lib/qvm";

export async function GET() {
  try {
    return Response.json(await getMarkets(await getDb()), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Markets unavailable.";
    return Response.json(
      { error: message },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
