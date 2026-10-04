import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qvm = await readFile(new URL("../lib/qvm.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0008_reliability_evidence.sql", import.meta.url), "utf8");
const auth = await readFile(new URL("../lib/odds-api-auth.ts", import.meta.url), "utf8");
const onlineCycle = await readFile(new URL("../lib/online-cycle.ts", import.meta.url), "utf8");
const chat = await readFile(new URL("../app/api/qvm/chat/route.ts", import.meta.url), "utf8");
const results = await readFile(new URL("../app/api/qvm/results/route.ts", import.meta.url), "utf8");
const cycleRoute = await readFile(new URL("../app/api/qvm/online-cycle/route.ts", import.meta.url), "utf8");

test("provider failures remain explicit and bounded", () => {
  assert.match(auth, /HTTP \$\{String\(status\)\}/);
  assert.match(auth, /apiKey=\[redacted\]/);
  assert.match(qvm, /updateSourceHealth\(db, "The Odds API", "ERROR"/);
  assert.match(qvm, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(qvm, /if \(!response\.ok\)/);
  assert.match(qvm, /fixturesMatched/);
});

test("paper actions and hosted reviews have retry contracts", () => {
  assert.match(migration, /idx_simulated_bets_open_identity/);
  assert.match(qvm, /SETTLE_PAPER_POSITIONS/);
  assert.match(qvm, /idempotent: true/);
  assert.match(results, /X-QVM-Request-ID/);
  assert.match(onlineCycle, /START_HOSTED_ONLINE_CYCLE/);
  assert.match(onlineCycle, /cycle:\$\{job\.startedAt\}:settlement/);
  assert.match(cycleRoute, /X-QVM-Request-ID/);
});

test("Luna stays read-only, bounded, paged and auditable", () => {
  assert.match(chat, /MAX_LUNA_TOOL_CALLS = 8/);
  assert.match(chat, /MAX_LUNA_TOOL_ROUNDS = 4/);
  assert.match(chat, /MAX_LUNA_TABLE_PAGE_SIZE = 50/);
  assert.match(chat, /partial: hasMore/);
  assert.match(chat, /recordIds/);
  assert.match(chat, /context: "luna_read"/);
  assert.doesNotMatch(chat, /db\.run\(/);
});
