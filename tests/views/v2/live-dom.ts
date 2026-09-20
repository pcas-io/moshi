// A small fake DOM for the live-refresh script, run in node:vm. There is no
// DOM library in this project, so the fake implements just the calls the
// script makes — which also documents them.

import { expect, vi } from "vitest";
import vm from "node:vm";
import { LIVE_REFRESH_SCRIPT } from "../../../src/views/v2/live-refresh";

export const JS = String(LIVE_REFRESH_SCRIPT).replace(/^<script>/, "").replace(/<\/script>$/, "");

export class FakeRow {
  classes = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
  };
  constructor(public id: string) {}
  getAttribute(k: string) { return k === "data-id" ? this.id : null; }
}
export class FakeScroller {
  /** The height the NEXT scroller is born with: a swap creates new elements. */
  static nextHeight = 1000;
  scrollTop = 0; scrollLeft = 0; scrollHeight = FakeScroller.nextHeight; clientHeight = 300;
  constructor(public key: string, public follow: string | null = null) {}
  getAttribute(k: string) { return k === "data-live-scroll" ? this.key : k === "data-live-follow" ? this.follow : null; }
}
export class FakeEl {
  attrs: Record<string, string>;
  rows: FakeRow[] = [];
  scrollers: FakeScroller[] = [];
  swaps = 0;
  focusVisible = false;
  textContent = "";
  private html = "";
  constructor(attrs: Record<string, string>, html = "") { this.attrs = attrs; this.innerHTML = html; this.swaps = 0; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  get innerHTML() { return this.html; }
  set innerHTML(v: string) {
    this.html = v; this.swaps++;
    this.rows = [...v.matchAll(/data-id="([^"]+)"/g)].map((m) => new FakeRow(m[1]!));
    this.scrollers = [...v.matchAll(/data-live-scroll="([^"]+)"( data-live-follow="([^"]+)")?/g)]
      .map((m) => new FakeScroller(m[1]!, m[3] ?? null));
  }
  querySelectorAll(sel: string) {
    if (sel === "[data-id]") return this.rows;
    if (sel === "[data-live-scroll]") return this.scrollers;
    throw new Error("unexpected selector " + sel);
  }
  querySelector(sel: string) {
    if (sel === ":focus-visible") return this.focusVisible ? {} : null;
    throw new Error("unexpected selector " + sel);
  }
  contains(node: unknown) { return node === this || (this.rows as unknown[]).includes(node); }
}

export interface Reply { status: number; type?: string; etag?: string; oob?: string; body?: string; hold?: Promise<void> }

export function world(els: FakeEl[], byId: Record<string, FakeEl> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const replies: (Reply | Error)[] = [];
  const listeners: Record<string, (ev?: unknown) => void> = {};
  const document = {
    hidden: false,
    querySelectorAll: (sel: string) => { expect(sel).toBe("[data-live][data-live-src]"); return els; },
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: (name: string, fn: (ev?: unknown) => void) => { listeners[name] = fn; },
  };
  interface FakeRange { commonAncestorContainer: unknown; intersectsNode: (el: FakeEl) => boolean }
  let selection: { isCollapsed: boolean; rangeCount: number; getRangeAt: (i: number) => FakeRange } | null = null;
  const selectionOf = (ranges: FakeRange[], collapsed = false) =>
    ({ isCollapsed: collapsed, rangeCount: ranges.length, getRangeAt: (i: number) => ranges[i]! });
  const reload = vi.fn();
  const win = {
    fetch: (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const r = replies.shift() ?? { status: 304 };
      if (r instanceof Error) return Promise.reject(r);
      const headers = new Map<string, string>([["content-type", r.type ?? "text/html; charset=UTF-8"]]);
      if (r.etag) headers.set("etag", r.etag);
      if (r.oob) headers.set("x-moshi-oob", r.oob);
      const res = { status: r.status, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, text: () => Promise.resolve(r.body ?? "") };
      return r.hold ? r.hold.then(() => res) : Promise.resolve(res);
    },
    getSelection: () => selection,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    location: { reload },
  } as Record<string, unknown>;
  win.window = win;
  vm.runInNewContext(JS, { ...win, window: win, document, setTimeout, clearTimeout, Math, Object, String, Error, decodeURIComponent, console });
  return {
    calls, replies, reload, document, listeners,
    /** A selection inside one node. */
    select: (node: unknown, opts: { collapsed?: boolean } = {}) => {
      selection = node
        ? selectionOf([{ commonAncestorContainer: node, intersectsNode: (el) => el.contains(node) }], opts.collapsed)
        : null;
    },
    /** A selection that starts in one container and ends in another: their
     *  common ancestor is outside of both. Optionally behind an unrelated range. */
    selectAcross: (touched: FakeEl[], opts: { afterUnrelatedRange?: boolean } = {}) => {
      const across: FakeRange = { commonAncestorContainer: { outside: true }, intersectsNode: (el) => touched.includes(el) };
      const unrelated: FakeRange = { commonAncestorContainer: { outside: true }, intersectsNode: () => false };
      selection = selectionOf(opts.afterUnrelatedRange ? [unrelated, across] : [across]);
    },
    reduceMotion: () => { win.matchMedia = () => ({ matches: true }); },
  };
}

export const live = (src: string, html = "", extra: Record<string, string> = {}) =>
  new FakeEl({ "data-live": "x", "data-live-src": src, ...extra }, html);
