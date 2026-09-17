import { getDb } from "../../../../db";
import { resetPaperBook } from "../../../../lib/qvm";

export async function POST() {
  try {
    return Response.json(await resetPaperBook(await getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper book reset failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
