// The titles of result links on the board.
//
// An operator who lets the board link results (MESH_RESULT_LINK_HOSTS) may
// also give moshi a READ-ONLY token for the service those links point to
// (MESH_RESULT_TITLE_MCP_URL, MESH_RESULT_TITLE_TOKEN). moshi then asks that
// service's MCP endpoint `get_entity(id)` once per id and keeps only the
// `title` of the answer; the rest is dropped on the spot.
//
// The board never waits for this. `titleOf` answers from the cache, `want`
// asks in the background (a few at a time, each bounded), and the next
// refresh shows what arrived. A title is kept for an hour, a failure for
// five minutes; without a token there is nothing to ask and every link keeps
// the end of its id. The token is never logged, and an error says no more
// than its kind.

import { log } from "./logger.js";

export const TITLE_TTL_MS = 60 * 60 * 1000;
export const FAILURE_TTL_MS = 5 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 3_000;
const MAX_IN_FLIGHT = 4;
const MAX_ENTRIES = 1000;
const MAX_TITLE = 120;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface Entry {
  title: string | null;
  until: number;
}

/** A title as it may appear on a page: one line, no control characters, bounded. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const one = raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  if (one === "") return null;
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1)}…` : one;
}

/** The JSON-RPC answer, whether it came as JSON or as one SSE event. */
function rpcResult(body: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const data = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

/** The `title` inside a `tools/call` answer whose first content is the entity as JSON. */
export function titleFromAnswer(answer: unknown): string | null {
  const result = (answer as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } })?.result;
  if (!result || result.isError) return null;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return cleanTitle((JSON.parse(text) as { title?: unknown }).title);
  } catch {
    return null;
  }
}

export class ResultTitles {
  private cache = new Map<string, Entry>();
  private asking = new Set<string>();
  private queue: string[] = [];

  constructor(
    private readonly opts: {
      mcpUrl: string;
      token: string;
      fetch?: Fetcher;
      now?: () => number;
    },
  ) {}

  /** What is known about `id` now: its title, or null (unknown, or no title). */
  titleOf(id: string): string | null {
    const hit = this.cache.get(id);
    return hit && hit.until > this.now() ? hit.title : null;
  }

  /** Ask for the titles of `ids` that are not known, in the background. */
  want(ids: string[]): void {
    for (const id of ids) {
      const hit = this.cache.get(id);
      if ((hit && hit.until > this.now()) || this.asking.has(id) || this.queue.includes(id)) continue;
      this.queue.push(id);
    }
    this.pump();
  }

  /** Resolves when everything asked for so far has an answer (tests). */
  async settled(): Promise<void> {
    while (this.asking.size > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 1));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private pump(): void {
    while (this.asking.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.asking.add(id);
      void this.ask(id).finally(() => {
        this.asking.delete(id);
        this.pump();
      });
    }
  }

  private remember(id: string, title: string | null, ttl: number): void {
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { title, until: this.now() + ttl });
  }

  private async ask(id: string): Promise<void> {
    const fetcher = this.opts.fetch ?? ((url, init) => fetch(url, init));
    try {
      const res = await fetcher(this.opts.mcpUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_entity", arguments: { id } } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const title = titleFromAnswer(rpcResult(await res.text(), res.headers.get("content-type") ?? ""));
      this.remember(id, title, title ? TITLE_TTL_MS : FAILURE_TTL_MS);
    } catch (err) {
      this.remember(id, null, FAILURE_TTL_MS);
      log("warn", "result title lookup failed", { error: (err as Error).name === "TimeoutError" ? "timeout" : String((err as Error).message).slice(0, 80) });
    }
  }
}
