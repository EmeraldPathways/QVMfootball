import { getDb } from "../../../../db";
import { placePaperBet } from "../../../../lib/qvm";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      fixtureId?: number;
      selection?: string;
      stakeAmount?: number;
    };
    if (!body.fixtureId || !body.selection || typeof body.selection !== "string") {
      return Response.json(
        { error: "fixtureId and selection are required." },
        { status: 400 },
      );
    }
    if (!/^(HOME|DRAW|AWAY|OVER|UNDER|BTTS_|HOME_OVER|AWAY_OVER)/.test(body.selection)) {
      return Response.json({ error: "Invalid selection." }, { status: 400 });
    }
    const bet = await placePaperBet(
      await getDb(),
      Number(body.fixtureId),
      body.selection,
      body.stakeAmount,
    );
    return Response.json({ bet }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper bet failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
