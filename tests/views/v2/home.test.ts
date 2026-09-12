// Rendering tests for the "Daylight" Home screen.
//
// These guard what rots silently: the four COPY.md §4 headlines, the lead
// sentence, the needs-attention band (which must not appear when there is
// nothing to attend to), the zero-agent hero, and the fact that the SENTINEL
// furniture — KPI band, mesh topology, uptime line, avatar pool — is gone.

import { describe, it, expect } from "vitest";
import {
  V2HomePage,
  homeHeadline,
  type V2HomeAgent,
  type V2HomeProps,
  type V2HomeThread,
} from "../../../src/views/v2/home";
import type { AttentionItem } from "../../../src/services/attention";

/** Local time, so the date line and the clock are stable in any TZ. */
const NOW = new Date("2026-09-12T14:16:00");

function render(props: V2HomeProps): Promise<string> {
  return Promise.resolve(V2HomePage(props)).then(String);
}

/** Hono escapes text nodes; apostrophes come out as entities. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

function agent(over: Partial<V2HomeAgent> = {}): V2HomeAgent {
  return {
    id: "01J0AGENT0000000000000000",
    name: "scout",
    role: "dev-assistant",
    presence: "live",
    msg24: 12,
    working_on: "indexing the docs",
    last_seen_at: NOW.toISOString(),
    ...over,
  };
}

const ROSTER: V2HomeAgent[] = [
  agent({ id: "a1", name: "triage-1", presence: "live", msg24: 31 }),
  agent({ id: "a2", name: "ops-kai", presence: "live", msg24: 22 }),
  agent({ id: "a3", name: "qa-bot", presence: "stale", msg24: 4, working_on: null }),
  agent({ id: "a4", name: "dex-eu", presence: "offline", msg24: 0 }),
  agent({ id: "a5", name: "nia", presence: "never", msg24: 0, last_seen_at: null }),
  agent({ id: "a6", name: "sec-warden", presence: "offline", msg24: 1 }),
];

function message(over: Partial<V2HomeThread["messages"][number]> = {}) {
  return {
    id: "m1",
    from: "triage-1",
    type: "info",
    payload: "checked the queue",
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  };
}

function thread(over: Partial<V2HomeThread> = {}): V2HomeThread {
  return {
    correlation_id: "01J0THREAD000000000000000",
    context: "incident #2214",
    participants: ["triage-1", "ops-kai"],
    messageCount: 6,
    messages: [
      message({ id: "m1", from: "triage-1", payload: "one" }),
      message({ id: "m2", from: "ops-kai", payload: "two" }),
      message({ id: "m3", from: "triage-1", payload: "three" }),
      message({ id: "m4", from: "ops-kai", payload: "four" }),
      message({ id: "m5", from: "triage-1", payload: "five" }),
      message({ id: "m6", from: "ops-kai", payload: "six" }),
    ],
    ...over,
  };
}

const BASE_STATS: V2HomeProps["stats"] = {
  agentsTotal: 8,
  agentsLive: 4,
  agentsStale: 2,
  msg24h: 103,
  threads: 14,
  incidents24h: 0,
};

function props(over: Partial<V2HomeProps> = {}): V2HomeProps {
  return {
    agents: ROSTER,
    attention: [],
    latestIncident: null,
    liveThread: null,
    now: NOW,
    userRole: "admin",
    csrfToken: "csrf-1",
    ...over,
    stats: { ...BASE_STATS, ...(over.stats ?? {}) },
  };
}

function attentionItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: "stale_agent",
    agent: "scout",
    text: "hasn't checked in for 3 days",
    href: "/agents?inspect=&presence=off#scout",
    ...over,
  };
}

describe("V2HomePage — headline (COPY.md §4)", () => {
  it("spells both numbers below thirteen", () => {
    expect(homeHeadline(4, 8)).toBe("Four of your eight agents are awake and talking.");
  });

  it("falls back to digits above twelve", () => {
    expect(homeHeadline(14, 20)).toBe("14 of your 20 agents are awake and talking.");
  });

  it("renders the nobody variant", async () => {
    const html = await render(props({ stats: { ...BASE_STATS, agentsLive: 0 } }));
    expect(html).toContain("Nobody is online right now.");
  });

  it("renders the one-agent variant", async () => {
    const html = await render(props({ stats: { ...BASE_STATS, agentsLive: 1 } }));
    expect(html).toContain("One of your eight agents is awake.");
  });

  it("renders the all-online variant", async () => {
    const html = await render(props({ stats: { ...BASE_STATS, agentsLive: 8, agentsStale: 0 } }));
    expect(html).toContain("All eight of your agents are awake and talking.");
  });

  it("renders the some-online variant", async () => {
    const html = await render(props());
    expect(html).toContain("Four of your eight agents are awake and talking.");
  });

  it("carries the date line and exactly one m-rise", async () => {
    const html = await render(props());
    // 12 September 2026 is a Saturday; COPY.md's sample line was written in 2025.
    expect(html).toContain("Saturday, 12 September · 14:16");
    expect(html.match(/class="m-rise"/g)).toHaveLength(1);
  });
});

describe("V2HomePage — lead sentence and counters", () => {
  it("states today's traffic", async () => {
    const html = await render(props());
    expect(html).toContain("103 messages moved through the mesh today across 14 threads.");
  });

  it("keeps the singular when there is one of each", async () => {
    const html = await render(props({ stats: { ...BASE_STATS, msg24h: 1, threads: 1 } }));
    expect(html).toContain("1 message moved through the mesh today across 1 thread.");
  });

  it("omits the incident sentence when there were none", async () => {
    const html = await render(props());
    expect(html).not.toContain("incident came in");
  });

  it("names the agent who closed the incident", async () => {
    const html = await render(props({
      stats: { ...BASE_STATS, incidents24h: 1 },
      latestIncident: {
        openedAt: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
        closedBy: "ops-kai",
        minutesToClose: 12,
      },
    }));
    expect(html).toContain("One incident came in this afternoon and ");
    expect(html).toContain('<strong style="font-weight:600">ops-kai</strong>');
    expect(html).toContain("closed it 12 minutes later.");
  });

  it("says so when the incident is still unanswered", async () => {
    const html = await render(props({
      stats: { ...BASE_STATS, incidents24h: 1 },
      latestIncident: { openedAt: NOW.toISOString(), closedBy: null, minutesToClose: null },
    }));
    expect(html).toContain("nobody has answered it yet.");
  });

  it("labels the three counters and derives the asleep one", async () => {
    const html = await render(props());
    expect(html).toContain(">online now<");
    expect(html).toContain(">quiet a while<");
    expect(html).toContain(">asleep<");
    // 8 total − 4 live − 2 quiet
    expect(html).toContain(">2</span>");
  });
});

describe("V2HomePage — needs-attention band", () => {
  it("renders nothing at all when there is nothing to attend to", async () => {
    const html = await render(props({ attention: [] }));
    expect(html).not.toContain("want your attention");
    expect(html).not.toContain("wants your attention");
    expect(html).not.toContain("Review");
  });

  it("uses the singular title and button for one item", async () => {
    const html = await render(props({ attention: [attentionItem()] }));
    expect(html).toContain("One thing wants your attention");
    expect(html).toContain("Review it");
    expect(html).toContain('<strong style="font-weight:600">scout</strong>');
    expect(html).toContain(esc("hasn't checked in for 3 days."));
  });

  it("uses the two-item title and button", async () => {
    const html = await render(props({
      attention: [
        attentionItem({ agent: "sec-warden", text: "reports 2 agents still on pre-rotation tokens" }),
        attentionItem(),
      ],
    }));
    expect(html).toContain("Two things want your attention");
    expect(html).toContain("Review both");
    expect(html).toContain(" · ");
  });

  it("counts the rest into the title and button but names only two", async () => {
    const html = await render(props({
      attention: [
        attentionItem({ agent: "sec-warden" }),
        attentionItem({ agent: "scout" }),
        attentionItem({ agent: "dex-eu" }),
        attentionItem({ kind: "backend", agent: undefined, text: "NATS is not connected", href: "/health" }),
      ],
    }));
    expect(html).toContain("4 things want your attention");
    expect(html).toContain("Review all 4");
    expect(html).not.toContain(">dex-eu</strong>");
    expect(html).not.toContain("NATS is not connected");
  });

  it("points the button at the first item, which is the one to act on", async () => {
    const html = await render(props({
      attention: [attentionItem({ href: "/conversations?id=abc" }), attentionItem()],
    }));
    expect(html).toContain('href="/conversations?id=abc"');
  });
});

describe("V2HomePage — the two cards", () => {
  it("titles the conversation card with both participants and the context", async () => {
    const html = await render(props({ liveThread: thread() }));
    expect(html).toContain("Latest conversation");
    expect(html).toContain("triage-1 and ops-kai · incident #2214");
    expect(html).toContain("Read the whole thread →");
    expect(html).toContain("6 messages");
  });

  it("shows only the last four messages but counts the whole thread", async () => {
    const html = await render(props({ liveThread: thread() }));
    expect(html).not.toContain(">one<");
    expect(html).not.toContain(">two<");
    expect(html).toContain(">three<");
    expect(html).toContain(">six<");
  });

  it("pulses exactly one live dot while the thread is warm", async () => {
    const html = await render(props({ liveThread: thread() }));
    expect(html.match(/class="m-pulse"/g)).toHaveLength(1);
    expect(html).toContain(">live<");
  });

  it("drops the live pill once the thread has gone quiet", async () => {
    const old = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    const html = await render(props({
      liveThread: thread({ messages: [message({ created_at: old })], messageCount: 1 }),
    }));
    expect(html).not.toContain('class="m-pulse"');
    expect(html).not.toContain(">live<");
  });

  it("says so when there is no conversation yet", async () => {
    const html = await render(props({ liveThread: null }));
    expect(html).toContain("Nothing here yet · しずか — no conversations so far.");
    expect(html).not.toContain("Read the whole thread");
  });

  it("lists five agents with their plain-language presence and work", async () => {
    const html = await render(props());
    expect(html).toContain("What everyone is working on");
    expect(html).toContain(esc("From each agent's last mesh_register call"));
    expect(html).toContain(">online<");
    expect(html).toContain(">quiet<");
    expect(html).toContain(">asleep<");
    expect(html).toContain("Nothing announced");
    expect(html).toContain(">msgs today<");
    expect(html).toContain("All 8 agents →");
    // The sixth agent stays behind the footer link.
    expect(html).not.toContain(">sec-warden<");
  });

  it("wires the live thread to SSE without an avatar pool", async () => {
    const html = await render(props({ liveThread: thread() }));
    expect(html).toContain("/sse/threads/");
    expect(html).toContain('id="v2-live-thread"');
    expect(html).not.toContain("v2-avatar-pool");
  });

  // `participants` carries recipients, so it holds the `broadcast` sentinel.
  // COPY.md §7 titles such a thread "{a} and everyone" — the wire word must
  // never reach the sub-line, and the Conversations screen must agree.
  it("calls a broadcast thread 'and everyone', never 'and broadcast'", async () => {
    const html = await render(props({
      liveThread: thread({
        participants: ["triage-1", "broadcast", "ops-kai"],
        context: "deploy window",
      }),
    }));
    expect(html).toContain("triage-1 and everyone · deploy window");
    expect(html).not.toContain("and broadcast");
  });

  // The SSE script inlines an emblem per name it might have to draw. The
  // whole roster would be up to MAX_AGENTS of them for a two-party thread.
  it("inlines emblems only for the thread's own parties", async () => {
    const html = await render(props({ liveThread: thread() }));
    const map = /var emblems = (\{.*?\});/s.exec(html)?.[1] ?? "";
    expect(Object.keys(JSON.parse(map)).sort()).toEqual(["ops-kai", "triage-1"]);
  });
});

describe("V2HomePage — connect prompt and empty state", () => {
  it("always offers the connect prompt when there are agents", async () => {
    const html = await render(props());
    expect(html).toContain("Adding an agent takes about a minute");
    expect(html).toContain(esc("We'll wait for its first handshake"));
    expect(html).toContain(">Connect an agent</a>");
    expect(html).toContain(">Read the docs</a>");
  });

  it("replaces the whole screen with the hero at zero agents", async () => {
    const html = await render(props({
      stats: { ...BASE_STATS, agentsTotal: 0, agentsLive: 0, agentsStale: 0 },
      agents: [],
      attention: [attentionItem()],
      liveThread: thread(),
    }));
    expect(html).toContain("No agents yet · まだ — connect your first one.");
    expect(html).toContain("Adding an agent takes about a minute");
    expect(html.match(/class="m-rise"/g)).toHaveLength(1);
    // Blocks 1–3 are gone entirely, band included.
    expect(html).not.toContain("Nobody is online right now.");
    expect(html).not.toContain("online now");
    expect(html).not.toContain("wants your attention");
    expect(html).not.toContain("Latest conversation");
    expect(html).not.toContain("What everyone is working on");
  });
});

describe("V2HomePage — the SENTINEL furniture is gone", () => {
  it("drops the hero, the KPI band and the mesh topology", async () => {
    const html = await render(props({ liveThread: thread() }));
    for (const gone of [
      "MESH STATUS",
      "UPTIME",
      "Mesh Topology",
      "Live Thread",
      "OPEN THREAD",
      "VIEW ALL",
      "Recent Activity",
      "oklch(",
      "v2-eyebrow",
    ]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("homeHeadline — the one-agent install", () => {
  // COPY.md §4's four variants all assume two or more agents: at total 1 they
  // read "One of your one agents is awake." and "All one of your agents are
  // awake and talking.". That is the screen a brand-new user sees first.
  it("says something grammatical when there is exactly one agent", () => {
    expect(homeHeadline(1, 1)).toBe("Your one agent is awake and talking.");
    expect(homeHeadline(0, 1)).toBe("Nobody is online right now.");
  });

  it("still spells the COPY variants from two agents up", () => {
    expect(homeHeadline(1, 2)).toBe("One of your two agents is awake.");
    expect(homeHeadline(2, 2)).toBe("All two of your agents are awake and talking.");
    expect(homeHeadline(4, 8)).toBe("Four of your eight agents are awake and talking.");
    expect(homeHeadline(0, 8)).toBe("Nobody is online right now.");
  });
});

describe("V2HomePage — the latest-conversation sub-line", () => {
  // A context is free text up to MAX_CONTEXT_LENGTH. Unclamped, a real one
  // ran to four lines on the live dashboard and pushed the card's first
  // message below the fold.
  it("keeps the sub-line to one line and keeps the full text on hover", async () => {
    const context = "crtx2 / Node k9. ".repeat(20);
    const html = await render(props({
      liveThread: thread({ context }),
    }));
    expect(html).toContain("text-overflow:ellipsis;white-space:nowrap");
    expect(html).toContain("title=");
  });
});
