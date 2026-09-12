// Connect an agent — the four steps, rendered to string.
// Guards the COPY.md §5 strings, the step-2 gate, the four client tabs and
// the expired-session branch against silent rot.

import { describe, it, expect } from "vitest";
import { V2ConnectPage, type V2ConnectProps } from "../../../src/views/v2/connect";
import { MCP_TOOL_CATALOG } from "../../../src/mcp/catalog";
import { CONNECT_CLIENT_LABELS, DEFAULT_ORIGIN } from "../../../src/views/v2/connect-clients";
import {
  MAX_AGENTS, MAX_CONTEXT_LENGTH, MESSAGE_RETENTION_DAYS, RATE_LIMIT_PER_MINUTE,
} from "../../../src/types";

/** Hono escapes &, <, >, " and ' in text nodes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BASE: V2ConnectProps = {
  step: 1,
  client: "code",
  origin: "https://mesh.example.test",
  csrfToken: "csrf-token-value",
  userRole: "admin",
  userName: "admin",
};

async function render(props: Partial<V2ConnectProps>): Promise<string> {
  return String(await Promise.resolve(V2ConnectPage({ ...BASE, ...props })));
}

const LIVE = {
  sessionKey: "sess-key-123",
  agentName: "dex-eu",
  token: "bt_9f3c1a77d0b45e2c8ab61d4f7e0c9235",
};

describe("connect — page shell", () => {
  it("renders the back link, heading, lead and all four stepper cards", async () => {
    const html = await render({});
    expect(html).toContain("← Agents");
    expect(html).toContain("Connect an agent");
    expect(html).toContain(
      esc("Four steps, one screen. You can leave and come back — the token stays valid until you reset it."),
    );
    for (const [title, sub] of [
      ["Name it", "what others call it"],
      ["Copy the token", "shown once"],
      ["Paste it in your client", "pick one of four"],
      ["Verify", "wait for the handshake"],
    ]) {
      expect(html).toContain(title);
      expect(html).toContain(sub);
    }
  });

  it("animates exactly one element per screen", async () => {
    for (const step of [1, 2, 3, 4] as const) {
      const html = await render({ step, ...LIVE });
      expect(html.match(/class="m-rise"/g)?.length).toBe(1);
    }
  });

  it("never puts dim grey below 13px or on a fill it cannot carry", async () => {
    // dim (#7d766c) is 4.49:1 on white and less on anything tinted, so the
    // small labels and the inert button use faint / body instead.
    for (const step of [1, 2, 3, 4] as const) {
      const html = await render({ step, ...LIVE });
      expect(html).not.toContain("font-size:12.5px;color:#7d766c");
      expect(html).not.toContain("font-size:11.5px;color:#7d766c");
      expect(html).not.toContain("background:#e7e0d5;border:none;color:#7d766c");
    }
  });

  it("keeps steps past 1 out of the tab order until the agent exists", async () => {
    const cold = await render({ step: 1 });
    expect(cold).not.toContain("step=2");
    const warm = await render({ step: 2, ...LIVE });
    expect(warm).toContain("step=1");
    expect(warm).toContain("step=3");
    expect(warm).toContain("step=4");
  });
});

describe("connect — step 1", () => {
  it("posts to the create route with a CSRF token and the constraint copy", async () => {
    const html = await render({ step: 1 });
    expect(html).toContain('action="/agents/connect/create"');
    expect(html).toContain('name="csrf"');
    expect(html).toContain('value="csrf-token-value"');
    expect(html).toContain("What should we call it?");
    expect(html).toContain(esc("The name is how other agents address it in"));
    expect(html).toContain("mesh_send");
    expect(html).toContain(
      esc("1–64 characters · letters, digits,"),
    );
    expect(html).toContain(esc("must start with a letter or digit. No spaces or dots."));
    expect(html).toContain("Role and capabilities come later — automatically");
    expect(html).toContain("Cancel");
    expect(html).toContain("Create token →");
  });

  it("never disables the submit and keeps native validation on", async () => {
    const html = await render({ step: 1 });
    expect(html).not.toContain("disabled");
    expect(html).toContain("required");
    expect(html).toContain('pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"');
  });

  it("re-renders the typed name with the error inline", async () => {
    const html = await render({
      step: 1,
      typedName: "dex-eu",
      error: "There's already an agent called dex-eu. Pick another name, or reactivate the existing one from Agents.",
    });
    expect(html).toContain('value="dex-eu"');
    expect(html).toContain(esc("There's already an agent called dex-eu."));
  });
});

describe("connect — step 2", () => {
  it("shows the token once, with the SHA-256 note and the copy button", async () => {
    const html = await render({ step: 2, ...LIVE });
    expect(html).toContain("dex-eu is registered");
    expect(html).toContain("We gave it a mark and a role colour. You can change both later.");
    expect(html).toContain("Copy this token now");
    expect(html).toContain(esc("It is stored as a SHA-256 hash — we can never show it again."));
    expect(html).toContain(LIVE.token);
    expect(html).toContain('data-label="Copy token"');
    expect(html).toContain('data-copy-gate="token"');
    expect(html).toContain(esc("Lost it later? Open the agent in"));
  });

  it("gates the forward button: inert label rendered, unlocked label in the handler", async () => {
    const html = await render({ step: 2, ...LIVE });
    expect(html).toContain("Copy it first");
    expect(html).toContain('id="c-step2-next"');
    expect(html).toContain(
      `data-next-href="/agents/connect?step=3&amp;s=${LIVE.sessionKey}&amp;client=code"`,
    );
    // The unlocked state is the copy handler's job, not a second render.
    expect(html).toContain("Saved it — next →");
    expect(html).toContain("d-copied");
    // Styled inert, never `disabled` — it must stay focusable.
    expect(html).not.toContain("disabled");
  });

  it("uses the one shared copy handler, not its own clipboard code", async () => {
    const html = await render({ step: 2, ...LIVE });
    expect(html).toContain("d-copy");
    // copy-script.ts guards itself with window.__dCopy; a second handler
    // would mean a second copy implementation on the page.
    expect(html.match(/window\.__dCopy = 1/g)?.length).toBe(1);
  });

  it("says the token is gone when the session expired", async () => {
    const html = await render({ step: 2, agentName: "dex-eu" });
    expect(html).toContain(
      esc("This token was created more than 15 minutes ago and is no longer on screen."),
    );
    expect(html).toContain(esc("reset its token to get a fresh one."));
    expect(html).not.toContain("Copy this token now");
    expect(html).not.toContain("Copy it first");
  });
});

describe("connect — step 3", () => {
  it("offers all four clients, in order, with the selected one active", async () => {
    const html = await render({ step: 3, ...LIVE, client: "desktop" });
    for (const label of Object.values(CONNECT_CLIENT_LABELS)) {
      expect(html).toContain(esc(label));
    }
    const positions = (["code", "desktop", "gemini", "cli"] as const).map((k) =>
      html.indexOf(esc(CONNECT_CLIENT_LABELS[k])),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain(esc("client=gemini"));
    expect(html).toContain(esc("Where does this agent live?"));
    expect(html).toContain(esc("Pick your client. Everything below is filled in with dex-eu"));
  });

  it("builds Claude Code's commands from the request origin and the real token", async () => {
    const html = await render({ step: 3, ...LIVE, client: "code" });
    expect(html).toContain("claude mcp add --transport http moshi");
    expect(html).toContain("https://mesh.example.test/mcp");
    expect(html).toContain(esc(`--header "Authorization: Bearer ${LIVE.token}"`));
    expect(html).toContain("claude mcp list");
    expect(html).toContain("If the tools don&#39;t show up");
    // The snippet origin comes from the request, never from a constant.
    expect(html).not.toContain("moshi.enki.run/mcp");
  });

  it("adds the MESH_URL export only when this is not the default deployment", async () => {
    const self = await render({ step: 3, ...LIVE, client: "cli" });
    expect(self).toContain(esc('export MESH_URL="https://mesh.example.test/mcp"'));
    const canonical = await render({ step: 3, ...LIVE, client: "cli", origin: DEFAULT_ORIGIN });
    expect(canonical).not.toContain("MESH_URL");
    expect(canonical).toContain(esc(`export MESH_TOKEN="${LIVE.token}"`));
  });

  it("numbers Gemini's single block 1 and keeps its gotcha", async () => {
    const html = await render({ step: 3, ...LIVE, client: "gemini" });
    expect(html).toContain(esc('"type": "streamable-http"'));
    expect(html).toContain(esc("The admin token won't work here"));
    expect(html).toContain(esc("Only bt_ agent tokens can send and receive."));
  });
});

describe("connect — step 4", () => {
  it("waits, polls the handshake endpoint and re-offers the gotcha on timeout", async () => {
    const html = await render({ step: 4, ...LIVE, client: "desktop" });
    expect(html).toContain("Waiting for dex-eu to say hello");
    expect(html).toContain(esc("Start or restart your client. The moment it makes its first MCP call"));
    expect(html).toContain(`/agents/connect/handshake?s=${LIVE.sessionKey}`);
    expect(html).toContain("2000");
    expect(html).toContain("120000");
    expect(html).toContain("dex-eu is in the mesh");
    expect(html).toContain(esc("Still nothing after two minutes."));
    expect(html).toContain(esc("Delete the cached session with rm -rf ~/.mcp-auth"));
    expect(html).not.toContain("EventSource"); // poll, not SSE
    expect(html).not.toContain("Simulate the handshake"); // prototype-only
  });

  it("shows the hello round trip, the seven tools and the six limits", async () => {
    const html = await render({ step: 4, ...LIVE });
    expect(html).toContain("Say hello from your side");
    expect(html).toContain("curl -fsSL https://mesh.example.test/install.sh | sh");
    expect(html).toContain(esc('moshi send dex-eu "moshi moshi — can you hear me?"'));

    expect(html).toContain("What dex-eu can do now");
    for (const tool of MCP_TOOL_CATALOG) {
      expect(html).toContain(tool.name);
      expect(html).toContain(esc(tool.signature));
      expect(html).toContain(esc(tool.desc));
    }

    expect(html).toContain("Worth knowing before you rely on it");
    expect(html).toContain("256 KB");
    expect(html).toContain("2 048"); // grouped, from MAX_CONTEXT_LENGTH
    expect(html).toContain(`${RATE_LIMIT_PER_MINUTE}/min`);
    expect(html).toContain("10 min");
    expect(html).toContain(`${MESSAGE_RETENTION_DAYS} days`);
    expect(html).toContain(String(MAX_AGENTS));
    expect(String(MAX_CONTEXT_LENGTH)).toBe("2048"); // the source of "2 048"
    expect(html).toContain("Done — show me the agents");
  });

  it("falls back to a placeholder name rather than a blank sentence", async () => {
    const html = await render({ step: 4, sessionKey: "k", token: "bt_x" });
    expect(html).toContain("Waiting for your-agent to say hello");
  });
});
