import { getDb } from "../../../../db";
import { settleCompletedBets } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await settleCompletedBets(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
