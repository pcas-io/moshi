// moshi.moshi design tokens — "Daylight".
// Drop-in replacement for src/views/v2/tokens.ts: same module contract
// (V2_TOKENS + V2_CSS consumed by layout/pages), light warm surfaces.
//
// Contrast: every ink/ground pair below was measured. Values marked
// (AA) meet 4.5:1 at the sizes they are used at. Do not recombine an
// ink with a different ground without re-measuring.

export const V2_FONT_FAMILY_SANS =
  "'Sora', system-ui, -apple-system, sans-serif";
export const V2_FONT_FAMILY_MONO = "'JetBrains Mono', ui-monospace, monospace";

export const V2_TOKENS = {
  // ── Surfaces ────────────────────────────────────────────────
  paper: "#faf7f2",      // page
  card: "#ffffff",       // cards, panels, table bodies
  sunk: "#fcfaf6",       // table headers, list panel, thread footer
  subtle: "#f4f0e9",     // chips, inline code, monogram fallback
  codeBg: "#24211d",     // command blocks
  codeInk: "#e8e3da",
  codeBtn: "#3c3832",    // copy button on a command block

  // ── Borders ─────────────────────────────────────────────────
  line: "#e7e0d5",       // structural: cards, header, footer
  lineSoft: "#f0eae0",   // inside a card: section rules
  lineRow: "#f7f3ec",    // table row separators
  lineStrong: "#d8cfc0", // inputs, secondary buttons

  // ── Text ────────────────────────────────────────────────────
  ink: "#24211d",        // headings, primary text            (AA 13.8:1)
  body: "#4a453e",       // paragraphs                        (AA  8.7:1)
  dim: "#7d766c",        // labels, secondary >= 13px         (AA  4.49:1)
  faint: "#6f6862",      // metadata < 13px                   (AA  5.48:1)

  // ── Brand green ─────────────────────────────────────────────
  green: "#0e8a3e",      // SOLID FILLS ONLY, under white text
  greenText: "#0c7c38",  // links and green text on white     (AA  5.1:1)
  greenDeep: "#0a6e31",  // green text on greenSoft           (AA  6.39:1)
  greenSoft: "#e8f6ec",
  greenLine: "#bfe4cb",
  live: "#16a34a",       // presence dot only — never text

  // ── Status ──────────────────────────────────────────────────
  amber: "#b7791f", amberSoft: "#fdf4e3", amberLine: "#eeddba", amberInk: "#8a5f16",
  red: "#c0392b",   redSoft: "#fcedeb",   redLine: "#efd9d5",   redInk: "#a9776e",
  blue: "#2b6cb0",  blueSoft: "#eaf2fb",
  purple: "#6b46c1", purpleSoft: "#f1ecfb",

  // ── Presence (services/presence.ts states) ──────────────────
  presenceLive: "#16a34a",
  presenceStale: "#b7791f",
  presenceOffline: "#c5bdb0",  // also used for "never"

  // ── Shape ───────────────────────────────────────────────────
  radiusPanel: 20,   // login card
  radiusCard: 18,    // page cards, tables, asides
  radiusBox: 16,     // callouts, notice bands
  radiusInner: 14,   // cards inside cards, message bubbles
  radiusCode: 12,    // command blocks
  radiusControl: 10, // buttons, inputs
  radiusAvatar: 8,   // 22-26px avatars; 10 at 34, 11 at 40, 15 at 52
  radiusPill: 999,

  // ── Layout ──────────────────────────────────────────────────
  maxWidthApp: 1400,   // Home, Agents, Conversations, Log
  maxWidthDoc: 1000,   // Connect, Sign in
  gutterMin: 16, gutterMax: 32,
} as const;

/**
 * Message/audit kind -> {ink, ground}. Replaces typeColor/entityColor.
 *
 * Pills render at 12px, so every pair has to clear 4.5:1. Three of them use
 * the deeper ink this file already defines for exactly that job rather than
 * the fill colour: `greenDeep` not `green` (5.73:1, was 3.99), `amberInk` not
 * `amber` (5.16:1, was 3.33) and `faint` not `dim` (4.82:1, was 3.95). The
 * grounds are unchanged, so the pills look the way they were designed to —
 * only the text got readable. `daylight.test.ts` measures every pair.
 */
export const KIND_COLORS: Record<string, readonly [string, string]> = {
  incident:        ["#c0392b", "#fcedeb"],
  alert:           ["#c0392b", "#fcedeb"],
  question:        ["#2b6cb0", "#eaf2fb"],
  answer:          ["#0a6e31", "#e8f6ec"],
  reply:           ["#0a6e31", "#e8f6ec"],
  task_update:     ["#6f6862", "#f4f0e9"],
  deploy_request:  ["#2b6cb0", "#eaf2fb"],
  deploy_status:   ["#2b6cb0", "#eaf2fb"],
  review_request:  ["#8a5f16", "#fdf4e3"],
  review_result:   ["#0a6e31", "#e8f6ec"],
  script:          ["#6b46c1", "#f1ecfb"],
  info:            ["#6f6862", "#f4f0e9"],
  // audit entity_type
  message:         ["#0a6e31", "#e8f6ec"],
  session:         ["#2b6cb0", "#eaf2fb"],
  agent:           ["#8a5f16", "#fdf4e3"],
};

export function kindColors(key: string): readonly [string, string] {
  return KIND_COLORS[key] ?? KIND_COLORS["info"]!;
}

// Full CSS string injected into pages via <style>. Deliberately thin:
// the pages carry their own inline styles, this file owns resets,
// keyframes and the handful of things inline styles cannot express.
export const V2_CSS = `
:root {
  --paper: ${V2_TOKENS.paper};
  --card: ${V2_TOKENS.card};
  --sunk: ${V2_TOKENS.sunk};
  --subtle: ${V2_TOKENS.subtle};
  --line: ${V2_TOKENS.line};
  --line-soft: ${V2_TOKENS.lineSoft};
  --line-row: ${V2_TOKENS.lineRow};
  --line-strong: ${V2_TOKENS.lineStrong};
  --ink: ${V2_TOKENS.ink};
  --body: ${V2_TOKENS.body};
  --dim: ${V2_TOKENS.dim};
  --faint: ${V2_TOKENS.faint};
  --green: ${V2_TOKENS.green};
  --green-text: ${V2_TOKENS.greenText};
  --green-deep: ${V2_TOKENS.greenDeep};
  --green-soft: ${V2_TOKENS.greenSoft};
  --live: ${V2_TOKENS.live};
  --font-sans: ${V2_FONT_FAMILY_SANS};
  --font-mono: ${V2_FONT_FAMILY_MONO};
}

html, body {
  margin: 0; padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  text-wrap: pretty;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea { font-family: inherit; }
pre { margin: 0; }

/* Links MUST be defined: an undefined link renders browser-default blue. */
a { color: var(--green-text); text-decoration: none; }
a:hover { color: var(--green-deep); }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: #dfd8cc; border-radius: 999px;
  border: 2px solid transparent; background-clip: padding-box;
}

/* Entrance for the primary panel of a screen. One element per screen,
   never staggered across a list — staggering made the old dashboard
   feel slow. */
@keyframes m-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.m-rise { animation: m-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }

/* The only looping animation in the product: the live indicator. */
@keyframes m-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
.m-pulse { animation: m-pulse 2s infinite; }

@media (prefers-reduced-motion: reduce) {
  .m-rise { animation: none; }
  .m-pulse { animation: none; }
}
`;
