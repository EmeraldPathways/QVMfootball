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

test("gives slow paper-trading operations a realistic timeout budget", async () => {
  let policy;
  try {
    policy = await vite.ssrLoadModule("/lib/qvm-timeouts.ts");
  } catch {
    assert.fail("The shared QVM timeout policy is missing.");
  }

  assert.equal(policy.qvmTimeoutMs("dataLoad"), 180_000);
  assert.equal(policy.qvmTimeoutMs("action"), 300_000);
  assert.equal(policy.qvmTimeoutMs("provider"), 30_000);
  assert.equal(policy.qvmTimeoutMs("ai"), 180_000);
});

test.after(async () => {
  await vite.close();
});
