import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const chatRouteSource = await readFile(
  new URL("../app/api/qvm/chat/route.ts", import.meta.url),
  "utf8",
);

test("keeps Luna focused and the mobile app header in normal flow", () => {
  assert.doesNotMatch(pageSource, /QVM expert · paper mode only/);
  assert.doesNotMatch(pageSource, /Luna explains the paper-trading system/);
  assert.doesNotMatch(pageSource, /<header className="sticky top-0 z-10/);
  assert.doesNotMatch(pageSource, /const quickPrompts = \[/);
  assert.doesNotMatch(pageSource, /quickPrompts\.map/);
  assert.match(pageSource, /fetch\("\/api\/qvm\/chat"/);
});

test("places Luna in AI Ops instead of a floating mobile modal", () => {
  const agentOpsStart = pageSource.indexOf("function AgentOpsView");
  const researchStart = pageSource.indexOf("function ResearchLab");
  const agentOpsSource = pageSource.slice(agentOpsStart, researchStart);
  const lunaPosition = agentOpsSource.indexOf('<LunaAssistant activeSection="agents"');
  const cardGridPosition = agentOpsSource.indexOf('xl:grid-cols-[1.2fr_1fr_1fr]');
  assert.ok(lunaPosition > cardGridPosition, "Luna should occupy the AI Ops card grid");
  assert.doesNotMatch(agentOpsSource, /Model connection/);
  assert.doesNotMatch(pageSource, /className="fixed bottom-4 right-4/);
  assert.match(pageSource, /className="[^"]*min-h-\[220px\][^"]*max-h-\[65vh\][^"]*overflow-y-auto/);
});

test("moves Model Connection into Settings", () => {
  const settingsStart = pageSource.indexOf("function SettingsView");
  const settingsEnd = pageSource.indexOf("function OnlineDataQuality");
  const settingsSource = pageSource.slice(settingsStart, settingsEnd);
  assert.match(settingsSource, /Model connection/);
  assert.match(pageSource, /<SettingsView overview=\{overview\} research=\{research\} agents=\{agents\} \/>/);
});

test("gives Luna the complete paper-bet audit and concise mobile-safe output guidance", () => {
  assert.doesNotMatch(chatRouteSource, /performance\.history\.slice\(-12\)/);
  assert.match(chatRouteSource, /performance\.history/);
  assert.match(chatRouteSource, /Do not use Markdown tables/i);
  assert.match(chatRouteSource, /120 words/);
});

test("exposes the existing D1 tables through read-only server tools", () => {
  assert.match(chatRouteSource, /read_qvm_table/);
  assert.match(chatRouteSource, /function_call_output/);
  assert.match(chatRouteSource, /MAX_LUNA_TOOL_CALLS/);
  assert.match(chatRouteSource, /simulated_bets/);
  assert.match(chatRouteSource, /worker_heartbeats/);
  assert.doesNotMatch(chatRouteSource, /db\.run\(/);
});
