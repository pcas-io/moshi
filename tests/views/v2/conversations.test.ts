// Conversations screen ("Daylight"). The assertions here are the strings and
// shapes that would rot silently: COPY.md §7 wording, the "a and b" thread
// title, the prefilled reply command, both empty states and the broadcast
// branch — plus the tokens and framings the redesign deleted.

import { describe, it, expect } from "vitest";
import { V2ConversationsPage } from "../../../src/views/v2/conversations";
import type { ConversationThread, MessageView } from "../../../src/services/message-queries";
import type { PaginatedResult } from "../../../src/types";

/** Hono escapes text nodes and attributes; assert on the readable form. */
function decode(html: string): string {
  return html
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function render(props: Parameters<typeof V2ConversationsPage>[0]): Promise<string> {
  return decode(String(await Promise.resolve(V2ConversationsPage(props))));
}

const NOW = Date.now();
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function message(over: Partial<MessageView> & Pick<MessageView, "id" | "from" | "to">): MessageView {
  return {
    type: "info",
    payload: JSON.stringify({ text: "error rate is up on checkout" }),
    context: "incident #2214 · production",
    correlation_id: "thr_1",
    reply_to: null,
    priority: "normal",
    ttl_seconds: 86400,
    created_at: minutesAgo(4),
    ...over,
  };
}

function thread(over: Partial<ConversationThread> = {}): ConversationThread {
  const messages = over.messages ?? [
    message({ id: "msg_01JB7M2K9QX4ZR", from: "triage-1", to: "ops-kai" }),
    message({ id: "msg_01JB7M3LAST", from: "ops-kai", to: "triage-1", type: "task_update" }),
  ];
  return {
    thread_id: "thr_1",
    started_at: minutesAgo(9),
    last_activity: minutesAgo(4),
    message_count: messages.length,
    first_payload: messages[0]?.payload ?? "",
    first_context: "incident #2214 · production",
    participants: ["triage-1", "ops-kai"],
    ...over,
    messages,
  };
}

function page(threads: ConversationThread[], over: Partial<PaginatedResult<ConversationThread>> = {}) {
  const result: PaginatedResult<ConversationThread> = {
    data: threads,
    has_more: false,
    total: threads.length,
    limit: 50,
    offset: 0,
    ...over,
  };
  return { result, agentRoles: { "triage-1": "triage-agent", "ops-kai": "dev-ops" } };
}

describe("V2ConversationsPage — thread titles", () => {
  it("joins the two participants with 'and', never with an arrow", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("triage-1 and ops-kai");
    expect(html).not.toContain("triage-1 → ops-kai");
  });

  it("names the broadcast partner 'everyone' and badges the row with 'all'", async () => {
    const bc = thread({
      thread_id: "thr_bc",
      participants: ["pm-mira", "broadcast"],
      messages: [message({ id: "msg_bc1", from: "pm-mira", to: "broadcast", correlation_id: "thr_bc" })],
    });
    const html = await render(page([bc]));
    expect(html).toContain("pm-mira and everyone");
    expect(html).not.toContain("pm-mira and broadcast");
    expect(html).toContain(">all<");
    // The badge is amber, and no message in a broadcast thread sits on the
    // own side — every bubble stays on the left.
    expect(html).toContain("background:#fdf4e3");
    expect(html).not.toContain("row-reverse");
  });

  it("falls back to the single participant when a thread has only one", async () => {
    const solo = thread({
      participants: ["triage-1"],
      messages: [message({ id: "msg_solo", from: "triage-1", to: "triage-1" })],
    });
    const html = await render(page([solo]));
    expect(html).toContain(">triage-1<");
    expect(html).not.toContain("triage-1 and");
  });
});

describe("V2ConversationsPage — read-only footer", () => {
  it("prefills the reply command with the open thread's last message id", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain('moshi reply msg_01JB7M3LAST "ack — watching the error rate"');
    expect(html).not.toContain("msg_01JB7M2K9QX4ZR \"ack");
  });

  it("uses the shared copy-button contract", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain('class="d-copy d-solid"');
    expect(html).toContain('data-label="Copy"');
    expect(html).toContain('data-copy-text="moshi reply msg_01JB7M3LAST');
  });

  it("explains why the dashboard cannot reply, and names mesh_reply", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("Reading only — replies come from the agents themselves");
    expect(html).toContain(
      "That's deliberate: every message has a verified sender. To answer, run this from your machine or let an agent call",
    );
    expect(html).toContain("mesh_reply");
    expect(html).not.toContain("READ-ONLY");
    expect(html).not.toContain("ADR-004");
  });

  it("drops the command block when no thread is open", async () => {
    const html = await render(page([]));
    expect(html).toContain("Reading only — replies come from the agents themselves");
    expect(html).not.toContain("moshi reply");
  });
});

describe("V2ConversationsPage — empty states", () => {
  it("shows the no-conversations state with the English sentence first", async () => {
    const html = await render(page([]));
    expect(html).toContain("Nothing here yet · しずか — no conversations so far.");
    expect(html).toContain("Pick a conversation on the left · もしもし");
    // No thread open: no meta line, no live pill.
    expect(html).not.toContain("updating live");
    expect(html).not.toContain("last activity");
  });

  it("shows the search miss with the query quoted", async () => {
    const html = await render({ ...page([]), query: "checkout" });
    expect(html).toContain('Nothing matches "checkout".');
    expect(html).not.toContain("Nothing here yet");
    expect(html).not.toContain("なし");
  });
});

describe("V2ConversationsPage — thread and message rendering", () => {
  it("writes the panel heading, count line and search placeholder from COPY", async () => {
    const html = await render(page([thread(), thread({ thread_id: "thr_2", last_activity: minutesAgo(600) })]));
    expect(html).toContain("Conversations");
    expect(html).toContain("2 threads · 1 still moving");
    expect(html).toContain("Search what was said, or paste a message id");
  });

  it("says '1 thread' for a single thread", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("1 thread · 1 still moving");
  });

  it("renders the detail meta, the live pill and a day separator", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("2 messages · about incident #2214 · production · last activity 4 min ago");
    expect(html).toContain("updating live");
    expect(html).toContain("m-pulse");
    expect(html).toContain("Today, ");
  });

  it("labels message kinds from the shared map and keeps the raw type debuggable", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain('title="task_update"');
    expect(html).toContain(">progress<");
    expect(html).toContain(">info<");
  });

  it("prefixes the message context with 'on: '", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("on: incident #2214 · production");
    expect(html).not.toContain("ctx:");
  });

  it("selects the thread named by ?id= and marks it as current", async () => {
    const second = thread({ thread_id: "thr_2", participants: ["dex-eu", "ops-kai"] });
    const html = await render({ ...page([thread(), second]), selectedId: "thr_2" });
    expect(html).toContain('href="/conversations?id=thr_2"');
    expect(html).toContain('aria-current="true"');
    // The selected row lifts out of the sunk panel with a green rail.
    expect(html).toContain("box-shadow:inset 3px 0 0 #0e8a3e");
  });

  it("carries the search and agent filter into every thread link", async () => {
    const html = await render({ ...page([thread()]), query: "checkout", filterAgent: "ops-kai" });
    expect(html).toContain("/conversations?id=thr_1&q=checkout&agent=ops-kai");
    expect(html).toContain('name="agent" value="ops-kai"');
  });
});

describe("V2ConversationsPage — what the redesign deleted", () => {
  it("keeps no SENTINEL-era framing, tints or badges", async () => {
    const html = await render(page([thread()]));
    for (const gone of [
      "THREADS — CORRELATION_ID",
      "correlation_id ·",
      "● SSE LIVE",
      "payload ≤ 256 KB",
      "oklch(",
      "OLDER →",
      "しずか · all quiet",
      "もしもし — pick a conversation on the left.",
    ]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("V2ConversationsPage — own side and paging", () => {
  it("flips the row for the thread's second participant and tints the bubble", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("flex-direction:row-reverse");
    // Own side: greenSoft on the lighter bubble border, notch bottom-right.
    expect(html).toContain("background:#e8f6ec;border:1px solid #cfe9d7;border-bottom-right-radius:5px");
    // Other side: subtle on its own border, notch bottom-left.
    expect(html).toContain("background:#f4f0e9;border:1px solid #eae3d7;border-bottom-left-radius:5px");
  });

  it("offers the older page when one exists, in sentence case", async () => {
    const html = await render(page([thread()], { has_more: true, total: 80 }));
    expect(html).toContain('href="/conversations?offset=50"');
    expect(html).toContain("Older →");
    expect(html).not.toContain("← Newer");
  });
});

describe("V2ConversationsPage — states a class rule has to win", () => {
  it("leaves an unselected row's background unset so .d-thread:hover applies", async () => {
    const html = await render({
      ...page([thread(), thread({ thread_id: "thr_2" })]),
      selectedId: "thr_1",
    });
    // An inline `background` outranks any class rule: the hover fill would be
    // dead on arrival. Only the selected row may state one.
    expect(html).not.toContain("cursor:pointer;background:transparent");
    expect(html).toContain('style="padding:14px 20px;border-bottom:1px solid #f2ece2;cursor:pointer"');
    expect(html).toContain(".d-thread:hover { background: var(--card); }");
  });

  it("keeps every kind pill above the 4.5:1 floor", async () => {
    const html = await render(page([thread({
      messages: [
        message({ id: "m1", from: "triage-1", to: "ops-kai", type: "reply" }),
        message({ id: "m2", from: "ops-kai", to: "triage-1", type: "review_request" }),
        message({ id: "m3", from: "triage-1", to: "ops-kai", type: "info" }),
      ],
    })]));
    expect(html).toContain("color:#0a6e31;background:#e8f6ec"); // greenDeep, not green
    expect(html).toContain("color:#8a5f16;background:#fdf4e3"); // amberInk, not amber
    expect(html).toContain("color:#6f6862;background:#f4f0e9"); // faint, not dim at 12px
    expect(html).not.toContain("color:#0e8a3e;background:#e8f6ec");
    expect(html).not.toContain("color:#b7791f;background:#fdf4e3");
    expect(html).not.toContain("color:#7d766c;background:#f4f0e9");
  });

  it("sets the footer's tool name in faint — it is below the 13px floor for dim", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("font-size:12.5px;color:#6f6862");
  });

  it("lets a long context break instead of widening the pane", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("font-size:13px;color:#7d766c;overflow-wrap:anywhere");
    expect(html).toContain("color:#6f6862;margin-top:5px;overflow-wrap:anywhere");
  });
});

describe("V2ConversationsPage — the live pill is a claim", () => {
  // Nothing on this screen polls, so the pill may only appear where it is
  // still true: a thread whose last activity is inside the presence window.
  it("shows `updating live` on a thread that is still moving", async () => {
    const fresh = new Date().toISOString();
    const html = await render(page([thread({ last_activity: fresh })]));
    expect(html).toContain("updating live");
  });

  it("omits it on a dormant thread rather than pulsing at a dead one", async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const html = await render(page([thread({ last_activity: old })]));
    expect(html).not.toContain("updating live");
  });
});

describe("V2ConversationsPage — the split has to know the viewport width", () => {
  // The wrapper is a flex item of a column <main> whose align-items computes
  // to `normal`, so without an explicit width it sizes to its content: the
  // split never learns it must wrap and the page scrolled sideways ~190px on
  // a phone. Pinned here because no unit test can see a layout overflow.
  it("pins the full-bleed container to 100% width", async () => {
    const html = await render(page([thread()]));
    expect(html).toContain("max-width:1400px");
    expect(html).toMatch(/max-width:1400px[^"]*width:100%/);
  });
});
