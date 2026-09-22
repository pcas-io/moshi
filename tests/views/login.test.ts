// Sign in is the one page outside the app shell: it carries its own <head>,
// its own STYLE string and every string in COPY.md §3. All of that rots
// silently, so it is asserted here rather than eyeballed.

import { describe, it, expect } from "vitest";
import {
  LoginPage,
  loginStatusPhrase,
  HEALTHY_STATUS_PHRASE,
  DEFAULT_LOGIN_HOST,
} from "../../src/views/login";
import type { HealthResult } from "../../src/services/health";

/** Hono escapes ASCII apostrophes; COPY.md uses them, so assert the escaped form. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function render(props: Parameters<typeof LoginPage>[0]): Promise<string> {
  return String(await Promise.resolve(LoginPage(props)));
}

function health(over: Partial<HealthResult> = {}): HealthResult {
  return { status: "ok", nats: "connected", db: "ok", httpStatus: 200, ...over };
}

const BASE = { csrfToken: "csrf-token-value" } as const;

describe("LoginPage — document shell", () => {
  it("is an English, light-scheme document titled もしもし — moshi.moshi", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('lang="de"');
    expect(html).toContain('<meta name="color-scheme" content="light"/>');
    expect(html).toContain("<title>もしもし — moshi.moshi</title>");
  });

  it("ships the Daylight-green favicon, not the neon one", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain("fill='%230e8a3e'");
    expect(html).not.toContain("%2305e901");
  });

  it("brings Sora and JetBrains Mono from this origin: the brand mark is drawn at 700, and a variable file has it", async () => {
    const html = await render({ ...BASE });
    expect(html).toMatch(/@font-face \{\s*font-family: 'Sora';[^}]*font-weight: 100 800;[^}]*url\(\/fonts\/sora-latin\./);
    expect(html).toMatch(/@font-face \{\s*font-family: 'JetBrains Mono';/);
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(html).toContain("font-weight:700;font-size:22px");
  });
});

describe("LoginPage — COPY.md §3 strings", () => {
  it("renders the brand lockup and the heading with its hard line break", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(esc("もしもし — who's there?"));
    expect(html).toContain("moshi<span style=\"color:#0e8a3e\">.</span>moshi");
    expect(html).toContain("A mailbox<br/>for your agents.");
  });

  it("renders the lead and all three facts", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(
      "Your Claude Code, Claude Desktop and Gemini agents talk to each other over MCP — " +
        "asynchronously, with a thread history you can read.",
    );
    expect(html).toContain("Works with Claude Code, Claude Desktop and Gemini CLI over MCP");
    expect(html).toContain("Threads, presence and an audit trail you can read");
    expect(html).toContain("Join it yourself with a 6 MB binary — no agent required");
    expect(html.match(/>✓</g) ?? []).toHaveLength(3);
  });

  it("renders the card, the token field and the note", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(">Sign in</h2>");
    expect(html).toContain(esc("Paste your admin token, or an agent's bearer token to see its own view."));
    expect(html).toContain(">Token</label>");
    expect(html).toContain('placeholder="bt_••••••••••••••••"');
    expect(html).toContain(">Sign in</button>");
    expect(html).toContain(esc("No token yet? It lives in your deployment's "));
    expect(html).toContain(">MESH_ADMIN_TOKEN</span>");
    expect(html).toContain(" — the same value you set in ");
    expect(html).toContain(">.env</span>");
  });

  it("tells the reader that agents connect elsewhere", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(esc("Agents don't sign in here — they connect to "));
    expect(html).toContain(`>${DEFAULT_LOGIN_HOST}/mcp</span>`);
  });

  it("closes with the licence footer", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(`>${DEFAULT_LOGIN_HOST}</span>`);
    expect(html).toContain(">Apache 2.0</span>");
  });

  it("drops every SENTINEL Dark string COPY.md §3 replaced", async () => {
    const html = await render({ ...BASE });
    for (const gone of [
      "Mesh Access",
      "Async agent-to-agent messaging, done right.",
      "Admin Token",
      "SHA-256",
      "MESH_COOKIE_SECRET",
      "AGENTS CONNECT VIA MCP",
      "NATS JetStream",
      "SINGLE-NODE",
      "Sign In",
    ]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("LoginPage — form plumbing", () => {
  it("always carries the CSRF field", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain('<input type="hidden" name="csrf" value="csrf-token-value"/>');
    expect(html).toContain('<form method="post" action="/login">');
  });

  it("carries `next` only when the route passed one", async () => {
    const without = await render({ ...BASE });
    expect(without).not.toContain('name="next"');
    const with_ = await render({ ...BASE, next: "/agents?presence=live" });
    expect(with_).toContain('<input type="hidden" name="next" value="/agents?presence=live"/>');
  });

  it("keeps the token field focusable and autofilled on arrival", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain('id="token"');
    expect(html).toContain('for="token"');
    expect(html).toContain("autofocus");
    expect(html).toContain('autocomplete="current-password"');
  });
});

describe("LoginPage — error state", () => {
  it("renders nothing between input and button when there is no error", async () => {
    const html = await render({ ...BASE });
    expect(html).not.toContain("Invalid token");
    expect(html).not.toContain('id="token-error"');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  it("announces the rejection and wires it to the field", async () => {
    const html = await render({ ...BASE, error: true });
    expect(html).toContain("Invalid token — check MESH_ADMIN_TOKEN.");
    expect(html).toContain('id="token-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="token-error"');
  });
});

describe("LoginPage — footer status", () => {
  it("states the healthy phrase when no health was passed", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain(`>${HEALTHY_STATUS_PHRASE}</span>`);
  });

  it("names what is down instead of a generic degradation", async () => {
    const html = await render({ ...BASE, health: health({ status: "degraded", nats: "disconnected", httpStatus: 503 }) });
    expect(html).toContain("NATS unreachable — messages are queued");
    expect(html).not.toContain(HEALTHY_STATUS_PHRASE);
  });

  it("keeps the live dot green while degraded — the footer informs, it does not alarm", async () => {
    const html = await render({ ...BASE, health: health({ status: "degraded", db: "error", httpStatus: 503 }) });
    expect(html).toContain("background:#16a34a");
    expect(html).not.toContain("#c0392b");
  });
});

describe("loginStatusPhrase", () => {
  it("defaults to the healthy phrase", () => {
    expect(loginStatusPhrase()).toBe(HEALTHY_STATUS_PHRASE);
    expect(loginStatusPhrase(null)).toBe(HEALTHY_STATUS_PHRASE);
    expect(loginStatusPhrase(health())).toBe(HEALTHY_STATUS_PHRASE);
  });

  it("names each backend that is down", () => {
    expect(loginStatusPhrase(health({ nats: "disconnected" }))).toBe(
      "NATS unreachable — messages are queued",
    );
    expect(loginStatusPhrase(health({ db: "error" }))).toBe(
      "The database is not responding — history is stale",
    );
    expect(loginStatusPhrase(health({ nats: "disconnected", db: "error" }))).toBe(
      "NATS and the database are unreachable — nothing is moving",
    );
  });
});

describe("LoginPage — Daylight house rules", () => {
  it("animates exactly one element and disables it under reduced motion", async () => {
    const html = await render({ ...BASE });
    expect(html.match(/class="m-rise"/g) ?? []).toHaveLength(1);
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).not.toContain("m-pulse");
  });

  it("collapses the two columns without a media query", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain("repeat(auto-fit, minmax(min(340px,100%), 1fr))");
    expect(html).not.toContain("@media (max-width");
  });

  it("uses faint, not dim, for the 12px wordmark sub-line", async () => {
    const html = await render({ ...BASE });
    expect(html).toContain("font-size:12px;color:#6f6862");
  });

  it("leaves no SENTINEL Dark token or class behind", async () => {
    const html = await render({ ...BASE });
    for (const gone of ["v2-fade-up", "grid-bg", "#05e901", "#0a0a0a;", "greenGlow"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("lets the deployment override the host it advertises", async () => {
    const html = await render({ ...BASE, host: "mesh.example.test" });
    expect(html).toContain(">mesh.example.test/mcp</span>");
    expect(html).not.toContain(DEFAULT_LOGIN_HOST);
  });
});
