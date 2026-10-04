import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/qvm/online-cycle/route.ts", import.meta.url),
  "utf8",
);
const researchRouteSource = await readFile(
  new URL("../app/api/qvm/research/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const cycleSource = await readFile(
  new URL("../lib/online-cycle.ts", import.meta.url),
  "utf8",
);

test("AI Ops starts long hosted cycles without holding the browser request", () => {
  assert.match(routeSource, /getRequestExecutionContext/);
  assert.match(routeSource, /waitUntil\(/);
  assert.match(routeSource, /status:\s*"STARTED"/);
  assert.match(routeSource, /status:\s*"RUNNING"/);
  assert.match(pageSource, /payload\.status === "STARTED"/);
  assert.match(pageSource, /watchOnlineCycle/);
});

test("keeps the hosted cycle inside resumable worker invocations", () => {
  assert.match(cycleSource, /appMeta/);
  assert.match(cycleSource, /runHostedOnlineCycleStep/);
  assert.match(routeSource, /continue/);
  assert.match(routeSource, /X-QVM-Cycle-Continuation/);
  assert.match(cycleSource, /fetch\(/);
});

test("keeps monitoring long enough for all hosted cycle steps", () => {
  assert.match(pageSource, /attempt < 120/);
});

test("shows hosted cycle timing and stage while AI Ops is running", () => {
  assert.match(researchRouteSource, /getHostedOnlineCycleStatus/);
  assert.match(cycleSource, /phaseLabel/);
  assert.match(cycleSource, /progress/);
  assert.match(pageSource, /onlineCycle/);
  assert.match(pageSource, /Started/);
  assert.match(pageSource, /Current stage/);
  assert.match(pageSource, /setResearch\(payload as Research\)/);
});
