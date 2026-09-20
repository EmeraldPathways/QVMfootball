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

test("starts a hosted heartbeat with a non-null finished timestamp", async () => {
  const onlineCycle = await vite.ssrLoadModule("/lib/online-cycle.ts");
  let inserted = null;
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return { limit: async () => [] };
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values) {
          inserted = values;
          return { run: async () => undefined };
        },
      };
    },
  };
  const startedAt = "2026-09-20T11:15:02.633Z";

  await onlineCycle.setHeartbeat(db, "RUNNING", startedAt, null);

  assert.equal(inserted?.lastFinishedAt, startedAt);
});

test.after(async () => {
  await vite.close();
});
