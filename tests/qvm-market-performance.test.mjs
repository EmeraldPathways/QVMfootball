import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qvmSource = await readFile(
  new URL("../lib/qvm.ts", import.meta.url),
  "utf8",
);

test("market assembly batches shared D1 reads", () => {
  const start = qvmSource.indexOf("export async function getMarkets");
  const end = qvmSource.indexOf("export async function getRiskSummary", start);
  assert.ok(start >= 0, "getMarkets must remain available");
  assert.ok(end > start, "getMarkets must have a bounded source section");

  const getMarketsSource = qvmSource.slice(start, end);
  assert.match(
    getMarketsSource,
    /const marketLineRows = await db\.select\(\)\.from\(marketLines\)/,
    "market lines should be loaded once for the response",
  );
  assert.doesNotMatch(
    getMarketsSource,
    /await db\.select\(\)\.from\(marketLines\)\.where\(/,
    "market lines must not be queried once per fixture",
  );
  assert.doesNotMatch(
    getMarketsSource,
    /await calculateMatchProbabilities\(db,/,
    "match probabilities must use the already-loaded market snapshot",
  );
});
