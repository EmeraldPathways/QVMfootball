import { desc, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  appMeta,
  fixtures,
  marketQuotes,
  modelRuns,
  predictions,
  simulatedBets,
  systemLogs,
  teamStats,
  teams,
  userPortfolios,
  calibrationBuckets,
  dataSnapshots,
  decisionReplays,
  experimentRuns,
  players,
  portfolioScenarios,
  workerHeartbeats,
  fixtureFeatures,
  availabilitySnapshots,
  dataSourceHealth,
  marketLines,
} from "../db/schema";

const SEED_KEY = "qvm_seed_v1";
const EDGE_THRESHOLD = 0.03;
const MAX_STAKE_PCT = 0.10;
const MAX_OPEN_EXPOSURE_PCT = 0.60;
const MAX_DAILY_LOSS_PCT = 0.05;
const MAX_FIXTURE_EXPOSURE_PCT = 0.10;
const MAX_QUOTE_AGE_SECONDS = 15 * 60;
const MODEL_VERSION = "dixon-coles-dynamic-v3";
const API_FOOTBALL_LEAGUE_ID = 39;
const API_FOOTBALL_LOOKAHEAD_DAYS = 7;
const API_FOOTBALL_LINEUP_WINDOW_HOURS = 48;
const API_FOOTBALL_MAX_DETAIL_FIXTURES = 4;
const FOOTBALL_DATA_LOOKBACK_DAYS = 7;
const FOOTBALL_DATA_LOOKAHEAD_DAYS = 7;

export const LEAGUE_CONFIGS = [
  { key: "epl", name: "Premier League", oddsSport: "soccer_epl" },
  { key: "bundesliga", name: "Bundesliga", oddsSport: "soccer_germany_bundesliga" },
  { key: "la_liga", name: "La Liga", oddsSport: "soccer_spain_la_liga" },
  { key: "serie_a", name: "Serie A", oddsSport: "soccer_italy_serie_a" },
] as const;

type QvmDb = Awaited<ReturnType<typeof import("../db").getDb>>;
type FixtureRow = typeof fixtures.$inferSelect;
type PredictionRow = typeof predictions.$inferSelect;
type QuoteRow = typeof marketQuotes.$inferSelect;
type BetRow = typeof simulatedBets.$inferSelect;

export type Selection = "HOME" | "DRAW" | "AWAY";

export type MatchProbabilities = {
  lambdaHome: number;
  lambdaAway: number;
  probabilityMatrix: number[][];
  trueHomeProb: number;
  trueDrawProb: number;
  trueAwayProb: number;
  fairHomeOdds: number;
  fairDrawOdds: number;
  fairAwayOdds: number;
  gridMass: number;
  tailMass: number;
  gridSize: number;
  modelVersion: string;
};

export type GoalMarketEvaluation = {
  marketType: "TOTALS" | "BTTS" | "TEAM_TOTALS";
  selection: string;
  line: number | null;
  fairOdds: number;
  trueProb: number;
  marketOdds: number | null;
  edgePct: number | null;
  action: "BET" | "NO_BET";
};

type MarketEvaluation = {
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
  dataQualityScore?: number;
  qualityReasons?: string[];
};

const SEED_TEAMS = [
  "Arsenal",
  "Chelsea",
  "Liverpool",
  "Manchester City",
  "Newcastle United",
  "Tottenham Hotspur",
  "Brighton",
  "Aston Villa",
  "West Ham United",
  "Everton",
];

function isoAt(dayOffset: number, hour: number) {
  const value = new Date();
  value.setDate(value.getDate() + dayOffset);
  value.setHours(hour, 0, 0, 0);
  return value.toISOString();
}

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const TEAM_ALIASES: Record<string, string> = {
  mancity: "manchestercity",
  manchesterutd: "manchesterunited",
  manunited: "manchesterunited",
  manchesterunited: "manchesterunited",
  spurs: "tottenhamhotspur",
  tottenham: "tottenhamhotspur",
  brightonandhovealbion: "brighton",
  brightonhovealbion: "brighton",
  afcbournemouth: "bournemouth",
  bournemouth: "bournemouth",
  westham: "westhamunited",
  newcastle: "newcastleunited",
  nottmforest: "nottinghamforest",
  wolves: "wolverhamptonwanderers",
  wolverhampton: "wolverhamptonwanderers",
};

function normaliseName(name: string) {
  const compact = name
    .toLowerCase()
    .replace(/football club|fc/g, "")
    .replace(/[^a-z0-9]/g, "");
  return TEAM_ALIASES[compact] ?? compact;
}

function poissonPmf(goals: number, lambda: number) {
  if (lambda === 0) return goals === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return Math.exp(-lambda) * lambda ** goals / factorial;
}

function dixonColesTau(homeGoals: number, awayGoals: number, lambdaHome: number, lambdaAway: number) {
  // Low-score dependence correction from Dixon–Coles. The correction is
  // intentionally conservative and is renormalised with the full grid below.
  const rho = -0.08;
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function fairOdds(probability: number) {
  return 1 / Math.max(probability, 0.000001);
}

function safeStrength(total: number, games: number, leagueAverage: number) {
  if (games <= 0 || leagueAverage <= 0) return 1;
  return (total / games) / leagueAverage;
}

function outcomeProbability(prediction: PredictionRow, selection: Selection) {
  if (selection === "HOME") return prediction.trueHomeProb;
  if (selection === "DRAW") return prediction.trueDrawProb;
  return prediction.trueAwayProb;
}

function outcomeFairOdds(prediction: PredictionRow, selection: Selection) {
  if (selection === "HOME") return prediction.fairHomeOdds;
  if (selection === "DRAW") return prediction.fairDrawOdds;
  return prediction.fairAwayOdds;
}

function outcomeMarketOdds(quote: QuoteRow, selection: Selection) {
  if (selection === "HOME") return quote.homeOdds;
  if (selection === "DRAW") return quote.drawOdds;
  return quote.awayOdds;
}

function outcomeConsensusProbability(quote: QuoteRow, selection: Selection) {
  if (selection === "HOME") return quote.consensusHomeProb ?? 1 / quote.homeOdds;
  if (selection === "DRAW") return quote.consensusDrawProb ?? 1 / quote.drawOdds;
  return quote.consensusAwayProb ?? 1 / quote.awayOdds;
}

function calculateStake(bankroll: number, trueProb: number, liveOdds: number) {
  if (liveOdds <= 1 || bankroll <= 0) return 0;
  const kellyF = ((trueProb * liveOdds) - 1) / (liveOdds - 1);
  const quarterKellyF = Math.max(0, kellyF / 4);
  return Math.min(bankroll * quarterKellyF, bankroll * MAX_STAKE_PCT);
}

function dataQualityScore(quote: QuoteRow, prediction: PredictionRow) {
  const age = quoteAgeSeconds(quote.capturedAt);
  let score = 35;
  score += Math.min(25, (quote.bookmakerCount ?? 1) * 5);
  if ((quote.overround ?? 1) < 0.15) score += 10;
  if (age <= MAX_QUOTE_AGE_SECONDS) score += 15;
  if ((prediction.tailMass ?? 1) <= 0.02) score += 10;
  return { score: Math.min(100, score), reasons: [
    ...(age > MAX_QUOTE_AGE_SECONDS ? ["STALE_QUOTE"] : []),
    ...((prediction.tailMass ?? 1) > 0.02 ? ["HIGH_SCORE_GRID_TAIL"] : []),
  ] };
}

function quoteAgeSeconds(capturedAt: string) {
  const timestamp = Date.parse(capturedAt);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - timestamp) / 1000);
}

function isStaleQuote(capturedAt: string) {
  return quoteAgeSeconds(capturedAt) > MAX_QUOTE_AGE_SECONDS;
}

function devigProbabilities(homeOdds: number, drawOdds: number, awayOdds: number) {
  const raw = [1 / homeOdds, 1 / drawOdds, 1 / awayOdds];
  const total = raw.reduce((sum, value) => sum + value, 0);
  return {
    home: raw[0] / total,
    draw: raw[1] / total,
    away: raw[2] / total,
    overround: total - 1,
  };
}

async function updateSourceHealth(db: QvmDb, source: string, status: string, recordsUpdated: number, message?: string) {
  const now = new Date().toISOString();
  await db.insert(dataSourceHealth).values({
    source,
    status,
    lastSuccessAt: status === "READY" ? now : null,
    lastAttemptAt: now,
    recordsUpdated,
    message: message?.slice(0, 500) ?? null,
  }).onConflictDoUpdate({
    target: dataSourceHealth.source,
    set: {
      status,
      lastSuccessAt: status === "READY" ? now : undefined,
      lastAttemptAt: now,
      recordsUpdated,
      message: message?.slice(0, 500) ?? null,
    },
  }).run();
}

export async function logEvent(
  db: QvmDb,
  message: string,
  level = "INFO",
  context?: string,
) {
  await db.insert(systemLogs).values({ message, level, context }).run();
}

async function getTeamRows(db: QvmDb) {
  return db.select().from(teams).orderBy(teams.name);
}

async function getFixtureRows(db: QvmDb) {
  return db.select().from(fixtures).orderBy(fixtures.matchDate);
}

async function getPredictionRows(db: QvmDb) {
  return db.select().from(predictions);
}

async function getLatestQuoteMap(db: QvmDb) {
  const rows = await db
    .select()
    .from(marketQuotes)
    .orderBy(desc(marketQuotes.capturedAt), desc(marketQuotes.id));
  const map = new Map<number, QuoteRow>();
  for (const row of rows) {
    if (!map.has(row.fixtureId)) map.set(row.fixtureId, row);
  }
  return map;
}

async function getPortfolio(db: QvmDb) {
  const rows = await db.select().from(userPortfolios).limit(1);
  if (rows[0]) return rows[0];
  const [created] = await db
    .insert(userPortfolios)
    .values({ currentBankroll: 1000, initialBankroll: 1000 })
    .returning();
  return created;
}

export async function updateTeamStrengths(db: QvmDb) {
  const completed = (await getFixtureRows(db)).filter(
    (fixture) =>
      fixture.status === "COMPLETED" &&
      fixture.homeGoals !== null &&
      fixture.awayGoals !== null,
  );
  const teamsRows = await getTeamRows(db);
  const totalHomeGoals = completed.reduce(
    (sum, fixture) => sum + (fixture.homeGoals ?? 0),
    0,
  );
  const totalAwayGoals = completed.reduce(
    (sum, fixture) => sum + (fixture.awayGoals ?? 0),
    0,
  );
  const leagueAvgGoalsHome =
    completed.length > 0 ? totalHomeGoals / completed.length : 1.8;
  const leagueAvgGoalsAway =
    completed.length > 0 ? totalAwayGoals / completed.length : 1.2;
  const aggregate = new Map<
    number,
    {
      homeGames: number;
      awayGames: number;
      weightedHomeGames: number;
      weightedAwayGames: number;
      goalsScoredHome: number;
      goalsConcededHome: number;
      goalsScoredAway: number;
      goalsConcededAway: number;
    }
  >();
  const statWrites = [];
  for (const team of teamsRows) {
    aggregate.set(team.id, {
      homeGames: 0,
      awayGames: 0,
      weightedHomeGames: 0,
      weightedAwayGames: 0,
      goalsScoredHome: 0,
      goalsConcededHome: 0,
      goalsScoredAway: 0,
      goalsConcededAway: 0,
    });
  }
  for (const fixture of completed) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(fixture.matchDate)) / 86_400_000);
    const weight = Math.max(0.35, Math.exp(-ageDays / 180));
    const home = aggregate.get(fixture.homeTeamId);
    const away = aggregate.get(fixture.awayTeamId);
    if (home) {
      home.homeGames += 1;
      home.weightedHomeGames += weight;
      home.goalsScoredHome += (fixture.homeGoals ?? 0) * weight;
      home.goalsConcededHome += (fixture.awayGoals ?? 0) * weight;
    }
    if (away) {
      away.awayGames += 1;
      away.weightedAwayGames += weight;
      away.goalsScoredAway += (fixture.awayGoals ?? 0) * weight;
      away.goalsConcededAway += (fixture.homeGoals ?? 0) * weight;
    }
  }
  for (const team of teamsRows) {
    const value = aggregate.get(team.id);
    if (!value) continue;
    const metrics = {
      matchesPlayed: value.homeGames + value.awayGames,
      goalsScoredHome: value.goalsScoredHome,
      goalsConcededHome: value.goalsConcededHome,
      goalsScoredAway: value.goalsScoredAway,
      goalsConcededAway: value.goalsConcededAway,
      attackStrengthHome: round(
        safeStrength(value.goalsScoredHome, value.weightedHomeGames, leagueAvgGoalsHome),
      ),
      defenseStrengthHome: round(
        safeStrength(value.goalsConcededHome, value.weightedHomeGames, leagueAvgGoalsAway),
      ),
      attackStrengthAway: round(
        safeStrength(value.goalsScoredAway, value.weightedAwayGames, leagueAvgGoalsAway),
      ),
      defenseStrengthAway: round(
        safeStrength(value.goalsConcededAway, value.weightedAwayGames, leagueAvgGoalsHome),
      ),
      updatedAt: new Date().toISOString(),
    };
    statWrites.push(db
      .insert(teamStats)
      .values({ teamId: team.id, ...metrics })
      .onConflictDoUpdate({
        target: teamStats.teamId,
        set: metrics,
      }));
  }
  if (statWrites.length > 0) await db.batch(statWrites);
  return {
    leagueAvgGoalsHome: round(leagueAvgGoalsHome, 3),
    leagueAvgGoalsAway: round(leagueAvgGoalsAway, 3),
    completedFixtures: completed.length,
  };
}

async function getLeagueAverages(db: QvmDb) {
  const completed = (await getFixtureRows(db)).filter(
    (fixture) =>
      fixture.status === "COMPLETED" &&
      fixture.homeGoals !== null &&
      fixture.awayGoals !== null,
  );
  const totalHomeGoals = completed.reduce((sum, fixture) => sum + (fixture.homeGoals ?? 0), 0);
  const totalAwayGoals = completed.reduce((sum, fixture) => sum + (fixture.awayGoals ?? 0), 0);
  return {
    leagueAvgGoalsHome: completed.length ? totalHomeGoals / completed.length : 1.8,
    leagueAvgGoalsAway: completed.length ? totalAwayGoals / completed.length : 1.2,
    completedFixtures: completed.length,
  };
}

export async function calculateMatchProbabilities(
  db: QvmDb,
  homeTeamId: number,
  awayTeamId: number,
): Promise<MatchProbabilities> {
  const averages = await getLeagueAverages(db);
  const statsRows = await db.select().from(teamStats);
  const homeStats = statsRows.find((row) => row.teamId === homeTeamId);
  const awayStats = statsRows.find((row) => row.teamId === awayTeamId);
  const home = homeStats ?? { attackStrengthHome: 1, defenseStrengthHome: 1 };
  const away = awayStats ?? { attackStrengthAway: 1, defenseStrengthAway: 1 };
  const lambdaHome =
    home.attackStrengthHome *
    away.defenseStrengthAway *
    averages.leagueAvgGoalsHome;
  const lambdaAway =
    away.attackStrengthAway *
    home.defenseStrengthHome *
    averages.leagueAvgGoalsAway;
  const gridSize = 12;
  const probabilityMatrix = Array.from({ length: gridSize }, (_, homeGoals) =>
    Array.from({ length: gridSize }, (_, awayGoals) =>
      poissonPmf(homeGoals, lambdaHome) * poissonPmf(awayGoals, lambdaAway) * dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway),
    ),
  );
  const gridMass = probabilityMatrix.reduce(
    (sum, row) => sum + row.reduce((rowSum, probability) => rowSum + probability, 0),
    0,
  );
  let trueHomeProb = 0;
  let trueDrawProb = 0;
  let trueAwayProb = 0;
  for (let homeGoals = 0; homeGoals < gridSize; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < gridSize; awayGoals += 1) {
      const probability = probabilityMatrix[homeGoals][awayGoals];
      if (homeGoals > awayGoals) trueHomeProb += probability;
      else if (homeGoals === awayGoals) trueDrawProb += probability;
      else trueAwayProb += probability;
    }
  }
  return {
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    probabilityMatrix,
    trueHomeProb: round(trueHomeProb / gridMass, 6),
    trueDrawProb: round(trueDrawProb / gridMass, 6),
    trueAwayProb: round(trueAwayProb / gridMass, 6),
    fairHomeOdds: round(fairOdds(trueHomeProb / gridMass), 3),
    fairDrawOdds: round(fairOdds(trueDrawProb / gridMass), 3),
    fairAwayOdds: round(fairOdds(trueAwayProb / gridMass), 3),
    gridMass: round(gridMass, 6),
    tailMass: round(Math.max(0, 1 - gridMass), 6),
    gridSize,
    modelVersion: MODEL_VERSION,
  };
}

export async function rebuildPredictions(db: QvmDb, scheduledOnly = false, strengthsReady = false) {
  if (!strengthsReady) await updateTeamStrengths(db);
  const fixtureRows = (await getFixtureRows(db)).filter((fixture) => !scheduledOnly || fixture.status === "SCHEDULED");
  const averages = await getLeagueAverages(db);
  const statsRows = await db.select().from(teamStats);
  const statsByTeam = new Map(statsRows.map((row) => [row.teamId, row]));
  for (const fixture of fixtureRows) {
    const homeStats = statsByTeam.get(fixture.homeTeamId) ?? { attackStrengthHome: 1, defenseStrengthHome: 1 };
    const awayStats = statsByTeam.get(fixture.awayTeamId) ?? { attackStrengthAway: 1, defenseStrengthAway: 1 };
    const lambdaHome = homeStats.attackStrengthHome * awayStats.defenseStrengthAway * averages.leagueAvgGoalsHome;
    const lambdaAway = awayStats.attackStrengthAway * homeStats.defenseStrengthHome * averages.leagueAvgGoalsAway;
    const model = probabilityModel(lambdaHome, lambdaAway);
    const values = {
      trueHomeProb: model.trueHomeProb,
      trueDrawProb: model.trueDrawProb,
      trueAwayProb: model.trueAwayProb,
      fairHomeOdds: model.fairHomeOdds,
      fairDrawOdds: model.fairDrawOdds,
      fairAwayOdds: model.fairAwayOdds,
      calculatedAt: new Date().toISOString(),
      modelVersion: model.modelVersion,
      gridSize: model.gridSize,
      tailMass: model.tailMass,
    };
    await db
      .insert(predictions)
      .values({ fixtureId: fixture.id, ...values })
      .onConflictDoUpdate({ target: predictions.fixtureId, set: values })
      .run();
  }
}

function probabilityModel(lambdaHome: number, lambdaAway: number): MatchProbabilities {
  const gridSize = 12;
  const probabilityMatrix = Array.from({ length: gridSize }, (_, homeGoals) =>
    Array.from({ length: gridSize }, (_, awayGoals) => poissonPmf(homeGoals, lambdaHome) * poissonPmf(awayGoals, lambdaAway) * dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway)),
  );
  const gridMass = probabilityMatrix.reduce((sum, row) => sum + row.reduce((rowSum, probability) => rowSum + probability, 0), 0);
  let trueHomeProb = 0;
  let trueDrawProb = 0;
  let trueAwayProb = 0;
  for (let homeGoals = 0; homeGoals < gridSize; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < gridSize; awayGoals += 1) {
      const probability = probabilityMatrix[homeGoals][awayGoals];
      if (homeGoals > awayGoals) trueHomeProb += probability;
      else if (homeGoals === awayGoals) trueDrawProb += probability;
      else trueAwayProb += probability;
    }
  }
  const normalisedHome = trueHomeProb / gridMass;
  const normalisedDraw = trueDrawProb / gridMass;
  const normalisedAway = trueAwayProb / gridMass;
  return {
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    probabilityMatrix,
    trueHomeProb: round(normalisedHome, 6),
    trueDrawProb: round(normalisedDraw, 6),
    trueAwayProb: round(normalisedAway, 6),
    fairHomeOdds: round(fairOdds(normalisedHome), 3),
    fairDrawOdds: round(fairOdds(normalisedDraw), 3),
    fairAwayOdds: round(fairOdds(normalisedAway), 3),
    gridMass: round(gridMass, 6),
    tailMass: round(Math.max(0, 1 - gridMass), 6),
    gridSize,
    modelVersion: MODEL_VERSION,
  };
}

function goalMarketProbability(model: MatchProbabilities, predicate: (home: number, away: number) => boolean) {
  let probability = 0;
  for (let home = 0; home < model.gridSize; home += 1) {
    for (let away = 0; away < model.gridSize; away += 1) {
      if (predicate(home, away)) probability += model.probabilityMatrix[home][away];
    }
  }
  return probability / Math.max(model.gridMass, 0.000001);
}

function derivedGoalMarkets(model: MatchProbabilities, lines: Array<typeof marketLines.$inferSelect>): GoalMarketEvaluation[] {
  const definitions: Array<{ marketType: GoalMarketEvaluation["marketType"]; selection: string; line: number; predicate: (home: number, away: number) => boolean }> = [
    { marketType: "TOTALS", selection: "OVER", line: 1.5, predicate: (h, a) => h + a > 1.5 },
    { marketType: "TOTALS", selection: "UNDER", line: 1.5, predicate: (h, a) => h + a < 1.5 },
    { marketType: "TOTALS", selection: "OVER", line: 2.5, predicate: (h, a) => h + a > 2.5 },
    { marketType: "TOTALS", selection: "UNDER", line: 2.5, predicate: (h, a) => h + a < 2.5 },
    { marketType: "TOTALS", selection: "OVER", line: 3.5, predicate: (h, a) => h + a > 3.5 },
    { marketType: "TOTALS", selection: "UNDER", line: 3.5, predicate: (h, a) => h + a < 3.5 },
    { marketType: "BTTS", selection: "YES", line: 0, predicate: (h, a) => h > 0 && a > 0 },
    { marketType: "BTTS", selection: "NO", line: 0, predicate: (h, a) => h === 0 || a === 0 },
    { marketType: "TEAM_TOTALS", selection: "HOME_OVER", line: 1.5, predicate: (h) => h > 1.5 },
    { marketType: "TEAM_TOTALS", selection: "AWAY_OVER", line: 1.5, predicate: (_, a) => a > 1.5 },
  ];
  return definitions.map((definition) => {
    const trueProb = goalMarketProbability(model, definition.predicate);
    const live = lines
      .filter((line) => line.marketType === definition.marketType && line.selection === definition.selection && (line.line ?? 0) === definition.line)
      .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
    const marketOdds = live?.odds ?? null;
    const edgePct = marketOdds && marketOdds > 1 ? marketOdds / fairOdds(trueProb) - 1 : null;
    return { marketType: definition.marketType, selection: definition.selection, line: definition.line || null, fairOdds: round(fairOdds(trueProb), 3), trueProb: round(trueProb, 6), marketOdds, edgePct: edgePct === null ? null : round(edgePct, 6), action: edgePct !== null && edgePct > EDGE_THRESHOLD ? "BET" : "NO_BET" };
  });
}

function goalSelectionKey(item: GoalMarketEvaluation) {
  return item.marketType === "BTTS" ? `BTTS_${item.selection}` : `${item.selection}_${item.line}`;
}

function isGoalSelection(selection: string) {
  return /^(OVER|UNDER|BTTS_|HOME_OVER|AWAY_OVER)/.test(selection);
}

function goalBetWon(selection: string, homeGoals: number, awayGoals: number) {
  const total = homeGoals + awayGoals;
  if (selection === "OVER_1.5") return total > 1.5;
  if (selection === "UNDER_1.5") return total < 1.5;
  if (selection === "OVER_2.5") return total > 2.5;
  if (selection === "UNDER_2.5") return total < 2.5;
  if (selection === "OVER_3.5") return total > 3.5;
  if (selection === "UNDER_3.5") return total < 3.5;
  if (selection === "BTTS_YES") return homeGoals > 0 && awayGoals > 0;
  if (selection === "BTTS_NO") return homeGoals === 0 || awayGoals === 0;
  if (selection === "HOME_OVER_1.5") return homeGoals > 1.5;
  if (selection === "AWAY_OVER_1.5") return awayGoals > 1.5;
  return null;
}

async function seedMarketQuotes(db: QvmDb, fixtureRows: FixtureRow[]) {
  const quoteRows = await db.select().from(marketQuotes);
  if (quoteRows.length > 0) return;
  const quoteByPair = new Map<string, [number, number, number]>([
    ["Arsenal|Liverpool", [2.55, 3.45, 2.95]],
    ["Manchester City|Chelsea", [1.42, 4.8, 11.5]],
    ["Tottenham Hotspur|Brighton", [2.1, 3.7, 3.65]],
    ["Aston Villa|West Ham United", [2.05, 3.5, 3.85]],
  ]);
  const teamsRows = await getTeamRows(db);
  const names = new Map(teamsRows.map((team) => [team.id, team.name]));
  const values = fixtureRows
    .filter((fixture) => fixture.status === "SCHEDULED")
    .map((fixture) => {
      const key =
        String(names.get(fixture.homeTeamId)) +
        "|" +
        String(names.get(fixture.awayTeamId));
      const odds = quoteByPair.get(key) ?? [2.5, 3.4, 2.9];
      return {
        fixtureId: fixture.id,
        league: fixture.league,
        provider: "Demo market",
        homeOdds: odds[0],
        drawOdds: odds[1],
        awayOdds: odds[2],
        capturedAt: new Date().toISOString(),
      };
    });
  if (values.length) await db.insert(marketQuotes).values(values).run();
}

async function seedSettledHistory(db: QvmDb, fixtureRows: FixtureRow[]) {
  const existingBets = await db.select().from(simulatedBets);
  if (existingBets.length > 0) return;
  const predictionsRows = await getPredictionRows(db);
  const teamsRows = await getTeamRows(db);
  const teamNames = new Map(teamsRows.map((team) => [team.id, team.name]));
  const specs: Array<{
    home: string;
    away: string;
    selection: Selection;
    odds: number;
    stake: number;
    result: "WON" | "LOST";
  }> = [
    { home: "Arsenal", away: "Chelsea", selection: "HOME", odds: 2.2, stake: 24, result: "WON" },
    { home: "Liverpool", away: "Tottenham Hotspur", selection: "DRAW", odds: 3.6, stake: 20, result: "WON" },
    { home: "Manchester City", away: "Newcastle United", selection: "HOME", odds: 1.65, stake: 30, result: "WON" },
    { home: "Brighton", away: "Aston Villa", selection: "HOME", odds: 2.8, stake: 18, result: "LOST" },
    { home: "West Ham United", away: "Everton", selection: "DRAW", odds: 3.25, stake: 22, result: "WON" },
  ];
  const values: Array<typeof simulatedBets.$inferInsert> = [];
  for (const spec of specs) {
    const fixture = fixtureRows.find(
      (item) =>
        item.status === "COMPLETED" &&
        teamNames.get(item.homeTeamId) === spec.home &&
        teamNames.get(item.awayTeamId) === spec.away,
    );
    if (!fixture) continue;
    const prediction = predictionsRows.find((item) => item.fixtureId === fixture.id);
    if (!prediction) continue;
    const trueProb = outcomeProbability(prediction, spec.selection);
    const fair = outcomeFairOdds(prediction, spec.selection);
    const pnl = spec.result === "WON" ? spec.stake * (spec.odds - 1) : -spec.stake;
    values.push({
      fixtureId: fixture.id,
      selection: spec.selection,
      marketOdds: spec.odds,
      impliedProb: round(1 / spec.odds, 6),
      trueProb,
      edgePct: round(spec.odds / fair - 1, 6),
      stakeAmount: spec.stake,
      status: "SETTLED",
      outcome: spec.result,
      profitLoss: round(pnl, 2),
      placedAt: isoAt(-8 + values.length, 17),
    });
  }
  if (values.length) await db.insert(simulatedBets).values(values).run();
  const portfolio = await getPortfolio(db);
  const profit = values.reduce((sum, bet) => sum + (bet.profitLoss ?? 0), 0);
  await db
    .update(userPortfolios)
    .set({
      currentBankroll: round(portfolio.initialBankroll + profit, 2),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(userPortfolios.id, portfolio.id))
    .run();
}

async function seedOpenPosition(db: QvmDb, fixtureRows: FixtureRow[]) {
  const existing = await db.select().from(simulatedBets);
  if (existing.some((bet) => bet.status === "PENDING")) return;
  const predictionsRows = await getPredictionRows(db);
  const quotesRows = await db.select().from(marketQuotes);
  const portfolio = await getPortfolio(db);
  const candidates = fixtureRows
    .filter((fixture) => fixture.status === "SCHEDULED")
    .flatMap((fixture) => {
      const prediction = predictionsRows.find((item) => item.fixtureId === fixture.id);
      const quote = quotesRows.find((item) => item.fixtureId === fixture.id);
      if (!prediction || !quote) return [];
      return (["HOME", "DRAW", "AWAY"] as Selection[]).map((selection) => {
        const odds = outcomeMarketOdds(quote, selection);
        const fair = outcomeFairOdds(prediction, selection);
        const trueProb = outcomeProbability(prediction, selection);
        return {
          fixture,
          selection,
          odds,
          fair,
          trueProb,
          edge: odds / fair - 1,
        };
      });
    })
    .filter((item) => item.edge > EDGE_THRESHOLD);
  const candidate = candidates.sort((left, right) => right.edge - left.edge)[0];
  if (!candidate) return;
  const stake = calculateStake(
    portfolio.currentBankroll,
    candidate.trueProb,
    candidate.odds,
  );
  if (stake <= 0) return;
  await db.insert(simulatedBets).values({
    fixtureId: candidate.fixture.id,
    selection: candidate.selection,
    marketOdds: round(candidate.odds, 3),
    impliedProb: round(1 / candidate.odds, 6),
    trueProb: round(candidate.trueProb, 6),
    edgePct: round(candidate.edge, 6),
    stakeAmount: round(stake, 2),
    status: "PENDING",
    placedAt: new Date().toISOString(),
  }).run();
}

let seedPromise: Promise<void> | null = null;

async function seedDatabase(db: QvmDb) {
  const marker = await db
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, SEED_KEY))
    .limit(1);
  if (marker.length > 0) return;
  const existingTeams = await db.select().from(teams).limit(1);
  if (existingTeams.length > 0) {
    await db
      .insert(appMeta)
      .values({
        key: SEED_KEY,
        value: "existing-database",
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    return;
  }
  await db
    .insert(teams)
    .values(SEED_TEAMS.map((name) => ({ name, league: "Premier League" })))
    .run();
  const teamsRows = await getTeamRows(db);
  const teamId = new Map(teamsRows.map((team) => [team.name, team.id]));
  const fixtureSeed: Array<{
    home: string;
    away: string;
    day: number;
    hour: number;
    homeGoals?: number;
    awayGoals?: number;
    status: "COMPLETED" | "SCHEDULED";
  }> = [
    { home: "Arsenal", away: "Chelsea", day: -12, hour: 19, homeGoals: 2, awayGoals: 1, status: "COMPLETED" },
    { home: "Liverpool", away: "Tottenham Hotspur", day: -10, hour: 16, homeGoals: 2, awayGoals: 2, status: "COMPLETED" },
    { home: "Manchester City", away: "Newcastle United", day: -8, hour: 15, homeGoals: 3, awayGoals: 0, status: "COMPLETED" },
    { home: "Brighton", away: "Aston Villa", day: -6, hour: 17, homeGoals: 1, awayGoals: 2, status: "COMPLETED" },
    { home: "West Ham United", away: "Everton", day: -4, hour: 20, homeGoals: 1, awayGoals: 1, status: "COMPLETED" },
    { home: "Arsenal", away: "Liverpool", day: 3, hour: 20, status: "SCHEDULED" },
    { home: "Manchester City", away: "Chelsea", day: 4, hour: 17, status: "SCHEDULED" },
    { home: "Tottenham Hotspur", away: "Brighton", day: 5, hour: 15, status: "SCHEDULED" },
    { home: "Aston Villa", away: "West Ham United", day: 6, hour: 19, status: "SCHEDULED" },
  ];
  await db
    .insert(fixtures)
    .values(
      fixtureSeed.map((fixture) => ({
        homeTeamId: teamId.get(fixture.home) as number,
        awayTeamId: teamId.get(fixture.away) as number,
        matchDate: isoAt(fixture.day, fixture.hour),
        homeGoals: fixture.homeGoals ?? null,
        awayGoals: fixture.awayGoals ?? null,
        status: fixture.status,
      })),
    )
    .run();
  await db
    .insert(userPortfolios)
    .values({ currentBankroll: 1000, initialBankroll: 1000 })
    .run();
  const fixtureRows = await getFixtureRows(db);
  await rebuildPredictions(db);
  await seedMarketQuotes(db, fixtureRows);
  await seedSettledHistory(db, fixtureRows);
  await seedOpenPosition(db, fixtureRows);
  await db
    .insert(appMeta)
    .values({
      key: SEED_KEY,
      value: "seeded",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  await logEvent(
    db,
    "Seeded QVM workspace with 10 teams, 5 completed fixtures, 4 upcoming fixtures, and a paper history.",
    "INFO",
    "seed",
  );
}

export function ensureSeeded(db: QvmDb) {
  if (seedPromise) return seedPromise;
  seedPromise = seedDatabase(db).finally(() => {
    seedPromise = null;
  });
  return seedPromise;
}

async function buildMarketRows(db: QvmDb) {
  await ensureSeeded(db);
  const [fixtureRows, teamsRows, predictionsRows, quoteMap, portfolio] =
    await Promise.all([
      getFixtureRows(db),
      getTeamRows(db),
      getPredictionRows(db),
      getLatestQuoteMap(db),
      getPortfolio(db),
    ]);
  const names = new Map(teamsRows.map((team) => [team.id, team.name]));
  const now = Date.now();
  return fixtureRows
    // Never surface stale scheduled fixtures as actionable markets. A match
    // whose kickoff has passed is either completed, postponed, or awaiting a
    // result provider; it must not re-enter the Edge Finder as a new bet.
    .filter((fixture) => fixture.status === "SCHEDULED" && Date.parse(fixture.matchDate) >= now)
    .map((fixture) => {
      const prediction = predictionsRows.find((row) => row.fixtureId === fixture.id);
      const quote = quoteMap.get(fixture.id);
      if (
        !prediction ||
        !quote ||
        quote.homeOdds <= 1 ||
        quote.drawOdds <= 1 ||
        quote.awayOdds <= 1
      ) return null;
      const quality = dataQualityScore(quote, prediction);
      const selections = (["HOME", "DRAW", "AWAY"] as Selection[]).map((selection) => {
        const marketOdds = outcomeMarketOdds(quote, selection);
        const fair = outcomeFairOdds(prediction, selection);
        const trueProb = outcomeProbability(prediction, selection);
        const marketProbability = Math.min(0.999, Math.max(0.001, outcomeConsensusProbability(quote, selection)));
        const blendedProbability = 0.7 * trueProb + 0.3 * marketProbability;
        const rawEdgePct = marketOdds / fair - 1;
        const blendedFairOdds = 1 / Math.max(blendedProbability, 0.000001);
        const robustEdgePct = marketOdds / blendedFairOdds - 1;
        const uncertainty = Math.min(0.18, 0.025 + (prediction.tailMass ?? 0) * 0.35 + Math.min(quoteAgeSeconds(quote.capturedAt) / 3600, 1) * 0.03 + Math.min(Math.abs(trueProb - marketProbability), 0.25) * 0.2);
        const uncertaintyLow = Math.max(0.001, blendedProbability - uncertainty);
        const uncertaintyHigh = Math.min(0.999, blendedProbability + uncertainty);
        const robustLowerEdge = marketOdds * uncertaintyLow - 1;
        const flags = [
          ...(quoteAgeSeconds(quote.capturedAt) > MAX_QUOTE_AGE_SECONDS ? ["STALE_QUOTE"] : []),
          ...((prediction.tailMass ?? 0) > 0.03 ? ["HIGH_SCORE_GRID_TAIL"] : []),
          ...((quote.bookmakerCount ?? 1) < 2 ? ["SINGLE_SOURCE"] : []),
          ...(Math.abs(trueProb - marketProbability) > 0.12 ? ["MODEL_MARKET_DIVERGENCE"] : []),
          ...(robustLowerEdge <= EDGE_THRESHOLD ? ["EDGE_NOT_ROBUST"] : []),
        ];
        const edgePct = robustEdgePct;
        const action = rawEdgePct > EDGE_THRESHOLD && robustLowerEdge > EDGE_THRESHOLD ? "BET" : "NO_BET";
        return {
          selection,
          marketOdds,
          fairOdds: fair,
          trueProb,
          impliedProb: 1 / marketOdds,
          edgePct,
          rawEdgePct,
          robustEdgePct: robustLowerEdge,
          marketProbability,
          blendedProbability,
          uncertaintyLow,
          uncertaintyHigh,
          action,
          flags,
          rationale: `${selection}: raw edge ${(rawEdgePct * 100).toFixed(1)}%; robust lower-bound edge ${(robustLowerEdge * 100).toFixed(1)}%.`,
          suggestedStake: action === "BET" ? calculateStake(portfolio.currentBankroll, blendedProbability, marketOdds) : 0,
          dataQualityScore: quality.score,
          qualityReasons: quality.reasons,
        } satisfies MarketEvaluation;
      });
      return {
        fixtureId: fixture.id,
        league: fixture.league,
        homeTeam: names.get(fixture.homeTeamId) ?? "Home",
        awayTeam: names.get(fixture.awayTeamId) ?? "Away",
        matchDate: fixture.matchDate,
        provider: quote.provider,
        capturedAt: quote.capturedAt,
        quoteAgeSeconds: round(quoteAgeSeconds(quote.capturedAt), 0),
        isStale: isStaleQuote(quote.capturedAt),
        lambdaHome: null as number | null,
        lambdaAway: null as number | null,
        gridMass: null as number | null,
        tailMass: null as number | null,
        dataQualityScore: quality.score,
        qualityReasons: quality.reasons,
        selections,
        bestEdge: Math.max(...selections.map((item) => item.edgePct)),
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
}

export async function getMarkets(db: QvmDb) {
  const rows = await buildMarketRows(db);
  const statsRows = await db.select().from(teamStats);
  const fixtureRows = await getFixtureRows(db);
  const predictionsRows = await getPredictionRows(db);
  for (const row of rows) {
    const fixture = fixtureRows.find((item) => item.id === row.fixtureId);
    const prediction = predictionsRows.find((item) => item.fixtureId === row.fixtureId);
    if (fixture && prediction) {
      const model = await calculateMatchProbabilities(db, fixture.homeTeamId, fixture.awayTeamId);
      row.lambdaHome = model.lambdaHome;
      row.lambdaAway = model.lambdaAway;
      row.gridMass = model.gridMass;
      row.tailMass = model.tailMass;
      const lines = await db.select().from(marketLines).where(eq(marketLines.fixtureId, fixture.id));
      (row as typeof row & { goalMarkets: GoalMarketEvaluation[] }).goalMarkets = derivedGoalMarkets(model, lines);
    }
  }
  const averages = await getLeagueAverages(db);
  return {
    markets: rows,
    model: {
      leagueAvgGoalsHome: averages.leagueAvgGoalsHome,
      leagueAvgGoalsAway: averages.leagueAvgGoalsAway,
      teamsWithStats: statsRows.length,
      grid: "12×12 Dixon–Coles scoreline matrix (tail-normalised)",
    },
  };
}

export async function getRiskSummary(db: QvmDb) {
  const [portfolio, bets] = await Promise.all([
    getPortfolio(db),
    db.select().from(simulatedBets).orderBy(simulatedBets.placedAt),
  ]);
  const pending = bets.filter((bet) => bet.status === "PENDING");
  const settled = bets.filter((bet) => bet.status === "SETTLED");
  const bankroll = Math.max(0, portfolio.currentBankroll);
  const openExposure = pending.reduce((sum, bet) => sum + bet.stakeAmount, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dailyLoss = settled.reduce((sum, bet) => {
    const placedAt = Date.parse(bet.placedAt);
    return placedAt >= dayStart.getTime() && bet.profitLoss < 0
      ? sum + Math.abs(bet.profitLoss)
      : sum;
  }, 0);
  let running = portfolio.initialBankroll;
  let peak = Math.max(portfolio.initialBankroll, 0.01);
  let maxDrawdown = 0;
  for (const bet of settled) {
    running += bet.profitLoss;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, (peak - running) / peak);
  }
  const openExposureLimit = bankroll * MAX_OPEN_EXPOSURE_PCT;
  const dailyLossLimit = bankroll * MAX_DAILY_LOSS_PCT;
  const flags: string[] = [];
  const runtime = await getRuntimeEnv();
  const killSwitch = runtime.QVM_KILL_SWITCH === "true";
  if (killSwitch) flags.push("Kill switch enabled");
  if (dailyLoss >= dailyLossLimit && dailyLossLimit > 0) {
    flags.push("Daily loss limit reached");
  }
  if (openExposure >= openExposureLimit && openExposureLimit > 0) {
    flags.push("Open exposure limit reached");
  }
  return {
    status: flags.length ? "HALTED" : "READY",
    flags,
    killSwitch,
    currentBankroll: round(bankroll, 2),
    openExposure: round(openExposure, 2),
    openExposureLimit: round(openExposureLimit, 2),
    dailyLoss: round(dailyLoss, 2),
    dailyLossLimit: round(dailyLossLimit, 2),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    pendingBets: pending.length,
    maxStakePct: MAX_STAKE_PCT * 100,
    maxOpenExposurePct: MAX_OPEN_EXPOSURE_PCT * 100,
    maxFixtureExposurePct: MAX_FIXTURE_EXPOSURE_PCT * 100,
    quoteMaxAgeSeconds: MAX_QUOTE_AGE_SECONDS,
  };
}

export async function getOverview(db: QvmDb) {
  await ensureSeeded(db);
  const [portfolio, bets, logs, fixtureRows, teamsRows, statsRows] =
    await Promise.all([
      getPortfolio(db),
      db.select().from(simulatedBets).orderBy(desc(simulatedBets.placedAt)),
      db
        .select()
        .from(systemLogs)
        .orderBy(desc(systemLogs.createdAt), desc(systemLogs.id))
        .limit(12),
      getFixtureRows(db),
      getTeamRows(db),
      db.select().from(teamStats),
    ]);
  const risk = await getRiskSummary(db);
  const latestModel = (
    await db
      .select()
      .from(modelRuns)
      .orderBy(desc(modelRuns.createdAt), desc(modelRuns.id))
      .limit(1)
  )[0];
  const latestAgents = await db
    .select()
    .from(agentRuns)
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
    .limit(2);
  const settled = bets.filter((bet) => bet.status === "SETTLED");
  const won = settled.filter((bet) => bet.outcome === "WON");
  const profit = settled.reduce((sum, bet) => sum + bet.profitLoss, 0);
  const pending = bets.filter((bet) => bet.status === "PENDING");
  const awaitingResultCount = pending.filter((bet) => {
    const fixture = fixtureRows.find((item) => item.id === bet.fixtureId);
    return fixture && Date.parse(fixture.matchDate) < Date.now() && (fixture.homeGoals === null || fixture.awayGoals === null);
  }).length;
  return {
    mode: "PAPER",
    portfolio: {
      currentBankroll: round(portfolio.currentBankroll, 2),
      initialBankroll: round(portfolio.initialBankroll, 2),
      roiPct: round((profit / portfolio.initialBankroll) * 100, 2),
      drawdownPct: risk.maxDrawdownPct,
    },
    kpis: {
      totalPlacedBets: bets.length,
      settledBets: settled.length,
      pendingBets: pending.length,
      awaitingResultBets: awaitingResultCount,
      winRatePct: settled.length ? round((won.length / settled.length) * 100, 1) : 0,
      profitLoss: round(profit, 2),
    },
    connection: {
      oddsFeed: (await runtimeHasOddsKey())
        ? "The Odds API ready"
        : "Demo snapshot",
      database: "D1 / SQL",
      execution: "Paper only",
      risk: risk.status === "HALTED" ? "HALTED · review required" : "READY · guardrails active",
    },
    activeTrades: pending.map((bet) => {
      const fixture = fixtureRows.find((item) => item.id === bet.fixtureId);
      const home = teamsRows.find((team) => team.id === fixture?.homeTeamId)?.name;
      const away = teamsRows.find((team) => team.id === fixture?.awayTeamId)?.name;
      const hasResult = fixture?.homeGoals !== null && fixture?.homeGoals !== undefined && fixture?.awayGoals !== null && fixture?.awayGoals !== undefined;
      const resultStatus = hasResult
        ? "READY_TO_SETTLE"
        : fixture && Date.parse(fixture.matchDate) < Date.now()
          ? "AWAITING_RESULT"
          : "UPCOMING";
      return {
        id: bet.id,
        fixtureId: bet.fixtureId,
        match: (home ?? "Home") + " vs " + (away ?? "Away"),
        matchDate: fixture?.matchDate ?? null,
        selection: bet.selection,
        odds: bet.marketOdds,
        edgePct: bet.edgePct,
        stake: bet.stakeAmount,
        placedAt: bet.placedAt,
        resultStatus,
      };
    }).filter((trade) => trade.resultStatus === "UPCOMING"),
    logs,
    model: {
      teamsTracked: teamsRows.length,
      teamStatsRows: statsRows.length,
      completedFixtures: fixtureRows.filter((fixture) => fixture.status === "COMPLETED").length,
      grid: "12×12",
      latestBacktest: latestModel
        ? {
            brierScore: latestModel.brierScore,
            logLoss: latestModel.logLoss,
            hitRate: latestModel.hitRate,
            averageTailMass: latestModel.averageTailMass,
            createdAt: latestModel.createdAt,
          }
        : null,
    },
    risk,
    agents: latestAgents.map((agent) => ({
      agentName: agent.agentName,
      role: agent.role,
      model: agent.model,
      status: agent.status,
      summary: agent.summary,
      finishedAt: agent.finishedAt,
    })),
    lastRefresh: logs[0]?.createdAt ?? null,
  };
}

export async function getPerformance(db: QvmDb) {
  await ensureSeeded(db);
  const [bets, fixturesRows, teamsRows, portfolio] = await Promise.all([
    db
      .select()
      .from(simulatedBets)
      .orderBy(simulatedBets.placedAt),
    getFixtureRows(db),
    getTeamRows(db),
    getPortfolio(db),
  ]);
  const names = new Map(teamsRows.map((team) => [team.id, team.name]));
  let runningBankroll = portfolio.initialBankroll;
  const history = bets.map((bet) => {
    if (bet.status === "SETTLED") runningBankroll += bet.profitLoss;
    const fixture = fixturesRows.find((item) => item.id === bet.fixtureId);
    return {
      ...bet,
      league: fixture?.league ?? "Premier League",
      match:
        (names.get(fixture?.homeTeamId ?? 0) ?? "Home") +
        " vs " +
        (names.get(fixture?.awayTeamId ?? 0) ?? "Away"),
      score:
        fixture?.homeGoals !== null && fixture?.homeGoals !== undefined
          ? String(fixture.homeGoals) + "–" + String(fixture.awayGoals)
          : "Not finished",
      status: bet.status as "PENDING" | "SETTLED",
      matchDate: fixture?.matchDate ?? null,
      runningBankroll: round(runningBankroll, 2),
    };
  });
  return {
    initialBankroll: portfolio.initialBankroll,
    currentBankroll: portfolio.currentBankroll,
    history,
    chart: [
      { label: "Start", bankroll: portfolio.initialBankroll },
      ...history.map((item, index) => ({
        label: "Bet " + String(index + 1),
        bankroll: item.runningBankroll,
      })),
    ],
  };
}

type WalkForwardAggregate = {
  homeGames: number;
  awayGames: number;
  goalsScoredHome: number;
  goalsConcededHome: number;
  goalsScoredAway: number;
  goalsConcededAway: number;
};

function emptyWalkForwardAggregate(): WalkForwardAggregate {
  return {
    homeGames: 0,
    awayGames: 0,
    goalsScoredHome: 0,
    goalsConcededHome: 0,
    goalsScoredAway: 0,
    goalsConcededAway: 0,
  };
}

function walkForwardProbabilities(lambdaHome: number, lambdaAway: number) {
  const matrix = Array.from({ length: 6 }, (_, homeGoals) =>
    Array.from({ length: 6 }, (_, awayGoals) =>
      poissonPmf(homeGoals, lambdaHome) * poissonPmf(awayGoals, lambdaAway),
    ),
  );
  const mass = matrix.reduce(
    (sum, row) => sum + row.reduce((rowSum, value) => rowSum + value, 0),
    0,
  );
  if (mass <= 0) return [1 / 3, 1 / 3, 1 / 3, 1] as const;
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let homeGoals = 0; homeGoals < 6; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < 6; awayGoals += 1) {
      const value = matrix[homeGoals][awayGoals];
      if (homeGoals > awayGoals) home += value;
      else if (homeGoals === awayGoals) draw += value;
      else away += value;
    }
  }
  return [home / mass, draw / mass, away / mass, Math.max(0, 1 - mass)] as const;
}

function actualOutcome(fixture: FixtureRow) {
  if ((fixture.homeGoals ?? 0) > (fixture.awayGoals ?? 0)) return 0;
  if ((fixture.homeGoals ?? 0) < (fixture.awayGoals ?? 0)) return 2;
  return 1;
}

export async function runWalkForwardBacktest(db: QvmDb) {
  await ensureSeeded(db);
  const completed = (await getFixtureRows(db)).filter(
    (fixture) =>
      fixture.status === "COMPLETED" &&
      fixture.homeGoals !== null &&
      fixture.awayGoals !== null,
  );
  const aggregates = new Map<number, WalkForwardAggregate>();
  const getAggregate = (teamId: number) => {
    const existing = aggregates.get(teamId);
    if (existing) return existing;
    const created = emptyWalkForwardAggregate();
    aggregates.set(teamId, created);
    return created;
  };
  let totalHomeGoals = 0;
  let totalAwayGoals = 0;
  let priorFixtures = 0;
  let brierTotal = 0;
  let logLossTotal = 0;
  let correct = 0;
  let tailTotal = 0;
  for (const fixture of completed) {
    const home = getAggregate(fixture.homeTeamId);
    const away = getAggregate(fixture.awayTeamId);
    const leagueHome = priorFixtures ? totalHomeGoals / priorFixtures : 1.8;
    const leagueAway = priorFixtures ? totalAwayGoals / priorFixtures : 1.2;
    const lambdaHome =
      safeStrength(home.goalsScoredHome, home.homeGames, leagueHome) *
      safeStrength(away.goalsConcededAway, away.awayGames, leagueHome) *
      leagueHome;
    const lambdaAway =
      safeStrength(away.goalsScoredAway, away.awayGames, leagueHome) *
      safeStrength(home.goalsConcededHome, home.homeGames, leagueAway) *
      leagueAway;
    const [homeProb, drawProb, awayProb, tailMass] = walkForwardProbabilities(
      lambdaHome,
      lambdaAway,
    );
    const predicted = [homeProb, drawProb, awayProb];
    const actual = actualOutcome(fixture);
    brierTotal += predicted.reduce(
      (sum, probability, index) =>
        sum + (probability - (index === actual ? 1 : 0)) ** 2,
      0,
    );
    logLossTotal += -Math.log(Math.max(predicted[actual], 1e-12));
    correct += Number(predicted.indexOf(Math.max(...predicted)) === actual);
    tailTotal += tailMass;

    totalHomeGoals += fixture.homeGoals ?? 0;
    totalAwayGoals += fixture.awayGoals ?? 0;
    priorFixtures += 1;
    home.homeGames += 1;
    home.goalsScoredHome += fixture.homeGoals ?? 0;
    home.goalsConcededHome += fixture.awayGoals ?? 0;
    away.awayGames += 1;
    away.goalsScoredAway += fixture.awayGoals ?? 0;
    away.goalsConcededAway += fixture.homeGoals ?? 0;
  }
  const result = {
    modelVersion: MODEL_VERSION,
    evaluationType: "WALK_FORWARD",
    fixturesAvailable: completed.length,
    fixturesEvaluated: completed.length,
    brierScore: completed.length ? round(brierTotal / completed.length, 6) : null,
    logLoss: completed.length ? round(logLossTotal / completed.length, 6) : null,
    hitRate: completed.length ? round(correct / completed.length, 6) : null,
    averageTailMass: completed.length ? round(tailTotal / completed.length, 6) : null,
    roiPct: null,
    maxDrawdownPct: null,
    note:
      "Leakage-safe evaluation; ROI and drawdown require historical market prices. " +
      "Tail mass is the probability outside the 0–5 goal grid.",
    createdAt: new Date().toISOString(),
  };
  await db.insert(modelRuns).values({
    modelVersion: result.modelVersion,
    evaluationType: result.evaluationType,
    fixturesEvaluated: result.fixturesEvaluated,
    brierScore: result.brierScore,
    logLoss: result.logLoss,
    hitRate: result.hitRate,
    averageTailMass: result.averageTailMass,
    roiPct: result.roiPct,
    maxDrawdownPct: result.maxDrawdownPct,
    createdAt: result.createdAt,
  }).run();
  await logEvent(
    db,
    "Walk-forward backtest completed across " + String(completed.length) + " completed fixtures.",
    "INFO",
    "backtest",
  );
  return result;
}

function parseJsonPayload(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function getAgentDashboard(db: QvmDb) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  const [runs, backtests, risk] = await Promise.all([
    db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
      .limit(20),
    db
      .select()
      .from(modelRuns)
      .orderBy(desc(modelRuns.createdAt), desc(modelRuns.id))
      .limit(8),
    getRiskSummary(db),
  ]);
  const latestByRole = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latestByRole.has(run.role)) latestByRole.set(run.role, run);
  }
  return {
    modelProfile: {
      label: runtime.LUNA_MODEL_LABEL ?? "Luna Max",
      exactModel: runtime.OPENAI_MODEL ?? null,
      apiConfigured: Boolean(runtime.OPENAI_API_KEY && runtime.OPENAI_MODEL),
      executionAuthority: "NONE",
    },
    policy: {
      mode: "PAPER",
      manualApprovalRequired: true,
      workerCanExecute: false,
      managerCanExecute: false,
    },
    risk,
    latest: Array.from(latestByRole.values()).map((run) => ({
      agentName: run.agentName,
      role: run.role,
      model: run.model,
      status: run.status,
      task: run.task,
      summary: run.summary,
      payload: parseJsonPayload(run.payload),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    history: runs.map((run) => ({
      id: run.id,
      agentName: run.agentName,
      role: run.role,
      model: run.model,
      status: run.status,
      task: run.task,
      summary: run.summary,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    backtests,
  };
}

export async function getResearchDashboard(db: QvmDb) {
  await ensureSeeded(db);
  const [snapshots, replays, experiments, scenarios, playerRows, heartbeats, calibration, sourceHealthRows, featureRows, availabilityRows] = await Promise.all([
    db.select().from(dataSnapshots).orderBy(desc(dataSnapshots.capturedAt), desc(dataSnapshots.id)).limit(10),
    db.select().from(decisionReplays).orderBy(desc(decisionReplays.createdAt), desc(decisionReplays.id)).limit(10),
    db.select().from(experimentRuns).orderBy(desc(experimentRuns.createdAt), desc(experimentRuns.id)).limit(10),
    db.select().from(portfolioScenarios).orderBy(desc(portfolioScenarios.createdAt), desc(portfolioScenarios.id)).limit(10),
    db.select().from(players),
    db.select().from(workerHeartbeats).limit(5),
    db.select().from(calibrationBuckets).orderBy(desc(calibrationBuckets.updatedAt), desc(calibrationBuckets.id)).limit(20),
    db.select().from(dataSourceHealth).where(sql`${dataSourceHealth.source} <> 'API-Football'`).orderBy(dataSourceHealth.source),
    db.select().from(fixtureFeatures).orderBy(desc(fixtureFeatures.capturedAt), desc(fixtureFeatures.id)).limit(100),
    db.select().from(availabilitySnapshots).orderBy(desc(availabilitySnapshots.capturedAt), desc(availabilitySnapshots.id)).limit(100),
  ]);
  return {
    capabilities: [
      "Bayesian-ready dynamic team strengths", "Player availability and lineup enrichment", "Event-level xG storage",
      "Historical odds and immutable source snapshots", "Portfolio correlation caps", "Counterfactual bankroll scenarios",
      "Champion/challenger experiments", "Decision replay and Auditor veto", "Worker heartbeat and drift monitoring",
      "Point-in-time feature store and source freshness gates", "De-vigged consensus and closing-line value",
    ],
    counts: { snapshots: snapshots.length, replays: replays.length, experiments: experiments.length, scenarios: scenarios.length, players: playerRows.length, calibrationBuckets: calibration.length, features: featureRows.length, availability: availabilityRows.length, sources: sourceHealthRows.length },
    latestSnapshots: snapshots,
    latestReplays: replays,
    experiments,
    scenarios,
    heartbeats,
    calibration,
    sourceHealth: sourceHealthRows,
    latestFeatures: featureRows.slice(0, 12),
    latestAvailability: availabilityRows.slice(0, 12),
  };
}

export async function recordAgentRuns(db: QvmDb, reports: unknown[]) {
  let recorded = 0;
  for (const raw of reports.slice(0, 4)) {
    if (!raw || typeof raw !== "object") continue;
    const report = raw as Record<string, unknown>;
    const agentName = typeof report.agent_name === "string" ? report.agent_name : null;
    const role = typeof report.role === "string" ? report.role : null;
    const task = typeof report.task === "string" ? report.task : null;
    if (!agentName || !role || !task) continue;
    const payload = report.payload && typeof report.payload === "object"
      ? JSON.stringify(report.payload)
      : null;
    await db.insert(agentRuns).values({
      agentName: agentName.slice(0, 80),
      role: role.slice(0, 20),
      model: typeof report.model === "string" ? report.model.slice(0, 120) : "Luna Max",
      status: typeof report.status === "string" ? report.status.slice(0, 20) : "DEGRADED",
      task: task.slice(0, 160),
      summary: typeof report.summary === "string" ? report.summary.slice(0, 4000) : null,
      payload: payload?.slice(0, 12000) ?? null,
      startedAt: typeof report.started_at === "string" ? report.started_at : new Date().toISOString(),
      finishedAt: typeof report.finished_at === "string" ? report.finished_at : new Date().toISOString(),
    }).run();
    recorded += 1;
  }
  return recorded;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normaliseIsoDate(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function fixtureIdentity(homeTeamId: number, awayTeamId: number, matchDate: string) {
  return String(homeTeamId) + "|" + String(awayTeamId) + "|" + matchDate;
}

export async function isWorkerRequestAuthorized(request: Request) {
  const runtime = await getRuntimeEnv();
  const expected = runtime.QVM_WORKER_SHARED_SECRET;
  return Boolean(expected && request.headers.get("X-QVM-Worker-Key") === expected);
}

export async function syncWorkerSnapshot(
  db: QvmDb,
  payload: Record<string, unknown>,
) {
  await ensureSeeded(db);
  const fixturesInput = Array.isArray(payload.fixtures) ? payload.fixtures : [];
  const marketsInput = Array.isArray(payload.markets) ? payload.markets : [];
  const teamRows = await getTeamRows(db);
  const teamByName = new Map(teamRows.map((team) => [normaliseName(team.name), team]));
  let teamsCreated = 0;
  const getOrCreateTeam = async (value: unknown) => {
    const name = asString(value);
    const key = normaliseName(name);
    if (!key) return null;
    const existing = teamByName.get(key);
    if (existing) return existing;
    const [created] = await db.insert(teams).values({ name, league: "Premier League" }).returning();
    if (!created) return null;
    teamByName.set(key, created);
    teamsCreated += 1;
    return created;
  };

  const fixtureRows = await getFixtureRows(db);
  const fixtureByIdentity = new Map(
    fixtureRows.map((fixture) =>
      [fixtureIdentity(fixture.homeTeamId, fixture.awayTeamId, fixture.matchDate), fixture] as const,
    ),
  );
  let fixturesCreated = 0;
  let fixturesUpdated = 0;
  for (const raw of fixturesInput.slice(0, 1000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const home = await getOrCreateTeam(item.home_team);
    const away = await getOrCreateTeam(item.away_team);
    const matchDate = normaliseIsoDate(item.match_date);
    if (!home || !away || !matchDate || home.id === away.id) continue;
    const rawStatus = asString(item.status).toUpperCase();
    const status = rawStatus === "COMPLETED" ? "COMPLETED" : "SCHEDULED";
    const homeGoals = asNumber(item.home_goals);
    const awayGoals = asNumber(item.away_goals);
    const key = fixtureIdentity(home.id, away.id, matchDate);
    const existing = fixtureByIdentity.get(key);
    if (existing) {
      const nextHomeGoals = homeGoals === null ? null : Math.trunc(homeGoals);
      const nextAwayGoals = awayGoals === null ? null : Math.trunc(awayGoals);
      if (
        existing.status !== status ||
        existing.homeGoals !== nextHomeGoals ||
        existing.awayGoals !== nextAwayGoals
      ) {
        await db.update(fixtures).set({
          status,
          homeGoals: nextHomeGoals,
          awayGoals: nextAwayGoals,
        }).where(eq(fixtures.id, existing.id)).run();
        existing.status = status;
        existing.homeGoals = nextHomeGoals;
        existing.awayGoals = nextAwayGoals;
        fixturesUpdated += 1;
      }
      continue;
    }
    const [created] = await db.insert(fixtures).values({
      homeTeamId: home.id,
      awayTeamId: away.id,
      matchDate,
      homeGoals: homeGoals === null ? null : Math.trunc(homeGoals),
      awayGoals: awayGoals === null ? null : Math.trunc(awayGoals),
      status,
    }).returning();
    if (created) {
      fixtureByIdentity.set(key, created);
      fixturesCreated += 1;
    }
  }

  const quoteRows = await db.select().from(marketQuotes);
  let quotesCreated = 0;
  for (const raw of marketsInput.slice(0, 1000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const home = await getOrCreateTeam(item.home_team);
    const away = await getOrCreateTeam(item.away_team);
    const matchDate = normaliseIsoDate(item.match_date);
    if (!home || !away || !matchDate) continue;
    const fixture = fixtureByIdentity.get(fixtureIdentity(home.id, away.id, matchDate));
    const homeOdds = asNumber(item.home_odds);
    const drawOdds = asNumber(item.draw_odds);
    const awayOdds = asNumber(item.away_odds);
    const capturedAt = normaliseIsoDate(item.captured_at) ?? new Date().toISOString();
    if (
      !fixture ||
      homeOdds === null ||
      drawOdds === null ||
      awayOdds === null ||
      homeOdds <= 1 ||
      drawOdds <= 1 ||
      awayOdds <= 1
    ) continue;
    const provider = asString(item.provider) || "Windows QVM worker";
    const duplicate = quoteRows.some(
      (quote) =>
        quote.fixtureId === fixture.id &&
        quote.provider === provider &&
        quote.capturedAt === capturedAt,
    );
    if (duplicate) continue;
    const [created] = await db.insert(marketQuotes).values({
      fixtureId: fixture.id,
      provider: provider.slice(0, 120),
      homeOdds,
      drawOdds,
      awayOdds,
      capturedAt,
    }).returning();
    if (created) {
      quoteRows.push(created);
      quotesCreated += 1;
    }
  }
  let featuresCreated = 0;
  const featuresInput = Array.isArray(payload.features) ? payload.features : [];
  for (const raw of featuresInput.slice(0, 1000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const home = await getOrCreateTeam(item.home_team);
    const away = await getOrCreateTeam(item.away_team);
    const matchDate = normaliseIsoDate(item.match_date);
    if (!home || !away || !matchDate) continue;
    const fixture = fixtureByIdentity.get(fixtureIdentity(home.id, away.id, matchDate));
    if (!fixture) continue;
    const capturedAt = normaliseIsoDate(item.captured_at) ?? new Date().toISOString();
    const exists = (await db.select().from(fixtureFeatures).where(eq(fixtureFeatures.fixtureId, fixture.id))).some((row) => row.source === (asString(item.source) || "Windows QVM worker") && row.capturedAt === capturedAt);
    if (exists) continue;
    await db.insert(fixtureFeatures).values({
      fixtureId: fixture.id,
      source: (asString(item.source) || "Windows QVM worker").slice(0, 120),
      capturedAt,
      availableAt: normaliseIsoDate(item.available_at) ?? capturedAt,
      homeXg: asNumber(item.home_xg),
      awayXg: asNumber(item.away_xg),
      homeShots: asNumber(item.home_shots) === null ? null : Math.trunc(asNumber(item.home_shots) as number),
      awayShots: asNumber(item.away_shots) === null ? null : Math.trunc(asNumber(item.away_shots) as number),
      homeBigChances: asNumber(item.home_big_chances) === null ? null : Math.trunc(asNumber(item.home_big_chances) as number),
      awayBigChances: asNumber(item.away_big_chances) === null ? null : Math.trunc(asNumber(item.away_big_chances) as number),
      homeRestDays: asNumber(item.home_rest_days),
      awayRestDays: asNumber(item.away_rest_days),
      travelKm: asNumber(item.travel_km),
      weatherJson: item.weather && typeof item.weather === "object" ? JSON.stringify(item.weather) : null,
      payload: JSON.stringify(item).slice(0, 12000),
    }).run();
    featuresCreated += 1;
  }
  let availabilityCreated = 0;
  const availabilityInput = Array.isArray(payload.availability) ? payload.availability : [];
  for (const raw of availabilityInput.slice(0, 2000)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const home = await getOrCreateTeam(item.home_team);
    const away = await getOrCreateTeam(item.away_team);
    const matchDate = normaliseIsoDate(item.match_date);
    const team = await getOrCreateTeam(item.team);
    if (!home || !away || !team || !matchDate) continue;
    const fixture = fixtureByIdentity.get(fixtureIdentity(home.id, away.id, matchDate));
    if (!fixture) continue;
    const capturedAt = normaliseIsoDate(item.captured_at) ?? new Date().toISOString();
    await db.insert(availabilitySnapshots).values({
      fixtureId: fixture.id,
      teamId: team.id,
      playerName: (asString(item.player_name) || "Unknown player").slice(0, 160),
      status: (asString(item.status).toUpperCase() || "UNKNOWN").slice(0, 30),
      expectedMinutes: asNumber(item.expected_minutes) ?? 0,
      source: (asString(item.source) || "Windows QVM worker").slice(0, 120),
      confidence: Math.min(1, Math.max(0, asNumber(item.confidence) ?? 0.5)),
      capturedAt,
      availableAt: normaliseIsoDate(item.available_at) ?? capturedAt,
      payload: JSON.stringify(item).slice(0, 12000),
    }).run();
    availabilityCreated += 1;
  }
  const storedModelRuns = await db.select().from(modelRuns);
  let modelRunsCreated = 0;
  const modelRunsInput = Array.isArray(payload.model_runs) ? payload.model_runs : [];
  for (const raw of modelRunsInput.slice(0, 4)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const createdAt = normaliseIsoDate(item.created_at) ?? new Date().toISOString();
    const modelVersion = asString(item.model_version) || MODEL_VERSION;
    const evaluationType = asString(item.evaluation_type) || "WALK_FORWARD";
    if (storedModelRuns.some((run) => run.modelVersion === modelVersion && run.createdAt === createdAt)) continue;
    const [created] = await db.insert(modelRuns).values({
      modelVersion: modelVersion.slice(0, 80),
      evaluationType: evaluationType.slice(0, 40),
      fixturesEvaluated: Math.max(0, Math.trunc(asNumber(item.fixtures_evaluated) ?? 0)),
      brierScore: asNumber(item.brier_score),
      logLoss: asNumber(item.log_loss),
      hitRate: asNumber(item.hit_rate),
      averageTailMass: asNumber(item.average_tail_mass),
      roiPct: asNumber(item.roi_pct),
      maxDrawdownPct: asNumber(item.max_drawdown_pct),
      createdAt,
    }).returning();
    if (created) {
      storedModelRuns.push(created);
      modelRunsCreated += 1;
    }
  }
  const model = await updateTeamStrengths(db);
  await rebuildPredictions(db);
  const reports = Array.isArray(payload.agent_runs) ? payload.agent_runs : [];
  const agentsRecorded = await recordAgentRuns(db, reports);
  if (featuresCreated > 0 || availabilityCreated > 0) {
    await db.insert(dataSnapshots).values({
      source: "Windows QVM worker",
      endpoint: "/api/qvm/worker/sync",
      contentHash: `worker:${Date.now()}:${featuresCreated}:${availabilityCreated}`,
      payload: JSON.stringify({ features: featuresCreated, availability: availabilityCreated }),
      capturedAt: new Date().toISOString(),
      availableAt: new Date().toISOString(),
      freshnessSeconds: 0,
      status: "VALID",
    }).run();
  }
  await updateSourceHealth(db, "Windows QVM worker", "READY", featuresCreated + availabilityCreated);
  await logEvent(
    db,
    "Windows worker sync completed: " + String(fixturesCreated + fixturesUpdated) +
      " fixture updates, " + String(quotesCreated) + " quotes, " + String(agentsRecorded) +
      " agent reports, " + String(featuresCreated) + " feature snapshots, " + String(availabilityCreated) + " availability snapshots, and " + String(modelRunsCreated) + " model runs.",
    "INFO",
    "worker_sync",
  );
  return {
    teamsCreated,
    fixturesCreated,
    fixturesUpdated,
    quotesCreated,
    modelRunsCreated,
    agentsRecorded,
    featuresCreated,
    availabilityCreated,
    model,
  };
}

export async function scanEdges(db: QvmDb) {
  await ensureSeeded(db);
  const markets = await buildMarketRows(db);
  const portfolio = await getPortfolio(db);
  const risk = await getRiskSummary(db);
  const existing = await db.select().from(simulatedBets);
  const created: Array<BetRow & { match: string }> = [];
  let reservedExposure = risk.openExposure;
  if (risk.status === "HALTED") {
    await logEvent(
      db,
      "Edge scan blocked by the deterministic risk gate: " + risk.flags.join(", ") + ".",
      "WARN",
      "risk_gate",
    );
    return {
      created,
      threshold: EDGE_THRESHOLD,
      blocked: true,
      risk,
    };
  }
  for (const market of markets) {
    if (market.isStale) continue;
    for (const evaluation of market.selections) {
      const alreadyOpen = existing.some(
        (bet) =>
          bet.fixtureId === market.fixtureId &&
          bet.selection === evaluation.selection &&
          bet.status === "PENDING",
      );
      if (evaluation.action !== "BET" || alreadyOpen) continue;
      const stake = calculateStake(
        portfolio.currentBankroll,
        evaluation.trueProb,
        evaluation.marketOdds,
      );
      if (stake <= 0) continue;
      const fixtureExposure = existing
        .filter(
          (bet) =>
            bet.fixtureId === market.fixtureId && bet.status === "PENDING",
        )
        .reduce((sum, bet) => sum + bet.stakeAmount, 0);
      if (
        stake > portfolio.currentBankroll * MAX_STAKE_PCT ||
        reservedExposure + stake > portfolio.currentBankroll * MAX_OPEN_EXPOSURE_PCT ||
        fixtureExposure + stake > portfolio.currentBankroll * MAX_FIXTURE_EXPOSURE_PCT
      ) {
        continue;
      }
      const [bet] = await db
        .insert(simulatedBets)
        .values({
          fixtureId: market.fixtureId,
          selection: evaluation.selection,
          marketOdds: round(evaluation.marketOdds, 3),
          impliedProb: round(evaluation.impliedProb, 6),
          trueProb: round(evaluation.trueProb, 6),
          edgePct: round(evaluation.edgePct, 6),
          stakeAmount: round(stake, 2),
          status: "PENDING",
          placedAt: new Date().toISOString(),
        })
        .returning();
      if (bet) {
        created.push({
          ...bet,
          match: market.homeTeam + " vs " + market.awayTeam,
        });
        existing.push(bet);
        reservedExposure += bet.stakeAmount;
      }
    }
  }
  await logEvent(
    db,
    "Edge scan completed: " +
      String(created.length) +
      " new paper positions above the 3% threshold.",
    "INFO",
    "edge_scan",
  );
  return { created, threshold: EDGE_THRESHOLD, blocked: false, risk };
}

export async function placePaperBet(
  db: QvmDb,
  fixtureId: number,
  selection: string,
  requestedStake?: number,
) {
  await ensureSeeded(db);
  const markets = await buildMarketRows(db);
  const market = markets.find((item) => item.fixtureId === fixtureId);
  const evaluation = market?.selections.find((item) => item.selection === selection);
  let goalEvaluation: GoalMarketEvaluation | undefined;
  if (market && isGoalSelection(selection)) {
    const fixture = (await getFixtureRows(db)).find((item) => item.id === fixtureId);
    if (fixture) {
      const model = await calculateMatchProbabilities(db, fixture.homeTeamId, fixture.awayTeamId);
      const lines = await db.select().from(marketLines).where(eq(marketLines.fixtureId, fixtureId));
      goalEvaluation = derivedGoalMarkets(model, lines).find((item) => goalSelectionKey(item) === selection);
    }
  }
  const selectedEvaluation = evaluation ?? goalEvaluation;
  if (!market || !selectedEvaluation) throw new Error("Fixture market is unavailable.");
  if (market.isStale) {
    throw new Error("The market quote is stale; refresh the feed before placing paper.");
  }
  if (selectedEvaluation.action !== "BET" || selectedEvaluation.marketOdds === null) {
    throw new Error("The requested market has no verified live price above the robust 3% edge threshold.");
  }
  const existing = await db.select().from(simulatedBets);
  if (
    existing.some(
      (bet) =>
        bet.fixtureId === fixtureId &&
        bet.selection === selection &&
        bet.status === "PENDING",
    )
  ) {
    throw new Error("An open paper position already exists for this fixture and selection.");
  }
  const risk = await getRiskSummary(db);
  if (risk.status === "HALTED") {
    throw new Error("Risk gate halted: " + risk.flags.join(", ") + ".");
  }
  const portfolio = await getPortfolio(db);
  const suggestedStake = calculateStake(
    portfolio.currentBankroll,
    selectedEvaluation.trueProb,
    selectedEvaluation.marketOdds,
  );
  const stake = requestedStake === undefined ? suggestedStake : round(requestedStake, 2);
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error("Enter a stake greater than €0.00.");
  }
  const fixtureExposure = existing
    .filter((bet) => bet.fixtureId === fixtureId && bet.status === "PENDING")
    .reduce((sum, bet) => sum + bet.stakeAmount, 0);
  if (
    stake <= 0 ||
    stake > portfolio.currentBankroll * MAX_STAKE_PCT ||
    risk.openExposure + stake > portfolio.currentBankroll * MAX_OPEN_EXPOSURE_PCT ||
    fixtureExposure + stake > portfolio.currentBankroll * MAX_FIXTURE_EXPOSURE_PCT
  ) {
    throw new Error("The requested position would exceed a configured exposure limit or the 10% stake cap.");
  }
  const [bet] = await db
    .insert(simulatedBets)
    .values({
      fixtureId,
      selection,
      marketOdds: round(selectedEvaluation.marketOdds, 3),
      impliedProb: round(1 / selectedEvaluation.marketOdds, 6),
      trueProb: round(selectedEvaluation.trueProb, 6),
      edgePct: round(selectedEvaluation.edgePct ?? 0, 6),
      stakeAmount: round(stake, 2),
      status: "PENDING",
      placedAt: new Date().toISOString(),
    })
    .returning();
  await logEvent(
    db,
    "Paper " +
      selection +
      " position created for " +
      market.homeTeam +
      " vs " +
      market.awayTeam +
      ".",
    "INFO",
    "paper_trade",
  );
  return bet;
}

export async function resetPaperBook(db: QvmDb) {
  await ensureSeeded(db);
  const [portfolio] = await db.select().from(userPortfolios).limit(1);
  const bets = await db.select().from(simulatedBets);
  const scheduled = (await getFixtureRows(db)).filter((fixture) => fixture.status === "SCHEDULED");
  await db.delete(simulatedBets).run();
  await db.delete(fixtures).where(eq(fixtures.status, "SCHEDULED")).run();
  if (portfolio) {
    await db.update(userPortfolios).set({ currentBankroll: 1000, initialBankroll: 1000, updatedAt: new Date().toISOString() }).where(eq(userPortfolios.id, portfolio.id)).run();
  }
  await logEvent(db, `Paper book reset: removed ${bets.length} simulated bets and ${scheduled.length} scheduled fixtures.`, "WARN", "paper_reset");
  return { removedBets: bets.length, removedScheduledFixtures: scheduled.length, currentBankroll: 1000 };
}

export async function settleCompletedBets(db: QvmDb) {
  await ensureSeeded(db);
  const pending = await db
    .select()
    .from(simulatedBets)
    .where(eq(simulatedBets.status, "PENDING"));
  const fixtureRows = await getFixtureRows(db);
  const quoteMap = await getLatestQuoteMap(db);
  const portfolio = await getPortfolio(db);
  let bankroll = portfolio.currentBankroll;
  let settledCount = 0;
  let pastKickoffWithoutResult = 0;
  for (const bet of pending) {
    const fixture = fixtureRows.find((item) => item.id === bet.fixtureId);
    if (
      !fixture ||
      fixture.homeGoals === null ||
      fixture.awayGoals === null
    ) {
      if (fixture && Date.parse(fixture.matchDate) < Date.now()) pastKickoffWithoutResult += 1;
      continue;
    }
    const actual: Selection =
      fixture.homeGoals > fixture.awayGoals
        ? "HOME"
        : fixture.homeGoals < fixture.awayGoals
          ? "AWAY"
          : "DRAW";
    const goalResult = goalBetWon(bet.selection, fixture.homeGoals, fixture.awayGoals);
    const won = goalResult === null ? actual === (bet.selection as Selection) : goalResult;
    const pnl = won ? bet.stakeAmount * (bet.marketOdds - 1) : -bet.stakeAmount;
    const closingQuote = quoteMap.get(bet.fixtureId);
    const closingOdds = closingQuote && !isGoalSelection(bet.selection)
      ? outcomeMarketOdds(closingQuote, bet.selection as Selection)
      : null;
    bankroll += pnl;
    settledCount += 1;
    await db
      .update(simulatedBets)
      .set({
        status: "SETTLED",
        outcome: won ? "WON" : "LOST",
        profitLoss: round(pnl, 2),
        closingOdds,
        clvPct:
          closingOdds && closingOdds > 1
            ? round((bet.marketOdds / closingOdds - 1) * 100, 4)
            : null,
      })
      .where(eq(simulatedBets.id, bet.id))
      .run();
  }
  if (settledCount > 0) {
    await db
      .update(userPortfolios)
      .set({
        currentBankroll: round(bankroll, 2),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(userPortfolios.id, portfolio.id))
      .run();
  }
  await logEvent(
    db,
    "Settlement pass completed: " + String(settledCount) + " paper positions settled" +
      (pastKickoffWithoutResult > 0
        ? "; " + String(pastKickoffWithoutResult) + " past-kickoff positions still await a full-time score."
        : "."),
    "INFO",
    "settlement",
  );
  return { settledCount, pastKickoffWithoutResult, currentBankroll: round(bankroll, 2) };
}

async function getRuntimeEnv() {
  try {
    const { env } = await import("cloudflare:workers");
    return env as unknown as {
      ODDS_API_KEY?: string;
      ODDS_API_REGIONS?: string;
      ODDS_API_MARKETS?: string;
      QVM_WORKER_SHARED_SECRET?: string;
      QVM_KILL_SWITCH?: string;
      LUNA_MODEL_LABEL?: string;
      OPENAI_API_KEY?: string;
      OPENAI_MODEL?: string;
      API_FOOTBALL_KEY?: string;
      API_FOOTBALL_API_KEY?: string;
      FOOTBALL_API_KEY?: string;
      SPORTMONKS_API_TOKEN?: string;
      SPORTMONKS_TOKEN?: string;
      SPORTSMONK_API_TOKEN?: string;
      FOOTBALL_SEASON?: string;
      FOOTBALL_DATA_API_KEY?: string;
    };
  } catch {
    return {};
  }
}

type SportmonksRecord = Record<string, unknown>;

function sportValue(record: SportmonksRecord, key: string) {
  return record[key];
}

function sportName(value: unknown) {
  return typeof value === "string" ? value : typeof value === "object" && value !== null && typeof (value as SportmonksRecord).name === "string" ? (value as SportmonksRecord).name as string : "";
}

function sportParticipants(item: SportmonksRecord) {
  const participants = Array.isArray(item.participants) ? item.participants as SportmonksRecord[] : [];
  const home = participants.find((participant) => participant.meta && (participant.meta as SportmonksRecord).location === "home") ?? participants[0];
  const away = participants.find((participant) => participant.meta && (participant.meta as SportmonksRecord).location === "away") ?? participants[1];
  return { home, away };
}

function sportParticipantId(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function sportScore(item: SportmonksRecord, location: "home" | "away") {
  const scores = Array.isArray(item.scores) ? item.scores as SportmonksRecord[] : [];
  const score = scores.find((value) => {
    if (String(value.participant ?? "").toLowerCase() === location) return true;
    const description = String(value.description ?? value.type ?? "").toLowerCase();
    return (description.includes("current") || description.includes("ft") || description.includes("full")) && String(value.score ?? "").toLowerCase().includes(location);
  }) ?? scores[scores.length - 1];
  const directGoals = sportValue(score ?? {}, "goals");
  const nestedScore = score?.score;
  const nestedGoals = nestedScore && typeof nestedScore === "object"
    ? sportValue(nestedScore as SportmonksRecord, "goals")
    : null;
  const goals = directGoals ?? nestedGoals;
  const numericGoals = typeof goals === "number" ? goals : Number(goals);
  return Number.isFinite(numericGoals) ? Math.trunc(numericGoals) : null;
}

export async function refreshSportmonks(db: QvmDb) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  const token = runtime.SPORTMONKS_API_TOKEN ?? runtime.SPORTMONKS_TOKEN ?? runtime.SPORTSMONK_API_TOKEN;
  if (!token) {
    await updateSourceHealth(db, "Sportmonks", "NOT_CONFIGURED", 0, "Add SPORTMONKS_API_TOKEN to enable lineups, injuries, xG and statistics.");
    return { source: "Sportmonks", updated: 0, status: "NOT_CONFIGURED" };
  }
  const now = new Date();
  // Results may be synced several days after kickoff. Keep a rolling window
  // wide enough to reconcile late result updates and paper positions placed
  // before the user last opened the app.
  const dateFrom = utcDateOnly(addUtcDays(now, -7));
  const dateTo = utcDateOnly(addUtcDays(now, 7));
  try {
    const endpoint = `/v3/football/fixtures/between/${dateFrom}/${dateTo}`;
    const params = new URLSearchParams({
      api_token: token,
      include: "participants;scores;lineups.player;events;statistics.type",
    });
    const response = await fetch(`https://api.sportmonks.com${endpoint}?${params.toString()}`, { signal: AbortSignal.timeout(10_000) });
    const payload = await response.json().catch(() => ({})) as SportmonksRecord;
    if (!response.ok || payload.message) throw new Error(`Sportmonks returned HTTP ${response.status}: ${String(payload.message ?? "request failed")}`);
    const fixtureRows = await getFixtureRows(db);
    const pendingRows = await db.select().from(simulatedBets).where(eq(simulatedBets.status, "PENDING"));
    const resultDates = new Set(
      pendingRows
        .map((bet) => fixtureRows.find((fixture) => fixture.id === bet.fixtureId))
        .filter((fixture): fixture is FixtureRow => Boolean(fixture) && Date.parse(fixture.matchDate) < Date.now())
        .map((fixture) => utcDateOnly(new Date(fixture.matchDate))),
    );
    const items = Array.isArray(payload.data) ? payload.data as SportmonksRecord[] : [];
    // The date-range endpoint can omit a recently completed fixture depending
    // on pagination/cache state. Re-query the exact dates of unresolved bets;
    // this is bounded by the number of distinct past kickoff dates.
    const seenItems = new Set(items.map((item) => String(item.id ?? `${item.starting_at}|${JSON.stringify(item.participants ?? [])}`)));
    for (const resultDate of resultDates) {
      const dateEndpoint = `/v3/football/fixtures/date/${resultDate}`;
      const dateResponse = await fetch(`https://api.sportmonks.com${dateEndpoint}?${params.toString()}`, { signal: AbortSignal.timeout(10_000) });
      const datePayload = await dateResponse.json().catch(() => ({})) as SportmonksRecord;
      if (!dateResponse.ok || datePayload.message) continue;
      for (const item of (Array.isArray(datePayload.data) ? datePayload.data as SportmonksRecord[] : [])) {
        const key = String(item.id ?? `${item.starting_at}|${JSON.stringify(item.participants ?? [])}`);
        if (!seenItems.has(key)) {
          items.push(item);
          seenItems.add(key);
        }
      }
    }
    const teamsRows = await getTeamRows(db);
    const teamMap = new Map(teamsRows.map((team) => [normaliseName(team.name), team]));
    const getOrCreateTeam = async (name: string) => {
      const key = normaliseName(name);
      const existing = teamMap.get(key);
      if (existing || !name.trim()) return existing ?? null;
      const [created] = await db.insert(teams).values({ name: name.trim(), league: "Premier League" }).returning();
      if (created) teamMap.set(key, created);
      return created ?? null;
    };
    let updated = 0;
    let lineups = 0;
    let features = 0;
    const existingAvailability = await db.select().from(availabilitySnapshots);
    const seenAvailability = new Set(
      existingAvailability.map((row) => `${row.fixtureId}|${row.teamId}|${row.playerName}|${row.status}|${row.expectedMinutes}`),
    );
    const capturedAt = new Date().toISOString();
    const saveAvailability = async (
      fixtureId: number,
      teamId: number,
      playerName: string,
      status: string,
      expectedMinutes: number,
      confidence: number,
      payload: unknown,
    ) => {
      const cleanName = playerName.trim();
      if (!cleanName) return false;
      const key = `${fixtureId}|${teamId}|${cleanName}|${status}|${expectedMinutes}`;
      if (seenAvailability.has(key)) return false;
      await db.insert(availabilitySnapshots).values({
        fixtureId,
        teamId,
        playerName: cleanName,
        status,
        expectedMinutes,
        source: "Sportmonks",
        confidence,
        capturedAt,
        availableAt: capturedAt,
        payload: JSON.stringify(payload).slice(0, 12000),
      }).run();
      seenAvailability.add(key);
      return true;
    };
    for (const item of items.slice(0, 500)) {
      const participants = sportParticipants(item);
      const homeName = sportName(sportValue(participants.home ?? {}, "name"));
      const awayName = sportName(sportValue(participants.away ?? {}, "name"));
      const home = await getOrCreateTeam(homeName);
      const away = await getOrCreateTeam(awayName);
      const matchDate = normaliseIsoDate(typeof item.starting_at === "string" ? item.starting_at : typeof item.starting_at_timestamp === "number" ? new Date(item.starting_at_timestamp * 1000).toISOString() : undefined);
      if (!home || !away || !matchDate) continue;
      const homeGoals = sportScore(item, "home");
      const awayGoals = sportScore(item, "away");
      const state = String((item.state as SportmonksRecord | undefined)?.state ?? item.status ?? "").toLowerCase();
      const status = /finished|ended|ft|complete/.test(state) || (homeGoals !== null && awayGoals !== null && !/scheduled|not started|ns/.test(state)) ? "COMPLETED" : "SCHEDULED";
      let fixture = fixtureRows.find((row) => row.homeTeamId === home.id && row.awayTeamId === away.id && Math.abs(Date.parse(row.matchDate) - Date.parse(matchDate)) < 36 * 60 * 60 * 1000);
      if (!fixture) {
        await db.insert(fixtures).values({ homeTeamId: home.id, awayTeamId: away.id, matchDate, homeGoals: null, awayGoals: null, status: "SCHEDULED" }).onConflictDoNothing().run();
        fixture = (await getFixtureRows(db)).find((row) => row.homeTeamId === home.id && row.awayTeamId === away.id && row.matchDate === matchDate);
      }
      if (!fixture) continue;
      await db.update(fixtures).set({ status, homeGoals, awayGoals }).where(eq(fixtures.id, fixture.id)).run();
      const lineupRows = Array.isArray(item.lineups) ? item.lineups as SportmonksRecord[] : [];
      if (lineupRows.length > 0) lineups += 1;
      const participantTeams = new Map<string, { id: number }>();
      for (const participant of [participants.home, participants.away]) {
        if (!participant) continue;
        const participantName = sportName(participant.name);
        const participantTeam = teamMap.get(normaliseName(participantName));
        const participantId = sportParticipantId(participant.id);
        if (participantTeam && participantId) participantTeams.set(participantId, participantTeam);
      }
      for (const lineup of lineupRows.slice(0, 200)) {
        const groupedPlayers = Array.isArray(lineup.players) ? lineup.players as SportmonksRecord[] : null;
        const playerEntries = groupedPlayers ?? [lineup];
        const lineupTeamName = sportName(sportValue(lineup.team as SportmonksRecord ?? {}, "name"));
        const groupedTeam = teamMap.get(normaliseName(lineupTeamName));
        const rowTeam = groupedTeam ?? participantTeams.get(sportParticipantId(lineup.team_id));
        if (!rowTeam) continue;
        for (const entry of playerEntries.slice(0, 40)) {
          const player = (entry.player as SportmonksRecord | undefined) ?? entry;
          const starter = entry.starter === true || String(entry.type?.name ?? entry.type ?? "").toLowerCase().includes("starter") || (entry.meta as SportmonksRecord | undefined)?.position === "starting";
          await saveAvailability(fixture.id, rowTeam.id, String(player.name ?? ""), starter ? "STARTER" : "AVAILABLE", Number(entry.minutes ?? 0), 0.85, entry);
        }
      }
      const statistics = Array.isArray(item.statistics) ? item.statistics as SportmonksRecord[] : [];
      const statValues = statistics.flatMap((row) => Array.isArray(row.statistics) ? row.statistics as SportmonksRecord[] : [row]);
      const numberFor = (needle: string) => {
        const value = statValues.find((row) => String(row.type?.name ?? row.name ?? "").toLowerCase().includes(needle));
        const raw = value?.data && typeof value.data === "object" ? (value.data as SportmonksRecord).value : value?.value;
        return typeof raw === "number" ? raw : null;
      };
      const xg = numberFor("expected goals");
      if (xg !== null) {
        await db.insert(fixtureFeatures).values({ fixtureId: fixture.id, source: "Sportmonks", capturedAt: new Date().toISOString(), availableAt: new Date().toISOString(), payload: JSON.stringify(item) }).run();
        features += 1;
      }
      updated += 1;
    }
    await updateTeamStrengths(db);
    await rebuildPredictions(db, true, true);
    const message = `Sportmonks checked ${items.length} fixtures, matched ${updated}, published lineups for ${lineups}, and stored ${features} feature snapshots.`;
    await updateSourceHealth(db, "Sportmonks", "READY", updated, message);
    await db.insert(dataSnapshots).values({ source: "Sportmonks", endpoint, contentHash: `sportmonks:${dateFrom}:${dateTo}:${Date.now()}`, payload: JSON.stringify({ dateFrom, dateTo, fixturesReturned: items.length, matched: updated, lineups, features }), capturedAt: new Date().toISOString(), availableAt: new Date().toISOString(), freshnessSeconds: 0, status: "VALID" }).run();
    await logEvent(db, message, "INFO", "sportmonks");
    return { source: "Sportmonks", updated, status: "READY", dateFrom, dateTo, fixturesReturned: items.length, lineups, features };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Sportmonks error";
    await updateSourceHealth(db, "Sportmonks", "ERROR", 0, message);
    await logEvent(db, `Sportmonks enrichment failed: ${message}`, "ERROR", "sportmonks");
    throw error;
  }
}

export async function refreshFootballDataOrg(db: QvmDb) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  if (!runtime.FOOTBALL_DATA_API_KEY) {
    await updateSourceHealth(db, "football-data.org", "NOT_CONFIGURED", 0, "Add FOOTBALL_DATA_API_KEY to enable fixture and result synchronisation.");
    return { source: "football-data.org", updated: 0, status: "NOT_CONFIGURED" };
  }
  const now = new Date();
  const dateFrom = utcDateOnly(addUtcDays(now, -FOOTBALL_DATA_LOOKBACK_DAYS));
  const dateTo = utcDateOnly(addUtcDays(now, FOOTBALL_DATA_LOOKAHEAD_DAYS));
  try {
    const endpoint = `/v4/competitions/PL/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const response = await fetch(`https://api.football-data.org${endpoint}`, {
      headers: { "X-Auth-Token": runtime.FOOTBALL_DATA_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`football-data.org returned HTTP ${response.status}.`);
    const payload = await response.json() as { matches?: Array<{ id?: number; utcDate?: string; status?: string; homeTeam?: { name?: string }; awayTeam?: { name?: string }; score?: { fullTime?: { home?: number | null; away?: number | null } } }> };
    const teamRows = await getTeamRows(db);
    const teamMap = new Map(teamRows.map((team) => [normaliseName(team.name), team]));
    const getOrCreate = async (value: string) => {
      const key = normaliseName(value);
      const found = teamMap.get(key);
      if (found) return found;
      const [created] = await db.insert(teams).values({ name: value, league: "Premier League" }).returning();
      if (created) teamMap.set(key, created);
      return created;
    };
    const fixturesRows = await getFixtureRows(db);
    let updated = 0;
    for (const match of (payload.matches ?? []).slice(0, 500)) {
      const home = await getOrCreate(match.homeTeam?.name ?? "");
      const away = await getOrCreate(match.awayTeam?.name ?? "");
      const matchDate = normaliseIsoDate(match.utcDate);
      if (!home || !away || !matchDate || home.id === away.id) continue;
      const scoreHome = asNumber(match.score?.fullTime?.home);
      const scoreAway = asNumber(match.score?.fullTime?.away);
      const status = match.status === "FINISHED" || (scoreHome !== null && scoreAway !== null) ? "COMPLETED" : "SCHEDULED";
      // Provider kickoff timestamps can differ after timezone conversion or a
      // reschedule. Match the same teams within a bounded 36-hour window so a
      // valid final score updates the bet's original fixture instead of
      // creating an orphan duplicate.
      const existing = fixturesRows
        .filter((fixture) => fixture.homeTeamId === home.id && fixture.awayTeamId === away.id)
        .map((fixture) => ({ fixture, distance: Math.abs(Date.parse(fixture.matchDate) - Date.parse(matchDate)) }))
        .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 36 * 60 * 60 * 1000)
        .sort((left, right) => left.distance - right.distance)[0]?.fixture;
      if (existing) {
        await db.update(fixtures).set({ status, homeGoals: scoreHome === null ? null : Math.trunc(scoreHome), awayGoals: scoreAway === null ? null : Math.trunc(scoreAway) }).where(eq(fixtures.id, existing.id)).run();
      } else {
        await db.insert(fixtures).values({ homeTeamId: home.id, awayTeamId: away.id, matchDate, status, homeGoals: scoreHome === null ? null : Math.trunc(scoreHome), awayGoals: scoreAway === null ? null : Math.trunc(scoreAway) }).run();
      }
      updated += 1;
    }
    await db.insert(dataSnapshots).values({
      source: "football-data.org",
      endpoint,
      contentHash: `football-data:${dateFrom}:${dateTo}:${Date.now()}`,
      payload: JSON.stringify({ dateFrom, dateTo, matchCount: payload.matches?.length ?? 0 }),
      capturedAt: new Date().toISOString(),
      availableAt: new Date().toISOString(),
      freshnessSeconds: 0,
      status: "VALID",
    }).run();
    const model = await updateTeamStrengths(db);
    await rebuildPredictions(db, true, true);
    await updateSourceHealth(db, "football-data.org", "READY", updated);
    await logEvent(db, `football-data.org synchronisation completed: ${updated} Premier League fixtures.`, "INFO", "football_data");
    return { source: "football-data.org", updated, status: "READY", dateFrom, dateTo, model };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown football-data.org error";
    await updateSourceHealth(db, "football-data.org", "ERROR", 0, message);
    await logEvent(db, `football-data.org synchronisation failed: ${message}`, "ERROR", "football_data");
    throw error;
  }
}

type OddsScoreEvent = {
  commence_time?: string;
  completed?: boolean;
  home_team?: string;
  away_team?: string;
  scores?: Array<{ name?: string; score?: string | number | null }>;
};

/**
 * Reconcile final scores from The Odds API as a third independent result
 * source. Its scores endpoint uses the same event universe as the odds feed
 * and can return completed games from the previous seven days.
 */
export async function refreshResultsFromTheOddsAPI(db: QvmDb) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  if (!runtime.ODDS_API_KEY) {
    return { source: "The Odds API scores", updated: 0, status: "NOT_CONFIGURED" };
  }
  const fixtureRows = await getFixtureRows(db);
  const teamsRows = await getTeamRows(db);
  let updated = 0;
  let events = 0;
  const failures: string[] = [];
  for (const league of LEAGUE_CONFIGS) {
    try {
      // The scores endpoint rejects lookbacks larger than three days (HTTP 422).
      // Three days covers the normal post-kickoff settlement window while
      // keeping this fallback within the provider's supported contract.
      const params = new URLSearchParams({ apiKey: runtime.ODDS_API_KEY, daysFrom: "3" });
      const response = await fetch(`https://api.the-odds-api.com/v4/sports/${league.oddsSport}/scores?${params.toString()}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = await response.json() as OddsScoreEvent[];
      events += items.length;
      for (const item of items) {
        if (item.completed !== true || !item.home_team || !item.away_team || !item.commence_time) continue;
        const home = teamsRows.find((team) => normaliseName(team.name) === normaliseName(item.home_team ?? ""));
        const away = teamsRows.find((team) => normaliseName(team.name) === normaliseName(item.away_team ?? ""));
        const kickoff = Date.parse(item.commence_time);
        if (!home || !away || !Number.isFinite(kickoff)) continue;
        const fixture = fixtureRows
          .filter((row) => row.homeTeamId === home.id && row.awayTeamId === away.id && row.league === league.name)
          .map((row) => ({ row, distance: Math.abs(Date.parse(row.matchDate) - kickoff) }))
          .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 36 * 60 * 60 * 1000)
          .sort((left, right) => left.distance - right.distance)[0]?.row;
        if (!fixture) continue;
        const scoreFor = (teamName: string) => {
          const score = item.scores?.find((entry) => normaliseName(entry.name ?? "") === normaliseName(teamName))?.score;
          const value = Number(score);
          return Number.isFinite(value) ? Math.trunc(value) : null;
        };
        const homeGoals = scoreFor(item.home_team);
        const awayGoals = scoreFor(item.away_team);
        if (homeGoals === null || awayGoals === null) continue;
        await db.update(fixtures).set({ status: "COMPLETED", homeGoals, awayGoals }).where(eq(fixtures.id, fixture.id)).run();
        updated += 1;
      }
    } catch (error) {
      failures.push(`${league.name}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  const message = `The Odds API scores checked ${events} events and reconciled ${updated} completed fixtures.` + (failures.length ? ` ${failures.join("; ")}` : "");
  await logEvent(db, message, failures.length === LEAGUE_CONFIGS.length ? "ERROR" : "INFO", "odds_scores");
  return { source: "The Odds API scores", updated, events, status: failures.length === LEAGUE_CONFIGS.length ? "ERROR" : failures.length ? "PARTIAL" : "READY", message };
}

type SportsDbEvent = {
  strHomeTeam?: string;
  strAwayTeam?: string;
  strTimestamp?: string;
  dateEvent?: string;
  intHomeScore?: string | number | null;
  intAwayScore?: string | number | null;
};

/**
 * Targeted fallback for unresolved past paper bets. Some odds/result feeds
 * omit matches once they leave their active event universe, while TheSportsDB
 * keeps a searchable event record with the final score.
 */
export async function refreshResultsFromTheSportsDB(db: QvmDb) {
  await ensureSeeded(db);
  const pending = await db.select().from(simulatedBets).where(eq(simulatedBets.status, "PENDING"));
  const fixtureRows = await getFixtureRows(db);
  const teamsRows = await getTeamRows(db);
  const unresolved = fixtureRows.filter((fixture) =>
    pending.some((bet) => bet.fixtureId === fixture.id) &&
    Date.parse(fixture.matchDate) < Date.now() &&
    (fixture.homeGoals === null || fixture.awayGoals === null),
  );
  let checked = 0;
  let updated = 0;
  for (const fixture of unresolved.slice(0, 20)) {
    const home = teamsRows.find((team) => team.id === fixture.homeTeamId);
    const away = teamsRows.find((team) => team.id === fixture.awayTeamId);
    if (!home || !away) continue;
    checked += 1;
    const query = encodeURIComponent(`${home.name} vs ${away.name}`);
    try {
      const response = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=${query}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({})) as { event?: SportsDbEvent[] };
      const event = (payload.event ?? []).find((candidate) => {
        const homeMatch = normaliseName(candidate.strHomeTeam ?? "") === normaliseName(home.name);
        const awayMatch = normaliseName(candidate.strAwayTeam ?? "") === normaliseName(away.name);
        const eventTime = Date.parse(candidate.strTimestamp ?? candidate.dateEvent ?? "");
        return homeMatch && awayMatch && Number.isFinite(eventTime) && Math.abs(eventTime - Date.parse(fixture.matchDate)) <= 36 * 60 * 60 * 1000;
      });
      const homeGoals = event ? Number(event.intHomeScore) : NaN;
      const awayGoals = event ? Number(event.intAwayScore) : NaN;
      if (!event || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
      await db.update(fixtures).set({ status: "COMPLETED", homeGoals: Math.trunc(homeGoals), awayGoals: Math.trunc(awayGoals) }).where(eq(fixtures.id, fixture.id)).run();
      updated += 1;
    } catch {
      // A fallback outage must never block the primary result feeds.
    }
  }
  const message = `TheSportsDB checked ${checked} unresolved fixtures and reconciled ${updated} final scores.`;
  await logEvent(db, message, "INFO", "sportsdb_scores");
  return { source: "TheSportsDB scores", checked, updated, status: "READY", message };
}

type ApiFootballEnvelope<T> = {
  response?: T[];
  errors?: Record<string, unknown> | unknown[];
  results?: number;
};

type ApiFootballFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string; long?: string };
  };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
};

type ApiFootballLineup = {
  team?: { id?: number; name?: string };
  players?: Array<{
    player?: { id?: number; name?: string };
    statistics?: Array<{
      games?: {
        minutes?: number | null;
        substitute?: boolean | null;
        starter?: boolean | null;
      };
    }>;
  }>;
};

type ApiFootballInjury = {
  player?: { id?: number; name?: string; type?: string; reason?: string };
  team?: { id?: number; name?: string };
};

function apiFootballErrorText(errors: unknown) {
  if (!errors) return "";
  if (Array.isArray(errors)) return errors.map((value) => String(value)).join(", ");
  if (typeof errors !== "object") return String(errors);
  return Object.entries(errors as Record<string, unknown>)
    .map(([key, value]) => {
      const detail = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
      return `${key}: ${detail}`;
    })
    .join("; ");
}

async function requestApiFootball<T>(
  url: string,
  headers: Record<string, string>,
  label: string,
) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as ApiFootballEnvelope<T> | null;
  const providerError = apiFootballErrorText(payload?.errors);
  if (!response.ok || providerError) {
    const status = response.ok ? "HTTP 200" : `HTTP ${response.status}`;
    throw new Error(`API-Football ${label} returned ${status}${providerError ? `: ${providerError}` : "."}`);
  }
  return {
    payload: payload ?? {},
    requestsRemaining: response.headers.get("x-ratelimit-requests-remaining"),
  };
}

function apiFootballSeasonDefault() {
  const now = new Date();
  return String(now.getUTCMonth() < 6 ? now.getUTCFullYear() - 1 : now.getUTCFullYear());
}

function utcDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function findApiFootballFixture(
  fixtureRows: FixtureRow[],
  teamsRows: Array<{ id: number; name: string }>,
  item: ApiFootballFixture,
) {
  const homeKey = normaliseName(item.teams?.home?.name ?? "");
  const awayKey = normaliseName(item.teams?.away?.name ?? "");
  if (!homeKey || !awayKey) return null;
  const home = teamsRows.find((team) => normaliseName(team.name) === homeKey);
  const away = teamsRows.find((team) => normaliseName(team.name) === awayKey);
  if (!home || !away) return null;
  const candidates = fixtureRows.filter(
    (fixture) =>
      fixture.status === "SCHEDULED" &&
      fixture.homeTeamId === home.id &&
      fixture.awayTeamId === away.id,
  );
  if (candidates.length === 0) return null;
  const providerTime = Date.parse(item.fixture?.date ?? "");
  if (!Number.isFinite(providerTime)) return candidates[0];
  return candidates
    .map((fixture) => ({
      fixture,
      distance: Math.abs(Date.parse(fixture.matchDate) - providerTime),
    }))
    .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 36 * 60 * 60 * 1000)
    .sort((left, right) => left.distance - right.distance)[0]?.fixture ?? null;
}

export async function refreshFootballEnrichment(db: QvmDb) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  const apiFootballKey = runtime.API_FOOTBALL_KEY ?? runtime.API_FOOTBALL_API_KEY ?? runtime.FOOTBALL_API_KEY;
  if (!apiFootballKey) {
    await updateSourceHealth(db, "API-Football", "NOT_CONFIGURED", 0, "Add API_FOOTBALL_KEY to enable lineup and fixture enrichment.");
    return { source: "API-Football", updated: 0, status: "NOT_CONFIGURED" };
  }
  const season = runtime.FOOTBALL_SEASON?.trim() || apiFootballSeasonDefault();
  try {
    const base = "https://v3.football.api-sports.io";
    const headers = { "x-apisports-key": apiFootballKey };
    const now = new Date();
    const dateFrom = utcDateOnly(addUtcDays(now, -1));
    const dateTo = utcDateOnly(addUtcDays(now, API_FOOTBALL_LOOKAHEAD_DAYS));
    const fixtureUrl = `${base}/fixtures?league=${API_FOOTBALL_LEAGUE_ID}&season=${encodeURIComponent(season)}&from=${dateFrom}&to=${dateTo}&timezone=UTC`;
    const fixtureRequest = await requestApiFootball<ApiFootballFixture>(fixtureUrl, headers, "fixtures");
    const fixturePayload = fixtureRequest.payload;
    const fixtureRows = await getFixtureRows(db);
    const teamsRows = await getTeamRows(db);
    const nameMap = new Map(teamsRows.map((team) => [normaliseName(team.name), team]));
    const fixtureIdMap = new Map(
      fixtureRows
        .filter((fixture) => fixture.apiFootballFixtureId)
        .map((fixture) => [fixture.apiFootballFixtureId as number, fixture]),
    );
    const matchedFixtures = (fixturePayload.response ?? [])
      .map((item) => {
        const apiFixtureId = item.fixture?.id;
        const existingByProviderId = apiFixtureId ? fixtureIdMap.get(apiFixtureId) : undefined;
        const fixture = existingByProviderId ?? findApiFootballFixture(fixtureRows, teamsRows, item);
        return fixture && apiFixtureId ? { item, fixture, apiFixtureId } : null;
      })
      .filter((value): value is { item: ApiFootballFixture; fixture: FixtureRow; apiFixtureId: number } => Boolean(value));
    for (const { fixture, apiFixtureId } of matchedFixtures) {
      if (fixture.apiFootballFixtureId === apiFixtureId) continue;
      const conflictingFixture = fixtureIdMap.get(apiFixtureId);
      if (conflictingFixture && conflictingFixture.id !== fixture.id) continue;
      await db
        .update(fixtures)
        .set({ apiFootballFixtureId: apiFixtureId })
        .where(eq(fixtures.id, fixture.id))
        .run();
      fixture.apiFootballFixtureId = apiFixtureId;
    }
    const detailCandidates = matchedFixtures
      .filter(({ item }) => {
        const timestamp = Date.parse(item.fixture?.date ?? "");
        return !Number.isFinite(timestamp) || (
          timestamp >= Date.now() - 6 * 60 * 60 * 1000 &&
          timestamp <= Date.now() + API_FOOTBALL_LINEUP_WINDOW_HOURS * 60 * 60 * 1000
        );
      })
      .sort((left, right) => Date.parse(left.item.fixture?.date ?? "") - Date.parse(right.item.fixture?.date ?? ""))
      .slice(0, API_FOOTBALL_MAX_DETAIL_FIXTURES);
    const existingAvailability = await db.select().from(availabilitySnapshots);
    const seenAvailability = new Set(
      existingAvailability.map((row) => `${row.fixtureId}|${row.teamId}|${row.playerName}|${row.status}|${row.expectedMinutes}`),
    );
    const capturedAt = new Date().toISOString();
    let updated = 0;
    let lineupFixtures = 0;
    let lineupRecords = 0;
    let injuryFixtures = 0;
    let injuryRecords = 0;
    let requests = 1;
    let requestsRemaining = fixtureRequest.requestsRemaining;
    const warnings: string[] = [];
    const saveAvailability = async (
      fixtureId: number,
      teamId: number,
      playerName: string,
      status: string,
      expectedMinutes: number,
      confidence: number,
      payload: unknown,
    ) => {
      const cleanName = playerName.trim();
      if (!cleanName) return false;
      const key = `${fixtureId}|${teamId}|${cleanName}|${status}|${expectedMinutes}`;
      if (seenAvailability.has(key)) return false;
      await db.insert(availabilitySnapshots).values({
        fixtureId,
        teamId,
        playerName: cleanName,
        status,
        expectedMinutes,
        source: "API-Football",
        confidence,
        capturedAt,
        availableAt: capturedAt,
        payload: JSON.stringify(payload).slice(0, 12000),
      }).run();
      seenAvailability.add(key);
      updated += 1;
      return true;
    };
    const resolveTeam = (providerName: string, fixture: FixtureRow, homeName: string, awayName: string) => {
      const direct = nameMap.get(normaliseName(providerName));
      if (direct) return direct;
      if (normaliseName(providerName) === normaliseName(homeName)) return teamsRows.find((team) => team.id === fixture.homeTeamId);
      if (normaliseName(providerName) === normaliseName(awayName)) return teamsRows.find((team) => team.id === fixture.awayTeamId);
      return undefined;
    };
    let rateLimited = false;
    for (const { item, fixture, apiFixtureId } of detailCandidates) {
      if (rateLimited) break;
      let lineupPayload: ApiFootballEnvelope<ApiFootballLineup> | null = null;
      requests += 1;
      try {
        const lineupRequest = await requestApiFootball<ApiFootballLineup>(`${base}/fixtures/lineups?fixture=${apiFixtureId}`, headers, "lineups");
        lineupPayload = lineupRequest.payload;
        requestsRemaining = lineupRequest.requestsRemaining ?? requestsRemaining;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lineup request failed.";
        warnings.push(message);
        rateLimited = /429|rate.?limit|too many requests/i.test(message);
      }
      if (lineupPayload) {
        if ((lineupPayload.response ?? []).length > 0) lineupFixtures += 1;
        for (const lineup of (lineupPayload.response ?? []).slice(0, 2)) {
          const team = resolveTeam(
            lineup.team?.name ?? "",
            fixture,
            item.teams?.home?.name ?? "",
            item.teams?.away?.name ?? "",
          );
          if (!team) continue;
          for (const player of (lineup.players ?? []).slice(0, 40)) {
            const game = player.statistics?.[0]?.games;
            const status = game?.starter ? "STARTER" : game?.substitute ? "BENCH" : "AVAILABLE";
            if (await saveAvailability(
              fixture.id,
              team.id,
              player.player?.name ?? "",
              status,
              game?.minutes ?? 0,
              0.95,
              player,
            )) lineupRecords += 1;
          }
        }
      }
      if (rateLimited) break;
      requests += 1;
      try {
        const injuryRequest = await requestApiFootball<ApiFootballInjury>(`${base}/injuries?fixture=${apiFixtureId}`, headers, "injuries");
        requestsRemaining = injuryRequest.requestsRemaining ?? requestsRemaining;
        if ((injuryRequest.payload.response ?? []).length > 0) injuryFixtures += 1;
        for (const injury of (injuryRequest.payload.response ?? []).slice(0, 80)) {
          const team = resolveTeam(
            injury.team?.name ?? "",
            fixture,
            item.teams?.home?.name ?? "",
            item.teams?.away?.name ?? "",
          );
          if (!team) continue;
          const reason = injury.player?.reason ?? injury.player?.type ?? "Reported unavailable";
          const status = /doubt|question|late|uncertain/i.test(reason) ? "DOUBTFUL" : "INJURED";
          if (await saveAvailability(
            fixture.id,
            team.id,
            injury.player?.name ?? "",
            status,
            0,
            0.8,
            injury,
          )) injuryRecords += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Injury request failed.";
        warnings.push(message);
        rateLimited = /429|rate.?limit|too many requests/i.test(message);
      }
    }
    const partial = warnings.length > 0 || (
      (fixturePayload.response ?? []).length > 0 && matchedFixtures.length === 0
    );
    const message = [
      `Checked ${fixturePayload.response?.length ?? 0} provider fixtures from ${dateFrom} to ${dateTo}; matched ${matchedFixtures.length} to local scheduled fixtures.`,
      `${lineupFixtures} fixture${lineupFixtures === 1 ? "" : "s"} returned published lineups (${lineupRecords} new player snapshots).`,
      `${injuryFixtures} fixture${injuryFixtures === 1 ? "" : "s"} returned injuries (${injuryRecords} new records).`,
      lineupFixtures === 0 ? "Lineups are normally published 20–40 minutes before kickoff." : "",
      requestsRemaining ? `API requests remaining: ${requestsRemaining}.` : "",
      warnings.length > 0 ? `Warnings: ${warnings.slice(0, 2).join(" | ")}` : "",
    ].filter(Boolean).join(" ");
    const status = partial ? "PARTIAL" : "READY";
    await updateSourceHealth(db, "API-Football", status, updated, message);
    await db.insert(dataSnapshots).values({
      source: "API-Football",
      endpoint: "/v3/fixtures + /v3/fixtures/lineups + /v3/injuries",
      contentHash: `api-football:${season}:${Date.now()}`,
      payload: JSON.stringify({ season, dateFrom, dateTo, fixturesReturned: fixturePayload.response?.length ?? 0, fixturesMatched: matchedFixtures.length, detailFixturesChecked: detailCandidates.length, lineupFixtures, lineupRecords, injuryFixtures, injuryRecords, requests, requestsRemaining }),
      capturedAt,
      availableAt: capturedAt,
      freshnessSeconds: 0,
      status: status === "READY" ? "VALID" : "PARTIAL",
    }).run();
    await logEvent(db, `API-Football enrichment ${status.toLowerCase()}: ${lineupRecords} lineup and ${injuryRecords} injury records across ${matchedFixtures.length} matched fixtures.`, partial ? "WARN" : "INFO", "data_enrichment");
    return { source: "API-Football", updated, status, message, season, dateFrom, dateTo, fixturesReturned: fixturePayload.response?.length ?? 0, fixturesMatched: matchedFixtures.length, detailFixturesChecked: detailCandidates.length, lineupFixtures, lineupRecords, injuryFixtures, injuryRecords, requests, requestsRemaining };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown API-Football error";
    await updateSourceHealth(db, "API-Football", "ERROR", 0, message);
    await logEvent(db, `API-Football enrichment failed: ${message}`, "ERROR", "data_enrichment");
    throw error;
  }
}

async function runtimeHasOddsKey() {
  const runtime = await getRuntimeEnv();
  return Boolean(runtime.ODDS_API_KEY);
}

export async function refreshOddsFromTheOddsAPI(db: QvmDb, league = LEAGUE_CONFIGS[0], rebuild = true) {
  await ensureSeeded(db);
  const runtime = await getRuntimeEnv();
  if (!runtime.ODDS_API_KEY) {
    await updateSourceHealth(db, "The Odds API", "NOT_CONFIGURED", 0, "Add ODDS_API_KEY to replace the seeded demo snapshot with live prices.");
    await logEvent(
      db,
      "Odds refresh used the seeded demo snapshot because ODDS_API_KEY is not configured.",
      "INFO",
      "odds_refresh",
    );
    return { source: "Demo snapshot", updated: 0, status: "NOT_CONFIGURED" };
  }
  try {
    const params = new URLSearchParams({
      apiKey: runtime.ODDS_API_KEY,
      regions: runtime.ODDS_API_REGIONS ?? "uk",
      // `h2h` and `totals` are broadly supported across EPL bookmakers.
      // BTTS is parsed when a provider returns it, but requesting it by
      // default causes a 422 for accounts/regions where it is unavailable.
      markets: runtime.ODDS_API_MARKETS ?? "h2h,totals",
      oddsFormat: "decimal",
    });
    const response = await fetch(
      `https://api.the-odds-api.com/v4/sports/${league.oddsSport}/odds/?` +
        params.toString(),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      throw new Error("The Odds API returned HTTP " + String(response.status) + ".");
    }
    const events = (await response.json()) as Array<{
      commence_time?: string;
      home_team?: string;
      away_team?: string;
      bookmakers?: Array<{
        title?: string;
        markets?: Array<{
          key?: string;
          outcomes?: Array<{ name?: string; price?: number; point?: number }>;
        }>;
      }>;
    }>;
    const fixtureRows = await getFixtureRows(db);
    const teamsRows = await getTeamRows(db);
    const nameMap = new Map(
      teamsRows.map((team) => [normaliseName(team.name), team]),
    );
    const getOrCreateTeam = async (name: string) => {
      const key = normaliseName(name);
      const existing = nameMap.get(key);
      if (existing) return existing;
      if (!name.trim()) return null;
      const [created] = await db.insert(teams).values({ name: name.trim(), league: league.name }).returning();
      if (created) nameMap.set(key, created);
      return created ?? null;
    };
    let updated = 0;
    for (const event of events) {
      const home = await getOrCreateTeam(event.home_team ?? "");
      const away = await getOrCreateTeam(event.away_team ?? "");
      if (!home || !away) continue;
      let fixture = fixtureRows.find(
        (row) =>
          row.status === "SCHEDULED" &&
          row.league === league.name &&
          row.homeTeamId === home.id &&
          row.awayTeamId === away.id,
      );
      if (!fixture && event.commence_time) {
        const matchDate = normaliseIsoDate(event.commence_time);
        if (matchDate) {
          await db.insert(fixtures).values({ homeTeamId: home.id, awayTeamId: away.id, league: league.name, matchDate, status: "SCHEDULED" }).onConflictDoNothing().run();
          fixture = (await getFixtureRows(db)).find((row) => row.homeTeamId === home.id && row.awayTeamId === away.id && row.matchDate === matchDate && row.league === league.name);
        }
      }
      // Aggregate valid h2h markets instead of silently selecting the first
      // bookmaker. This keeps the displayed price real while preserving the
      // breadth of the source for quality gating.
      const h2hBooks = (event.bookmakers ?? []).flatMap((bookmaker) => {
        const market = (bookmaker.markets ?? []).find((item) => item.key === "h2h");
        const outcomes = market?.outcomes ?? [];
        const priceFor = (name: string) => outcomes.find(
          (outcome) => normaliseName(outcome.name ?? "") === normaliseName(name),
        )?.price;
        const homePrice = priceFor(event.home_team ?? "");
        const awayPrice = priceFor(event.away_team ?? "");
        const drawPrice = outcomes.find(
          (outcome) => normaliseName(outcome.name ?? "") === "draw",
        )?.price;
        return typeof homePrice === "number" && homePrice > 1 &&
          typeof drawPrice === "number" && drawPrice > 1 &&
          typeof awayPrice === "number" && awayPrice > 1
          ? [{ title: bookmaker.title ?? "The Odds API", homeOdds: homePrice, drawOdds: drawPrice, awayOdds: awayPrice }]
          : [];
      });
      const bookmakerCount = h2hBooks.length;
      const homeOdds = Math.max(...h2hBooks.map((book) => book.homeOdds), 0);
      const drawOdds = Math.max(...h2hBooks.map((book) => book.drawOdds), 0);
      const awayOdds = Math.max(...h2hBooks.map((book) => book.awayOdds), 0);
      if (!fixture || !homeOdds || !drawOdds || !awayOdds) continue;
      const consensus = devigProbabilities(homeOdds, drawOdds, awayOdds);
      await db
        .insert(marketQuotes)
        .values({
          fixtureId: fixture.id,
          provider: `The Odds API · ${bookmakerCount} bookmakers`,
          homeOdds,
          drawOdds,
          awayOdds,
          capturedAt: new Date().toISOString(),
          consensusHomeProb: round(consensus.home, 6),
          consensusDrawProb: round(consensus.draw, 6),
          consensusAwayProb: round(consensus.away, 6),
          overround: round(consensus.overround, 6),
          bestHomeOdds: homeOdds,
          bestDrawOdds: drawOdds,
          bestAwayOdds: awayOdds,
          sourceConfidence: 0.8,
          bookmakerCount,
        })
        .run();
      const lineValues = event.bookmakers?.flatMap((bookmaker) => (bookmaker.markets ?? []).flatMap((item) => {
        if (!item.key || !["totals", "btts"].includes(item.key)) return [];
        return (item.outcomes ?? []).flatMap((outcome) => {
          if (!outcome.name || typeof outcome.price !== "number") return [];
          const selection = item.key === "btts" ? (normaliseName(outcome.name) === "yes" ? "YES" : "NO") : outcome.name.toUpperCase();
          return [{ fixtureId: fixture.id, provider: bookmaker.title ?? "The Odds API", marketType: item.key === "totals" ? "TOTALS" : "BTTS", selection, line: typeof outcome.point === "number" ? outcome.point : null, odds: outcome.price, capturedAt: new Date().toISOString() }];
        });
      }) ?? []);
      if (lineValues.length) await db.insert(marketLines).values(lineValues).onConflictDoNothing().run();
      await db.insert(dataSnapshots).values({
        source: "The Odds API",
        endpoint: `/v4/sports/${league.oddsSport}/odds/`,
        contentHash: `${fixture.id}:${homeOdds}:${drawOdds}:${awayOdds}:${Date.now()}`,
        payload: JSON.stringify({ fixtureId: fixture.id, homeOdds, drawOdds, awayOdds }),
        capturedAt: new Date().toISOString(),
        availableAt: new Date().toISOString(),
        freshnessSeconds: 0,
        status: "VALID",
      }).run();
      updated += 1;
    }
    await updateSourceHealth(db, "The Odds API", "READY", updated);
    if (rebuild) await rebuildPredictions(db, true);
    await logEvent(
      db,
      `${league.name} odds refresh completed from The Odds API: ` +
        String(updated) +
        " fixture markets updated.",
      "INFO",
      "odds_refresh",
    );
    await updateSourceHealth(db, "The Odds API", "READY", updated);
    return { source: "The Odds API", league: league.name, updated, status: "READY" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown odds error";
    await updateSourceHealth(db, "The Odds API", "ERROR", 0, message);
    await logEvent(db, "Odds refresh failed: " + message, "ERROR", "odds_refresh");
    throw error;
  }
}

export async function refreshAllOddsFromTheOddsAPI(db: QvmDb) {
  const results: Array<{ league: string; updated: number; status: string; error?: string }> = [];
  for (const league of LEAGUE_CONFIGS) {
    try {
      const result = await refreshOddsFromTheOddsAPI(db, league, false);
      results.push({ league: league.name, updated: result.updated, status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown odds error";
      results.push({ league: league.name, updated: 0, status: "ERROR", error: message });
      await logEvent(db, `${league.name} odds feed failed: ${message}`, "ERROR", "odds_refresh");
    }
  }
  const updated = results.reduce((sum, item) => sum + item.updated, 0);
  const failed = results.filter((item) => item.status !== "READY");
  await rebuildPredictions(db, true);
  await updateSourceHealth(
    db,
    "The Odds API",
    failed.length === results.length ? "ERROR" : failed.length ? "PARTIAL" : "READY",
    updated,
    failed.length ? failed.map((item) => `${item.league}: ${item.error ?? item.status}`).join(" | ") : undefined,
  );
  return {
    source: "The Odds API",
    updated,
    status: failed.length === results.length ? "ERROR" : failed.length ? "PARTIAL" : "READY",
    leagues: results,
  };
}

export async function syncTodayData(db: QvmDb) {
  await ensureSeeded(db);
  let fixtures: unknown = null;
  let odds: unknown = null;
  let enrichment: unknown = null;
  const errors: string[] = [];
  try {
    fixtures = await refreshFootballDataOrg(db);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Fixture synchronisation failed.");
  }
  try {
    odds = await refreshAllOddsFromTheOddsAPI(db);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Odds synchronisation failed.");
  }
  // Sportmonks carries large lineup/statistics payloads and has its own
  // explicit refresh action. Do not let it block fresh odds reaching Edge
  // Finder when the user presses the primary live-data refresh.
  enrichment = {
    source: "Sportmonks",
    updated: 0,
    status: "DEFERRED",
    message: "Run Refresh football enrichment separately for lineups, injuries, xG and statistics.",
  };
  await rebuildPredictions(db, true);
  const sourceNotReady = [fixtures, odds].some((result) => {
    if (!result || typeof result !== "object") return true;
    return (result as { status?: string }).status !== "READY";
  });
  const partial = errors.length > 0 || sourceNotReady;
  await logEvent(
    db,
    partial
      ? `Today's data sync completed with warnings: ${errors.join(" | ") || "one or more sources are not READY"}`
      : "Today's football fixtures, odds and predictions synchronised.",
    partial ? "WARN" : "INFO",
    "daily_sync",
  );
  return { fixtures, odds, enrichment, errors, status: partial ? "PARTIAL" : "READY" };
}
