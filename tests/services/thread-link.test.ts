import { describe, expect, it } from "vitest";
import { threadHref } from "../../src/services/thread-link.js";

// The bug this file exists for: three call sites built this URL by hand and
// only one of them carried `#thread`. Which entry point a reader had used
// decided whether a tap landed on the conversation or on the thread list.
describe("threadHref", () => {
  it("always names the thread anchor", () => {
    expect(threadHref("thr_1")).toBe("/conversations?id=thr_1#thread");
    expect(threadHref("thr_1", "offset=50")).toBe("/conversations?id=thr_1&offset=50#thread");
  });

  it("encodes the id, and the anchor stays last", () => {
    const href = threadHref("a b&c#d", "q=x");
    expect(href).toBe("/conversations?id=a%20b%26c%23d&q=x#thread");
    expect(href.endsWith("#thread")).toBe(true);
    expect(href.indexOf("#")).toBe(href.lastIndexOf("#"));
  });

  it("appends nothing for an empty query string", () => {
    expect(threadHref("thr_1", "")).toBe("/conversations?id=thr_1#thread");
  });
});
