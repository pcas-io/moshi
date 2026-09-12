// The merged Log screen: two tabs, one route.
//
// These assert the things that rot silently — the COPY §8 strings, the
// audit sentences (keyed on the snake_case actions the services really
// write, not the dotted names the copy deck guesses at), and the controls
// the redesign deleted.

import { describe, it, expect } from "vitest";
import { V2LogPage, parseLogTab, parseLogRouting, messageRoutingOf } from "../../../src/views/v2/log";
import type { V2LogProps } from "../../../src/views/v2/log";
import { auditSentence, entityLabel } from "../../../src/views/v2/activity";
import { LOG_EMPTY_TEXT } from "../../../src/views/v2/messages";
import type { MessageView } from "../../../src/services/message-queries";
import { ACTIVITY_RETENTION_DAYS, MESSAGE_RETENTION_DAYS } from "../../../src/types";
import type { Activity, PaginatedResult } from "../../../src/types";

async function render(props: V2LogProps): Promise<string> {
  return String(await Promise.resolve(V2LogPage(props)));
}

/** Hono escapes `'` and `&` in text nodes; undo it so assertions read as copy. */
function text(html: string): string {
  return html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const NOW = new Date("2026-09-12T09:41:00Z").toISOString();

function msg(over: Partial<MessageView> = {}): MessageView {
  return {
    id: "01JMSG000000000000000000",
    from: "ops-kai",
    to: "triage-1",
    type: "info",
    payload: "{}",
    context: "the redeploy",
    correlation_id: null,
    reply_to: null,
    priority: "normal",
    ttl_seconds: 86400,
    created_at: NOW,
    ...over,
  };
}

function ev(over: Partial<Activity> = {}): Activity {
  return {
    id: "01JACT000000000000000000",
    action: "message_sent",
    entity_type: "message",
    entity_id: "01JMSG000000000000000000",
    summary: "ops-kai → triage-1 [incident]",
    agent_name: "ops-kai",
    created_at: NOW,
    ...over,
  };
}

function page<Row>(data: Row[], over: Partial<PaginatedResult<Row>> = {}): PaginatedResult<Row> {
  return { data, has_more: false, total: data.length, limit: 50, offset: 0, ...over };
}

const BASE: V2LogProps = { tab: "messages", agentRoles: {}, userRole: "admin" };

describe("Log shell", () => {
  it("titles the page and leads with the retention sentence", async () => {
    const html = await render({ ...BASE, messages: page([msg()]) });
    expect(html).toContain("<title>Log — moshi.moshi</title>");
    expect(html).toContain(">Log</h1>");
    expect(html).toContain(
      "Everything that happened, newest first. Messages keep 30 days of history; audit events keep 90.",
    );
  });

  it("states retention from the rotation constants, not a retyped number", async () => {
    const html = await render({ ...BASE, messages: page([msg()]) });
    expect(html).toContain(
      `Messages keep ${MESSAGE_RETENTION_DAYS} days of history; audit events keep ${ACTIVITY_RETENTION_DAYS}.`,
    );
  });

  it("renders both tabs and underlines the active one", async () => {
    const html = await render({ ...BASE, messages: page([msg()]) });
    expect(html).toContain(">Messages</a>");
    expect(html).toContain(">Audit trail</a>");
    expect(html).toContain('href="/log?tab=audit"');
    expect(html).toContain("border-bottom:2px solid #0e8a3e");
  });

  it("carries the search and routing state across the tab links", async () => {
    const html = await render({
      ...BASE, tab: "messages", query: "nginx", routing: "broadcast", messages: page([msg()]),
    });
    expect(html).toContain("tab=audit&amp;routing=broadcast&amp;q=nginx");
  });

  it("shows the three routing pills on the messages tab only", async () => {
    const messages = await render({ ...BASE, messages: page([msg()]) });
    expect(messages).toContain(">Everything</a>");
    expect(messages).toContain(">One to one</a>");
    expect(messages).toContain(">To everyone</a>");

    const audit = await render({ ...BASE, tab: "audit", events: page([ev()]) });
    expect(audit).not.toContain(">One to one</a>");
    expect(audit).not.toContain(">To everyone</a>");
  });

  it("keeps the search box on both tabs, submitting back to /log", async () => {
    for (const props of [
      { ...BASE, messages: page([msg()]) },
      { ...BASE, tab: "audit" as const, events: page([ev()]) },
    ]) {
      const html = await render(props);
      expect(html).toContain('placeholder="Search payload, context, message or thread id"');
      expect(html).toContain('action="/log"');
      expect(html).toContain(`value="${props.tab}"`);
    }
  });

  it("animates exactly one element per screen", async () => {
    for (const props of [
      { ...BASE, messages: page([msg()]) },
      { ...BASE, tab: "audit" as const, events: page([ev()]), topActors: [{ agent_name: "ops-kai", count: 3 }] },
    ]) {
      const html = await render(props);
      expect(html.match(/class="m-rise"/g)).toHaveLength(1);
      expect(html).not.toContain("m-pulse 1.6s");
    }
  });

  it("parses the query string it emits", () => {
    expect(parseLogTab("audit")).toBe("audit");
    expect(parseLogTab("messages")).toBe("messages");
    expect(parseLogTab("nonsense")).toBe("messages");
    expect(parseLogTab(undefined)).toBe("messages");
    expect(parseLogRouting("direct")).toBe("direct");
    expect(parseLogRouting("broadcast")).toBe("broadcast");
    expect(parseLogRouting("capability")).toBe("all");
    expect(messageRoutingOf("all")).toBeUndefined();
    expect(messageRoutingOf("direct")).toBe("direct");
  });
});

describe("Log · Messages tab", () => {
  it("renders the five column headers and a row", async () => {
    const html = await render({ ...BASE, messages: page([msg({ context: "the nginx 502 spike" })]) });
    for (const h of ["Time", "From", "To", "Kind", "What it was about"]) {
      expect(html).toContain(`>${h}</span>`);
    }
    expect(html).toContain(">ops-kai</span>");
    expect(html).toContain(">triage-1</span>");
    expect(html).toContain(">the nginx 502 spike</span>");
  });

  it("calls a broadcast recipient everyone", async () => {
    const html = await render({ ...BASE, messages: page([msg({ to: "broadcast" })]) });
    expect(html).toContain(">everyone</span>");
    expect(html).not.toContain("ALL LIVE AGENTS");
    expect(html).not.toContain(">broadcast</span>");
  });

  it("drops the Prio column and marks only high priority, with a red dot", async () => {
    const high = await render({ ...BASE, messages: page([msg({ priority: "high" })]) });
    expect(high).toContain('title="High priority"');
    expect(high).toContain("background:#c0392b;flex-shrink:0");

    const normal = await render({ ...BASE, messages: page([msg({ priority: "normal" })]) });
    expect(normal).not.toContain('title="High priority"');
    expect(normal).not.toContain(">Prio</span>");
    expect(normal).not.toContain(">normal<");
  });

  it("shows the display label for a kind, not the wire value", async () => {
    const html = await render({ ...BASE, messages: page([msg({ type: "task_update" })]) });
    expect(html).toContain(">progress</span>");
    expect(html).not.toContain(">task_update</span>");
  });

  it("counts the page the way COPY sets it: en dash, space thousands", async () => {
    const html = await render({
      ...BASE,
      messages: page([msg()], { total: 1284, has_more: true, offset: 0, limit: 50 }),
    });
    expect(html).toContain("Showing 1–50 of 1 284");
    expect(html).toContain("Older →");
    expect(html).not.toContain("← Newer");
    expect(html).not.toContain("1,284");
  });

  it("offers ← Newer once past the first page", async () => {
    const html = await render({
      ...BASE,
      messages: page([msg()], { total: 120, has_more: true, offset: 50, limit: 50 }),
    });
    expect(html).toContain("← Newer");
    // Page one is the bare URL — no `offset=0` noise in the link.
    expect(html).toContain('href="/log?tab=messages"');
    expect(html).toContain("offset=100");
    expect(html).toContain("Showing 51–100 of 120");
  });

  it("drops both buttons when everything fits on one page", async () => {
    const html = await render({ ...BASE, messages: page([msg()], { total: 1 }) });
    expect(html).toContain("Showing 1–1 of 1");
    expect(html).not.toContain("Older →");
    expect(html).not.toContain("← Newer");
  });

  it("says one thing when nothing matches", async () => {
    const html = await render({ ...BASE, messages: page<MessageView>([]), query: "zzz" });
    expect(html).toContain(LOG_EMPTY_TEXT);
    expect(html).toContain("Nothing matches this filter · なし");
    expect(html).toContain(">Time</span>"); // the header row survives
    expect(html).not.toContain("Showing");
  });

  it("ships none of the controls the redesign removed", async () => {
    const html = await render({ ...BASE, messages: page([msg()]) });
    for (const gone of [
      "READ-ONLY LOG",
      "Routing · All",
      "capability:*",
      "spec'd",
      "Context · required",
      "60 msg/min",
      "なし · no messages for this filter",
    ]) {
      expect(text(html)).not.toContain(gone);
    }
  });
});

describe("Log · Audit trail tab", () => {
  const actors = [
    { agent_name: "ops-kai", count: 11 },
    { agent_name: "admin", count: 4 },
  ];

  it("renders a sentence per row with the raw action on the title", async () => {
    const html = await render({
      ...BASE, tab: "audit", topActors: actors,
      events: page([ev({ summary: "ops-kai → triage-1 [incident]" })]),
    });
    expect(html).toContain("ops-kai messaged triage-1");
    expect(html).toContain('title="message_sent"');
  });

  it("labels entities as words", async () => {
    const html = await render({
      ...BASE, tab: "audit", topActors: actors,
      events: page([
        ev({ id: "a", entity_type: "message" }),
        ev({ id: "b", entity_type: "session", action: "auth_login", agent_name: "admin", summary: "admin authenticated (admin)" }),
        ev({ id: "c", entity_type: "agent", action: "agent_created", agent_name: "admin", summary: 'Agent "dex-eu" created' }),
      ]),
    });
    expect(html).toContain(">message</span>");
    expect(html).toContain(">sign-in</span>");
    expect(html).toContain(">agent change</span>");
    expect(html).not.toContain(">session</span>");
  });

  it("badges the operator as You and an agent with its emblem", async () => {
    const html = await render({
      ...BASE, tab: "audit", topActors: actors,
      events: page([
        ev({ id: "a", action: "auth_login", entity_type: "session", agent_name: "admin", summary: "admin authenticated (admin)" }),
        ev({ id: "b", agent_name: "ops-kai" }),
      ]),
    });
    expect(html).toContain(">You</span>");
    expect(html).toContain("<svg"); // the agent's emblem
  });

  it("renders the Busiest today aside from real totals", async () => {
    const html = await render({ ...BASE, tab: "audit", events: page([ev()]), topActors: actors });
    expect(html).toContain("Busiest today");
    expect(html).toContain(">11</span>");
    expect(html).toContain("width:100%;height:100%");   // top actor's bar
    expect(html).toContain("width:36%;height:100%");    // 4 of 11
    expect(html).not.toContain("Top Actors");
  });

  it("paginates the stream with the same footer as the messages tab", async () => {
    const html = await render({
      ...BASE, tab: "audit", topActors: actors,
      events: page([ev()], { total: 240, has_more: true, offset: 50, limit: 50 }),
    });
    expect(html).toContain("Showing 51–100 of 240");
    expect(html).toContain("tab=audit&amp;offset=100");
    expect(html).toContain("← Newer");
  });

  it("says one thing when nothing matches, in the stream and the aside", async () => {
    const html = await render({ ...BASE, tab: "audit", events: page<Activity>([]), topActors: [] });
    expect(html.match(new RegExp(LOG_EMPTY_TEXT, "g"))).toHaveLength(2);
    expect(html).toContain("Busiest today");
    expect(html).not.toContain("まだ");
  });

  it("ships none of the chrome the redesign removed", async () => {
    const html = await render({ ...BASE, tab: "audit", events: page([ev()]), topActors: actors });
    for (const gone of [
      "AUDIT LOG",
      "STREAMING",
      "Top Actors",
      "なし · no events for this filter",
      "Last 15m",
      "All time",
    ]) {
      expect(text(html)).not.toContain(gone);
    }
  });
});

describe("audit sentences", () => {
  // Every action string the services actually write:
  // grep -rn 'action: "' src
  const cases: ReadonlyArray<readonly [Partial<Activity>, string]> = [
    [{ action: "message_sent", agent_name: "ops-kai", summary: "ops-kai → triage-1 [incident]" },
      "ops-kai messaged triage-1"],
    [{ action: "message_sent", agent_name: "pm-mira", summary: "pm-mira → broadcast [info]" },
      "pm-mira messaged everyone"],
    [{ action: "message_sent", agent_name: "ops-kai", summary: "ops-kai → triage-1 [reply to 01J]" },
      "ops-kai messaged triage-1"],
    [{ action: "auth_login", agent_name: "admin", summary: "admin authenticated (admin)" },
      "You signed in — session cookie issued"],
    // No separate MCP action: a check-in is auth_login by a non-operator.
    [{ action: "auth_login", agent_name: "cortex-local", summary: "cortex-local authenticated (agent)" },
      "cortex-local checked in over MCP"],
    [{ action: "agent_created", agent_name: "admin", summary: 'Agent "dex-eu" created' },
      "You created dex-eu"],
    [{ action: "agent_revoked", agent_name: "admin", summary: 'Agent "qa-bot" revoked' },
      "You deactivated qa-bot"],
    [{ action: "agent_reactivated", agent_name: "admin", summary: 'Agent "qa-bot" reactivated with new token' },
      "You reactivated qa-bot"],
    [{ action: "agent_renamed", agent_name: "admin", summary: 'Agent "scout" renamed to "scout-eu"' },
      "You renamed scout to scout-eu"],
    [{ action: "agent_token_reset", agent_name: "admin", summary: 'Token reset for agent "scout"' },
      "You reset scout's token"],
    [{ action: "agent_deleted", agent_name: "admin", summary: 'Agent "ghost" deleted' },
      "You deleted ghost"],
  ];

  for (const [over, expected] of cases) {
    it(`turns ${over.action} into "${expected}"`, () => {
      expect(auditSentence(ev(over))).toBe(expected);
    });
  }

  it("never leaves a known action as its stored summary", () => {
    for (const [over] of cases) {
      const row = ev(over);
      expect(auditSentence(row)).not.toBe(row.summary);
      expect(auditSentence(row)).not.toBe(row.action);
    }
  });

  it("treats an operator with no name as You", () => {
    expect(auditSentence(ev({ action: "auth_login", agent_name: null, summary: null })))
      .toBe("You signed in — session cookie issued");
  });

  it("falls back to the stored summary, then the action, for anything unknown", () => {
    expect(auditSentence(ev({ action: "quota_exceeded", summary: "scout hit the cap" })))
      .toBe("scout hit the cap");
    expect(auditSentence(ev({ action: "quota_exceeded", summary: null }))).toBe("quota_exceeded");
    // A malformed row for a known action degrades instead of printing "You created undefined".
    expect(auditSentence(ev({ action: "agent_created", summary: "Agent created" }))).toBe("Agent created");
  });

  it("keeps unknown entity types verbatim", () => {
    expect(entityLabel("message")).toBe("message");
    expect(entityLabel("session")).toBe("sign-in");
    expect(entityLabel("agent")).toBe("agent change");
    expect(entityLabel("webhook")).toBe("webhook");
  });
});
