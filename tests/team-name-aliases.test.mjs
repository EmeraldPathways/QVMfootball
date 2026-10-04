import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  resolve: { alias: { "@": new URL("..", import.meta.url).pathname } },
  server: { middlewareMode: true },
});

test("maps provider team-name variants to one canonical identity", async () => {
  const qvm = await vite.ssrLoadModule("/lib/qvm.ts");

  assert.equal(
    qvm.normaliseName("Brighton & Hove Albion FC"),
    qvm.normaliseName("Brighton"),
  );

  const teams = qvm.buildTeamNameMap([
    { id: 7, name: "Brighton" },
    { id: 21, name: "Brighton & Hove Albion FC" },
  ]);
  assert.equal(teams.get(qvm.normaliseName("Brighton & Hove Albion FC"))?.id, 7);
});

test("prefers the fresh quote when duplicate provider fixtures share an identity", async () => {
  const qvm = await vite.ssrLoadModule("/lib/qvm.ts");
  const kickoff = "2026-10-10T14:00:00.000Z";
  const fixtures = [
    { id: 449, league: "Premier League", homeTeamId: 1, awayTeamId: 2, matchDate: kickoff },
    { id: 1023, league: "Premier League", homeTeamId: 1, awayTeamId: 2, matchDate: kickoff },
  ];
  const names = new Map([[1, "Sunderland"], [2, "Brighton" ]]);
  const quotes = new Map([
    [449, { capturedAt: "2026-09-18T22:27:49.280Z" }],
    [1023, { capturedAt: "2026-09-19T20:32:02.887Z" }],
  ]);

  assert.equal(
    qvm.canonicalFixtureKey(fixtures[0], names),
    qvm.canonicalFixtureKey(fixtures[1], names),
  );
  assert.equal(qvm.preferredFixtureId(fixtures, quotes, Date.parse("2026-09-19T20:35:00.000Z")), 1023);
});

test.after(async () => {
  await vite.close();
});
