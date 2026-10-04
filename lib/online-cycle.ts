import { desc, eq } from "drizzle-orm";
import { appMeta, paperActionReceipts, workerHeartbeats } from "../db/schema";
import {
  LEAGUE_CONFIGS,
  getMarkets,
  getOverview,
  getPerformance,
  getResearchDashboard,
  logEvent,
  rebuildPredictions,
  recordAgentRuns,
  refreshFootballDataOrg,
  refreshOddsFromTheOddsAPI,
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
const ONLINE_CYCLE_JOB_KEY = "qvm_online_cycle_job_v1";
const ONLINE_CYCLE_LEASE_MS = 10 * 60 * 1000;
const HOSTED_PROVIDER_TIMEOUT_MS = 20_000;
const HOSTED_AI_STEP_TIMEOUT_MS = 20_000;

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

async function askOpenAI(
  runtime: Runtime,
  instructions: string,
  input: unknown,
  timeoutMs = qvmTimeoutMs("ai"),
): Promise<AiResult> {
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
        signal: AbortSignal.timeout(timeoutMs),
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

export async function setHeartbeat(
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
        lastFinishedAt: status === "RUNNING" ? existing[0].lastFinishedAt ?? startedAt : new Date().toISOString(),
        lastError,
        cyclesCompleted: increment ? existing[0].cyclesCompleted + 1 : existing[0].cyclesCompleted,
      })
      .where(eq(workerHeartbeats.id, existing[0].id))
      .run();
    return;
  }
  const heartbeatInsert = db.insert(workerHeartbeats).values({
    workerName: ONLINE_WORKER_NAME,
    status,
    lastStartedAt: startedAt,
    lastFinishedAt: status === "RUNNING" ? startedAt : new Date().toISOString(),
    lastError,
    cyclesCompleted: increment ? 1 : 0,
  });
  const safeInsert = typeof (heartbeatInsert as { onConflictDoNothing?: unknown }).onConflictDoNothing === "function"
    ? (heartbeatInsert as { onConflictDoNothing: (config: { target: unknown }) => typeof heartbeatInsert }).onConflictDoNothing({ target: workerHeartbeats.workerName })
    : heartbeatInsert;
  await safeInsert.run();
}

export async function isHostedOnlineCycleRunning(db: QvmDb) {
  const heartbeat = await reconcileStaleHostedOnlineCycle(db);
  if (heartbeat?.status !== "RUNNING") return false;
  const job = await getOnlineCycleJobWithRetry(db);
  const activityAt = Date.parse(job?.updatedAt ?? heartbeat.lastStartedAt ?? "");
  return Number.isFinite(activityAt) && Date.now() - activityAt < ONLINE_CYCLE_LEASE_MS;
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

export async function runHostedOnlineCycle(db: QvmDb, startedAt = new Date().toISOString()) {
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
      settlement = await settleCompletedBets(db, `cycle:${startedAt}:settlement`);
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

type OnlineCyclePhase =
  | "FIXTURES"
  | "ODDS"
  | "ENRICHMENT"
  | "RESULTS"
  | "SPORTSDB_RESULTS"
  | "SETTLEMENT"
  | "BACKTEST"
  | "WORKER"
  | "MANAGER"
  | "AUDITOR"
  | "FINALIZE"
  | "DONE";

type AgentDraft = {
  status: "SUCCEEDED" | "DEGRADED";
  summary: string;
  response: string | null;
  error: string | null;
};

type OnlineCycleJob = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  phase: OnlineCyclePhase;
  errors: string[];
  oddsIndex: number;
  resultsIndex: number;
  sportsDbOffset: number;
  dataSync: Record<string, unknown>;
  enrichment: unknown;
  results: unknown[];
  settlement: unknown;
  backtest: unknown;
  worker?: AgentDraft;
  manager?: AgentDraft;
  auditor?: AgentDraft;
  finalStatus?: "READY" | "PARTIAL";
  agentsRecorded?: number;
};

type OnlineCycleStepResult = {
  status: "RUNNING" | "READY" | "DEGRADED" | "PARTIAL";
  next: boolean;
  startedAt?: string;
  agentsRecorded?: number;
};

export type HostedOnlineCycleStatus = {
  status: "IDLE" | "RUNNING" | "READY" | "DEGRADED";
  phase: OnlineCyclePhase | "IDLE";
  phaseLabel: string;
  progress: number;
  startedAt: string | null;
  updatedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  cyclesCompleted: number;
  stageIndex: number;
  stageCount: number;
  durationSeconds: number | null;
};

const ONLINE_CYCLE_PHASE_LABELS: Record<OnlineCyclePhase, string> = {
  FIXTURES: "Fixture synchronisation",
  ODDS: "Odds refresh",
  ENRICHMENT: "Sportmonks enrichment",
  RESULTS: "Results synchronisation",
  SPORTSDB_RESULTS: "Secondary results check",
  SETTLEMENT: "Paper settlement",
  BACKTEST: "Walk-forward evaluation",
  WORKER: "Online analyst review",
  MANAGER: "Manager review",
  AUDITOR: "Auditor review",
  FINALIZE: "Saving reports",
  DONE: "Completed",
};

const ONLINE_CYCLE_PHASES: OnlineCyclePhase[] = [
  "FIXTURES",
  "ODDS",
  "ENRICHMENT",
  "RESULTS",
  "SPORTSDB_RESULTS",
  "SETTLEMENT",
  "BACKTEST",
  "WORKER",
  "MANAGER",
  "AUDITOR",
  "FINALIZE",
  "DONE",
];

function cycleProgress(phase: OnlineCyclePhase | "IDLE") {
  if (phase === "IDLE") return 0;
  const index = ONLINE_CYCLE_PHASES.indexOf(phase);
  return index < 0 ? 0 : Math.round((index / (ONLINE_CYCLE_PHASES.length - 1)) * 100);
}

function newOnlineCycleJob(startedAt: string): OnlineCycleJob {
  return {
    version: 1,
    startedAt,
    updatedAt: new Date().toISOString(),
    phase: "FIXTURES",
    errors: [],
    oddsIndex: 0,
    resultsIndex: 0,
    sportsDbOffset: 0,
    dataSync: {},
    enrichment: null,
    results: [],
    settlement: null,
    backtest: null,
  };
}

function parseOnlineCycleJob(value: string | null | undefined): OnlineCycleJob | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<OnlineCycleJob>;
    if (parsed.version !== 1 || typeof parsed.startedAt !== "string" || typeof parsed.phase !== "string") return null;
    return {
      ...newOnlineCycleJob(parsed.startedAt),
      ...parsed,
      errors: Array.isArray(parsed.errors) ? parsed.errors.map(String).slice(0, 40) : [],
      oddsIndex: typeof parsed.oddsIndex === "number" ? parsed.oddsIndex : 0,
      resultsIndex: typeof parsed.resultsIndex === "number" ? parsed.resultsIndex : 0,
      sportsDbOffset: typeof parsed.sportsDbOffset === "number" ? parsed.sportsDbOffset : 0,
      dataSync: parsed.dataSync && typeof parsed.dataSync === "object" ? parsed.dataSync as Record<string, unknown> : {},
      results: Array.isArray(parsed.results) ? parsed.results : [],
    };
  } catch {
    return null;
  }
}

async function getOnlineCycleJob(db: QvmDb) {
  const rows = await db
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, ONLINE_CYCLE_JOB_KEY))
    .limit(1);
  return parseOnlineCycleJob(rows[0]?.value);
}

async function getOnlineCycleJobWithRetry(db: QvmDb) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getOnlineCycleJob(db);
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Hosted online cycle state could not be read.");
}

export async function reconcileStaleHostedOnlineCycle(db: QvmDb, now = Date.now()) {
  const existing = await db
    .select()
    .from(workerHeartbeats)
    .where(eq(workerHeartbeats.workerName, ONLINE_WORKER_NAME))
    .orderBy(desc(workerHeartbeats.id))
    .limit(1);
  const heartbeat = existing[0];
  if (!heartbeat || heartbeat.status !== "RUNNING") return heartbeat ?? null;

  const job = await getOnlineCycleJobWithRetry(db);
  const activityAt = Date.parse(job?.updatedAt ?? heartbeat.lastStartedAt ?? "");
  if (Number.isFinite(activityAt) && now - activityAt < ONLINE_CYCLE_LEASE_MS) return heartbeat;

  const startedAt = job?.startedAt ?? heartbeat.lastStartedAt ?? new Date(now).toISOString();
  const phase = job?.phase ?? "UNKNOWN";
  const lastError = `Hosted online review lease expired during ${phase}. It was marked degraded and can be restarted safely.`;
  await setHeartbeat(db, "DEGRADED", startedAt, lastError);
  return {
    ...heartbeat,
    status: "DEGRADED",
    lastStartedAt: startedAt,
    lastFinishedAt: new Date(now).toISOString(),
    lastError,
  };
}

export async function getHostedOnlineCycleStatus(db: QvmDb, now = Date.now()): Promise<HostedOnlineCycleStatus> {
  const heartbeat = await reconcileStaleHostedOnlineCycle(db, now);
  const job = await getOnlineCycleJobWithRetry(db);
  const status = heartbeat?.status === "RUNNING" || heartbeat?.status === "READY" || heartbeat?.status === "DEGRADED"
    ? heartbeat.status
    : "IDLE";
  const phase = job?.phase && ONLINE_CYCLE_PHASE_LABELS[job.phase] ? job.phase : "IDLE";
  const phaseLabel = status === "RUNNING"
    ? ONLINE_CYCLE_PHASE_LABELS[phase]
    : status === "READY"
      ? "Completed"
      : status === "DEGRADED"
        ? phase === "DONE" ? "Completed with warnings" : `Stopped at ${ONLINE_CYCLE_PHASE_LABELS[phase]}`
        : "Not started";
  const phaseIndex = phase === "IDLE" ? -1 : ONLINE_CYCLE_PHASES.indexOf(phase);
  const stageIndex = phaseIndex < 0 ? 0 : phaseIndex + 1;
  const startedMs = Date.parse(heartbeat?.lastStartedAt ?? job?.startedAt ?? "");
  const finishedMs = Date.parse(heartbeat?.lastFinishedAt ?? "");
  const durationEnd = status === "RUNNING" ? now : finishedMs;
  return {
    status,
    phase,
    phaseLabel,
    progress: status === "RUNNING"
      ? cycleProgress(phase)
      : status === "READY" || (status === "DEGRADED" && phase === "DONE")
        ? 100
        : status === "DEGRADED"
          ? cycleProgress(phase)
          : 0,
    startedAt: heartbeat?.lastStartedAt ?? job?.startedAt ?? null,
    updatedAt: job?.updatedAt ?? null,
    lastFinishedAt: heartbeat?.lastFinishedAt ?? null,
    lastError: heartbeat?.lastError ?? null,
    cyclesCompleted: heartbeat?.cyclesCompleted ?? 0,
    stageIndex,
    stageCount: ONLINE_CYCLE_PHASES.length,
    durationSeconds: Number.isFinite(startedMs) && Number.isFinite(durationEnd)
      ? Math.max(0, Math.round((durationEnd - startedMs) / 1000))
      : null,
  };
}

async function saveOnlineCycleJob(db: QvmDb, job: OnlineCycleJob) {
  const value = JSON.stringify({ ...job, updatedAt: new Date().toISOString() });
  await db
    .insert(appMeta)
    .values({ key: ONLINE_CYCLE_JOB_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
    .run();
}

function addCycleError(job: OnlineCycleJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message && !job.errors.includes(message)) job.errors.push(message.slice(0, 500));
  job.errors = job.errors.slice(0, 40);
}

async function runCyclePhase<T>(job: OnlineCycleJob, label: string, action: () => Promise<T>) {
  try {
    const result = await action();
    if (sourceStatus(result) === "ERROR") addCycleError(job, `${label} returned an error.`);
    return result;
  } catch (error) {
    addCycleError(job, error instanceof Error ? `${label}: ${error.message}` : `${label} failed.`);
    return null;
  }
}

async function buildHostedContext(db: QvmDb, job: OnlineCycleJob) {
  const [overview, markets, performance, research] = await Promise.all([
    getOverview(db),
    getMarkets(db),
    getPerformance(db),
    getResearchDashboard(db),
  ]);
  return {
    dataSync: job.dataSync,
    enrichment: job.enrichment,
    results: job.results,
    settlement: job.settlement,
    backtest: job.backtest,
    errors: job.errors,
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
}

async function runHostedAgent(
  runtime: Runtime,
  instructions: string,
  input: unknown,
  fallback: string,
): Promise<AgentDraft> {
  const prompt = await askOpenAI(runtime, instructions, input, HOSTED_AI_STEP_TIMEOUT_MS);
  return {
    status: prompt.text ? "SUCCEEDED" : "DEGRADED",
    summary: prompt.text ?? fallback,
    response: prompt.text,
    error: prompt.error,
  };
}

async function finalizeHostedOnlineCycle(db: QvmDb, job: OnlineCycleJob): Promise<OnlineCycleStepResult> {
  const context = await buildHostedContext(db, job);
  const runtime = await getRuntimeEnv();
  const model = runtime.OPENAI_MODEL ?? runtime.LUNA_MODEL_LABEL ?? ONLINE_MODEL_LABEL;
  const workerSummary = job.worker?.summary ?? fallbackWorkerSummary(context);
  const managerSummary = job.manager?.summary ?? fallbackManagerSummary(context);
  const auditorSummary = job.auditor?.summary ?? fallbackAuditorSummary(context);
  const reports = [
    report(
      "QVM Online Analyst",
      "WORKER",
      "Validate the hosted QVM data and rank paper-trading candidates.",
      job.worker?.status ?? "DEGRADED",
      workerSummary,
      { source: "hosted-openai", response: job.worker?.response ?? null, error: job.worker?.error ?? "OPENAI_NOT_RUN", facts: context },
      model,
      job.startedAt,
    ),
    report(
      "QVM Manager",
      "MANAGER",
      "Review the hosted analyst report and issue a constrained paper-trade recommendation.",
      job.manager?.status ?? "DEGRADED",
      managerSummary,
      { source: "hosted-openai", response: job.manager?.response ?? null, error: job.manager?.error ?? "OPENAI_NOT_RUN", analystReport: workerSummary, facts: context },
      model,
      job.startedAt,
    ),
    report(
      "QVM Auditor",
      "AUDITOR",
      "Verify evidence, deterministic gates and hosted-agent consistency.",
      job.auditor?.status ?? "DEGRADED",
      auditorSummary,
      { source: "hosted-openai", response: job.auditor?.response ?? null, error: job.auditor?.error ?? "OPENAI_NOT_RUN", analystReport: workerSummary, managerReport: managerSummary, facts: context },
      model,
      job.startedAt,
    ),
  ];
  const agentsRecorded = await recordAgentRuns(db, reports);
  const allAgentsSucceeded = [job.worker, job.manager, job.auditor].every((agent) => agent?.status === "SUCCEEDED");
  const status = job.errors.length || !allAgentsSucceeded ? "PARTIAL" : "READY";
  await setHeartbeat(db, status === "READY" ? "READY" : "DEGRADED", job.startedAt, job.errors.length ? job.errors.join(" | ").slice(0, 500) : null, true);
  await logEvent(
    db,
    `Hosted online QVM cycle completed: ${agentsRecorded} OpenAI role reports recorded${job.errors.length ? ` with ${job.errors.length} warning${job.errors.length === 1 ? "" : "s"}` : "."}`,
    status === "READY" ? "INFO" : "WARN",
    "hosted_online_cycle",
  );
  job.phase = "DONE";
  job.finalStatus = status;
  job.agentsRecorded = agentsRecorded;
  await saveOnlineCycleJob(db, job);
  return { status, next: false, startedAt: job.startedAt, agentsRecorded };
}

function normaliseCycleRequestId(value: unknown) {
  if (typeof value !== "string") return null;
  const requestId = value.trim().slice(0, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId) ? requestId : null;
}

async function readCycleReceipt(db: QvmDb, requestId: string) {
  const rows = await db
    .select()
    .from(paperActionReceipts)
    .where(eq(paperActionReceipts.requestId, requestId))
    .limit(1);
  const receipt = rows[0];
  if (!receipt || receipt.action !== "START_HOSTED_ONLINE_CYCLE") return null;
  try {
    const value = JSON.parse(receipt.responseJson) as Record<string, unknown>;
    return value;
  } catch {
    return null;
  }
}

async function writeCycleReceipt(db: QvmDb, requestId: string, response: Record<string, unknown>) {
  await db.insert(paperActionReceipts).values({
    requestId,
    action: "START_HOSTED_ONLINE_CYCLE",
    responseJson: JSON.stringify(response),
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing().run();
}

export async function startHostedOnlineCycle(db: QvmDb, startedAt: string, requestIdValue?: unknown) {
  const requestId = normaliseCycleRequestId(requestIdValue);
  if (requestId) {
    const receipt = await readCycleReceipt(db, requestId);
    if (receipt) return { ...receipt, idempotent: true };
  }
  if (await isHostedOnlineCycleRunning(db)) {
    const heartbeat = await db
      .select()
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.workerName, ONLINE_WORKER_NAME))
      .orderBy(desc(workerHeartbeats.id))
      .limit(1);
    const response = {
      status: "RUNNING",
      startedAt: heartbeat[0]?.lastStartedAt ?? startedAt,
      message: "A hosted online review is already running. Check AI Ops again shortly.",
    };
    if (requestId) await writeCycleReceipt(db, requestId, response);
    return response;
  }
  await saveOnlineCycleJob(db, newOnlineCycleJob(startedAt));
  await setHeartbeat(db, "RUNNING", startedAt, null);
  const response = {
    status: "STARTED",
    startedAt,
    message: "Hosted online review started in the background.",
  };
  if (requestId) await writeCycleReceipt(db, requestId, response);
  return response;
}

export async function runHostedOnlineCycleStep(db: QvmDb, expectedStartedAt?: string): Promise<OnlineCycleStepResult> {
  const job = await getOnlineCycleJobWithRetry(db);
  if (!job || (expectedStartedAt && job.startedAt !== expectedStartedAt)) {
    return { status: "DEGRADED", next: false };
  }
  if (job.phase === "DONE") {
    return { status: job.finalStatus ?? "PARTIAL", next: false, startedAt: job.startedAt, agentsRecorded: job.agentsRecorded };
  }

  await setHeartbeat(db, "RUNNING", job.startedAt, null);
  try {
    if (job.phase === "FIXTURES") {
      job.dataSync.fixtures = await runCyclePhase(job, "Fixture synchronisation", () => refreshFootballDataOrg(db, HOSTED_PROVIDER_TIMEOUT_MS));
      job.phase = "ODDS";
    } else if (job.phase === "ODDS") {
      if (job.oddsIndex < LEAGUE_CONFIGS.length) {
        const league = LEAGUE_CONFIGS[job.oddsIndex];
        job.dataSync.odds = [
          ...(Array.isArray(job.dataSync.odds) ? job.dataSync.odds : []),
          await runCyclePhase(job, `${league.name} odds refresh`, () => refreshOddsFromTheOddsAPI(db, league, false, HOSTED_PROVIDER_TIMEOUT_MS)),
        ];
        job.oddsIndex += 1;
      } else {
        await runCyclePhase(job, "Prediction rebuild", () => rebuildPredictions(db, true));
        await logEvent(db, "Hosted online fixture and odds synchronisation completed.", "INFO", "daily_sync");
        job.phase = "ENRICHMENT";
      }
    } else if (job.phase === "ENRICHMENT") {
      job.enrichment = await runCyclePhase(job, "Sportmonks enrichment", () => refreshSportmonks(db, HOSTED_PROVIDER_TIMEOUT_MS));
      job.phase = "RESULTS";
    } else if (job.phase === "RESULTS") {
      if (job.resultsIndex < LEAGUE_CONFIGS.length) {
        const league = LEAGUE_CONFIGS[job.resultsIndex];
        job.results.push(await runCyclePhase(job, `${league.name} result refresh`, () => refreshResultsFromTheOddsAPI(db, league, HOSTED_PROVIDER_TIMEOUT_MS)));
        job.resultsIndex += 1;
      } else {
        job.phase = "SPORTSDB_RESULTS";
      }
    } else if (job.phase === "SPORTSDB_RESULTS") {
      const limit = 5;
      const result = await runCyclePhase(job, "TheSportsDB result refresh", () => refreshResultsFromTheSportsDB(db, limit, job.sportsDbOffset, HOSTED_PROVIDER_TIMEOUT_MS)) as { checked?: number } | null;
      const checked = typeof result?.checked === "number" ? result.checked : 0;
      if (result && checked >= limit && job.sportsDbOffset < 20) {
        job.sportsDbOffset += limit;
      } else {
        job.phase = "SETTLEMENT";
      }
    } else if (job.phase === "SETTLEMENT") {
      job.settlement = await runCyclePhase(job, "Paper settlement", () => settleCompletedBets(db, `cycle:${job.startedAt}:settlement`));
      job.phase = "BACKTEST";
    } else if (job.phase === "BACKTEST") {
      job.backtest = await runCyclePhase(job, "Walk-forward evaluation", () => runWalkForwardBacktest(db));
      job.phase = "WORKER";
    } else if (job.phase === "WORKER") {
      const context = await buildHostedContext(db, job);
      const runtime = await getRuntimeEnv();
      job.worker = await runHostedAgent(
        runtime,
        "You are QVM Football Workbench's hosted online analyst. Review only the supplied deterministic application facts. Return a concise report covering data freshness, source failures, market candidates, calibration limits, and research tasks. Do not invent fixtures, odds, injuries, or results. Do not recommend real-money action.",
        context,
        fallbackWorkerSummary(context),
      );
      job.phase = "MANAGER";
    } else if (job.phase === "MANAGER") {
      const context = await buildHostedContext(db, job);
      const runtime = await getRuntimeEnv();
      job.manager = await runHostedAgent(
        runtime,
        "You are QVM Football Workbench's hosted Manager. Review the supplied analyst report and deterministic facts. Issue a constrained paper-only decision: recommend no bet or identify a specific paper candidate only when live price, freshness, edge, data quality, and risk gates support it. Never place a bet, never claim real execution, and never invent missing data. Return a concise decision with risk flags and a reason.",
        { ...context, analystReport: job.worker?.summary ?? fallbackWorkerSummary(context) },
        fallbackManagerSummary(context),
      );
      job.phase = "AUDITOR";
    } else if (job.phase === "AUDITOR") {
      const context = await buildHostedContext(db, job);
      const runtime = await getRuntimeEnv();
      job.auditor = await runHostedAgent(
        runtime,
        "You are QVM Football Workbench's hosted Auditor. Verify that the analyst and manager stayed within supplied evidence, freshness gates, risk controls, and paper-only authority. Return PASS or DEGRADED with a short list of violations or warnings. Do not add new factual claims.",
        { ...context, analystReport: job.worker?.summary ?? fallbackWorkerSummary(context), managerReport: job.manager?.summary ?? fallbackManagerSummary(context) },
        fallbackAuditorSummary(context),
      );
      job.phase = "FINALIZE";
    } else if (job.phase === "FINALIZE") {
      return await finalizeHostedOnlineCycle(db, job);
    } else {
      throw new Error(`Unknown hosted online cycle phase: ${job.phase}`);
    }

    await saveOnlineCycleJob(db, job);
    return { status: "RUNNING", next: true, startedAt: job.startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hosted online cycle failed.";
    addCycleError(job, message);
    job.phase = "DONE";
    job.finalStatus = "PARTIAL";
    await saveOnlineCycleJob(db, job).catch(() => undefined);
    await setHeartbeat(db, "DEGRADED", job.startedAt, job.errors.join(" | ").slice(0, 500), true).catch(() => undefined);
    await logEvent(db, `Hosted online QVM cycle failed: ${message}`, "ERROR", "hosted_online_cycle").catch(() => undefined);
    return { status: "DEGRADED", next: false, startedAt: job.startedAt };
  }
}

export async function continueHostedOnlineCycle(db: QvmDb, requestUrl: string, expectedStartedAt: string) {
  const result = await runHostedOnlineCycleStep(db, expectedStartedAt);
  if (!result.next) return result;
  const nextUrl = new URL(requestUrl);
  nextUrl.searchParams.set("continue", "1");
  nextUrl.searchParams.set("startedAt", expectedStartedAt);
  const response = await fetch(nextUrl.toString(), {
    method: "POST",
    headers: { "X-QVM-Cycle-Continuation": "1" },
  });
  if (!response.ok) throw new Error(`Hosted online cycle continuation returned HTTP ${response.status}.`);
  return result;
}
