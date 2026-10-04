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

let auth;
try {
  auth = await vite.ssrLoadModule("/lib/odds-api-auth.ts");
} catch {
  auth = {};
}

test("normalises the odds key and preserves a safe provider diagnostic", () => {
  assert.equal(typeof auth.normaliseOddsApiKey, "function");
  assert.equal(typeof auth.describeOddsApiFailure, "function");
  assert.equal(auth.normaliseOddsApiKey({ ODDS_API_KEY: "  live-key\n" }), "live-key");
  assert.equal(auth.normaliseOddsApiKey({ ODDS_API_KEY: "  \t" }), null);
  assert.equal(
    auth.describeOddsApiFailure(401, '{"message":"API key not found"}'),
    "The Odds API returned HTTP 401: API key not found.",
  );
  assert.doesNotMatch(
    auth.describeOddsApiFailure(401, '{"message":"apiKey=secret-value"}'),
    /secret-value/,
  );
});

test.after(async () => {
  await vite.close();
});
