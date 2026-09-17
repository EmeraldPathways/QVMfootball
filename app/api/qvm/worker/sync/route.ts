import { getDb } from "../../../../../db";
import {
  isWorkerRequestAuthorized,
  syncWorkerSnapshot,
} from "../../../../../lib/qvm";

export async function POST(request: Request) {
  if (!(await isWorkerRequestAuthorized(request))) {
    return Response.json({ error: "Worker authentication failed." }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "A JSON worker snapshot is required." }, { status: 400 });
    }
    return Response.json(
      await syncWorkerSnapshot(await getDb(), body as Record<string, unknown>),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker sync failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
