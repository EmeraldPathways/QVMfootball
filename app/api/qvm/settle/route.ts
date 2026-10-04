import { getDb } from "../../../../db";
import { settleCompletedBets } from "../../../../lib/qvm";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { requestId?: unknown } | null;
    const requestId = body?.requestId ?? request.headers.get("X-QVM-Request-ID");
    return Response.json(await settleCompletedBets(await getDb(), requestId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
