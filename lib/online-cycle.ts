import { desc, eq } from "drizzle-orm";
import { workerHeartbeats } from "../db/schema";
import {
  getMarkets,
  getOverview,
  getPerformance,
  getResearchDashboard,
  logEvent,
  recordAgentRuns,
  refreshResultsFromTheOddsAPI,
  refreshResultsFromTheSportsDB,
  refreshSportmonks,
  runWalkForwardBacktest,
  settleCompletedBets,
  syncTodayData,
} from "./qvm";
import { qvmTimeoutMs } from "./qvm-timeouts";

const ONLINE_WORKER_NAME = "qvm-online";
const ONLINE_MODEL_LABEL = "Hosted OpenAI";

type QvmDb = Awaited<ReturnType<typeof import("../db").getDb>>;

type Runtime = {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENAI_REASONING_EFFORT?: string;
  LUNA_MODEL_LABEL?: string;
};

type AiResult = {
  text: string | null;
  error: string | null;
};

async function getRuntimeEnv(): Promise<Runtime> {
  try {
    const { env } = await import("cloudflare:workers");
    return env as unknown as Runtime;
  } catch {
    return {};
  }
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

async function askOpenAI(runtime: Runtime, instructions: string, input: unknown): Promise<AiResult> {
  if (!runtime.OPENAI_API_KEY || !runtime.OPENAI_MODEL) {
    return { text: null, error: "OPENAI_NOT_CONFIGURED" };
  }

  try {
    const response = await fetch(
      `${(runtime.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: runtime.OPENAI_MODEL,
          instructions,
          input: JSON.stringify(input),
          reasoning: { effort: runtime.OPENAI_REASONING_EFFORT ?? "medium" },
          max_output_tokens: 900,
          store: false,
        }),
        signal: AbortSignal.timeout(qvmTimeoutMs("ai")),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage = payload && typeof payload === "object" && "error" in payload
        ? String((payload.error as { message?: unknown })?.message ?? "The model request failed.")
        : "The model request failed.";
      return { text: null, error: providerMessage.slice(0, 500) };
    }
    const text = extractResponseText(payload);
    return text ? { text: text.slice(0, 4000), error: null } : { text: null, error: "OPENAI_EMPTY_RESPONSE" };
  } catch (error) {
    return {
      text: null,
      error: (error instanceof Error ? error.message : "The hosted OpenAI request failed.").slice(0, 500),
    };
  }
}

async function setHeartbeat(
  db: QvmDb,
  status: string,
  startedAt: string,
  lastError: string | null,
  increment = false,
) {
  const existing = await db
    .select()
    .from(workerHeartbeats)
    .where(eq(workerHeartbeats.workerName, ONLINE_WORKER_NAME))
    .orderBy(desc(workerHeartbeats.id))
    .limit(1);
  if (existing[0]) {
    await db
      .update(workerHeartbeats)
      .set({
        status,
        lastStartedAt: startedAt,
        lastFinishedAt: status === "RUNNING" ? existing[0].lastFinishedAt : new Date().toISOString(),
        lastError,
        cyclesCompleted: increment ? existing[0].cyclesCompleted + 1 : existing[0].cyclesCompleted,
      })
      .where(eq(workerHeartbeats.id, existing[0].id))
      .run();
    return;
  }
  await db.insert(workerHeartbeats).values({
    workerName: ONLINE_WORKER_NAME,
    status,
    lastStartedAt: startedAt,
    lastFinishedAt: status === "RUNNING" ? null : new Date().toISOString(),
    lastError,
    cyclesCompleted: increment ? 1 : 0,
  }).run();
}

function sourceStatus(value: unknown) {
  if (!value || typeof value !== "object") return "UNKNOWN";
  return String((value as { status?: unknown }).status ?? "UNKNOWN");
}

function fallbackWorkerSummary(context: Record<string, unknown>) {
  const markets = Array.isArray(context.markets) ? context.markets : [];
  const freshMarkets = markets.filter((market) => market && typeof market === "object" && !(market as { isStale?: boolean }).isStale).length;
  const backtest = context.backtest && typeof context.backtest === "object" ? context.backtest as { fixturesEvaluated?: number } : {};
  return markets.length === 0
    ? "No eligible live markets are available for the hosted review. Refresh the feed and confirm provider health before considering a paper position."
    : `Hosted review checked ${markets.length} market${markets.length === 1 ? "" : "s"}; ${freshMarkets} are inside the quote-freshness gate. Walk-forward evaluation covers ${backtest.fixturesEvaluated ?? 0} completed fixtures.`;
}

function fallbackManagerSummary(context: Record<string, unknown>) {
  const markets = Array.isArray(context.markets) ? context.markets : [];
  return markets.length === 0
    ? "REQUEST_MORE_DATA: no live market candidates were supplied, so the Manager cannot issue a paper-trading recommendation."
    : "No automatic paper position was created. Review the Edge Finder and deterministic risk gate before manually confirming any paper trade.";
}

function fallbackAuditorSummary(context: Record<string, unknown>) {
  const errors = Array.isArray(context.errors) ? context.errors : [];
  return errors.length
    ? `DEGRADED: hosted cycle completed with ${errors.length} provider warning${errors.length === 1 ? "" : "s"}; no real-money execution authority is available.`
    : "PASS: hosted data, deterministic gates and paper-only authority were reviewed; no real-money execution is available.";
}

function report(
  agentName: string,
  role: string,
  task: string,
  status: string,
  summary: string,
  payload: Record<string, unknown>,
  model: string,
  startedAt: string,
) {
  return {
    agent_name: agentName,
    role,
    model,
    status,
    task,
    summary,
    payload,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

export async function runHostedOnlineCycle(db: QvmDb) {
  const startedAt = new Date().toISOString();
  await setHeartbeat(db, "RUNNING", startedAt, null);

  try {
    const errors: string[] = [];
    let dataSync: unknown = null;
    let enrichment: unknown = null;
    let results: unknown = null;
    let settlement: unknown = null;

    try {
      dataSync = await syncTodayData(db);
      if (dataSync && typeof dataSync === "object" && Array.isArray((dataSync as { errors?: unknown }).errors)) {
        errors.push(...((dataSync as { errors: unknown[] }).errors).map(String));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Live data synchronisation failed.");
    }

    try {
      enrichment = await refreshSportmonks(db);
      if (sourceStatus(enrichment) === "ERROR") errors.push("Sportmonks enrichment returned an error.");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Sportmonks enrichment failed.");
    }

    const resultSources: Array<{ source: string; result?: unknown; error?: string }> = [];
    for (const [source, refresh] of [
      ["The Odds API scores", refreshResultsFromTheOddsAPI],
      ["TheSportsDB scores", refreshResultsFromTheSportsDB],
    ] as const) {
      try {
        resultSources.push({ source, result: await refresh(db) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Result synchronisation failed.";
        resultSources.push({ source, error: message });
        errors.push(message);
      }
    }
    results = resultSources;

    try {
      settlement = await settleCompletedBets(db);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Paper settlement failed.");
    }

    let backtest: unknown = null;
    try {
      backtest = await runWalkForwardBacktest(db);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Walk-forward evaluation failed.");
    }

    const [overview, markets, performance, research] = await Promise.all([
      getOverview(db),
      getMarkets(db),
      getPerformance(db),
      getResearchDashboard(db),
    ]);
    const context = {
      dataSync,
      enrichment,
      results,
      settlement,
      backtest,
      errors,
      overview: {
        mode: overview.mode,
        kpis: overview.kpis,
        portfolio: overview.portfolio,
        risk: overview.risk,
        connection: overview.connection,
        activeTrades: overview.activeTrades,
      },
      markets: markets.markets.slice(0, 20),
      performance: {
        currentBankroll: performance.currentBankroll,
        history: performance.history.slice(-12),
      },
      sourceHealth: research.sourceHealth,
      researchCounts: research.counts,
    } satisfies Record<string, unknown>;

    const runtime = await getRuntimeEnv();
    const model = runtime.OPENAI_MODEL ?? runtime.LUNA_MODEL_LABEL ?? ONLINE_MODEL_LABEL;
    const workerPrompt = await askOpenAI(
      runtime,
      "You are QVM Football Workbench's hosted online analyst. Review only the supplied deterministic application facts. Return a concise report covering data freshness, source failures, market candidates, calibration limits, and research tasks. Do not invent fixtures, odds, injuries, or results. Do not recommend real-money action.",
      context,
    );
    const workerSummary = workerPrompt.text ?? fallbackWorkerSummary(context);
    const workerReport = report(
      "QVM Online Analyst",
      "WORKER",
      "Validate the hosted QVM data and rank paper-trading candidates.",
      workerPrompt.text ? "SUCCEEDED" : "DEGRADED",
      workerSummary,
      { source: "hosted-openai", response: workerPrompt.text, error: workerPrompt.error, facts: context },
      model,
      startedAt,
    );

    const managerInput = { ...context, analystReport: workerSummary };
    const managerPrompt = await askOpenAI(
      runtime,
      "You are QVM Football Workbench's hosted Manager. Review the supplied analyst report and deterministic facts. Issue a constrained paper-only decision: recommend no bet or identify a specific paper candidate only when live price, freshness, edge, data quality, and risk gates support it. Never place a bet, never claim real execution, and never invent missing data. Return a concise decision with risk flags and a reason.",
      managerInput,
    );
    const managerSummary = managerPrompt.text ?? fallbackManagerSummary(context);
    const managerReport = report(
      "QVM Manager",
      "MANAGER",
      "Review the hosted analyst report and issue a constrained paper-trade recommendation.",
      managerPrompt.text ? "SUCCEEDED" : "DEGRADED",
      managerSummary,
      { source: "hosted-openai", response: managerPrompt.text, error: managerPrompt.error, analystReport: workerSummary },
      model,
      startedAt,
    );

    const auditorInput = { ...context, analystReport: workerSummary, managerReport: managerSummary };
    const auditorPrompt = await askOpenAI(
      runtime,
      "You are QVM Football Workbench's hosted Auditor. Verify that the analyst and manager stayed within supplied evidence, freshness gates, risk controls, and paper-only authority. Return PASS or DEGRADED with a short list of violations or warnings. Do not add new factual claims.",
      auditorInput,
    );
    const auditorSummary = auditorPrompt.text ?? fallbackAuditorSummary(context);
    const auditorReport = report(
      "QVM Auditor",
      "AUDITOR",
      "Verify evidence, deterministic gates and hosted-agent consistency.",
      auditorPrompt.text ? "SUCCEEDED" : "DEGRADED",
      auditorSummary,
      { source: "hosted-openai", response: auditorPrompt.text, error: auditorPrompt.error, analystReport: workerSummary, managerReport: managerSummary },
      model,
      startedAt,
    );

    const agentsRecorded = await recordAgentRuns(db, [workerReport, managerReport, auditorReport]);
    const cycleStatus = errors.length > 0 || !workerPrompt.text || !managerPrompt.text || !auditorPrompt.text ? "PARTIAL" : "READY";
    await setHeartbeat(db, cycleStatus === "READY" ? "READY" : "DEGRADED", startedAt, errors.length ? errors.join(" | ").slice(0, 500) : null, true);
    await logEvent(
      db,
      `Hosted online QVM cycle completed: ${agentsRecorded} OpenAI role reports recorded${errors.length ? ` with ${errors.length} warning${errors.length === 1 ? "" : "s"}` : "."}`,
      cycleStatus === "READY" ? "INFO" : "WARN",
      "hosted_online_cycle",
    );
    return {
      status: cycleStatus,
      dataSync,
      enrichment,
      results,
      settlement,
      backtest,
      agentsRecorded,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hosted online cycle failed.";
    await setHeartbeat(db, "DEGRADED", startedAt, message.slice(0, 500), true);
    await logEvent(db, `Hosted online QVM cycle failed: ${message}`, "ERROR", "hosted_online_cycle");
    throw error;
  }
}
