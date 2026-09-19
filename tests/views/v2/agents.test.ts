// Rendering tests for the "Daylight" Agents screen.
//
// These guard the things that rot silently: the COPY.md strings, the presence
// words, the two empty states, the histogram's fixed 24 slots, and the fact
// that the old SENTINEL furniture (token panel, new-agent form, sparkline,
// token column) really is gone.

import { describe, it, expect } from "vitest";
import { V2AgentsPage, type V2AgentsAgent } from "../../../src/views/v2/agents";
import { PRESENCE_THRESHOLDS } from "../../../src/services/presence";
import { MESSAGE_RETENTION_DAYS } from "../../../src/types";

const QUIET_MINUTES = Math.round(PRESENCE_THRESHOLDS.liveMs / 60_000);

async function render(props: Parameters<typeof V2AgentsPage>[0]): Promise<string> {
  return String(await Promise.resolve(V2AgentsPage(props)));
}

function agent(over: Partial<V2AgentsAgent> = {}): V2AgentsAgent {
  return {
    id: "01J0AGENT0000000000000000",
    name: "scout",
    // The address an agent is born with is its lower-cased name.
    inbox_key: (over.name ?? "scout").toLowerCase(),
    role: "dev-assistant",
    capabilities: ["search", "summarise"],
    is_active: true,
    presence: "live",
    msg24: 12,
    heat: new Array<number>(24).fill(0),
    working_on: "indexing the docs",
    last_seen_at: new Date().toISOString(),
    created_at: "2026-09-04T09:12:00",
    ...over,
  };
}

const BASE = { csrfToken: "csrf-token-1", userRole: "admin" } as const;
const GREEN = "#0e8a3e"; // V2_TOKENS.green — the selected row's inset marker

describe("V2AgentsPage — presence", () => {
  const roster = [
    agent({ id: "a1", name: "scout", presence: "live" }),
    agent({ id: "a2", name: "qa-bot", presence: "stale" }),
    agent({ id: "a3", name: "dex-eu", presence: "offline" }),
    agent({ id: "a4", name: "nia", presence: "never", last_seen_at: null }),
  ];

  it("uses the plain-language word under every name, with `never` reading asleep", async () => {
    const html = await render({ ...BASE, agents: roster });
    expect(html).toContain(">online<");
    expect(html).toContain(">quiet<");
    expect(html).toContain(">asleep<");
    // "never seen" is the components.ts label; the table column is one word.
    expect(html).not.toContain(">never seen<");
  });

  it("spells the selected agent's presence out as a sentence", async () => {
    const live = await render({ ...BASE, agents: roster, inspectId: "a1" });
    expect(live).toContain("Online — last seen just now");

    const quiet = await render({ ...BASE, agents: roster, inspectId: "a2" });
    expect(quiet).toContain(`Quiet — no MCP call in the last ${QUIET_MINUTES} minutes`);

    const asleep = await render({ ...BASE, agents: roster, inspectId: "a3" });
    expect(asleep).toContain("Asleep — presence expired");

    const never = await render({ ...BASE, agents: roster, inspectId: "a4" });
    expect(never).toContain("Never connected — it has a token but has never called in");
    expect(never).toContain(">never<"); // the Last seen cell
  });

  it("counts the whole roster in the filter pills, not the filtered list", async () => {
    const html = await render({ ...BASE, agents: roster, presenceFilter: "live" });
    expect(html).toContain("All 4");
    expect(html).toContain("Online 1");
    expect(html).toContain("Quiet 1");
    expect(html).toContain("Asleep 2"); // offline + never
    expect(html).toContain('href="/agents?presence=off"');
    // Only the matching row survives the filter.
    expect(html).toContain(">scout<");
    expect(html).not.toContain(">qa-bot<");
  });

  it("reports the roster in the lead sentence", async () => {
    const html = await render({ ...BASE, agents: roster });
    expect(html).toContain(
      "4 registered, 1 awake. Tokens are hashed — reset one and the old value dies instantly.",
    );
  });
});

describe("V2AgentsPage — action consequences", () => {
  it("states the consequence of reset and deactivate on a second line", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).toContain("Reset token");
    expect(html).toContain(
      "Issues a new bearer token. The agent goes offline until you paste the new one.",
    );
    expect(html).toContain("Deactivate");
    expect(html).toContain(
      "Stops delivery and hides it from mesh_status. Reversible, history is kept.",
    );
    expect(html).toContain("Read its conversations");
    expect(html).toContain("Delete agent");
    // Each consequence is a block-level span inside its own button.
    expect(html).toContain("display:block;font-size:12.5px;font-weight:400");
  });

  it("swaps in Reactivate, with its own consequence, for a deactivated agent", async () => {
    const html = await render({ ...BASE, agents: [agent({ is_active: false })] });
    expect(html).toContain("Reactivate");
    expect(html).toContain("Issues a new token and starts delivering again.");
    expect(html).toContain("Deactivated");
    expect(html).not.toContain("Reset token");
    expect(html).not.toContain("Stops delivery and hides it from mesh_status");
  });

  it("carries the CSRF token on every mutating form", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    for (const action of ["/agents/reset-token", "/agents/revoke", "/agents/delete"]) {
      expect(html).toContain(`action="${action}"`);
    }
    // reset-token, revoke, delete, plus the layout's sign-out form.
    expect(html.match(/name="csrf" value="csrf-token-1"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("uses the COPY.md delete dialog, sourcing the retention window from types", async () => {
    const html = await render({ ...BASE, agents: [agent({ name: "scout" })] });
    expect(html).toContain("Delete scout?");
    expect(html).toContain(
      "The name becomes reusable and the token stops working immediately. " +
        `Message history is kept for ${MESSAGE_RETENTION_DAYS} days. This cannot be undone.`,
    );
    expect(html).toContain("Delete permanently");
    expect(html).toContain(">Cancel<");
  });
});

describe("V2AgentsPage — rename", () => {
  it("offers a rename form that says what survives", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).toContain('action="/agents/rename"');
    expect(html).toMatch(/<input[^>]*name="name"[^>]*value="scout"/);
    expect(html).toContain('maxlength="64"');
    expect(html).toContain('pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}"');
    expect(html).toContain("Keeps its token, inbox and history.");
    expect(html).toContain("Other agents reach it under the new name from then on.");
  });

  it("offers it for a deactivated agent too: a label is a label", async () => {
    const html = await render({ ...BASE, agents: [agent({ is_active: false })] });
    expect(html).toContain('action="/agents/rename"');
  });

  it("names the inbox by its key, which a rename does not change", async () => {
    const html = await render({ ...BASE, agents: [agent({ name: "scout-eu", inbox_key: "scout" })] });
    expect(html).toContain("mesh.agents.scout.inbox");
    expect(html).not.toContain("mesh.agents.scout-eu.inbox");
  });
});

describe("V2AgentsPage — empty roster", () => {
  it("shows the empty state and drops the aside entirely", async () => {
    const html = await render({ ...BASE, agents: [] });
    expect(html).toContain("No agents yet · まだ — connect your first one.");
    expect(html).toContain('href="/agents/connect"');
    expect(html).toContain(
      "0 registered, 0 awake. Tokens are hashed — reset one and the old value dies instantly.",
    );
    // Nothing to inspect => no aside, no modal, no modal script.
    expect(html).not.toContain("Capabilities it announced");
    expect(html).not.toContain('id="v2-del-modal"');
    expect(html).not.toContain("data-del-open");
  });

  it("keeps the aside on the first agent when a filter matches nothing", async () => {
    const html = await render({
      ...BASE,
      agents: [agent({ id: "a1", name: "scout", presence: "live" })],
      presenceFilter: "stale",
    });
    expect(html).toContain("No agents yet · まだ — connect your first one.");
    expect(html).toContain("Capabilities it announced");
    expect(html).toContain("Online — last seen just now");
  });
});

describe("V2AgentsPage — a single agent", () => {
  const one = agent({
    id: "a1",
    name: "x",
    role: null,
    capabilities: [],
    msg24: 0,
    working_on: null,
    heat: new Array<number>(24).fill(0),
  });

  it("renders the monogram X and 24 histogram stubs", async () => {
    const html = await render({ ...BASE, agents: [one] });
    expect(html).toContain(">X</text>"); // 34px row emblem and 52px aside emblem
    // An all-zero agent shows 24 flat 3px rules — a stub per hour, never a gap.
    expect(html.match(/height:3px;border-radius:3px/g)).toHaveLength(24);
    expect(html).toContain("Messages per hour, last 24h");
  });

  it("keeps the fixed grid and the horizontal scroller", async () => {
    const html = await render({ ...BASE, agents: [one] });
    const track = /grid-template-columns:38px 1\.1fr 1fr 1\.3fr 96px 92px/g;
    expect(html.match(track)).toHaveLength(2); // header row + the one agent row
    expect(html).toContain("min-width:720px");
    expect(html).toContain("overflow-x:auto");
  });

  it("fills the empty fields with words rather than dashes", async () => {
    const html = await render({ ...BASE, agents: [one] });
    expect(html).toContain("Nothing announced");
    expect(html).toContain(">none yet<");
    expect(html).toContain(">0 today<");
  });

  it("labels the six fact rows and names the inbox subject", async () => {
    const html = await render({ ...BASE, agents: [one] });
    for (const label of ["Token", "Role", "Last seen", "Registered", "Messages", "Inbox"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("Active, hashed");
    expect(html).toContain("4 Sep, 09:12"); // three letters in every month
    expect(html).toContain("mesh.agents.x.inbox");
  });
});

describe("V2AgentsPage — states a class rule has to win", () => {
  // An inline `background` outranks every class rule, hover included. Any
  // element whose spec §8 hover is a fill must therefore leave the property
  // to CSS — otherwise the hover is dead and nothing in the render shows it.
  it("leaves the unselected row's background unset so .d-row:hover applies", async () => {
    const html = await render({
      ...BASE,
      agents: [
        agent({ id: "a1", name: "scout" }),
        agent({ id: "a2", name: "qa-bot", presence: "stale" }),
      ],
      inspectId: "a1",
    });
    expect(html).not.toContain("cursor:pointer;background:transparent");
    expect(html).toContain(`cursor:pointer;background:#f6fbf7;box-shadow:inset 3px 0 0 ${GREEN}`);
    expect(html).toContain('aria-current="true"');
  });

  it("hands the pill, outline and ghost fills to the page stylesheet", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).toContain(".d-pill:hover { background: var(--sunk); }");
    expect(html).toContain(".d-outline:hover { background: var(--subtle); }");
    expect(html).toContain(".d-delete:hover { background: var(--subtle); color: var(--ink); }");
    // The inactive pills and every outlined button wear the classes.
    expect(html.match(/class="d-pill"/g)).toHaveLength(3);
    expect(html.match(/class="d-outline"/g)).toHaveLength(4); // rename, reset, deactivate, cancel
    expect(html).toContain('class="d-delete"');
    // Solid fills keep the shared brightness hook — `filter` is never inline.
    expect(html).toContain('class="d-solid"');
    expect(html).not.toContain("filter:brightness");
  });
});

describe("V2AgentsPage — what the redesign removed", () => {
  it("keeps the table header sentence-case and free of the dropped columns", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    for (const head of ["Agent", "Role", "Working on", "Last seen", "Today"]) {
      expect(html).toContain(`>${head}<`);
    }
    expect(html).not.toContain(">Trend<");
    expect(html).not.toContain(">24h<");
    expect(html).not.toContain(">Capabilities<");
    expect(html).not.toContain(">disabled<");
  });

  it("no longer renders the token panel, the new-agent form or the uppercase furniture", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).not.toContain("v2-token-panel");
    expect(html).not.toContain("Register New Agent");
    expect(html).not.toContain("+ New Agent");
    expect(html).not.toContain("Destructive Action");
    expect(html).not.toContain("Delete Forever");
    expect(html).not.toContain("ADMIN — TOKEN AUTH");
    expect(html).not.toContain("Consumer");
    expect(html).not.toContain("86 400 s");
    // The German title attribute on the name input went with the form.
    expect(html).not.toContain("Zeichen");
    // Both deleted chart primitives.
    expect(html).not.toContain("v2-spark");
    expect(html).not.toContain("polyline");
  });

  it("emits no second copy handler — layout.tsx already injects the only one", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    // The guard assignment appears once per injected copy-script block.
    expect(html.match(/window\.__dCopy = 1/g)).toHaveLength(1);
    expect(html).not.toContain("__v2copy");
  });

  it("shows the server flash in the error band", async () => {
    const html = await render({
      ...BASE,
      agents: [agent()],
      error: "That form expired. Reload the page and try again.",
    });
    expect(html).toContain("That didn&#39;t work");
    expect(html).toContain("That form expired. Reload the page and try again.");
  });
});

describe("V2AgentsPage — the one-time token", () => {
  // Creating an agent moved to the connect flow, but resetting a token did
  // not. Without somewhere to render the new plaintext value, a reset would
  // revoke the old token and drop the new one on the floor.
  it("shows a reset token once, with a copy button and the hash warning", async () => {
    const html = await render({ ...BASE, agents: [agent()], newToken: "bt_abc123def456" });
    expect(html).toContain("bt_abc123def456");
    expect(html).toContain("Copy this token now");
    expect(html).toContain("It is stored as a SHA-256 hash — we can never show it again.");
    expect(html).toContain('class="d-copy');
    expect(html).toContain('data-copy-from="#v2-new-token"');
  });

  it("shows nothing of the kind when there is no token to hand over", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).not.toContain("Copy this token now");
    // The shared copy handler always ships; the band's own hook must not.
    expect(html).not.toContain('id="v2-new-token"');
  });
});

describe("V2AgentsPage — the empty roster on a phone", () => {
  // The rows need the 720px track; a centred first-run sentence does not.
  // Inside it, the message and its button start at x≈360 on a 360px screen.
  it("drops the 720px track entirely when there is nothing to scroll", async () => {
    const html = await render({ ...BASE, agents: [] });
    expect(html).toContain("No agents yet · まだ — connect your first one.");
    expect(html).toContain("Connect an agent");
    // No track, no scroller, no column headers over an empty table.
    expect(html).not.toContain("min-width:720px");
    expect(html).not.toContain("overflow-x:auto");
    expect(html).not.toContain(">Working on<");
  });

  it("keeps the track the moment there is a row to scroll", async () => {
    const html = await render({ ...BASE, agents: [agent()] });
    expect(html).toContain("min-width:720px");
    expect(html).toContain("overflow-x:auto");
    expect(html).toContain(">Working on<");
    // The empty state still sits outside the scroller, for the filtered case.
    const track = html.indexOf("min-width:720px");
    expect(track).toBeGreaterThan(-1);
  });
});
