import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("keeps Luna focused and the mobile app header in normal flow", () => {
  assert.doesNotMatch(pageSource, /QVM expert · paper mode only/);
  assert.doesNotMatch(pageSource, /Luna explains the paper-trading system/);
  assert.doesNotMatch(pageSource, /<header className="sticky top-0 z-10/);
  assert.match(pageSource, /fetch\("\/api\/qvm\/chat"/);
  assert.match(pageSource, /How do I read robust edge\?/);
});
