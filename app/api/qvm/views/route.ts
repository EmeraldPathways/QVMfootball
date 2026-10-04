import { getDb } from "../../../../db";
import { ensureSeeded, deleteEdgeView, getSavedEdgeViews, saveEdgeView } from "../../../../lib/qvm";

export async function GET() {
  try {
    const db = await getDb();
    await ensureSeeded(db);
    return Response.json({ views: await getSavedEdgeViews(db) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Saved Edge Finder views are unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { name?: unknown; filters?: unknown } | null;
    if (typeof body?.name !== "string") {
      return Response.json({ error: "A view name is required." }, { status: 400 });
    }
    const db = await getDb();
    await ensureSeeded(db);
    return Response.json({ view: await saveEdgeView(db, body.name, body.filters) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Edge Finder view could not be saved.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { id?: unknown } | null;
    const id = typeof body?.id === "number" ? body.id : Number(body?.id);
    const db = await getDb();
    await ensureSeeded(db);
    return Response.json(await deleteEdgeView(db, id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Edge Finder view could not be deleted.";
    return Response.json({ error: message }, { status: 400 });
  }
}
