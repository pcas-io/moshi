// The browser half of the live sections: what is shown, and when it is left
// alone. Runs the real script in node:vm against the fake DOM in live-dom.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";
import { LIVE_REFRESH_CSS } from "../../../src/views/v2/live-refresh";
import { FakeEl, FakeScroller, JS, live, world } from "./live-dom";

beforeEach(() => { vi.useFakeTimers(); FakeScroller.nextHeight = 1000; });
afterEach(() => { vi.useRealTimers(); });

describe("live-refresh script", () => {
  it("is a classic script that parses, and adds no keyframes of its own", () => {
    new vm.Script(JS);
    expect(JS).not.toMatch(/=>|\blet\b|\bconst\b/); // ES5, like the other inline scripts
    expect(LIVE_REFRESH_CSS).not.toContain("@keyframes");
    expect(LIVE_REFRESH_CSS).toContain("prefers-reduced-motion");
  });

  it("asks every five seconds with the fragment Accept header, and never with text/html", async () => {
    const el = live("/fragments/log/messages?q=a");
    const w = world([el]);
    expect(w.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url).toBe("/fragments/log/messages?q=a");
    expect(w.calls[0]!.headers["Accept"]).toBe("text/x-moshi-fragment");
    expect(JSON.stringify(w.calls[0]!.headers)).not.toContain("text/html");
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(2);
  });

  it("swaps in new markup, remembers the ETag and sends it back itself", async () => {
    const el = live("/f", '<i data-id="a"></i>');
    const w = world([el]);
    w.replies.push({ status: 200, etag: '"v1"', body: '<i data-id="a"></i><i data-id="b"></i>' }, { status: 304 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).toContain('data-id="b"');
    expect(w.calls[0]!.headers["If-None-Match"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls[1]!.headers["If-None-Match"]).toBe('"v1"');
    expect(el.swaps).toBe(1); // the 304 touched nothing
  });

  it("reloads the page exactly once when the session is gone", async () => {
    const a = live("/a"), b = live("/b");
    const w = world([a, b]);
    w.replies.push({ status: 401, type: "application/json" }, { status: 401, type: "application/json" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.reload).toHaveBeenCalledTimes(1);
    const asked = w.calls.length;
    expect(asked).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.reload).toHaveBeenCalledTimes(1);
    expect(w.calls).toHaveLength(asked); // and nobody asks again while the page reloads
  });

  it("never puts an error body into the page: wrong status or wrong type keeps the old content", async () => {
    const el = live("/f", "<b>old</b>");
    const w = world([el]);
    w.replies.push({ status: 500, type: "application/json", body: '{"error":"internal server error"}' },
      { status: 200, type: "application/json", body: '{"oops":1}' });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.calls).toHaveLength(2); // it did ask, twice
    expect(el.innerHTML).toBe("<b>old</b>");
    expect(el.swaps).toBe(0);
  });

  it("never puts a proxy's HTML error page into the page either: 502 text/html during a deploy", async () => {
    const el = live("/f", "<b>old</b>");
    const w = world([el]);
    w.replies.push({ status: 502, type: "text/html", body: "<h1>Bad Gateway</h1>" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(1);
    expect(el.innerHTML).toBe("<b>old</b>");
  });

  it("backs off on errors, doubling up to a minute, and returns to five seconds on success", async () => {
    const el = live("/f");
    const w = world([el]);
    w.replies.push(new Error("offline"), new Error("offline"), new Error("offline"), new Error("offline"), new Error("offline"),
      { status: 200, etag: '"v"', body: "ok" }, { status: 304 });
    const gaps: number[] = [];
    let last = 0, clock = 0;
    for (let i = 0; i < 400 && w.calls.length < 7; i++) {
      await vi.advanceTimersByTimeAsync(1000); clock += 1000;
      if (w.calls.length > gaps.length) { gaps.push(clock - last); last = clock; }
    }
    expect(gaps).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 5000]);
  });

  it("leaves a section alone while the keyboard focus or a text selection is inside it", async () => {
    const el = live("/f", '<i data-id="a"></i>');
    const w = world([el]);
    w.replies.push({ status: 200, etag: '"v1"', body: "NEW" }, { status: 200, etag: '"v1"', body: "NEW" }, { status: 200, etag: '"v1"', body: "NEW" });
    el.focusVisible = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).not.toBe("NEW");
    el.focusVisible = false;
    w.select(el.rows[0]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).not.toBe("NEW");
    // The skipped version was not recorded as seen: it is asked for again.
    expect(w.calls[2 - 1]!.headers["If-None-Match"]).toBeUndefined();
    w.select(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).toBe("NEW");
  });

  it("keeps a scroller where it was, and takes one that stood at the bottom to the new bottom", async () => {
    const markup = '<div data-live-scroll="thread"></div><div data-live-scroll="x"></div>';
    const el = live("/f", markup);
    const w = world([el]);
    el.scrollers[0]!.scrollTop = 700; // 1000 - 700 - 300 = 0: at the bottom
    el.scrollers[1]!.scrollLeft = 120; el.scrollers[1]!.scrollTop = 40;
    FakeScroller.nextHeight = 1400; // what the swap brings in is taller
    w.replies.push({ status: 200, etag: '"v"', body: markup + "<i></i>" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.swaps).toBe(1);
    const [thread, x] = el.scrollers;
    expect(x!.scrollLeft).toBe(120);
    expect(x!.scrollTop).toBe(40);
    expect(thread!.scrollTop).toBe(1100); // 1400 - 300: the new bottom, not the old position
  });

  it("a scroller marked data-live-follow=bottom starts at the bottom, follows new content, and lets go once the reader scrolls up", async () => {
    const box = (extra = "") => `<div data-live-scroll="home-thread" data-live-follow="bottom"></div>${extra}`;
    const el = live("/f", box());
    const w = world([el]);
    expect(el.scrollers[0]!.scrollTop).toBe(700); // pinned on the first run: the newest message is at the bottom
    FakeScroller.nextHeight = 1400;
    w.replies.push({ status: 200, etag: '"1"', body: box("<i></i>") });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.scrollers[0]!.scrollTop).toBe(1100);
    // The reader scrolls up to read something older: leave it there.
    el.scrollers[0]!.scrollTop = 200;
    FakeScroller.nextHeight = 1800;
    w.replies.push({ status: 200, etag: '"2"', body: box("<i></i><i></i>") });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.scrollers[0]!.scrollTop).toBe(200);
  });

  it("a follow scroller whose content did not overflow yet follows as soon as it does", async () => {
    FakeScroller.nextHeight = 300; // fits: scrollTop can only be 0
    const el = live("/f", '<div data-live-scroll="home-thread" data-live-follow="bottom"></div>');
    const w = world([el]);
    expect(el.scrollers[0]!.scrollTop).toBe(0);
    FakeScroller.nextHeight = 640;
    w.replies.push({ status: 200, etag: '"1"', body: '<div data-live-scroll="home-thread" data-live-follow="bottom"></div><i></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.scrollers[0]!.scrollTop).toBe(340);
  });

  it("marks rows it has not seen before, once, and only where the page asked for it", async () => {
    const marked = live("/a", '<i data-id="a"></i>', { "data-live-mark": "rows" });
    const plain = live("/b", '<i data-id="a"></i>');
    const w = world([marked, plain]);
    const body = '<i data-id="n"></i><i data-id="a"></i>';
    w.replies.push({ status: 200, etag: '"1"', body }, { status: 200, etag: '"1"', body });
    await vi.advanceTimersByTimeAsync(5000);
    const classesOf = (el: FakeEl, id: string) => [...el.rows.find((r) => r.id === id)!.classes];
    expect(classesOf(marked, "n")).toContain("d-new");
    expect(classesOf(marked, "a")).toEqual([]);
    expect(classesOf(plain, "n")).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(classesOf(marked, "n")).not.toContain("d-new"); // the fade has started
    await vi.advanceTimersByTimeAsync(3000);
    expect(classesOf(marked, "n")).toEqual([]);
  });

  it("marks nothing on the first fill of an empty section, and nothing under reduced motion", async () => {
    const empty = live("/a", "", { "data-live-mark": "rows" });
    const w = world([empty]);
    w.replies.push({ status: 200, etag: '"1"', body: '<i data-id="a"></i><i data-id="b"></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(empty.swaps).toBe(1);
    expect(empty.rows).toHaveLength(2);
    expect(empty.rows.flatMap((r) => [...r.classes])).toEqual([]);

    const el = live("/b", '<i data-id="a"></i>', { "data-live-mark": "rows" });
    const w2 = world([el]);
    w2.reduceMotion();
    w2.replies.push({ status: 200, etag: '"1"', body: '<i data-id="n"></i><i data-id="a"></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.rows.flatMap((r) => [...r.classes])).toEqual([]);
  });

  it("writes out-of-band text into the element the header names, as text", async () => {
    const el = live("/f");
    const count = new FakeEl({});
    const w = world([el], { "convos-count": count });
    w.replies.push({ status: 200, etag: '"1"', body: "x", oob: "convos-count=3+threads+%C2%B7+1+still+moving&missing=x" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(count.textContent).toBe("3 threads · 1 still moving");
  });

  it("a 304 after an outage brings the five second beat back", async () => {
    const el = live("/f");
    const w = world([el]);
    w.replies.push({ status: 200, etag: '"v"', body: "x" }, new Error("offline"), { status: 304 }, { status: 304 });
    const at: number[] = [];
    let clock = 0;
    for (let i = 0; i < 60 && w.calls.length < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000); clock += 1000;
      while (at.length < w.calls.length) at.push(clock);
    }
    expect(at).toEqual([5000, 10_000, 20_000, 25_000]);
  });

  it("reloads once even when two sections get their 401 while both requests are on the wire", async () => {
    const a = live("/a"), b = live("/b");
    const w = world([a, b]);
    let release = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    w.replies.push({ status: 401, type: "application/json", hold }, { status: 401, type: "application/json", hold });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(2); // both asked before either answer came
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.reload).toHaveBeenCalledTimes(1);
  });

  it("a caret is not a selection: a click into a bubble does not freeze the section", async () => {
    const el = live("/f", '<i data-id="a"></i>');
    const w = world([el]);
    w.select(el.rows[0], { collapsed: true });
    w.replies.push({ status: 200, etag: '"1"', body: "NEW" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).toBe("NEW");
  });

  it("leaves every section alone that a selection reaches into, also from outside and in a later range", async () => {
    const list = live("/list", "old list"), pane = live("/pane", "old pane"), other = live("/other", "old other");
    const w = world([list, pane, other]);
    w.selectAcross([list, pane], { afterUnrelatedRange: true }); // dragged from the list into the pane, or Cmd+A
    for (let i = 0; i < 3; i++) w.replies.push({ status: 200, etag: '"1"', body: "NEW" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(list.innerHTML).toBe("old list");
    expect(pane.innerHTML).toBe("old pane");
    expect(other.innerHTML).toBe("NEW");
  });

  it("does not replace what a pointer is pressed down on: the click would never arrive", async () => {
    // A swap between mousedown and mouseup removes the element the press
    // began on, and the browser then fires no click at all.
    const list = live("/list", '<i data-id="a"></i>'), other = live("/other", "old");
    const w = world([list, other]);
    for (let i = 0; i < 4; i++) w.replies.push({ status: 200, etag: `"${i}"`, body: "NEW" });
    w.listeners["mousedown"]!({ target: list.rows[0] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(list.innerHTML).not.toBe("NEW");
    expect(other.innerHTML).toBe("NEW");
    w.listeners["mouseup"]!({});
    await vi.advanceTimersByTimeAsync(5000);
    expect(list.innerHTML).toBe("NEW"); // caught up: the skipped version was never counted as seen
  });

  it("treats a finger like a mouse button, and a cancelled touch as lifted", async () => {
    const el = live("/f", '<i data-id="a"></i>');
    const w = world([el]);
    w.replies.push({ status: 200, etag: '"1"', body: "NEW" }, { status: 200, etag: '"1"', body: "NEW" });
    w.listeners["touchstart"]!({ target: el.rows[0] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).not.toBe("NEW");
    w.listeners["touchcancel"]!({});
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.innerHTML).toBe("NEW");
  });

  it("marks a new row whatever its id is called, also `constructor` and `__proto__`", async () => {
    // A thread row's id is the sender's correlation_id: any string.
    const el = live("/f", '<i data-id="a"></i>', { "data-live-mark": "rows" });
    const w = world([el]);
    w.replies.push({ status: 200, etag: '"1"', body: '<i data-id="constructor"></i><i data-id="__proto__"></i><i data-id="n"></i><i data-id="a"></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.rows.filter((r) => r.classes.has("d-new")).map((r) => r.id)).toEqual(["constructor", "__proto__", "n"]);
  });

  it("does not replace the markup when a 200 brings what is already there, but still takes the out-of-band text", async () => {
    // A proxy that rewrites ETags turns every 304 into a 200. Replacing the
    // DOM every five seconds would reset hover, tooltips and a screen
    // reader's position for nothing.
    const el = live("/f");
    const count = new FakeEl({});
    const w = world([el], { "convos-count": count });
    w.replies.push({ status: 200, etag: 'W/"1"', body: "<b>same</b>", oob: "convos-count=1+thread" },
      { status: 200, etag: 'W/"2"', body: "<b>same</b>", oob: "convos-count=2+threads" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.swaps).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.swaps).toBe(1);
    expect(count.textContent).toBe("2 threads");
    expect(w.calls[2 - 1]!.headers["If-None-Match"]).toBe('W/"1"');
  });

  it("tells a screen reader how many rows are new, in a status element outside of the swapped markup", async () => {
    const el = live("/f", '<i data-id="a"></i>', { "data-live-mark": "rows", "data-live-noun": "message" });
    const status = new FakeEl({});
    const w = world([el], { "d-live-status": status });
    w.replies.push({ status: 200, etag: '"1"', body: '<i data-id="a"></i><i data-id="b"></i>' },
      { status: 200, etag: '"2"', body: '<i data-id="a"></i><i data-id="b"></i><i data-id="c"></i><i data-id="d"></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(status.textContent).toBe("1 new message");
    await vi.advanceTimersByTimeAsync(5000);
    expect(status.textContent).toBe("2 new messages");
  });

  it("announces new rows under reduced motion too, where nothing is highlighted", async () => {
    const el = live("/f", '<i data-id="a"></i>', { "data-live-mark": "rows", "data-live-noun": "message" });
    const status = new FakeEl({});
    const w = world([el], { "d-live-status": status });
    w.reduceMotion();
    w.replies.push({ status: 200, etag: '"1"', body: '<i data-id="a"></i><i data-id="b"></i>' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(status.textContent).toBe("1 new message");
    expect(el.rows.flatMap((r) => [...r.classes])).toEqual([]);
  });

  it("does not ask while the tab is hidden, and asks at once when it comes back", async () => {
    const el = live("/f");
    const w = world([el]);
    w.document.hidden = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.calls).toHaveLength(0);
    w.document.hidden = false;
    w.listeners["visibilitychange"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls).toHaveLength(1);
  });

  it("does nothing on a page without live sections", async () => {
    const w = world([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.calls).toHaveLength(0);
  });
});
