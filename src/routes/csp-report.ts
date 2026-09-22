// POST /csp-report: where a browser says what the Content-Security-Policy
// blocked, or would have blocked while it is Report-Only.
//
// Public and unauthenticated by nature (the sign-in page reports too), so it
// takes little, keeps less, and never answers with anything but 204: one
// bounded log line per report, at most sixty a minute (and one line that says
// how many were left out), paths without their query strings, nothing of a
// body it does not understand.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { log } from "../services/logger.js";

const MAX_LINES_PER_MINUTE = 60;
const MAX_FIELD = 200;
/** The browser cuts a script sample at 40 characters. Cut again: it is the
 *  sender's text. */
const MAX_SAMPLE = 80;

const short = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value.slice(0, MAX_FIELD) : undefined);

/** Origin and path, never the query: a URL in a report can carry anything. */
function withoutQuery(value: unknown): string | undefined {
  const text = short(value);
  if (!text) return undefined;
  if (!/^https?:\/\//i.test(text)) return text.split("?")[0]; // "inline", "eval", "data"
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`.slice(0, MAX_FIELD);
  } catch {
    return undefined;
  }
}

function pathOf(value: unknown): string | undefined {
  const text = short(value);
  if (!text) return undefined;
  try {
    return new URL(text).pathname.slice(0, MAX_FIELD);
  } catch {
    return undefined;
  }
}

interface Violation {
  document?: string;
  directive?: string;
  blocked?: string;
  line?: number;
  disposition?: string;
  /** Where the script came from, and how it begins ('report-sample'): what
   *  tells an own script that lost its nonce from one a proxy or a browser
   *  extension put into the page. "inline" on line 2 says neither. */
  source?: string;
  sample?: string;
}

function violationsIn(body: unknown): Violation[] {
  const one = (r: Record<string, unknown>): Violation | null => {
    const directive = short(r["effective-directive"] ?? r["violated-directive"] ?? r["effectiveDirective"]);
    if (!directive) return null;
    const line = r["line-number"] ?? r["lineNumber"];
    return {
      document: pathOf(r["document-uri"] ?? r["documentURL"]),
      directive,
      blocked: withoutQuery(r["blocked-uri"] ?? r["blockedURL"]),
      line: typeof line === "number" && Number.isFinite(line) ? line : undefined,
      disposition: short(r["disposition"]),
      source: withoutQuery(r["source-file"] ?? r["sourceFile"]),
      sample: short(r["script-sample"] ?? r["sample"])?.slice(0, MAX_SAMPLE),
    };
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(body) && isObject(body["csp-report"])) return [one(body["csp-report"])].filter((v): v is Violation => v !== null);
  if (Array.isArray(body)) {
    return body.slice(0, 10).flatMap((r) => (isObject(r) && r["type"] === "csp-violation" && isObject(r["body"]) ? [one(r["body"])] : [])).filter((v): v is Violation => v !== null);
  }
  return [];
}

export function createCspReportRoute(now: () => number = Date.now): Hono {
  const route = new Hono();
  let windowStart = Number.NEGATIVE_INFINITY;
  let lines = 0;
  let leftOut = 0;

  route.all("/csp-report", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405, { Allow: "POST" });
    let body: unknown = null;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      /* not JSON: nothing to say about it */
    }
    for (const violation of violationsIn(body)) {
      // A new minute, or a clock that stepped back (which must not keep this
      // shut for the length of the step).
      const age = now() - windowStart;
      if (age >= 60_000 || age < 0) {
        // Sixty junk posts a minute cost nothing and would hide every real
        // report. They still can; this says that it happened.
        if (leftOut > 0) log("warn", "csp violations not logged", { count: leftOut, limit_per_minute: MAX_LINES_PER_MINUTE });
        windowStart = now();
        lines = 0;
        leftOut = 0;
      }
      if (lines >= MAX_LINES_PER_MINUTE) { leftOut++; continue; }
      lines++;
      log("warn", "csp violation", { ...violation });
    }
    return c.body(null, 204);
  });
  return route;
}
