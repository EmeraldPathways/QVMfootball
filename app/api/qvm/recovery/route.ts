import { getDb } from "../../../../db";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getRecoverySnapshot } from "../../../../lib/qvm";

export async function GET() {
  try {
    if (!await getChatGPTUser()) {
      return Response.json({ error: "Sign in with ChatGPT to download a recovery snapshot." }, { status: 401 });
    }
    const snapshot = await getRecoverySnapshot(await getDb());
    return Response.json(snapshot, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="qvm-recovery-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recovery snapshot unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
