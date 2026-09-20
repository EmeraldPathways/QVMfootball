import { getDb } from "../../../../db";
import {
  getAgentDashboard,
  getMarkets,
  getOverview,
  getPerformance,
  getResearchDashboard,
  placePaperBet,
} from "../../../../lib/qvm";
import { qvmTimeoutMs } from "../../../../lib/qvm-timeouts";

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY = 12;

function cleanMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" as const : "user" as const,
      content: typeof item.content === "string" ? item.content.trim().slice(0, MAX_MESSAGE_LENGTH) : "",
    }))
    .filter((item) => item.content.length > 0)
    .slice(-MAX_HISTORY);
}

function extractResponseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string") return record.output_text.trim();
  if (!Array.isArray(record.output)) return "";
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text.trim();
      }
    }
  }
  return "";
}

function parsePaperBetRequest(text: string, markets: Array<{ fixtureId: number; homeTeam: string; awayTeam: string }>) {
  if (!/^\s*(?:confirm|place|bet)\b/i.test(text)) return null;
  const fixtureMatch = text.match(/\bfixture\s*(\d+)\b/i);
  const fixture = fixtureMatch
    ? markets.find((market) => market.fixtureId === Number(fixtureMatch[1]))
    : markets.find((market) => {
        const lower = text.toLowerCase();
        return lower.includes(market.homeTeam.toLowerCase()) && lower.includes(market.awayTeam.toLowerCase());
      });
  if (!fixture) return null;

  const lower = text.toLowerCase();
  let selection: string | null = null;
  const goal = lower.match(/\b(over|under)\s*(\d+(?:\.\d+)?)\b/);
  const btts = lower.match(/\bbtts\s*(yes|no)\b/);
  const teamTotal = lower.match(/\b(home|away)\s+(over|under)\s*(\d+(?:\.\d+)?)\b/);
  if (teamTotal) selection = `${teamTotal[1].toUpperCase()}_${teamTotal[2].toUpperCase()}_${teamTotal[3]}`;
  else if (btts) selection = `BTTS_${btts[1].toUpperCase()}`;
  else if (goal) selection = `${goal[1].toUpperCase()}_${goal[2]}`;
  else {
    const result = lower.match(/\b(home|draw|away)\b/);
    if (result) selection = result[1].toUpperCase();
  }
  const stakeMatch = text.match(/(?:€|£|stake\s*)\s*(\d+(?:\.\d+)?)/i);
  const stakeAmount = stakeMatch ? Number(stakeMatch[1]) : undefined;
  return selection ? { fixtureId: fixture.fixtureId, match: `${fixture.homeTeam} vs ${fixture.awayTeam}`, selection, stakeAmount } : null;
}

async function getRuntimeEnv() {
  try {
    const { env } = await import("cloudflare:workers");
    return env as unknown as {
      OPENAI_API_KEY?: string;
      OPENAI_BASE_URL?: string;
      OPENAI_MODEL?: string;
      OPENAI_REASONING_EFFORT?: string;
      LUNA_MODEL_LABEL?: string;
    };
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { messages?: unknown; activeSection?: unknown } | null;
  const messages = cleanMessages(body?.messages);
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user") {
    return Response.json({ error: "Enter a question for the QVM assistant." }, { status: 400 });
  }

  const runtime = await getRuntimeEnv();
  if (!runtime.OPENAI_API_KEY || !runtime.OPENAI_MODEL) {
    return Response.json(
      { error: "The Luna assistant is not fully configured. Add OPENAI_API_KEY and the exact account-enabled OPENAI_MODEL to the private Site runtime." },
      { status: 503 },
    );
  }

  try {
    const db = await getDb();
    const [overview, markets, performance, agents, research] = await Promise.all([
      getOverview(db),
      getMarkets(db),
      getPerformance(db),
      getAgentDashboard(db),
      getResearchDashboard(db),
    ]);

    const paperBetRequest = parsePaperBetRequest(latest.content, markets.markets);
    if (paperBetRequest) {
      try {
        const bet = await placePaperBet(db, paperBetRequest.fixtureId, paperBetRequest.selection, paperBetRequest.stakeAmount);
        return Response.json({
          answer: `Paper bet created for **${paperBetRequest.match}**: **${paperBetRequest.selection}** at odds **${bet.marketOdds}**, stake **€${bet.stakeAmount.toFixed(2)}**. It is now pending in Active trades and Match Results & Bets.`,
          modelLabel: runtime.LUNA_MODEL_LABEL ?? "Luna Max",
          paperBet: bet,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The paper bet could not be created.";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const context = {
      activeSection: typeof body?.activeSection === "string" ? body.activeSection : "overview",
      mode: overview.mode,
      portfolio: overview.portfolio,
      kpis: overview.kpis,
      risk: overview.risk,
      connection: overview.connection,
      model: overview.model,
      activeTrades: overview.activeTrades,
      markets: markets.markets.slice(0, 12),
      performance: {
        currentBankroll: performance.currentBankroll,
        history: performance.history.slice(-12),
      },
      agentPolicy: agents.policy,
      agentProfile: agents.modelProfile,
      latestAgentReports: agents.latest,
      researchCounts: research.counts,
      dataSources: (research.sourceHealth ?? []).map((source) => ({
        source: source.source,
        status: source.status,
        lastSuccessAt: source.lastSuccessAt,
        lastAttemptAt: source.lastAttemptAt,
        recordsUpdated: source.recordsUpdated,
        message: source.message,
      })),
      latestFeatureSnapshots: (research.latestFeatures ?? []).slice(0, 8),
      latestAvailabilitySnapshots: (research.latestAvailability ?? []).slice(0, 8),
    };

    const instructions = `You are Luna, the QVM Football Workbench assistant. You are an expert in football probability modelling, value betting, bankroll risk management, paper trading, and this application's screens and controls.

Use only the supplied application context for current numbers, fixtures, odds, positions, model status, agent status, source health, feature snapshots, and availability snapshots. Never invent injuries, news, odds, fixtures, results, lineup decisions, xG values, or probabilities. If the context does not contain an answer, say that it is unavailable and explain where the user can check it.

Explain concepts clearly for a user who is learning. Distinguish model probability, de-vigged market probability, raw edge, robust edge, uncertainty, stake sizing, closing-line value, ROI, and drawdown. Treat the model as uncertain: a positive edge is not a guarantee. Point out stale quotes, poor data quality, insufficient sample size, tail mass, market disagreement, missing or stale source data, exposure limits, and other risk flags when relevant. Explain that football-data.org is used for fixture and result synchronisation, The Odds API is used for bookmaker prices, and Sportmonks is used for lineup, injury, xG and match-statistic enrichment. Only report a source as active when the supplied context says it is READY.

This is a paper-trading application. You have no real-money execution authority. You may create a paper position only when the user explicitly uses a command beginning with 'place' or 'confirm' and provides a fixture, selection, and optional stake; the deterministic risk gate still has final authority. Never claim to place, approve, settle, or modify a real bet. When discussing a possible position, label it as an educational or paper-trading interpretation and remind the user to review the Edge Finder and risk gate. Do not provide personalised financial guarantees or encourage reckless gambling. Prefer 'no bet' when evidence is weak.

Answer concisely with short headings or bullets when useful. Mention the relevant app section or button when giving navigation help. Current model profile label: ${runtime.LUNA_MODEL_LABEL ?? "Luna Max"}.`;

    const conversation = messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");
    const input = `${conversation}\n\nLIVE QVM APPLICATION CONTEXT:\n${JSON.stringify(context)}`;

    const response = await fetch(`${(runtime.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: runtime.OPENAI_MODEL,
        instructions,
        input,
        reasoning: { effort: runtime.OPENAI_REASONING_EFFORT ?? "medium" },
        max_output_tokens: 700,
        store: false,
      }),
      signal: AbortSignal.timeout(qvmTimeoutMs("ai")),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage = payload && typeof payload === "object" && "error" in payload
        ? String((payload.error as { message?: unknown })?.message ?? "The model request failed.")
        : "The model request failed.";
      return Response.json({ error: providerMessage.slice(0, 500) }, { status: 502 });
    }

    const answer = extractResponseText(payload);
    if (!answer) return Response.json({ error: "Luna returned no readable answer." }, { status: 502 });
    return Response.json({ answer: answer.slice(0, 8000), modelLabel: runtime.LUNA_MODEL_LABEL ?? "Luna Max" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Luna assistant is unavailable.";
    return Response.json({ error: message.slice(0, 500) }, { status: 503 });
  }
}
