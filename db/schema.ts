import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  text(name).notNull().default(sql`CURRENT_TIMESTAMP`);

export const teams = sqliteTable(
  "teams",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    league: text("league").notNull().default("Premier League"),
  },
  (table) => ({
    nameIndex: uniqueIndex("idx_teams_name").on(table.name),
    leagueIndex: index("idx_teams_league").on(table.league),
  }),
);

export const fixtures = sqliteTable(
  "fixtures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    league: text("league").notNull().default("Premier League"),
    matchDate: text("match_date").notNull(),
    homeGoals: integer("home_goals"),
    awayGoals: integer("away_goals"),
    status: text("status").notNull().default("SCHEDULED"),
    apiFootballFixtureId: integer("api_football_fixture_id"),
  },
  (table) => ({
    dateIndex: index("idx_fixtures_match_date").on(table.matchDate),
    statusIndex: index("idx_fixtures_status").on(table.status),
    leagueIndex: index("idx_fixtures_league").on(table.league),
    teamsIndex: index("idx_fixtures_teams").on(
      table.homeTeamId,
      table.awayTeamId,
    ),
    identityIndex: uniqueIndex("idx_fixtures_identity").on(
      table.homeTeamId,
      table.awayTeamId,
      table.matchDate,
    ),
    apiFootballFixtureIndex: uniqueIndex("idx_fixtures_api_football_id").on(
      table.apiFootballFixtureId,
    ),
  }),
);

export const teamStats = sqliteTable(
  "team_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    matchesPlayed: integer("matches_played").notNull().default(0),
    goalsScoredHome: integer("goals_scored_home").notNull().default(0),
    goalsConcededHome: integer("goals_conceded_home").notNull().default(0),
    goalsScoredAway: integer("goals_scored_away").notNull().default(0),
    goalsConcededAway: integer("goals_conceded_away").notNull().default(0),
    attackStrengthHome: real("attack_strength_home").notNull().default(1),
    defenseStrengthHome: real("defense_strength_home").notNull().default(1),
    attackStrengthAway: real("attack_strength_away").notNull().default(1),
    defenseStrengthAway: real("defense_strength_away").notNull().default(1),
    updatedAt: timestamp("updated_at"),
  },
  (table) => ({
    teamIndex: uniqueIndex("idx_team_stats_team_id").on(table.teamId),
  }),
);

export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixtures.id, { onDelete: "cascade" }),
    trueHomeProb: real("true_home_prob").notNull(),
    trueDrawProb: real("true_draw_prob").notNull(),
    trueAwayProb: real("true_away_prob").notNull(),
    fairHomeOdds: real("fair_home_odds").notNull(),
    fairDrawOdds: real("fair_draw_odds").notNull(),
    fairAwayOdds: real("fair_away_odds").notNull(),
    calculatedAt: timestamp("calculated_at"),
    calibratedHomeProb: real("calibrated_home_prob"),
    calibratedDrawProb: real("calibrated_draw_prob"),
    calibratedAwayProb: real("calibrated_away_prob"),
    modelVersion: text("model_version").notNull().default("dixon-coles-dynamic-v3"),
    gridSize: integer("grid_size").notNull().default(12),
    tailMass: real("tail_mass").notNull().default(0),
    dataQualityScore: real("data_quality_score").notNull().default(0),
  },
  (table) => ({
    fixtureIndex: uniqueIndex("idx_predictions_fixture_id").on(table.fixtureId),
  }),
);

export const marketQuotes = sqliteTable(
  "market_quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixtures.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("Demo market"),
    homeOdds: real("home_odds").notNull(),
    drawOdds: real("draw_odds").notNull(),
    awayOdds: real("away_odds").notNull(),
    capturedAt: timestamp("captured_at"),
    marketType: text("market_type").notNull().default("1X2"),
    bookmakerCount: integer("bookmaker_count").notNull().default(1),
    consensusHomeProb: real("consensus_home_prob"),
    consensusDrawProb: real("consensus_draw_prob"),
    consensusAwayProb: real("consensus_away_prob"),
    overround: real("overround"),
    bestHomeOdds: real("best_home_odds"),
    bestDrawOdds: real("best_draw_odds"),
    bestAwayOdds: real("best_away_odds"),
    isClosing: integer("is_closing").notNull().default(0),
    sourceConfidence: real("source_confidence").notNull().default(0.5),
  },
  (table) => ({
    fixtureIndex: index("idx_market_quotes_fixture_id").on(table.fixtureId),
    capturedIndex: index("idx_market_quotes_captured_at").on(table.capturedAt),
  }),
);

export const marketLines = sqliteTable(
  "market_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixtures.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    marketType: text("market_type").notNull(),
    selection: text("selection").notNull(),
    line: real("line"),
    odds: real("odds").notNull(),
    capturedAt: timestamp("captured_at"),
    isClosing: integer("is_closing").notNull().default(0),
  },
  (table) => ({
    fixtureIndex: index("idx_market_lines_fixture_id").on(table.fixtureId),
    identityIndex: uniqueIndex("idx_market_lines_identity").on(
      table.fixtureId,
      table.provider,
      table.marketType,
      table.selection,
      table.line,
      table.capturedAt,
    ),
  }),
);

export const simulatedBets = sqliteTable(
  "simulated_bets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id")
      .notNull()
      .references(() => fixtures.id, { onDelete: "cascade" }),
    selection: text("selection").notNull(),
    marketOdds: real("market_odds").notNull(),
    impliedProb: real("implied_prob").notNull(),
    trueProb: real("true_prob").notNull(),
    edgePct: real("edge_pct").notNull(),
    stakeAmount: real("stake_amount").notNull(),
    status: text("status").notNull().default("PENDING"),
    outcome: text("outcome"),
    profitLoss: real("profit_loss").notNull().default(0),
    closingOdds: real("closing_odds"),
    clvPct: real("clv_pct"),
    placedAt: timestamp("placed_at"),
    commissionAmount: real("commission_amount").notNull().default(0),
    slippagePct: real("slippage_pct").notNull().default(0),
    dataQualityScore: real("data_quality_score").notNull().default(0),
    approvalStatus: text("approval_status").notNull().default("AUTO_GATED"),
    marketType: text("market_type").notNull().default("1X2"),
    line: real("line"),
  },
  (table) => ({
    fixtureStatusIndex: index("idx_simulated_bets_fixture_status").on(
      table.fixtureId,
      table.status,
    ),
    placedAtIndex: index("idx_simulated_bets_placed_at").on(table.placedAt),
  }),
);

export const userPortfolios = sqliteTable("user_portfolios", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currentBankroll: real("current_bankroll").notNull().default(1000),
  initialBankroll: real("initial_bankroll").notNull().default(1000),
  updatedAt: timestamp("updated_at"),
});

export const systemLogs = sqliteTable(
  "system_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    level: text("level").notNull().default("INFO"),
    message: text("message").notNull(),
    context: text("context"),
    createdAt: timestamp("created_at"),
  },
  (table) => ({
    createdIndex: index("idx_system_logs_created_at").on(table.createdAt),
  }),
);

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at"),
});

export const modelRuns = sqliteTable(
  "model_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelVersion: text("model_version").notNull().default("poisson-v2-walk-forward"),
    evaluationType: text("evaluation_type").notNull().default("WALK_FORWARD"),
    fixturesEvaluated: integer("fixtures_evaluated").notNull().default(0),
    brierScore: real("brier_score"),
    logLoss: real("log_loss"),
    hitRate: real("hit_rate"),
    averageTailMass: real("average_tail_mass"),
    roiPct: real("roi_pct"),
    maxDrawdownPct: real("max_drawdown_pct"),
    createdAt: timestamp("created_at"),
  },
  (table) => ({
    createdIndex: index("idx_model_runs_created_at").on(table.createdAt),
  }),
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentName: text("agent_name").notNull(),
    role: text("role").notNull(),
    model: text("model").notNull().default("Luna Max"),
    status: text("status").notNull().default("RUNNING"),
    task: text("task").notNull(),
    summary: text("summary"),
    payload: text("payload"),
    startedAt: timestamp("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => ({
    roleStatusIndex: index("idx_agent_runs_role_status").on(
      table.role,
      table.status,
    ),
    startedIndex: index("idx_agent_runs_started_at").on(table.startedAt),
  }),
);

export const modelVersions = sqliteTable(
  "model_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    featureSet: text("feature_set").notNull().default("goals_home_away"),
    parametersJson: text("parameters_json"),
    gitCommit: text("git_commit"),
    status: text("status").notNull().default("CHALLENGER"),
    isActive: integer("is_active").notNull().default(0),
    createdAt: timestamp("created_at"),
  },
  (table) => ({
    activeIndex: index("idx_model_versions_active").on(table.isActive),
  }),
);

export const calibrationBuckets = sqliteTable(
  "calibration_buckets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelVersion: text("model_version").notNull(),
    outcomeClass: text("outcome_class").notNull(),
    bucket: integer("bucket").notNull(),
    predictionCount: integer("prediction_count").notNull().default(0),
    predictedProbability: real("predicted_probability").notNull().default(0),
    observedFrequency: real("observed_frequency").notNull().default(0),
    updatedAt: timestamp("updated_at"),
  },
  (table) => ({
    modelBucketIndex: index("idx_calibration_model_bucket").on(table.modelVersion, table.bucket),
  }),
);

export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerName: text("worker_name").notNull(),
  status: text("status").notNull().default("STARTING"),
  lastStartedAt: timestamp("last_started_at"),
  lastFinishedAt: timestamp("last_finished_at"),
  lastError: text("last_error"),
  cyclesCompleted: integer("cycles_completed").notNull().default(0),
});

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: integer("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: text("position"),
  expectedMinutes: real("expected_minutes").notNull().default(0),
  attackRating: real("attack_rating").notNull().default(0),
  defenceRating: real("defence_rating").notNull().default(0),
  availability: text("availability").notNull().default("UNKNOWN"),
  source: text("source").notNull().default("manual"),
  sourceUpdatedAt: timestamp("source_updated_at"),
});

export const fixtureEvents = sqliteTable("fixture_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fixtureId: integer("fixture_id").notNull().references(() => fixtures.id, { onDelete: "cascade" }),
  minute: integer("minute").notNull(),
  eventType: text("event_type").notNull(),
  teamId: integer("team_id").references(() => teams.id, { onDelete: "set null" }),
  playerId: integer("player_id").references(() => players.id, { onDelete: "set null" }),
  xg: real("xg"),
  payload: text("payload"),
  recordedAt: timestamp("recorded_at"),
});

export const dataSnapshots = sqliteTable("data_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  endpoint: text("endpoint").notNull(),
  contentHash: text("content_hash").notNull(),
  payload: text("payload").notNull(),
  capturedAt: timestamp("captured_at"),
  availableAt: timestamp("available_at"),
  status: text("status").notNull().default("VALID"),
  freshnessSeconds: integer("freshness_seconds"),
});

export const fixtureFeatures = sqliteTable(
  "fixture_features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id").notNull().references(() => fixtures.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    capturedAt: timestamp("captured_at"),
    availableAt: timestamp("available_at"),
    homeXg: real("home_xg"),
    awayXg: real("away_xg"),
    homeShots: integer("home_shots"),
    awayShots: integer("away_shots"),
    homeBigChances: integer("home_big_chances"),
    awayBigChances: integer("away_big_chances"),
    homeRestDays: real("home_rest_days"),
    awayRestDays: real("away_rest_days"),
    travelKm: real("travel_km"),
    weatherJson: text("weather_json"),
    payload: text("payload"),
  },
  (table) => ({
    fixtureIndex: index("idx_fixture_features_fixture_id").on(table.fixtureId),
    capturedIndex: index("idx_fixture_features_captured_at").on(table.capturedAt),
  }),
);

export const availabilitySnapshots = sqliteTable(
  "availability_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fixtureId: integer("fixture_id").notNull().references(() => fixtures.id, { onDelete: "cascade" }),
    teamId: integer("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id").references(() => players.id, { onDelete: "set null" }),
    playerName: text("player_name").notNull(),
    status: text("status").notNull().default("UNKNOWN"),
    expectedMinutes: real("expected_minutes").notNull().default(0),
    source: text("source").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    capturedAt: timestamp("captured_at"),
    availableAt: timestamp("available_at"),
    payload: text("payload"),
  },
  (table) => ({
    fixtureIndex: index("idx_availability_fixture_id").on(table.fixtureId),
    teamIndex: index("idx_availability_team_id").on(table.teamId),
    capturedIndex: index("idx_availability_captured_at").on(table.capturedAt),
  }),
);

export const dataSourceHealth = sqliteTable(
  "data_source_health",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    status: text("status").notNull().default("NOT_CONFIGURED"),
    lastSuccessAt: text("last_success_at"),
    lastAttemptAt: text("last_attempt_at"),
    recordsUpdated: integer("records_updated").notNull().default(0),
    message: text("message"),
  },
  (table) => ({
    sourceIndex: uniqueIndex("idx_data_source_health_source").on(table.source),
  }),
);

export const decisionReplays = sqliteTable("decision_replays", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fixtureId: integer("fixture_id").references(() => fixtures.id, { onDelete: "set null" }),
  decision: text("decision").notNull(),
  modelVersion: text("model_version").notNull(),
  dataSnapshotIds: text("data_snapshot_ids"),
  deterministicChecks: text("deterministic_checks").notNull(),
  agentReports: text("agent_reports"),
  approvalStatus: text("approval_status").notNull().default("NOT_REQUIRED"),
  createdAt: timestamp("created_at"),
});

export const experimentRuns = sqliteTable("experiment_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  experimentName: text("experiment_name").notNull(),
  championVersion: text("champion_version").notNull(),
  challengerVersion: text("challenger_version").notNull(),
  metricsJson: text("metrics_json").notNull(),
  status: text("status").notNull().default("COMPLETED"),
  createdAt: timestamp("created_at"),
});

export const portfolioScenarios = sqliteTable("portfolio_scenarios", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scenarioName: text("scenario_name").notNull(),
  assumptionsJson: text("assumptions_json").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: timestamp("created_at"),
});
