import { getDb } from "../../../../db";
import { runHostedOnlineCycle } from "../../../../lib/online-cycle";

export async function POST() {
  try {
    return Response.json(await runHostedOnlineCycle(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hosted online cycle failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
