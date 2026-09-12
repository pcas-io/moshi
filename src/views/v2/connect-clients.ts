// The four clients of connect step 3, plus the step-4 hello command.
//
// Split out of connect.tsx purely for size: this file is data, that one is
// layout. Every string here is verbatim from
// docs/design_handoff_moshi_daylight/COPY.md §5 — intro, block labels and
// notes, the commands themselves and the per-client gotcha. Do not reword
// them here; change COPY.md first.
//
// Origins are always passed in from `requestOrigin(c)` so a self-hosted
// moshi never tells its operator to point an agent at someone else's host.

/** Tab order on step 3. Fixed — COPY.md §5 lists them in this order. */
export const CONNECT_CLIENT_ORDER = ["code", "desktop", "gemini", "cli"] as const;

export type ConnectClientKey = (typeof CONNECT_CLIENT_ORDER)[number];

export const DEFAULT_CONNECT_CLIENT: ConnectClientKey = "code";

export function isConnectClientKey(value: string | undefined): value is ConnectClientKey {
  return !!value && (CONNECT_CLIENT_ORDER as readonly string[]).includes(value);
}

export interface ConnectBlock {
  label: string;
  /** The grey aside beside the label — where to run it, what to expect. */
  note: string;
  code: string;
}

export interface ConnectClient {
  label: string;
  intro: string;
  blocks: readonly ConnectBlock[];
  gotchaTitle: string;
  gotcha: string;
}

/** The canonical deployment. Anything else is self-hosted and needs the
 *  extra MESH_URL export — the same conditional agents.tsx already had. */
export const DEFAULT_ORIGIN = "https://moshi.enki.run";

/** Shown on step 3/4 in place of a real name when the flow has no session. */
export const PLACEHOLDER_AGENT_NAME = "your-agent";

export const CONNECT_CLIENT_LABELS: Record<ConnectClientKey, string> = {
  code: "Claude Code",
  desktop: "Claude Desktop",
  gemini: "Gemini CLI",
  cli: "moshi CLI (for humans)",
};

function cliTokenBlock(origin: string, token: string): string {
  const meshUrl = origin === DEFAULT_ORIGIN ? "" : `\nexport MESH_URL="${origin}/mcp"`;
  return `export MESH_TOKEN="${token}"${meshUrl}\nmoshi status`;
}

/** One client's panel, with the real origin and token already pasted in. */
export function connectClient(
  key: ConnectClientKey,
  origin: string,
  token: string,
): ConnectClient {
  switch (key) {
    case "code":
      return {
        label: CONNECT_CLIENT_LABELS.code,
        intro:
          "One command registers moshi as an MCP server for this project. " +
          "Run it in the repo where the agent works.",
        blocks: [
          {
            label: "Register the server",
            note: "in your project directory",
            code:
              `claude mcp add --transport http moshi \\\n  ${origin}/mcp \\\n` +
              `  --header "Authorization: Bearer ${token}"`,
          },
          {
            label: "Check it landed",
            note: "should list moshi as connected",
            code: "claude mcp list",
          },
        ],
        gotchaTitle: "If the tools don't show up",
        gotcha:
          "Restart the Claude Code session — MCP servers are read at startup. " +
          "The seven mesh_* tools then appear in the tool list.",
      };
    case "desktop":
      return {
        label: CONNECT_CLIENT_LABELS.desktop,
        intro:
          "Desktop speaks MCP over stdio, so it connects through mcp-remote and an " +
          "OAuth 2.1 + PKCE handshake instead of a header. You'll paste the token in " +
          "the browser once.",
        blocks: [
          {
            label: "Add it to claude_desktop_config.json",
            note: 'inside "mcpServers"',
            code:
              `"moshi": {\n  "command": "npx",\n` +
              `  "args": ["-y", "mcp-remote", "${origin}/mcp"]\n}`,
          },
          {
            label: "Then restart Desktop",
            note: "the OAuth window opens by itself",
            code: `# paste this token in the browser prompt:\n${token}`,
          },
        ],
        gotchaTitle: "Starting the OAuth flow over",
        gotcha:
          "Delete the cached session with rm -rf ~/.mcp-auth and restart Desktop — " +
          "the browser prompt comes back.",
      };
    case "gemini":
      return {
        label: CONNECT_CLIENT_LABELS.gemini,
        intro:
          "Same shape as Claude Code's config file: a streamable-http server with a " +
          "bearer header.",
        blocks: [
          {
            label: "Add the server to your MCP settings",
            note: "under mcpServers",
            code:
              `"moshi": {\n  "type": "streamable-http",\n  "url": "${origin}/mcp",\n` +
              `  "headers": { "Authorization": "Bearer ${token}" }\n}`,
          },
        ],
        gotchaTitle: "The admin token won't work here",
        gotcha:
          "Only bt_ agent tokens can send and receive. The admin token is an " +
          "operator identity — it has no inbox and isn't addressable.",
      };
    case "cli":
      return {
        label: CONNECT_CLIENT_LABELS.cli,
        intro:
          "A 6 MB Go binary, no dependencies. This is how you join the mesh yourself, " +
          "without an agent in the middle.",
        blocks: [
          {
            label: "Install",
            note: "macOS, Linux and Windows are detected",
            code: `curl -fsSL ${origin}/install.sh | sh`,
          },
          {
            label: "Point it at your token",
            note: "add it to your shell profile to keep it",
            code: cliTokenBlock(origin, token),
          },
        ],
        gotchaTitle: "Piping works out of the box",
        gotcha:
          "stdin is detected automatically: docker logs app 2>&1 | moshi send ops " +
          "--type incident. Update later with moshi self-update.",
      };
  }
}

/** Step 4's round-trip proof. Three lines, no MESH_URL line: the prototype
 *  leaves it out and the install script already knows its own origin. */
export function helloCommand(origin: string, token: string, agentName: string): string {
  return (
    `curl -fsSL ${origin}/install.sh | sh\n` +
    `export MESH_TOKEN="${token}"\n` +
    `moshi send ${agentName} "moshi moshi — can you hear me?"`
  );
}
