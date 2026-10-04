import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("pauses automatic quote refresh when The Odds API is already in error", () => {
  const start = pageSource.indexOf("const staleRefreshAttempted");
  const end = pageSource.indexOf("const watchOnlineCycle", start);
  assert.ok(start >= 0 && end > start, "initial quote refresh effect must remain identifiable");
  const refreshEffect = pageSource.slice(start, end);
  assert.match(refreshEffect, /sourceHealth/);
  assert.match(refreshEffect, /The Odds API/);
  assert.match(refreshEffect, /Automatic live quote refresh paused/);
});
