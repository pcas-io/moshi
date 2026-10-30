// The README's signature check for receivers is code people copy. This runs
// it as written, so the example and its stated results cannot drift from what
// moshi sends (src/services/webhook-sign.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { signingHeaders, generateSigningSecret } from "../../src/services/webhook-sign";

const README = readFileSync("README.md", "utf-8");
const block = /<!-- webhook-verify:[^>]*-->\n```js\n([\s\S]*?)```/.exec(README)?.[1] ?? "";

function run(extra = "") {
  const printed: unknown[] = [];
  const sandbox = { require: createRequire(import.meta.url), console: { log: (v: unknown) => printed.push(v) }, Buffer, out: undefined as unknown };
  vm.runInNewContext(`${block}\n${extra}`, sandbox);
  return { printed, out: sandbox.out };
}

describe("README: checking a moshi webhook", () => {
  it("is there", () => {
    expect(block).toContain("function verifyMoshiWebhook");
  });

  it("prints what its comments say: true, then three refusals", () => {
    const { printed } = run();
    expect(printed).toEqual([true, false, false, false]);
  });

  it("accepts what moshi actually signs", () => {
    const secret = generateSigningSecret();
    const body = JSON.stringify({ type: "message.created", data: { agent: "kate" } });
    const now = 1_761_836_430;
    const headers = signingHeaders(secret, "wh_01JBTEST", now, body);
    const { out } = run(`out = verifyMoshiWebhook(${JSON.stringify(secret)}, ${JSON.stringify(headers)}, ${JSON.stringify(body)}, ${now});`);
    expect(out).toBe(true);
  });
});
