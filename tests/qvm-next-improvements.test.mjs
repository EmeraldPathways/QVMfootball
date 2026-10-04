import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0008_reliability_evidence.sql", import.meta.url), "utf8");
const qvm = await readFile(new URL("../lib/qvm.ts", import.meta.url), "utf8");
const onlineCycle = await readFile(new URL("../lib/online-cycle.ts", import.meta.url), "utf8");
const viewsRoute = await readFile(new URL("../app/api/qvm/views/route.ts", import.meta.url), "utf8");
const recoveryRoute = await readFile(new URL("../app/api/qvm/recovery/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("adds recovery tables and indexes without destructive migration statements", () => {
  assert.match(schema, /paperActionReceipts/);
  assert.match(schema, /savedEdgeViews/);
  assert.match(schema, /evaluationStart/);
  assert.match(migration, /CREATE TABLE `paper_action_receipts`/);
  assert.match(migration, /CREATE TABLE `saved_edge_views`/);
  assert.match(migration, /idx_simulated_bets_open_identity/);
  assert.match(migration, /idx_worker_heartbeats_worker_name/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test("captures immutable decision evidence and handles legacy rows explicitly", () => {
  assert.match(qvm, /export async function recordDecisionReplay/);
  assert.match(qvm, /LEGACY_UNKNOWN/);
  assert.match(qvm, /replayable: false/);
  assert.match(qvm, /PAPER_BET/);
  assert.match(qvm, /SCAN_NO_BET/);
  assert.match(qvm, /requestId/);
  assert.match(qvm, /closingQuoteForFixture/);
  assert.match(qvm, /correlationGroups/);
});

test("records point-in-time evaluation boundaries and visible quote movement", () => {
  assert.match(qvm, /evaluationStart/);
  assert.match(qvm, /evaluationEnd/);
  assert.match(qvm, /trainCutoff/);
  assert.match(qvm, /leakageChecked/);
  assert.match(qvm, /uniform-v1/);
  assert.match(qvm, /experimentRuns/);
  assert.match(qvm, /openingOdds/);
  assert.match(qvm, /movementPct/);
});

test("keeps saved views, recovery export and hosted progress online", () => {
  assert.match(viewsRoute, /export async function GET/);
  assert.match(viewsRoute, /export async function POST/);
  assert.match(recoveryRoute, /Content-Disposition/);
  assert.match(recoveryRoute, /getChatGPTUser/);
  assert.match(page, /Saved Edge Finder view/);
  assert.match(page, /Search Edge Finder markets/);
  assert.match(page, /Sort Edge Finder markets/);
  assert.match(page, /12 fixtures per page/);
  assert.match(qvm, /maxQuoteAgeSeconds/);
  assert.match(qvm, /placedOnly/);
  assert.match(page, /Download recovery JSON/);
  assert.match(page, /durationSeconds/);
  assert.match(onlineCycle, /stageIndex/);
});

test("does not show an unqualified no-review state after a completed hosted cycle", () => {
  assert.match(page, /research\.onlineCycle/);
  assert.match(page, /cycleFallbackAgentRun/);
  assert.doesNotMatch(page, /No hosted review has run yet\. Use Run online review to create the first report\./);
});
