import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  resolve: { alias: { "@": new URL("..", import.meta.url).pathname } },
  server: { middlewareMode: true },
});

after(async () => vite.close());

test("marks a matching match or goal selection as already placed", async () => {
  const { isBetPlaced } = await vite.ssrLoadModule("/app/page.tsx");

  const trades = [
    { fixtureId: 42, selection: "HOME" },
    { fixtureId: 42, selection: "OVER_2.5" },
  ];

  assert.equal(isBetPlaced(trades, 42, "HOME"), true);
  assert.equal(isBetPlaced(trades, 42, "OVER_2.5"), true);
  assert.equal(isBetPlaced(trades, 42, "AWAY"), false);
  assert.equal(isBetPlaced(trades, 99, "HOME"), false);
});
