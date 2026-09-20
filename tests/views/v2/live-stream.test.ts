// The browser half of the live sections: WHEN to ask. GET /sse/messages says
// that something was sent; what is shown still comes from the fragments, so
// everything in live-refresh.test.ts holds with and without a stream.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";
import { FakeScroller, JS, live, world } from "./live-dom";

beforeEach(() => { vi.useFakeTimers(); FakeScroller.nextHeight = 1000; });
afterEach(() => { vi.useRealTimers(); });

describe("live-refresh script — with the message stream", () => {
  const PILL = '<span data-live-pill hidden></span>';

  it("opens one stream; once it is open it asks at once and the timer slows down to a minute", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    expect(w.streams.map((s) => s.url)).toEqual(["/sse/messages"]);
    await vi.advanceTimersByTimeAsync(1000);
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(1); // closes the gap between the render and the subscription
    await vi.advanceTimersByTimeAsync(59_000);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.calls).toHaveLength(2); // the timer stays as the safety net
  });

  it("asks 300 ms after an event, and once for a burst of events", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.streams[0]!.message({ id: "m1", thread_id: "t1", created_at: "x" });
    await vi.advanceTimersByTimeAsync(299);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls).toHaveLength(2);
    for (const id of ["m2", "m3", "m4"]) {
      w.streams[0]!.message({ id, thread_id: "t1", created_at: "x" });
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls).toHaveLength(3);
  });

  it("is not starved by a steady flow of events: the 300 ms run from the first one", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.calls.splice(0);
    for (let i = 0; i < 10; i++) { // one event every 200 ms, for two seconds
      w.streams[0]!.message({ id: `m${i}`, thread_id: "t", created_at: "x" });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(w.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("a section pinned to a thread only asks when that thread is named, also within a burst", async () => {
    const list = live("/list");
    const thread = live("/thread?id=T1", "", { "data-live-thread": "T1" });
    const w = world([list, thread], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const asked = () => w.calls.splice(0).map((c) => c.url).sort();
    expect(asked()).toEqual(["/list", "/thread?id=T1"]);

    w.streams[0]!.message({ id: "m1", thread_id: "T2", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toEqual(["/list"]);

    w.streams[0]!.message({ id: "m2", thread_id: "T2", created_at: "x" });
    w.streams[0]!.message({ id: "m3", thread_id: "T1", created_at: "x" });
    w.streams[0]!.message({ id: "m4", thread_id: "T3", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toEqual(["/list", "/thread?id=T1"]);
  });

  it("forgets which threads were named once it has asked: the next foreign event leaves a pinned section alone again", async () => {
    const list = live("/list");
    const thread = live("/thread?id=T1", "", { "data-live-thread": "T1" });
    const w = world([list, thread], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const asked = () => w.calls.splice(0).map((c) => c.url).sort();
    asked();
    w.streams[0]!.message({ id: "m1", thread_id: "T1", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toEqual(["/list", "/thread?id=T1"]);
    w.streams[0]!.message("not json");
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toEqual(["/list", "/thread?id=T1"]);
    w.streams[0]!.message({ id: "m2", thread_id: "T2", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(asked()).toEqual(["/list"]);
  });

  it("keeps the named threads in an object without a prototype: a thread can be called `constructor`", async () => {
    const list = live("/list");
    const pinned = ["constructor", "__proto__", "toString"].map((id) => live(`/thread?id=${id}`, "", { "data-live-thread": id }));
    const w = world([list, ...pinned], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.calls.splice(0);
    w.streams[0]!.message({ id: "m", thread_id: "T2", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls.map((c) => c.url)).toEqual(["/list"]);
    w.streams[0]!.message({ id: "m", thread_id: "constructor", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls.map((c) => c.url).sort()).toEqual(["/list", "/list", "/thread?id=constructor"]);
  });

  it("asks again when an event arrives while a fetch is already on its way", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    let release = () => {};
    w.replies.push({ status: 304, hold: new Promise<void>((r) => { release = r; }) });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(1); // in flight: it may have read the database before the message
    w.streams[0]!.message({ id: "m1", thread_id: "t1", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(2);
  });

  it("treats an event it cannot read as 'something happened'", async () => {
    const list = live("/list");
    const thread = live("/thread?id=T1", "", { "data-live-thread": "T1" });
    const w = world([list, thread], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.calls.splice(0);
    w.streams[0]!.message("not json");
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls.map((c) => c.url).sort()).toEqual(["/list", "/thread?id=T1"]);
  });

  it("a lost stream puts the timer on ten seconds, and the browser's repeated errors do not push it away", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(1);
    w.streams[0]!.drop();
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(3000); w.streams[0]!.drop(); } // 9 s, three failed retries
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.calls).toHaveLength(3);
    // Back again: ask at once for what was missed, then the slow timer.
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(w.calls).toHaveLength(4);
  });

  it("keeps the five seconds for as long as no stream has ever opened", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.refuse(); // 503: the limit is reached
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(2);
  });

  it("retries a refused stream itself, later each time and at most every five minutes", async () => {
    const w = world([live("/f")], {}, { stream: true });
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      w.streams[w.streams.length - 1]!.refuse();
      const before = w.streams.length;
      let waited = 0;
      while (w.streams.length === before && waited < 1_000_000) { await vi.advanceTimersByTimeAsync(1000); waited += 1000; }
      gaps.push(waited);
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    // One that opens resets the wait.
    w.streams[w.streams.length - 1]!.open();
    w.streams[w.streams.length - 1]!.refuse();
    const before = w.streams.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.streams.length).toBe(before + 1);
  });

  it("closes the stream while the tab is hidden, retries nothing, and opens a new one when it is back", async () => {
    const w = world([live("/f")], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.document.hidden = true;
    w.listeners["visibilitychange"]!();
    expect(w.streams[0]!.readyState).toBe(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(w.streams).toHaveLength(1);
    w.document.hidden = false;
    w.listeners["visibilitychange"]!();
    expect(w.streams).toHaveLength(2);
    expect(w.streams[1]!.readyState).toBe(0);
  });

  it("does not claim `updating live` while the new stream is still connecting, and asks again once it is open", async () => {
    const el = live("/f", PILL);
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.pills[0]!.hidden).toBe(false);
    w.document.hidden = true;
    w.listeners["visibilitychange"]!();
    expect(el.pills[0]!.hidden).toBe(true);
    w.document.hidden = false;
    w.listeners["visibilitychange"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.pills[0]!.hidden).toBe(true); // connecting
    const asked = w.calls.length;
    w.streams[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.pills[0]!.hidden).toBe(false);
    // The fetch at "visible" may have read the database before the new
    // subscription existed: the open stream asks once more.
    expect(w.calls.length).toBe(asked + 1);
  });

  it("opens no second stream when the tab reports 'visible' twice", async () => {
    const w = world([live("/f")], {}, { stream: true });
    w.streams[0]!.open();
    w.listeners["visibilitychange"]!();
    w.listeners["visibilitychange"]!();
    expect(w.streams).toHaveLength(1);
  });

  it("does not open a stream in a tab that starts hidden", async () => {
    const el = live("/f");
    const found = [el];
    // hidden before the script runs
    const w = world(found, {}, { stream: true });
    expect(w.streams).toHaveLength(1); // visible by default in this fake …
    const hiddenWorld = (() => {
      const streams: unknown[] = [];
      const ctx = {
        window: {} as Record<string, unknown>,
        document: { hidden: true, querySelectorAll: () => found, getElementById: () => null, addEventListener: () => {} },
        setTimeout, clearTimeout, Math, Object, String, Error, JSON, decodeURIComponent, console,
      };
      ctx.window.fetch = () => Promise.reject(new Error("must not be called"));
      ctx.window.EventSource = function () { streams.push(1); return {}; };
      vm.runInNewContext(JS, { ...ctx, ...ctx.window });
      return streams;
    })();
    expect(hiddenWorld).toHaveLength(0); // … and none when it is not
  });

  it("shows the pill only while the stream is open, also in markup that was just swapped in", async () => {
    const el = live("/f", PILL);
    const w = world([el], {}, { stream: true });
    expect(el.pills[0]!.hidden).toBe(true);
    w.replies.push({ status: 200, etag: '"1"', body: `<b>new</b>${PILL}` });
    w.streams[0]!.open();
    expect(el.pills[0]!.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.innerHTML).toContain("<b>new</b>");
    expect(el.pills[0]!.hidden).toBe(false); // a new element, rendered hidden by the server
    w.streams[0]!.drop();
    expect(el.pills[0]!.hidden).toBe(true);
  });

  it("comes back after five seconds to a section it had to leave alone, not after a minute", async () => {
    const el = live("/f", '<i data-id="a"></i>');
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0); // 304, timer now at a minute
    w.select(el.rows[0]);
    w.replies.push({ status: 200, etag: '"v2"', body: "NEW" }, { status: 200, etag: '"v2"', body: "NEW" });
    w.streams[0]!.message({ id: "m", thread_id: "t", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(el.innerHTML).not.toBe("NEW"); // the reader is selecting text in there
    w.select(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).toBe("NEW");
    const asked = w.calls.length;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(w.calls).toHaveLength(asked); // and back to the slow timer afterwards
  });

  it("tries a failed fetch again after ten seconds, not after the stream's minute", async () => {
    // The stream can be fine while one request fails: a proxy hiccup, a
    // deploy that the event stream happened to survive.
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0); // 304, timer at a minute
    w.replies.push(new Error("502"), new Error("502"), { status: 200, etag: '"2"', body: "NEW" }, { status: 304 });
    w.streams[0]!.message({ id: "m", thread_id: "t", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    expect(w.calls).toHaveLength(2); // the one that fails
    await vi.advanceTimersByTimeAsync(9_999);
    expect(w.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls).toHaveLength(3); // fails again: twenty seconds now
    await vi.advanceTimersByTimeAsync(20_000);
    expect(w.calls).toHaveLength(4);
    expect(el.innerHTML).toBe("NEW");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(w.calls).toHaveLength(4); // and back to the slow timer
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.calls).toHaveLength(5);
  });

  it("asks at once, and looks after its stream, when the browser says the network is back", async () => {
    const el = live("/f");
    const w = world([el], {}, { stream: true });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    w.replies.push(new Error("offline"));
    w.streams[0]!.message({ id: "m", thread_id: "t", created_at: "x" });
    await vi.advanceTimersByTimeAsync(300);
    const asked = w.calls.length;
    w.listeners["window:online"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(asked + 1);
    // A stream the script had given up on for now is tried again right away.
    w.streams[0]!.refuse();
    expect(w.streams).toHaveLength(1);
    w.listeners["window:online"]!();
    expect(w.streams).toHaveLength(2);
  });

  it("closes the stream when the page reloads for a lost session", async () => {
    const w = world([live("/f")], {}, { stream: true });
    w.replies.push({ status: 401, type: "application/json" });
    w.streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.reload).toHaveBeenCalledTimes(1);
    expect(w.streams[0]!.readyState).toBe(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(w.streams).toHaveLength(1);
  });

  it("opens no stream on a page without live sections", () => {
    const w = world([], {}, { stream: true });
    expect(w.streams).toHaveLength(0);
  });
});
