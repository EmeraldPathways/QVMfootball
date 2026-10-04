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

test("marks an abandoned running cycle as degraded after its lease expires", async () => {
  const onlineCycle = await vite.ssrLoadModule("/lib/online-cycle.ts");
  const heartbeat = {
    id: 1,
    workerName: "qvm-online",
    status: "RUNNING",
    lastStartedAt: "2026-09-20T19:13:30.560Z",
    lastFinishedAt: "2026-09-20T14:02:59.897Z",
    lastError: null,
    cyclesCompleted: 2,
  };
  const job = {
    version: 1,
    startedAt: heartbeat.lastStartedAt,
    updatedAt: "2026-09-20T19:14:29.413Z",
    phase: "SETTLEMENT",
    errors: [],
  };
  let selectCount = 0;
  let heartbeatUpdate = null;
  const db = {
    select() {
      return {
        from() {
          const rows = selectCount++ === 1 ? [{ key: "qvm_online_cycle_job_v1", value: JSON.stringify(job) }] : [heartbeat];
          return {
            where() {
              return {
                orderBy() {
                  return { limit: async () => rows };
                },
                limit: async () => rows,
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values) {
          heartbeatUpdate = values;
          return { where() { return { run: async () => undefined }; } };
        },
      };
    },
  };

  const result = await onlineCycle.reconcileStaleHostedOnlineCycle(
    db,
    Date.parse("2026-09-20T19:30:00.000Z"),
  );

  assert.equal(result.status, "DEGRADED");
  assert.equal(heartbeatUpdate.status, "DEGRADED");
  assert.match(heartbeatUpdate.lastError, /SETTLEMENT/);
});

test.after(async () => {
  await vite.close();
});
