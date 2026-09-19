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

test.after(async () => {
  await vite.close();
});
