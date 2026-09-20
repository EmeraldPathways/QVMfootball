"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  BrainCircuit,
  BookOpenCheck,
  Calculator,
  CheckCircle2,
  Clock3,
  CircleAlert,
  Database,
  Gauge,
  LayoutDashboard,
  LineChart,
  ListChecks,
  ListFilter,
  MessageCircle,
  Menu,
  Play,
  RefreshCw,
  ScanLine,
  ServerCog,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Send,
  Target,
  TrendingUp,
  Trophy,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { qvmTimeoutMs } from "@/lib/qvm-timeouts";

type View = "overview" | "edge" | "performance" | "agents" | "research" | "settings";
type Selection = string;

type RiskSummary = {
  status: "READY" | "HALTED";
  flags: string[];
  killSwitch?: boolean;
  currentBankroll: number;
  openExposure: number;
  openExposureLimit: number;
  dailyLoss: number;
  dailyLossLimit: number;
  maxDrawdownPct: number;
  pendingBets: number;
  maxStakePct: number;
  maxOpenExposurePct: number;
  maxFixtureExposurePct: number;
  quoteMaxAgeSeconds: number;
};

type AgentRun = {
  id?: number;
  agentName: string;
  role: string;
  model: string;
  status: string;
  task: string;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

type Backtest = {
  id?: number;
  modelVersion: string;
  evaluationType: string;
  fixturesAvailable?: number;
  fixturesEvaluated: number;
  brierScore: number | null;
  logLoss: number | null;
  hitRate: number | null;
  averageTailMass: number | null;
  roiPct: number | null;
  maxDrawdownPct: number | null;
  note?: string;
  createdAt: string;
};

type AgentDashboard = {
  modelProfile: {
    label: string;
    exactModel: string | null;
    apiConfigured: boolean;
    executionAuthority: string;
    runtime?: string;
  };
  policy: {
    mode: string;
    manualApprovalRequired: boolean;
    workerCanExecute: boolean;
    managerCanExecute: boolean;
  };
  risk: RiskSummary;
  latest: Array<AgentRun & { payload: Record<string, unknown> | null }>;
  history: AgentRun[];
  backtests: Backtest[];
};

type Overview = {
  mode: string;
  portfolio: {
    currentBankroll: number;
    initialBankroll: number;
    roiPct: number;
    drawdownPct: number;
  };
  kpis: {
    totalPlacedBets: number;
    settledBets: number;
    pendingBets: number;
    awaitingResultBets: number;
    winRatePct: number;
    profitLoss: number;
  };
  connection: {
    oddsFeed: string;
    database: string;
    execution: string;
    risk: string;
  };
  activeTrades: Array<{
    id: number;
    fixtureId: number;
    match: string;
    matchDate: string | null;
    selection: string;
    odds: number;
    edgePct: number;
    stake: number;
    placedAt: string;
    resultStatus: "UPCOMING" | "AWAITING_RESULT" | "READY_TO_SETTLE";
  }>;
  logs: Array<{
    id: number;
    level: string;
    message: string;
    context: string | null;
    createdAt: string;
  }>;
  model: {
    teamsTracked: number;
    teamStatsRows: number;
    completedFixtures: number;
    grid: string;
    latestBacktest: Backtest | null;
  };
  risk: RiskSummary;
  agents: Array<Pick<AgentRun, "agentName" | "role" | "model" | "status" | "summary" | "finishedAt">>;
  lastRefresh: string | null;
};

type MarketSelection = {
  selection: Selection;
  marketOdds: number;
  fairOdds: number;
  trueProb: number;
  impliedProb: number;
  edgePct: number;
  suggestedStake: number;
  rawEdgePct: number;
  robustEdgePct: number;
  marketProbability: number;
  blendedProbability: number;
  uncertaintyLow: number;
  uncertaintyHigh: number;
  action: "BET" | "NO_BET";
  flags: string[];
  rationale: string;
};

type Market = {
  fixtureId: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  provider: string;
  capturedAt: string;
  quoteAgeSeconds: number;
  isStale: boolean;
  lambdaHome: number | null;
  lambdaAway: number | null;
  gridMass: number | null;
  tailMass: number | null;
  dataQualityScore: number;
  qualityReasons: string[];
  selections: MarketSelection[];
  goalMarkets?: Array<{
    marketType: "TOTALS" | "BTTS" | "TEAM_TOTALS";
    selection: string;
    line: number | null;
    fairOdds: number;
    trueProb: number;
    marketOdds: number | null;
    edgePct: number | null;
    action: "BET" | "NO_BET";
  }>;
  bestEdge: number;
};

type MarketsPayload = {
  markets: Market[];
  model: {
    leagueAvgGoalsHome: number;
    leagueAvgGoalsAway: number;
    teamsWithStats: number;
    grid: string;
  };
};

export function isBetPlaced(
  trades: ReadonlyArray<{ fixtureId: number; selection: string }>,
  fixtureId: number,
  selection: string,
) {
  return trades.some((trade) => trade.fixtureId === fixtureId && trade.selection === selection);
}

function isFixtureBetPlaced(
  trades: ReadonlyArray<{ fixtureId: number; selection: string }>,
  fixtureId: number,
) {
  return trades.some((trade) => trade.fixtureId === fixtureId);
}

function BetPlacedIndicator({ label = "Bet placed" }: { label?: string }) {
  return <span aria-label={label} title={label} className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_0_3px_rgba(52,211,153,0.16),0_0_12px_rgba(52,211,153,0.75)]" />;
}

type Performance = {
  initialBankroll: number;
  currentBankroll: number;
  history: Array<{
    id: number;
    league: string;
    match: string;
    score: string;
    status: "PENDING" | "SETTLED";
    selection: Selection;
    marketOdds: number;
    edgePct: number;
    stakeAmount: number;
    outcome: "WON" | "LOST" | null;
    profitLoss: number;
    placedAt: string;
    matchDate: string | null;
    runningBankroll: number;
  }>;
  chart: Array<{ label: string; bankroll: number }>;
};

type Research = {
  capabilities: string[];
  counts: { snapshots: number; replays: number; experiments: number; scenarios: number; players: number; calibrationBuckets: number; features?: number; availability?: number; sources?: number };
  heartbeats: Array<{ workerName: string; status: string; cyclesCompleted: number; lastFinishedAt: string | null }>;
  latestReplays: Array<{ id: number; decision: string; modelVersion: string; createdAt: string }>;
  sourceHealth?: Array<{ source: string; status: string; lastSuccessAt: string | null; lastAttemptAt: string | null; recordsUpdated: number; message: string | null }>;
};

const navItems: Array<{
  value: View;
  label: string;
  caption: string;
  icon: ComponentType<{ className?: string; size?: number }>;
}> = [
  { value: "overview", label: "Overview", caption: "System pulse", icon: LayoutDashboard },
  { value: "edge", label: "Edge Finder", caption: "Value surface", icon: Target },
  { value: "performance", label: "Performance", caption: "Audit hub", icon: LineChart },
  { value: "agents", label: "AI Ops", caption: "Hosted OpenAI", icon: BrainCircuit },
  { value: "research", label: "Research Lab", caption: "Experiments + replay", icon: BookOpenCheck },
  { value: "settings", label: "Settings", caption: "Sources + diagnostics", icon: Settings },
];

const leagueTabs = [
  { key: "all", label: "All leagues" },
  { key: "Premier League", label: "Premier League" },
  { key: "Bundesliga", label: "Bundesliga" },
  { key: "La Liga", label: "La Liga" },
  { key: "Serie A", label: "Serie A" },
] as const;

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

function WorkspaceNavigation({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className={mobile ? "flex h-full flex-col" : "flex h-full flex-col"}>
      <div className="flex items-center gap-3 px-5 py-5 lg:px-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500 text-base font-bold text-white shadow-lg shadow-indigo-500/20">Q</div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-wide text-slate-100">QVM Workbench</p>
          <p className="text-xs text-slate-500">Football value lab</p>
        </div>
      </div>
      <div className="px-5 pb-5 lg:px-4">
        <StatusPill tone="emerald"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> PAPER MODE</StatusPill>
      </div>
      <div className="border-t border-slate-800/80 px-5 pt-6 lg:px-4">
        <p className="mb-3 px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Workspace</p>
        <TabsList aria-label="QVM workbench sections" className="!inline-flex !h-auto !w-full !flex-col !items-stretch !justify-start !gap-1 !rounded-none !bg-transparent !p-0">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger
                key={item.value}
                value={item.value}
                onClick={onNavigate}
                className="!h-auto !min-h-[58px] !flex-none min-w-0 justify-start gap-3 rounded-xl border border-transparent px-3 py-3 text-left text-slate-400 data-[state=active]:border-indigo-400/20 data-[state=active]:bg-indigo-500/10 data-[state=active]:text-indigo-200"
              >
                <Icon size={18} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] font-normal text-slate-600 data-[state=active]:text-indigo-300/70">{item.caption}</span>
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      <div className="mt-auto border-t border-slate-800/80 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10 text-xs font-semibold text-emerald-300">AP</div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-200">Personal workspace</p>
            <p className="truncate text-xs text-slate-500">Paper-only access · owner controls</p>
          </div>
        </div>
        <div className="mt-5 flex items-start gap-2 text-xs text-slate-500"><CircleAlert size={14} className="mt-0.5 shrink-0 text-amber-300" /> <span>No live execution. Research and paper positions only.</span></div>
      </div>
    </div>
  );
}

function formatOdds(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function formatPct(value: number, signed = false) {
  const prefix = signed && value > 0 ? "+" : "";
  return prefix + value.toFixed(1) + "%";
}

function formatDate(value: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-IE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function selectionLabel(value: Selection) {
  if (value === "HOME") return "Home";
  if (value === "AWAY") return "Away";
  if (value === "DRAW") return "Draw";
  if (value.startsWith("BTTS_")) return `BTTS ${value.slice(5) === "YES" ? "Yes" : "No"}`;
  const teamTotal = value.match(/^(HOME|AWAY)_(OVER|UNDER)_(.+)$/);
  if (teamTotal) return `${teamTotal[1] === "HOME" ? "Home" : "Away"} ${teamTotal[2] === "OVER" ? "over" : "under"} ${teamTotal[3]}`;
  const total = value.match(/^(OVER|UNDER)_(.+)$/);
  if (total) return `${total[1] === "OVER" ? "Over" : "Under"} ${total[2]}`;
  return value;
}

function isGoalsSelection(value: Selection) {
  return /^(OVER|UNDER|BTTS_|HOME_OVER|HOME_UNDER|AWAY_OVER|AWAY_UNDER)/.test(value);
}

function edgeTone(edge: number) {
  if (edge > 0.05) return "emerald";
  if (edge > 0.03) return "indigo";
  return "muted";
}

function bestSelection(market: Market) {
  return [...market.selections].sort((left, right) => right.robustEdgePct - left.robustEdgePct)[0];
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ComponentType<{ className?: string; size?: number }>;
  accent: "indigo" | "emerald" | "sky" | "amber";
}) {
  const iconClass = {
    indigo: "bg-indigo-500/15 text-indigo-300",
    emerald: "bg-emerald-500/15 text-emerald-300",
    sky: "bg-sky-500/15 text-sky-300",
    amber: "bg-amber-500/15 text-amber-300",
  }[accent];
  return (
    <article className="panel rounded-2xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-400">{label}</p>
        <span className={"rounded-xl p-2 " + iconClass}>
          <Icon size={17} />
        </span>
      </div>
      <p className="mt-4 text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </article>
  );
}

function StatusPill({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "emerald" | "indigo" | "amber" | "rose";
}) {
  const styles = {
    slate: "border-slate-700 bg-slate-800/70 text-slate-300",
    emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    indigo: "border-indigo-500/25 bg-indigo-500/10 text-indigo-300",
    amber: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    rose: "border-rose-500/25 bg-rose-500/10 text-rose-300",
  }[tone];
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium " + styles}>
      {children}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-300">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-50 sm:text-2xl">
          {title}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function MiniChart({ points }: { points: Array<{ bankroll: number }> }) {
  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-slate-700 text-sm text-slate-500">
        Settled positions will plot here.
      </div>
    );
  }
  const values = points.map((point) => point.bankroll);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const coordinates = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 94 - ((point.bankroll - min) / range) * 78;
      return x.toFixed(2) + "," + y.toFixed(2);
    })
    .join(" ");
  return (
    <div className="relative h-40 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/30 p-2">
      <div className="pointer-events-none absolute inset-x-3 top-1/4 border-t border-dashed border-slate-800" />
      <div className="pointer-events-none absolute inset-x-3 top-1/2 border-t border-dashed border-slate-800" />
      <div className="pointer-events-none absolute inset-x-3 top-3/4 border-t border-dashed border-slate-800" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <polyline
          fill="none"
          stroke="#34d399"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
          points={coordinates}
        />
      </svg>
      <div className="absolute bottom-2 left-3 text-[11px] text-slate-500">
        {formatMoney(min)}
      </div>
      <div className="absolute right-3 top-2 text-[11px] text-emerald-300">
        {formatMoney(max)}
      </div>
    </div>
  );
}

function OverviewView({
  overview,
  onScan,
  onRefresh,
  busy,
}: {
  overview: Overview;
  onScan: () => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const matchTrades = overview.activeTrades.filter((trade) => !isGoalsSelection(trade.selection));
  const goalsTrades = overview.activeTrades.filter((trade) => isGoalsSelection(trade.selection));
  const groupedTrades = [...matchTrades, ...goalsTrades];
  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="System overview"
        title="Paper book, live signal"
        detail="The control surface is ready for research and paper execution."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={busy}
              className="border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"
            >
              <RefreshCw size={14} className={busy ? "mr-2 animate-spin" : "mr-2"} />
              Sync live data
            </Button>
            <Button
              size="sm"
              onClick={onScan}
              disabled={busy}
              className="bg-indigo-500 text-white hover:bg-indigo-400"
            >
              <Zap size={14} className="mr-2" />
              Scan edges
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Current bankroll"
          value={formatMoney(overview.portfolio.currentBankroll)}
          detail={"Start " + formatMoney(overview.portfolio.initialBankroll)}
          icon={Wallet}
          accent="indigo"
        />
        <MetricCard
          label="Total placed bets"
          value={String(overview.kpis.totalPlacedBets)}
          detail={String(overview.kpis.pendingBets) + " open · " + String(overview.kpis.settledBets) + " settled"}
          icon={Activity}
          accent="sky"
        />
        <MetricCard
          label="Running ROI"
          value={formatPct(overview.portfolio.roiPct, true)}
          detail={formatMoney(overview.kpis.profitLoss) + " net P&L"}
          icon={TrendingUp}
          accent="emerald"
        />
        <MetricCard
          label="Global win rate"
          value={formatPct(overview.kpis.winRatePct)}
          detail="Settled positions only"
          icon={Trophy}
          accent="amber"
        />
      </div>

      <div className="grid gap-4">
        <section className="panel rounded-2xl p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-slate-300">Model health</p>
              <p className="mt-1 text-xs text-slate-500">
                Dynamic Dixon–Coles scoreline engine · 12×12 tail-normalised probabilities
              </p>
            </div>
            <StatusPill tone={overview.risk.status === "READY" ? "emerald" : "rose"}>
              {overview.risk.status === "READY" ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
              {overview.risk.status === "READY" ? "Guardrails ready" : "Risk gate halted"}
            </StatusPill>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <p className="text-xs text-slate-500">Tracked teams</p>
              <p className="mt-1 text-lg font-semibold text-slate-100">{overview.model.teamsTracked}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <p className="text-xs text-slate-500">Completed fixtures</p>
              <p className="mt-1 text-lg font-semibold text-slate-100">{overview.model.completedFixtures}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <p className="text-xs text-slate-500">Score grid</p>
              <p className="mt-1 text-lg font-semibold text-slate-100">{overview.model.grid}</p>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between text-xs">
            <span className="text-slate-500">Open exposure utilization</span>
            <span className="font-medium text-emerald-300">
              {formatMoney(overview.risk.openExposure)} / {formatMoney(overview.risk.openExposureLimit)}
            </span>
          </div>
          <Progress
            value={Math.min(100, overview.risk.openExposureLimit > 0 ? (overview.risk.openExposure / overview.risk.openExposureLimit) * 100 : 0)}
            className="mt-2 h-1.5 bg-slate-800 [&>div]:bg-emerald-400"
          />
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg border border-slate-800 bg-slate-950/25 p-2.5">
              <p className="text-slate-500">Daily loss</p>
              <p className="mt-1 font-mono text-slate-200">{formatMoney(overview.risk.dailyLoss)}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/25 p-2.5">
              <p className="text-slate-500">Max drawdown</p>
              <p className="mt-1 font-mono text-slate-200">{formatPct(overview.risk.maxDrawdownPct)}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/25 p-2.5">
              <p className="text-slate-500">Quote SLA</p>
              <p className="mt-1 font-mono text-slate-200">{Math.round(overview.risk.quoteMaxAgeSeconds / 60)}m</p>
            </div>
          </div>
          {overview.risk.flags.length > 0 && (
            <p className="mt-3 text-xs text-rose-300">{overview.risk.flags.join(" · ")}</p>
          )}
        </section>

      </div>

      <div className="grid gap-4">
        <section className="panel overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-slate-200">Active trades</p>
              <p className="mt-1 text-xs text-slate-500">Future paper positions only · completed fixtures are tracked in Match Results</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                {overview.activeTrades.filter((trade) => trade.resultStatus === "UPCOMING").length} open
              </Badge>
            </div>
          </div>
          {overview.activeTrades.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              No future open paper positions. {overview.kpis.awaitingResultBets > 0 ? `${overview.kpis.awaitingResultBets} finished position${overview.kpis.awaitingResultBets === 1 ? " is" : "s are"} awaiting a verified score in Match Results.` : "Run an edge scan to evaluate the current market surface."}
            </div>
          ) : (
            <div className="max-h-[420px] overflow-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-500">Match</TableHead>
                    <TableHead className="text-slate-500">Side</TableHead>
                    <TableHead className="text-slate-500">Edge</TableHead>
                    <TableHead className="text-right text-slate-500">Stake</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedTrades.map((trade, index) => (
                    <Fragment key={trade.id}>
                    {index === 0 && matchTrades.length > 0 && <TableRow className="border-slate-800 bg-slate-950/40 hover:bg-slate-950/40"><TableCell colSpan={4} className="py-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-200">Match result bets · {matchTrades.length}</TableCell></TableRow>}
                    {index === matchTrades.length && goalsTrades.length > 0 && <TableRow className="border-slate-800 bg-slate-950/40 hover:bg-slate-950/40"><TableCell colSpan={4} className="py-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200">Goals bets · {goalsTrades.length}</TableCell></TableRow>}
                    <TableRow className="border-slate-800/80 hover:bg-slate-800/25">
                      <TableCell>
                        <p className="max-w-[260px] truncate font-medium text-slate-200">{trade.match}</p>
                        <p className="mt-1 flex items-center gap-1 text-xs text-indigo-200"><Clock3 size={12} /> Kick-off {trade.matchDate ? formatDate(trade.matchDate) : "—"}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                          <span>Placed {formatDate(trade.placedAt)}</span>
                          {trade.resultStatus === "AWAITING_RESULT" && <span className="text-amber-300">Awaiting full-time score</span>}
                          {trade.resultStatus === "READY_TO_SETTLE" && <span className="text-emerald-300">Result received · settlement pending</span>}
                        </p>
                      </TableCell>
                      <TableCell><StatusPill tone="indigo">{selectionLabel(trade.selection)}</StatusPill></TableCell>
                      <TableCell className="font-mono text-emerald-300">{formatPct(trade.edgePct * 100)}</TableCell>
                      <TableCell className="text-right font-mono text-slate-200">{formatMoney(trade.stake)}</TableCell>
                    </TableRow>
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

function EdgeFinderView({
  markets,
  model,
  activeLeague,
  placedTrades,
  onScan,
  onPlace,
  busy,
}: {
  markets: MarketsPayload;
  model: Overview["model"];
  activeLeague: string;
  placedTrades: Overview["activeTrades"];
  onScan: () => void;
  onPlace: (fixtureId: number, selection: string, stakeAmount?: number) => void;
  busy: boolean;
}) {
  const [stakeOverrides, setStakeOverrides] = useState<Record<number, string>>({});
  const [goalStakeOverrides, setGoalStakeOverrides] = useState<Record<string, string>>({});
  const visibleMarkets = markets.markets.filter((market) => activeLeague === "all" || market.league === activeLeague);
  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Live opportunity surface"
        title="Edge Finder"
    detail={"Compare market odds with the " + model.grid + " Dixon–Coles fair-price surface."}
        action={
          <Button
            size="sm"
            onClick={onScan}
            disabled={busy}
            className="bg-emerald-500 text-slate-950 hover:bg-emerald-400"
          >
            <Zap size={14} className="mr-2" />
            Run paper scan
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel rounded-2xl p-4">
          <p className="text-xs uppercase tracking-[0.13em] text-slate-500">Model baseline</p>
          <p className="mt-2 text-lg font-semibold text-slate-100">
            {markets.model.leagueAvgGoalsHome.toFixed(2)} / {markets.model.leagueAvgGoalsAway.toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-slate-500">League home / away goals</p>
        </div>
        <div className="panel rounded-2xl p-4">
          <p className="text-xs uppercase tracking-[0.13em] text-slate-500">Minimum edge</p>
          <p className="mt-2 text-lg font-semibold text-emerald-300">3.00%</p>
          <p className="mt-1 text-xs text-slate-500">Strict scanner threshold</p>
        </div>
        <div className="panel rounded-2xl p-4">
          <p className="text-xs uppercase tracking-[0.13em] text-slate-500">Sizing rule</p>
          <p className="mt-2 text-lg font-semibold text-indigo-300">¼ Kelly · 10% cap</p>
          <p className="mt-1 text-xs text-slate-500">Per-wager bankroll constraint</p>
        </div>
        <div className="panel rounded-2xl p-4 md:col-span-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.13em] text-slate-500">Tradeability filter</p>
              <p className="mt-2 text-lg font-semibold text-slate-100">Quality score ≥ 60 · 12×12 Dixon–Coles grid</p>
              <p className="mt-1 text-xs text-slate-500">Low-history, stale-quote and high-tail-risk fixtures are excluded from paper execution.</p>
            </div>
            <ShieldCheck className="text-emerald-300" size={22} />
          </div>
        </div>
      </div>

      <section className="panel flex flex-col overflow-hidden rounded-2xl">
        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-200">Upcoming {activeLeague === "all" ? "football" : activeLeague} markets</p>
            <p className="mt-1 text-xs text-slate-500">Upcoming fixtures only, from the current time. Best-priced outcome per fixture is shown first.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ListFilter size={14} />
            {visibleMarkets.length} fixtures · demo or live snapshot
          </div>
        </div>

        <div className="order-1 hidden overflow-hidden md:block">
          <Table className="w-full table-fixed [&_th]:whitespace-normal [&_td]:min-w-0 [&_td]:whitespace-normal [&_td]:break-words">
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="w-[30%] text-slate-500">Match details</TableHead>
                <TableHead className="w-[10%] text-slate-500">Selection</TableHead>
                <TableHead className="w-[9%] text-slate-500">Market odds</TableHead>
                <TableHead className="w-[9%] text-slate-500">Fair odds</TableHead>
                <TableHead className="w-[9%] text-slate-500">Edge</TableHead>
                <TableHead className="w-[15%] text-slate-500">Suggested stake</TableHead>
                <TableHead className="w-[18%] text-right text-slate-500">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleMarkets.map((market) => {
                const best = bestSelection(market);
                const tone = best.action === "BET" ? edgeTone(best.robustEdgePct) : "muted";
                const stakeValue = stakeOverrides[market.fixtureId] ?? best.suggestedStake.toFixed(2);
                const betPlaced = isFixtureBetPlaced(placedTrades, market.fixtureId);
                return (
                  <TableRow key={market.fixtureId} className="border-slate-800/80 hover:bg-slate-800/25">
                    <TableCell>
                      <p className="font-medium text-slate-100">{market.homeTeam} <span className="text-slate-600">vs</span> {market.awayTeam}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(market.matchDate)} · {market.provider} · {market.isStale ? "stale quote" : Math.round(market.quoteAgeSeconds) + "s old"} · quality {market.dataQualityScore.toFixed(0)} · xG {market.lambdaHome?.toFixed(2) ?? "—"}–{market.lambdaAway?.toFixed(2) ?? "—"}</p>
                    </TableCell>
                    <TableCell><StatusPill tone="indigo">{selectionLabel(best.selection)}</StatusPill></TableCell>
                    <TableCell className="font-mono text-slate-200">{formatOdds(best.marketOdds)}</TableCell>
                    <TableCell className="font-mono text-slate-300">{formatOdds(best.fairOdds)}</TableCell>
                    <TableCell>
                      {tone === "emerald" ? (
                        <Badge className="soft-glow border-emerald-400/30 bg-emerald-400/15 font-mono text-emerald-200">
                          {formatPct(best.robustEdgePct * 100, true)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className={tone === "indigo" ? "border-indigo-400/30 bg-indigo-400/10 font-mono text-indigo-200" : "border-slate-700 bg-slate-900/40 font-mono text-slate-400"}>
                          {formatPct(best.robustEdgePct * 100, true)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell><div className="flex items-center gap-2"><span className="text-xs text-slate-500">€</span><input type="number" min="0.01" step="0.01" inputMode="decimal" value={stakeValue} onChange={(event) => setStakeOverrides((current) => ({ ...current, [market.fixtureId]: event.target.value }))} aria-label={`Stake for ${market.homeTeam} versus ${market.awayTeam}`} className="w-24 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-sm text-slate-200 outline-none focus:border-indigo-400" />{betPlaced && <BetPlacedIndicator label="Bet already placed on this fixture" />}</div></TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || best.action !== "BET"}
                        title={best.action === "BET" ? "Create a paper position" : best.flags.join(" · ") || "No robust edge"}
                        aria-label={best.action === "BET" ? `Paper bet ${selectionLabel(best.selection)} ${market.homeTeam} versus ${market.awayTeam}` : `No paper bet: ${best.flags.join(", ") || "no robust edge"}`}
                        onClick={() => onPlace(market.fixtureId, best.selection, Number(stakeValue))}
                        className="border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"
                      >
                        <Play size={13} className="mr-1.5" />
                        Paper bet
                      </Button>
                      {best.action !== "BET" && <p className="mt-1 max-w-full break-words text-[10px] leading-4 text-amber-300/80">Blocked: {best.flags.join(" · ") || "no robust edge"}</p>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="order-3 border-t border-slate-800/80 px-4 py-3 sm:px-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Goals market fair prices</p>
            <span className="text-[11px] text-slate-600">Live odds appear when supplied by the feed</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {visibleMarkets.flatMap((market) => (market.goalMarkets ?? []).filter((item) => item.marketType !== "TEAM_TOTALS").map((item) => (
              <div key={`${market.fixtureId}-${item.marketType}-${item.selection}-${item.line ?? 0}`} className="rounded-lg border border-slate-800 bg-slate-950/25 px-3 py-2 text-xs">
                <p className="truncate text-slate-400">{market.homeTeam} v {market.awayTeam}</p>
                <p className="mt-1 flex items-center gap-1 text-[11px] text-indigo-200"><Clock3 size={11} /> Kick-off {formatDate(market.matchDate)}</p>
                <div className="mt-1 flex items-center justify-between gap-2"><span className="text-slate-200">{item.marketType === "BTTS" ? `BTTS ${item.selection}` : `${item.selection} ${item.line}`}</span><span className="font-mono text-indigo-200">{formatOdds(item.marketOdds ?? item.fairOdds)}</span></div>
                <p className="mt-1 text-[11px] text-slate-500">Fair {formatOdds(item.fairOdds)} · {formatPct(item.trueProb * 100)}</p>
                {(() => { const goalKey = `${market.fixtureId}-${item.marketType}-${item.selection}-${item.line ?? 0}`; const goalSelection = item.marketType === "BTTS" ? `BTTS_${item.selection}` : `${item.selection}_${item.line}`; const goalStake = goalStakeOverrides[goalKey] ?? (item.marketOdds ? "10.00" : "0.00"); const betPlaced = isBetPlaced(placedTrades, market.fixtureId, goalSelection); return <div className="mt-2 flex items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-slate-500">€<input type="number" min="0.01" step="0.01" inputMode="decimal" value={goalStake} disabled={!item.marketOdds || item.action !== "BET"} onChange={(event) => setGoalStakeOverrides((current) => ({ ...current, [goalKey]: event.target.value }))} aria-label={`Stake for ${market.homeTeam} versus ${market.awayTeam} ${item.selection} ${item.line ?? ""}`} className="min-w-0 w-full rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-xs text-slate-200 outline-none focus:border-indigo-400" />{betPlaced && <BetPlacedIndicator label="Bet already placed on this goal market" />}</label><Button size="sm" variant="outline" disabled={!item.marketOdds || item.action !== "BET" || busy} onClick={() => onPlace(market.fixtureId, goalSelection, Number(goalStake))} className="h-7 shrink-0 border-slate-700 bg-slate-900/50 text-xs text-slate-300 hover:bg-slate-800"><Play size={12} className="mr-1" /> {item.marketOdds ? "Paper bet" : "Fair only"}</Button></div>; })()}
              </div>
            ))) }
          </div>
        </div>

        <div className="order-2 space-y-3 p-3 md:hidden">
          {visibleMarkets.map((market) => {
            const best = bestSelection(market);
            const tone = best.action === "BET" ? edgeTone(best.robustEdgePct) : "muted";
            const stakeValue = stakeOverrides[market.fixtureId] ?? best.suggestedStake.toFixed(2);
            const betPlaced = isFixtureBetPlaced(placedTrades, market.fixtureId);
            return (
              <article key={market.fixtureId} className={"rounded-xl border p-4 " + (tone === "emerald" ? "soft-glow border-emerald-500/25 bg-emerald-500/[0.04]" : "border-slate-800 bg-slate-950/25")}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-100">{market.homeTeam} <span className="text-slate-600">vs</span> {market.awayTeam}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatDate(market.matchDate)} · {market.provider} · {market.isStale ? "stale quote" : Math.round(market.quoteAgeSeconds) + "s old"} · quality {market.dataQualityScore.toFixed(0)}</p>
                    <p className="mt-1 text-xs text-indigo-200/80">Model xG <span className="font-mono">{market.lambdaHome?.toFixed(2) ?? "—"}–{market.lambdaAway?.toFixed(2) ?? "—"}</span></p>
                  </div>
                  {tone === "emerald" ? <Badge className="border-emerald-400/30 bg-emerald-400/15 text-emerald-200">Value</Badge> : <StatusPill tone={tone === "indigo" ? "indigo" : "slate"}>Watch</StatusPill>}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg bg-slate-900/70 p-2"><p className="text-slate-500">Side</p><p className="mt-1 font-medium text-indigo-200">{selectionLabel(best.selection)}</p></div>
                  <div className="rounded-lg bg-slate-900/70 p-2"><p className="text-slate-500">Market / fair</p><p className="mt-1 font-mono text-slate-200">{formatOdds(best.marketOdds)} / {formatOdds(best.fairOdds)}</p></div>
                  <div className="rounded-lg bg-slate-900/70 p-2"><p className="text-slate-500">Robust edge</p><p className={"mt-1 font-mono " + (best.action === "BET" ? "text-emerald-300" : "text-slate-400")}>{formatPct(best.robustEdgePct * 100, true)}</p></div>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <label className="flex items-center gap-1 text-sm text-slate-400">Stake €<input type="number" min="0.01" step="0.01" inputMode="decimal" value={stakeValue} onChange={(event) => setStakeOverrides((current) => ({ ...current, [market.fixtureId]: event.target.value }))} aria-label={`Stake for ${market.homeTeam} versus ${market.awayTeam}`} className="w-20 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-sm text-slate-200 outline-none focus:border-indigo-400" />{betPlaced && <BetPlacedIndicator label="Bet already placed on this fixture" />}</label>
                  <Button size="sm" title={best.action === "BET" ? "Create a paper position" : best.flags.join(" · ") || "No robust edge"} aria-label={best.action === "BET" ? `Paper bet ${selectionLabel(best.selection)} ${market.homeTeam} versus ${market.awayTeam}` : `No paper bet: ${best.flags.join(", ") || "no robust edge"}`} onClick={() => onPlace(market.fixtureId, best.selection, Number(stakeValue))} disabled={busy || best.action !== "BET"} className="bg-indigo-500 text-white hover:bg-indigo-400">
                    <Play size={13} className="mr-1.5" /> Paper bet
                  </Button>
                </div>
                {best.action !== "BET" && <p className="mt-2 text-[11px] leading-4 text-amber-300/80">Paper bet blocked: {best.flags.join(" · ") || "no robust edge"}</p>}
              </article>
            );
          })}
        </div>
      </section>

    </div>
  );
}

function PerformanceView({
  performance,
  activeLeague,
  onSettle,
  busy,
}: {
  performance: Performance;
  activeLeague: string;
  onSettle: () => void;
  busy: boolean;
}) {
  const history = performance.history.filter((bet) => activeLeague === "all" || bet.league === activeLeague);
  const matchHistory = history.filter((bet) => !isGoalsSelection(bet.selection));
  const goalsHistory = history.filter((bet) => isGoalsSelection(bet.selection));
  const groupedHistory = [...matchHistory, ...goalsHistory];
  const chart = [{ label: "Start", bankroll: performance.initialBankroll }, ...history.map((item, index) => ({ label: "Bet " + String(index + 1), bankroll: item.runningBankroll }))];
  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Portfolio audit"
        title="Performance Audit Hub"
        detail="Every settled paper position rolls forward into the simulation ledger."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onSettle}
            disabled={busy}
            className="border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"
          >
            <ListChecks size={14} className="mr-2" />
            Sync results & settle
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Bankroll curve</p>
              <p className="mt-1 text-xs text-slate-500">Starting balance to latest settled position</p>
            </div>
            <BarChart3 size={18} className="text-emerald-300" />
          </div>
          <div className="mt-5">
            <MiniChart points={chart} />
          </div>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs">
            <span className="text-slate-500">Start <span className="ml-1 font-mono text-slate-200">{formatMoney(performance.initialBankroll)}</span></span>
            <span className="text-slate-500">Current <span className="ml-1 font-mono text-emerald-300">{formatMoney(performance.currentBankroll)}</span></span>
              <span className="text-slate-500">Rows <span className="ml-1 font-mono text-slate-200">{history.length}</span></span>
          </div>
        </section>

        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Ledger controls</p>
              <p className="mt-1 text-xs text-slate-500">Risk and settlement posture</p>
            </div>
            <ShieldCheck size={18} className="text-indigo-300" />
          </div>
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <span className="text-sm text-slate-400">Mode</span>
              <StatusPill tone="emerald"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Paper only</StatusPill>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <span className="text-sm text-slate-400">Drawdown guard</span>
              <span className="font-mono text-sm text-slate-200">10% max stake</span>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <span className="text-sm text-slate-400">History integrity</span>
              <span className="flex items-center gap-1.5 text-sm text-emerald-300"><CheckCircle2 size={14} /> SQL-backed</span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <p className="text-sm font-medium text-slate-200">Match results and bets</p>
            <p className="mt-1 text-xs text-slate-500">Match-result bets and goals bets are shown separately with final score and net result.</p>
          </div>
          <StatusPill tone="slate"><Database size={13} /> Durable ledger</StatusPill>
        </div>
        <div className="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500">Match</TableHead>
                <TableHead className="text-slate-500">Actual result</TableHead>
                <TableHead className="text-slate-500">Bet</TableHead>
                <TableHead className="text-slate-500">Odds</TableHead>
                <TableHead className="text-slate-500">Stake</TableHead>
                <TableHead className="text-slate-500">Result</TableHead>
                <TableHead className="text-right text-slate-500">Net P&L</TableHead>
                <TableHead className="text-right text-slate-500">Bankroll</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedHistory.map((bet, index) => (
                <Fragment key={bet.id}>
                {(index === 0 && matchHistory.length > 0) && <TableRow className="border-slate-800 bg-slate-950/40 hover:bg-slate-950/40"><TableCell colSpan={8} className="py-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-200">Match result bets · {matchHistory.length}</TableCell></TableRow>}
                {(index === matchHistory.length && goalsHistory.length > 0) && <TableRow className="border-slate-800 bg-slate-950/40 hover:bg-slate-950/40"><TableCell colSpan={8} className="py-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200">Goals bets · {goalsHistory.length}</TableCell></TableRow>}
                <TableRow className="border-slate-800/80 hover:bg-slate-800/25">
                  <TableCell>
                    <p className="font-medium text-slate-200">{bet.match}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span>Placed {formatDate(bet.placedAt)}</span>
                      <span className="text-indigo-200">Kick-off {bet.matchDate ? formatDate(bet.matchDate) : "—"}</span>
                    </p>
                  </TableCell>
                  <TableCell><span className="font-mono text-base text-slate-200">{bet.score}</span></TableCell>
                  <TableCell><StatusPill tone="indigo">{selectionLabel(bet.selection)}</StatusPill></TableCell>
                  <TableCell className="font-mono text-slate-300">{formatOdds(bet.marketOdds)}</TableCell>
                  <TableCell className="font-mono text-slate-300">{formatMoney(bet.stakeAmount)}</TableCell>
                  <TableCell>{bet.status === "PENDING" ? <StatusPill tone="amber">PENDING</StatusPill> : bet.outcome === "WON" ? <StatusPill tone="emerald"><ArrowUpRight size={13} /> WON</StatusPill> : <StatusPill tone="rose"><ArrowDownRight size={13} /> LOST</StatusPill>}</TableCell>
                  <TableCell className={"text-right font-mono " + (bet.status === "PENDING" ? "text-slate-500" : bet.profitLoss >= 0 ? "text-emerald-300" : "text-rose-300")}>{bet.status === "PENDING" ? "—" : (bet.profitLoss >= 0 ? "+" : "") + formatMoney(bet.profitLoss)}</TableCell>
                  <TableCell className="text-right font-mono text-slate-200">{bet.status === "PENDING" ? "—" : formatMoney(bet.runningBankroll)}</TableCell>
                </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="space-y-3 p-3 md:hidden">
          {matchHistory.length > 0 && <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-200">Match result bets · {matchHistory.length}</p>}
          {groupedHistory.map((bet, index) => (
            <Fragment key={bet.id}>
            {index === matchHistory.length && goalsHistory.length > 0 && <p className="px-1 pt-3 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200">Goals bets · {goalsHistory.length}</p>}
            <article className="rounded-xl border border-slate-800 bg-slate-950/25 p-4">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-medium text-slate-200">{bet.match}</p><p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>{bet.score}</span><span>Placed {formatDate(bet.placedAt)}</span><span className="text-indigo-200">Kick-off {bet.matchDate ? formatDate(bet.matchDate) : "—"}</span></p></div>
                {bet.status === "PENDING" ? <StatusPill tone="amber">PENDING</StatusPill> : bet.outcome === "WON" ? <StatusPill tone="emerald">WON</StatusPill> : <StatusPill tone="rose">LOST</StatusPill>}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                <div><p className="text-slate-500">Final score</p><p className="mt-1 font-mono text-slate-200">{bet.score}</p></div>
                <div><p className="text-slate-500">Bet</p><p className="mt-1 text-indigo-200">{selectionLabel(bet.selection)}</p></div>
                <div><p className="text-slate-500">Odds / stake</p><p className="mt-1 font-mono text-slate-200">{formatOdds(bet.marketOdds)} / {formatMoney(bet.stakeAmount)}</p></div>
                <div><p className="text-slate-500">Net P&L</p><p className={"mt-1 font-mono " + (bet.status === "PENDING" ? "text-slate-500" : bet.profitLoss >= 0 ? "text-emerald-300" : "text-rose-300")}>{bet.status === "PENDING" ? "—" : (bet.profitLoss >= 0 ? "+" : "") + formatMoney(bet.profitLoss)}</p></div>
              </div>
              <div className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-500">Status <span className="float-right font-mono text-slate-200">{bet.status === "PENDING" ? "Awaiting final score" : bet.outcome}</span></div>
            </article>
            </Fragment>
          ))}
        </div>
      </section>
    </div>
  );
}

function agentTone(status: string): "emerald" | "amber" | "rose" | "slate" {
  if (status === "SUCCEEDED" || status === "READY") return "emerald";
  if (status === "DEGRADED" || status === "REQUEST_MORE_DATA") return "amber";
  if (status === "BLOCKED" || status === "HALTED") return "rose";
  return "slate";
}

function AgentOpsView({
  agents,
  onBacktest,
  onOnlineCycle,
  busy,
}: {
  agents: AgentDashboard;
  onBacktest: () => void;
  onOnlineCycle: () => void;
  busy: boolean;
}) {
  const worker = agents.latest.find((run) => run.role === "WORKER");
  const manager = agents.latest.find((run) => run.role === "MANAGER");
  const latestBacktest = agents.backtests[0];
  const renderAgent = (run: AgentDashboard["latest"][number] | undefined, fallback: string) => (
    <section className="panel rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-500/15 p-2 text-indigo-300">
            {run?.role === "MANAGER" ? <BrainCircuit size={18} /> : <Bot size={18} />}
          </div>
          <div>
            <p className="text-sm font-medium text-slate-200">{run?.agentName ?? fallback}</p>
            <p className="mt-1 text-xs text-slate-500">{run?.task ?? "Awaiting the next hosted online review."}</p>
          </div>
        </div>
        <StatusPill tone={agentTone(run?.status ?? "IDLE")}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {run?.status ?? "IDLE"}
        </StatusPill>
      </div>
      <p className="mt-5 min-h-[48px] text-sm leading-6 text-slate-300">
        {run?.summary ?? "No hosted review has run yet. Use Run online review to create the first report."}
      </p>
      <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-3 text-xs">
        <span className="text-slate-500">Model profile</span>
        <span className="font-mono text-indigo-200">{run?.model ?? agents.modelProfile.label}</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-slate-500">Last online review</span>
        <span className="flex items-center gap-1.5 text-slate-300"><Clock3 size={13} /> {formatDate(run?.finishedAt ?? null)}</span>
      </div>
    </section>
  );

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Agent operations"
        title="Manager + Online AI control room"
        detail="OpenAI reviews deterministic facts; the hosted Site owns the model, risk gates, and paper ledger."
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              onClick={onOnlineCycle}
              disabled={busy}
              className="bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            >
              <Sparkles size={14} className="mr-2" />
              Run online review
            </Button>
            <Button
              size="sm"
              onClick={onBacktest}
              disabled={busy}
              className="bg-indigo-500 text-white hover:bg-indigo-400"
            >
              <ScanLine size={14} className="mr-2" />
              Run walk-forward test
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_1fr]">
        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-indigo-300">Model connection</p>
              <p className="mt-2 text-xl font-semibold text-slate-100">{agents.modelProfile.label}</p>
              <p className="mt-1 text-xs text-slate-500">
                {agents.modelProfile.exactModel ?? "Exact API model ID not configured"}
              </p>
            </div>
            <BrainCircuit size={20} className="text-indigo-300" />
          </div>
          <div className="mt-5 space-y-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-slate-500">API status</span><StatusPill tone={agents.modelProfile.apiConfigured ? "emerald" : "amber"}>{agents.modelProfile.apiConfigured ? "Configured" : "Fallback mode"}</StatusPill></div>
            <div className="flex items-center justify-between"><span className="text-slate-500">Compute location</span><span className="font-mono text-emerald-300">Hosted Site</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-500">Execution authority</span><span className="font-mono text-emerald-300">{agents.modelProfile.executionAuthority}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-500">Paper approval</span><span className="font-mono text-slate-200">Manual required</span></div>
          </div>
        </section>
        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.14em] text-emerald-300">Risk gate</p><p className="mt-2 text-xl font-semibold text-slate-100">{agents.risk.status}</p></div>{agents.risk.status === "READY" ? <ShieldCheck size={20} className="text-emerald-300" /> : <ShieldAlert size={20} className="text-rose-300" />}</div>
          <div className="mt-5 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-slate-800 bg-slate-950/25 p-2.5"><p className="text-slate-500">Open exposure</p><p className="mt-1 font-mono text-slate-200">{formatMoney(agents.risk.openExposure)} / {formatMoney(agents.risk.openExposureLimit)}</p></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/25 p-2.5"><p className="text-slate-500">Daily loss</p><p className="mt-1 font-mono text-slate-200">{formatMoney(agents.risk.dailyLoss)} / {formatMoney(agents.risk.dailyLossLimit)}</p></div>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">Agents cannot bypass the {agents.risk.maxStakePct}% single-wager cap, {agents.risk.maxFixtureExposurePct}% fixture cap, or {agents.risk.maxOpenExposurePct}% total open-exposure cap.</p>
          {agents.risk.flags.length > 0 && <p className="mt-3 text-xs text-rose-300">{agents.risk.flags.join(" · ")}</p>}
        </section>
        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.14em] text-amber-300">Evaluation</p><p className="mt-2 text-xl font-semibold text-slate-100">{latestBacktest ? latestBacktest.fixturesEvaluated + " fixtures" : "Awaiting run"}</p></div><Calculator size={20} className="text-amber-300" /></div>
          {latestBacktest ? <div className="mt-5 grid grid-cols-2 gap-2 text-xs"><div><p className="text-slate-500">Brier</p><p className="mt-1 font-mono text-slate-200">{latestBacktest.brierScore?.toFixed(4) ?? "—"}</p></div><div><p className="text-slate-500">Log loss</p><p className="mt-1 font-mono text-slate-200">{latestBacktest.logLoss?.toFixed(4) ?? "—"}</p></div><div><p className="text-slate-500">Hit rate</p><p className="mt-1 font-mono text-emerald-300">{latestBacktest.hitRate === null ? "—" : formatPct(latestBacktest.hitRate * 100)}</p></div><div><p className="text-slate-500">Tail mass</p><p className="mt-1 font-mono text-amber-200">{latestBacktest.averageTailMass === null ? "—" : formatPct(latestBacktest.averageTailMass * 100)}</p></div></div> : <p className="mt-5 text-sm leading-6 text-slate-500">Use the evaluation button to score the model without using future fixtures in the prediction.</p>}
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {renderAgent(worker, "QVM Online Analyst")}
        {renderAgent(manager, "QVM Manager")}
      </div>

      <section className="panel overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4"><div><p className="text-sm font-medium text-slate-200">Agent audit trail</p><p className="mt-1 text-xs text-slate-500">Every hosted review is timestamped in the existing D1 database.</p></div><ServerCog size={18} className="text-slate-500" /></div>
        <div className="overflow-x-auto"><Table><TableHeader><TableRow className="border-slate-800 hover:bg-transparent"><TableHead className="text-slate-500">Agent</TableHead><TableHead className="text-slate-500">Model</TableHead><TableHead className="text-slate-500">Status</TableHead><TableHead className="text-slate-500">Summary</TableHead><TableHead className="text-right text-slate-500">Completed</TableHead></TableRow></TableHeader><TableBody>{agents.history.length === 0 ? <TableRow className="border-slate-800"><TableCell colSpan={5} className="py-10 text-center text-sm text-slate-500">No hosted reports yet. Run an online review to populate this audit trail.</TableCell></TableRow> : agents.history.map((run) => <TableRow key={run.id ?? run.startedAt + run.agentName} className="border-slate-800/80"><TableCell><p className="font-medium text-slate-200">{run.agentName}</p><p className="mt-1 text-xs text-slate-500">{run.role === "WORKER" ? "ONLINE ANALYST" : run.role}</p></TableCell><TableCell className="font-mono text-xs text-indigo-200">{run.model}</TableCell><TableCell><StatusPill tone={agentTone(run.status)}>{run.status}</StatusPill></TableCell><TableCell className="max-w-[520px] text-sm text-slate-400">{run.summary ?? "—"}</TableCell><TableCell className="text-right text-xs text-slate-500">{formatDate(run.finishedAt)}</TableCell></TableRow>)}</TableBody></Table></div>
      </section>
    </div>
  );
}

function ResearchLab({ research }: { research: Research }) {
  return (
    <div className="space-y-6">
      <SectionHeading eyebrow="Model review" title="Research Lab" detail="Persistent data lineage, counterfactuals, experiments and decision replay." />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(research.counts).map(([label, value]) => <div key={label} className="panel rounded-2xl p-4"><p className="text-xs uppercase tracking-[0.12em] text-slate-500">{label.replace(/([A-Z])/g, " $1")}</p><p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p></div>)}
      </div>
      <section className="panel overflow-hidden rounded-2xl"><div className="border-b border-slate-800 px-5 py-4"><p className="text-sm font-medium text-slate-200">Decision replay</p><p className="mt-1 text-xs text-slate-500">Recommendations are reconstructed from model versions, source snapshots and deterministic checks.</p></div><div className="overflow-x-auto"><Table><TableHeader><TableRow className="border-slate-800 hover:bg-transparent"><TableHead className="text-slate-500">Decision</TableHead><TableHead className="text-slate-500">Model</TableHead><TableHead className="text-right text-slate-500">Recorded</TableHead></TableRow></TableHeader><TableBody>{research.latestReplays.length === 0 ? <TableRow className="border-slate-800"><TableCell colSpan={3} className="py-8 text-center text-sm text-slate-500">Run an online review cycle to create the first replay record.</TableCell></TableRow> : research.latestReplays.map((replay) => <TableRow key={replay.id} className="border-slate-800"><TableCell className="font-medium text-slate-200">{replay.decision}</TableCell><TableCell className="font-mono text-xs text-indigo-200">{replay.modelVersion}</TableCell><TableCell className="text-right text-xs text-slate-500">{formatDate(replay.createdAt)}</TableCell></TableRow>)}</TableBody></Table></div></section>
    </div>
  );
}

function SettingsView({ overview, research }: { overview: Overview; research: Research }) {
  const connectionItems = [
    { label: "Odds feed", value: overview.connection.oddsFeed, icon: Target },
    { label: "Data layer", value: overview.connection.database, icon: Database },
    { label: "Execution", value: overview.connection.execution, icon: Play },
    { label: "Risk engine", value: overview.connection.risk, icon: ShieldCheck },
  ];

  return (
    <div className="space-y-6">
      <SectionHeading eyebrow="Workspace configuration" title="Settings" detail="Sources, diagnostics, research services and hosted runtime readiness in one place." />
      <OnlineDataQuality research={research} />

      <section className="panel rounded-2xl p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-200">Connection posture</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">A compact view of the services that protect the paper-trading workflow.</p>
          </div>
          <StatusPill tone={overview.risk.status === "READY" ? "emerald" : "rose"}>
            {overview.risk.status === "READY" ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
            {overview.risk.status === "READY" ? "All guardrails ready" : "Review risk gate"}
          </StatusPill>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {connectionItems.map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex items-center justify-between gap-2"><p className="text-xs uppercase tracking-[0.12em] text-slate-500">{label}</p><Icon size={16} className="text-indigo-300" /></div>
              <p className="mt-3 text-sm font-semibold text-slate-100">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-200">Paper risk policy</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Hard limits applied by the hosted paper ledger and every online review.</p>
          </div>
          <ShieldCheck size={18} className="text-emerald-300" />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4"><p className="text-xs uppercase tracking-[0.12em] text-slate-500">Maximum single stake</p><p className="mt-2 font-mono text-xl font-semibold text-indigo-200">{overview.risk.maxStakePct}%</p><p className="mt-1 text-xs text-slate-600">of current bankroll</p></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4"><p className="text-xs uppercase tracking-[0.12em] text-slate-500">Maximum open exposure</p><p className="mt-2 font-mono text-xl font-semibold text-indigo-200">{overview.risk.maxOpenExposurePct}%</p><p className="mt-1 text-xs text-slate-600">across pending bets</p></div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4"><p className="text-xs uppercase tracking-[0.12em] text-slate-500">Maximum per fixture</p><p className="mt-2 font-mono text-xl font-semibold text-indigo-200">{overview.risk.maxFixtureExposurePct}%</p><p className="mt-1 text-xs text-slate-600">across one match</p></div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <section className="panel rounded-2xl p-5">
          <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-200">Decision quality infrastructure</p><p className="mt-1 text-xs leading-5 text-slate-500">Research controls remain visible here without competing with live opportunity review.</p></div><Gauge size={18} className="text-amber-300" /></div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(research.counts).map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3"><p className="text-[11px] uppercase tracking-[0.1em] text-slate-500">{label.replace(/([A-Z])/g, " $1")}</p><p className="mt-1 text-lg font-semibold text-slate-100">{value}</p></div>)}
          </div>
        </section>

        <section className="panel rounded-2xl p-5">
          <div className="flex items-center justify-between"><div><p className="text-sm font-medium text-slate-200">Hosted runtime health</p><p className="mt-1 text-xs text-slate-500">Online review cycles and heartbeat status.</p></div><Activity size={17} className="text-indigo-300" /></div>
          {research.heartbeats.length === 0 ? <p className="mt-5 text-sm text-slate-500">No online review recorded yet.</p> : research.heartbeats.map((heartbeat) => <div key={heartbeat.workerName} className="mt-4 flex items-center justify-between gap-3 border-b border-slate-800 pb-3 text-sm"><div><p className="text-slate-300">Hosted QVM runtime</p><p className="mt-1 text-xs text-slate-500">{heartbeat.cyclesCompleted} cycle{heartbeat.cyclesCompleted === 1 ? "" : "s"} · {formatDate(heartbeat.lastFinishedAt)}</p></div><StatusPill tone={heartbeat.status === "READY" ? "emerald" : "amber"}>{heartbeat.status}</StatusPill></div>)}
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
        <section className="panel rounded-2xl p-5">
          <p className="text-sm font-medium text-slate-200">Enabled research capabilities</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">{research.capabilities.map((capability) => <div key={capability} className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2 text-sm text-slate-300"><CheckCircle2 size={14} className="mr-2 inline text-emerald-300" />{capability}</div>)}</div>
        </section>
        <section className="panel overflow-hidden rounded-2xl">
          <div className="border-b border-slate-800 px-5 py-4"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium text-slate-200">Recent system logs</p><p className="mt-1 text-xs text-slate-500">Latest API polls, scans and settlement activity.</p></div><ServerCog size={17} className="text-slate-500" /></div></div>
          <div className="max-h-[360px] overflow-y-auto scrollbar-thin">{overview.logs.length === 0 ? <p className="px-5 py-8 text-sm text-slate-500">No system logs recorded yet.</p> : overview.logs.map((log) => <div key={log.id} className="border-b border-slate-800/80 px-5 py-3 last:border-b-0"><div className="flex items-start justify-between gap-3"><p className="text-sm text-slate-300">{log.message}</p><StatusPill tone={log.level === "ERROR" ? "rose" : log.level === "WARN" ? "amber" : "slate"}>{log.level}</StatusPill></div><p className="mt-1 text-[11px] text-slate-600">{formatDate(log.createdAt)}{log.context ? " · " + log.context : ""}</p></div>)}</div>
        </section>
      </div>
    </div>
  );
}

function OnlineDataQuality({ research }: { research: Research }) {
  return (
    <section className="panel mb-5 rounded-2xl p-4 sm:p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-sm font-semibold text-slate-100">Online data quality</p><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">Live odds and football-data.org fixtures/results are refreshed together; Sportmonks supplies lineups, injuries, xG and match features.</p></div>
        <StatusPill tone="indigo"><Database size={13} /> {research.sourceHealth?.length ?? 0} sources monitored</StatusPill>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(research.sourceHealth ?? []).map((source) => <div key={source.source} className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/30 p-4"><div className="flex items-center justify-between gap-2"><p className="min-w-0 truncate text-sm text-slate-200">{source.source}</p><StatusPill tone={source.status === "READY" ? "emerald" : source.status === "ERROR" ? "rose" : "amber"}>{source.status}</StatusPill></div><p className="mt-2 text-xs text-slate-500">{source.recordsUpdated} records · {formatDate(source.lastSuccessAt)}</p>{source.message && <p className="mt-2 break-words text-xs leading-5 text-amber-200/80">{source.message}</p>}</div>)}
        {(research.sourceHealth ?? []).length === 0 && <p className="text-sm text-slate-500">No external source health records yet. Refresh the odds feed or lineups to initialise them.</p>}
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="panel flex min-h-[420px] flex-col items-center justify-center rounded-2xl">
      <RefreshCw size={24} className="animate-spin text-indigo-300" />
      <p className="mt-4 text-sm font-medium text-slate-200">Loading QVM state</p>
      <p className="mt-1 text-xs text-slate-500">Preparing the seeded paper book…</p>
    </div>
  );
}

type ChatMessage = { role: "user" | "assistant"; content: string };

function MarkdownInline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  return <>{parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-xs text-indigo-200">{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  })}</>;
}

function LunaMessage({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line.startsWith("|") && line.endsWith("|")) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|") && lines[index].trim().endsWith("|")) tableLines.push(lines[index++].trim());
      const rows = tableLines.filter((row) => !/^\|?\s*:?-{3,}/.test(row)).map((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()));
      if (rows.length > 0) blocks.push(<div key={`table-${index}`} className="my-2 overflow-hidden rounded-lg border border-slate-700/80"><table className="w-full table-fixed text-left text-[11px]"><thead className="bg-slate-900/80 text-slate-400"><tr>{rows[0].map((cell, cellIndex) => <th key={cellIndex} className="break-words px-2 py-1.5 font-medium"> <MarkdownInline text={cell} /></th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex} className="border-t border-slate-800/80"><>{row.map((cell, cellIndex) => <td key={cellIndex} className="break-words px-2 py-1.5 align-top text-slate-300"><MarkdownInline text={cell} /></td>)}</></tr>)}</tbody></table></div>);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      blocks.push(<p key={`heading-${index}`} className="mt-2 font-semibold text-slate-100"><MarkdownInline text={line.replace(/^#{1,4}\s+/, "")} /></p>);
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push(<div key={`bullet-${index}`} className="flex gap-2"><span className="text-indigo-300">•</span><span><MarkdownInline text={line.replace(/^[-*]\s+/, "")} /></span></div>);
    } else {
      blocks.push(<p key={`paragraph-${index}`}><MarkdownInline text={line} /></p>);
    }
    index += 1;
  }
  return <div className="space-y-2">{blocks}</div>;
}

function LunaAssistant({ activeSection, onPaperBet }: { activeSection: View; onPaperBet: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask about markets, model metrics, risk, or paper positions.",
    },
  ]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/qvm/chat", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, activeSection }),
        signal: AbortSignal.timeout(qvmTimeoutMs("ai")),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(String(payload.error ?? "Luna could not answer."));
      setMessages((current) => [...current, { role: "assistant", content: String(payload.answer) }]);
      if (payload.paperBet) await onPaperBet();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Luna could not answer.");
    } finally {
      setBusy(false);
    }
  }

  const quickPrompts = [
    "Why is this a no-bet?",
    "Explain my current risk.",
    "How do I read robust edge?",
  ];

  return (
    <div className="fixed bottom-4 right-4 z-30 sm:bottom-6 sm:right-6">
      {open && (
        <section
          aria-label="Luna QVM assistant"
          className="mb-3 flex h-[min(620px,calc(100vh-6rem))] w-[min(410px,calc(100vw-2rem))] min-w-0 flex-col overflow-hidden rounded-2xl border border-indigo-400/20 bg-[#0a1729]/[.98] shadow-2xl shadow-black/40 backdrop-blur-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-200"><Sparkles size={17} /></span>
              <p className="text-sm font-semibold text-slate-100">Luna assistant</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Close Luna assistant" onClick={() => setOpen(false)} className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"><X size={17} /></Button>
          </div>
          <div className="min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-4 py-4" aria-live="polite">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={(message.role === "user" ? "ml-8 rounded-xl rounded-br-sm bg-indigo-500/15 px-3 py-2.5 text-sm text-indigo-100" : "mr-4 rounded-xl rounded-bl-sm border border-slate-800 bg-slate-950/45 px-3 py-2.5 text-sm leading-6 text-slate-300") + " break-words"}>
                {message.role === "assistant" ? <LunaMessage content={message.content} /> : message.content}
              </div>
            ))}
            {busy && <div className="mr-12 rounded-xl border border-slate-800 bg-slate-950/45 px-3 py-2.5 text-sm text-slate-500">Luna is reviewing the current QVM context…</div>}
            {error && <div role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2.5 text-xs leading-5 text-rose-200">{error}</div>}
          </div>
          <div className="border-t border-slate-800 px-3 py-3">
            <div className="mb-2 flex flex-wrap gap-1.5 pb-1">
              {quickPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => setDraft(prompt)} className="shrink-0 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-indigo-400/40 hover:text-indigo-200">{prompt}</button>)}
            </div>
            <form onSubmit={submit} className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
                rows={2}
                maxLength={2000}
                aria-label="Ask Luna a question"
                placeholder="Ask about a market, model metric, or control…"
                className="min-h-[48px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400/60"
              />
              <Button type="submit" size="icon" aria-label="Send question to Luna" disabled={busy || !draft.trim()} className="h-11 w-11 shrink-0 bg-indigo-500 text-white hover:bg-indigo-400 disabled:opacity-40"><Send size={16} /></Button>
            </form>
          </div>
        </section>
      )}
      {!open && <Button onClick={() => setOpen(true)} aria-label="Open Luna QVM assistant" className="h-12 rounded-full bg-indigo-500 px-4 text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-400"><MessageCircle size={17} /><span className="ml-2 hidden sm:inline">Ask Luna</span></Button>}
    </div>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<View>("overview");
  const [activeLeague, setActiveLeague] = useState<string>("all");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [markets, setMarkets] = useState<MarketsPayload | null>(null);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [agents, setAgents] = useState<AgentDashboard | null>(null);
  const [research, setResearch] = useState<Research | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const staleRefreshAttempted = useRef(false);

  const loadAll = useCallback(async () => {
    setError(null);
    async function fetchJson(path: string) {
      const response = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(qvmTimeoutMs("dataLoad")) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error ?? `Unable to load ${path}.`));
      return payload;
    }
    const payloads = await Promise.all([
      fetchJson("/api/qvm/overview"),
      fetchJson("/api/qvm/markets"),
      fetchJson("/api/qvm/performance"),
      fetchJson("/api/qvm/agents"),
      fetchJson("/api/qvm/research"),
    ]);
    const failed = payloads.find((payload) => payload.error);
    if (failed) throw new Error(String(failed.error));
    setOverview(payloads[0] as Overview);
    setMarkets(payloads[1] as MarketsPayload);
    setPerformance(payloads[2] as Performance);
    setAgents(payloads[3] as AgentDashboard);
    setResearch(payloads[4] as Research);
  }, []);

  useEffect(() => {
    // The async loader intentionally owns the initial request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll()
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load QVM state."))
      .finally(() => setLoading(false));
  }, [loadAll]);

  useEffect(() => {
    if (loading || busy || !markets || staleRefreshAttempted.current) return;
    const staleCount = markets.markets.filter((market) => market.isStale).length;
    if (staleCount === 0) return;
    staleRefreshAttempted.current = true;
    void (async () => {
      setBusy(true);
      setNotice(`Refreshing ${staleCount} stale market quote${staleCount === 1 ? "" : "s"} before paper review…`);
      try {
        const response = await fetch("/api/qvm/refresh", {
          method: "POST",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(qvmTimeoutMs("action")),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.error) throw new Error(String(payload.error ?? "The live quote refresh failed."));
        await loadAll();
        const updated = Number((payload.odds as { updated?: unknown } | null | undefined)?.updated ?? 0);
        setNotice(`Live quote feed refreshed: ${updated} market${updated === 1 ? "" : "s"} updated.`);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "TimeoutError") {
          setNotice("The live quote refresh timed out. Review source status before placing paper.");
        } else {
          setNotice(reason instanceof Error ? reason.message : "The live quote refresh failed.");
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, loadAll, loading, markets]);

  async function runAction(
    path: string,
    body?: Record<string, unknown>,
    successMessage?: string,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(qvmTimeoutMs("action")),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(String(payload.error ?? "Action failed."));
      await loadAll();
      const fixtureSync = payload.fixtures as { updated?: number; status?: string } | null | undefined;
      const oddsSync = payload.odds as { updated?: number; status?: string } | null | undefined;
      const enrichmentSync = payload.enrichment as {
        updated?: number;
        status?: string;
        message?: string | null;
        fixturesMatched?: number;
        lineupFixtures?: number;
        injuryRecords?: number;
      } | null | undefined;
      if (fixtureSync || oddsSync) {
        const fixtureCount = fixtureSync?.updated ?? 0;
        const oddsCount = oddsSync?.updated ?? 0;
        const lineupSummary = enrichmentSync?.status === "NOT_CONFIGURED"
          ? "Sportmonks not configured"
          : enrichmentSync?.message
            ? enrichmentSync.message
            : `Sportmonks ${enrichmentSync?.updated ?? 0} enrichment record${enrichmentSync?.updated === 1 ? "" : "s"}`;
        const sourceSummary = `Live data synchronised: football-data.org ${fixtureCount} fixture${fixtureCount === 1 ? "" : "s"}; The Odds API ${oddsCount} market${oddsCount === 1 ? "" : "s"}; ${lineupSummary}`;
        setNotice(payload.status === "PARTIAL" ? `${sourceSummary} Review source status in Settings.` : sourceSummary);
      } else if (payload.source === "Sportmonks") {
        const message = String(payload.message ?? "Football enrichment completed.");
        setNotice(payload.status === "PARTIAL" ? `${message} Review source status in Settings.` : message);
      } else if (Array.isArray(payload.created)) {
        setNotice(payload.blocked ? "Paper scan blocked by the risk gate." : `Paper scan completed: ${payload.created.length} new paper position${payload.created.length === 1 ? "" : "s"}.`);
      } else if (payload.bet?.stakeAmount) {
        setNotice(`Paper position created: ${formatMoney(Number(payload.bet.stakeAmount))} stake.`);
      } else if (payload.settlement || Array.isArray(payload.sources)) {
        const settlementCount = Number(payload.settlement?.settledCount ?? 0);
        const waitingCount = Number(payload.settlement?.pastKickoffWithoutResult ?? 0);
        const sourceErrors = (payload.sources as Array<{ source?: string; error?: string }> | undefined)
          ?.filter((source) => source.error)
          .map((source) => `${source.source}: ${source.error}`) ?? [];
        const suffix = sourceErrors.length ? ` ${sourceErrors.join(" · ")}` : "";
        const waiting = waitingCount > 0
          ? ` ${waitingCount} past-kickoff position${waitingCount === 1 ? " is" : "s are"} still waiting for a full-time score from a provider.`
          : "";
        setNotice(`Results sync completed: ${settlementCount} paper position${settlementCount === 1 ? "" : "s"} settled.${waiting}${suffix}`);
      } else {
        setNotice(successMessage ?? "Action completed.");
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "TimeoutError") {
        setNotice("The data action timed out. Check the source status and try again.");
      } else if (reason instanceof TypeError) {
        setNotice("The data action could not reach the server. Check your connection and try again.");
      } else {
        setNotice(reason instanceof Error ? reason.message : "Action failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  const currentTitle = useMemo(
    () => navItems.find((item) => item.value === activeTab)?.label ?? "Overview",
    [activeTab],
  );

  return (
    <>
    <Tabs
      value={activeTab}
      onValueChange={(value) => { setActiveTab(value as View); setSidebarOpen(false); }}
      className="min-h-screen lg:!flex-row"
    >
      <aside className="hidden border-r border-slate-800/80 bg-[#091626]/95 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[248px] lg:shrink-0 lg:flex-col">
        <WorkspaceNavigation />
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
          <button aria-label="Close navigation" className="absolute inset-0 cursor-default bg-slate-950/70 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <aside aria-label="Mobile navigation" className="relative h-full w-[min(88vw,360px)] overflow-y-auto border-r border-slate-700/80 bg-[#091626] shadow-2xl shadow-black/50">
            <div className="flex items-center justify-end px-4 pt-4">
              <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} className="h-10 w-10 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-slate-100"><X size={20} /></Button>
            </div>
            <WorkspaceNavigation mobile onNavigate={() => setSidebarOpen(false)} />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1">
        <header className="border-b border-slate-800/80 bg-[#07111f] px-4 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1380px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <Button variant="outline" size="icon" aria-label="Open navigation" onClick={() => setSidebarOpen(true)} className="mb-3 h-10 w-10 rounded-xl border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800 lg:hidden"><Menu size={19} /></Button>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Private trading terminal</p>
              <h1 className="mt-1 text-lg font-semibold text-slate-100">{currentTitle}</h1>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              {overview && <span className="hidden text-xs text-slate-500 lg:inline">Updated {formatDate(overview.lastRefresh)}</span>}
              <div className="flex flex-wrap items-center justify-end gap-1 rounded-xl border border-slate-800 bg-slate-950/35 p-1">
                <span className="sr-only">Quick controls</span>
                <Button size="icon" aria-label="Refresh live data" title="Refresh live odds, fixtures, results and lineups" onClick={() => runAction("/api/qvm/refresh")} disabled={busy} className="h-8 w-8 rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400"><RefreshCw size={15} className={busy ? "animate-spin" : ""} /></Button>
                <Button size="icon" aria-label="Run paper scan" title="Run paper scan" onClick={() => runAction("/api/qvm/scan")} disabled={busy} className="h-8 w-8 rounded-lg bg-indigo-500 text-white hover:bg-indigo-400"><Zap size={15} /></Button>
                <Button size="icon" variant="outline" aria-label="Refresh football enrichment" title="Refresh Sportmonks lineups, injuries and xG" onClick={() => runAction("/api/qvm/enrich", undefined, "Sportmonks enrichment completed.")} disabled={busy} className="h-8 w-8 rounded-lg border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"><RefreshCw size={15} /></Button>
              <Button size="icon" variant="outline" aria-label="Sync results and settle bets" title="Sync football results and settle bets" onClick={() => runAction("/api/qvm/results", undefined, "Results synchronised and bets settled.")} disabled={busy} className="h-8 w-8 rounded-lg border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"><CheckCircle2 size={15} /></Button>
                <Button size="icon" variant="outline" aria-label="Sync results" title="Sync football results and settle bets" onClick={() => runAction("/api/qvm/results", undefined, "Results synchronised and bets settled.")} disabled={busy} className="h-8 w-8 rounded-lg border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800"><ListChecks size={15} /></Button>
                <Button size="icon" variant="outline" aria-label="Reset paper book" title="Reset paper book" onClick={() => { if (window.confirm("Reset the paper book, remove previous paper bets and scheduled fixtures, and restore €1,000?")) runAction("/api/qvm/reset", undefined, "Paper book reset. Refresh live data to load today’s games."); }} disabled={busy} className="h-8 w-8 rounded-lg border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"><X size={15} /></Button>
              </div>
              <StatusPill tone="emerald"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /><span className="hidden sm:inline">Paper mode</span><span className="sr-only">Paper mode</span></StatusPill>
            </div>
          </div>
        </header>

        <div className="terminal-grid px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[1380px]">
            {notice && (
              <div role="status" aria-live="polite" className="mb-5 flex items-center gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
                <Sparkles size={15} className="shrink-0 text-indigo-300" />
                {notice}
              </div>
            )}
            <div role="tablist" aria-label="Football competitions" className="mb-6 flex max-w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {leagueTabs.map((league) => (
                <button key={league.key} type="button" role="tab" aria-selected={activeLeague === league.key} onClick={() => setActiveLeague(league.key)} className={`shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium transition ${activeLeague === league.key ? "border-indigo-400/40 bg-indigo-500/15 text-indigo-100 shadow-[0_0_20px_rgba(99,102,241,0.12)]" : "border-slate-800 bg-slate-950/30 text-slate-500 hover:border-slate-700 hover:text-slate-200"}`}>{league.label}</button>
              ))}
            </div>
            {loading ? (
              <LoadingState />
            ) : error ? (
              <div role="alert" className="panel flex min-h-[420px] flex-col items-center justify-center rounded-2xl p-6 text-center">
                <CircleAlert size={28} className="text-rose-300" />
                <p className="mt-4 text-sm font-medium text-slate-100">QVM data is unavailable</p>
                <p className="mt-2 max-w-md text-xs leading-5 text-slate-500">{error}</p>
                <Button size="sm" onClick={() => { setLoading(true); loadAll().catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load state.")).finally(() => setLoading(false)); }} className="mt-5 bg-indigo-500 text-white hover:bg-indigo-400">Retry</Button>
              </div>
            ) : (
              <>
                <TabsContent value="overview" className="mt-0">
                  {overview && <OverviewView overview={overview} onScan={() => runAction("/api/qvm/scan", undefined, "Edge scan completed.")} onRefresh={() => runAction("/api/qvm/sync-today", undefined, "Today’s fixtures, odds and predictions synchronised.")} busy={busy} />}
                </TabsContent>
                <TabsContent value="edge" className="mt-0">
                  {markets && overview && <EdgeFinderView markets={markets} model={overview.model} activeLeague={activeLeague} placedTrades={overview.activeTrades} onScan={() => runAction("/api/qvm/scan")} onPlace={(fixtureId, selection, stakeAmount) => runAction("/api/qvm/bets", { fixtureId, selection, stakeAmount }, "Paper position created.")} busy={busy} />}
                </TabsContent>
                <TabsContent value="performance" className="mt-0">
                  {performance && <PerformanceView performance={performance} activeLeague={activeLeague} onSettle={() => runAction("/api/qvm/results", undefined, "Results synchronised and bets settled.")} busy={busy} />}
                </TabsContent>
                <TabsContent value="agents" className="mt-0">
                  {agents && <AgentOpsView agents={agents} onOnlineCycle={() => runAction("/api/qvm/online-cycle", undefined, "Hosted online review completed.")} onBacktest={() => runAction("/api/qvm/backtest", undefined, "Walk-forward evaluation completed.")} busy={busy} />}
                </TabsContent>
                <TabsContent value="research" className="mt-0">
                  {research && <ResearchLab research={research} />}
                </TabsContent>
                <TabsContent value="settings" className="mt-0">
                  {overview && research && <SettingsView overview={overview} research={research} />}
                </TabsContent>
              </>
            )}
          </div>
        </div>
      </main>
    </Tabs>
    <LunaAssistant activeSection={activeTab} onPaperBet={loadAll} />
    </>
  );
}
