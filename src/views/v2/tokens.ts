// moshi.moshi design tokens — "SENTINEL Dark".
// Successor of the Soft Pastel system: same module contract (V2_TOKENS +
// V2_CSS consumed by layout/pages), new visual language — charcoal surfaces,
// neon-green accent, Sora + JetBrains Mono, uppercase tracking, sharp 2px
// CTAs, fadeUp motion. The metaphor: a mission-control console for the mesh.
// Deterministic anime avatars and the 4-state presence logic carry over 1:1.

export const V2_FONT_FAMILY_SANS =
  "'Sora', system-ui, -apple-system, sans-serif";
export const V2_FONT_FAMILY_MONO = "'JetBrains Mono', ui-monospace, monospace";

export const V2_TOKENS = {
  // Surfaces
  bg: "#0f0f0f",       // page
  panel: "#121212",    // list panels (conversations sidebar)
  surface: "#161616",  // cards
  surface2: "#1d1d1d", // raised rows / hover
  chip: "#242424",     // capability tags, kbd
  inset: "#0f0f0f",    // inputs, code blocks
  modal: "#191919",    // dialogs, palette
  btn3: "#2e2e2e",     // tertiary buttons
  btn3Hover: "#383838",
  // Borders
  line: "#242424",     // structural (topbar, footer, section rules)
  lineCard: "#262626", // card borders
  lineRow: "#1f1f1f",  // row separators
  line2: "#333333",    // inputs, stronger outlines
  // Text
  text: "#f5f5f5",
  textBody: "#d9d9d9",
  textDim: "#999999",
  textMute: "#666666",
  textFaint: "#555555",
  // Color
  accent: "hsl(119 99% 46%)", // neon green ≈ #05e901
  accentHover: "#9dff96",
  accentInk: "#0a0a0a",       // text on accent / white CTAs
  warn: "#e0992f",            // stale, broadcast, warnings
  danger: "#ef4444",
  info: "#6aa8e8",            // sessions, NATS, capability
  script: "#c084fc",          // script message type
  // Shape
  radius: 8,      // cards
  radiusBtn: 2,   // CTAs, chips
  radiusInput: 4, // inputs, code, avatars
  maxWidth: 1760,
} as const;

/** Neon-green glow with alpha — the accent hsl(119 99% 46%) as rgba. */
export function greenGlow(alpha: number): string {
  return `rgba(5,233,1,${alpha})`;
}

/** 56px blueprint grid, laid over hero/login surfaces. */
export const V2_GRID_BG =
  "linear-gradient(rgba(255,255,255,0.026) 1px,transparent 1px)," +
  "linear-gradient(90deg,rgba(255,255,255,0.026) 1px,transparent 1px)";

/** Radial green glows for the hero (bottom-left strong, top-right faint). */
export const V2_HERO_BG =
  `radial-gradient(720px 360px at 16% 110%,${greenGlow(0.11)},transparent 62%),` +
  `radial-gradient(900px 500px at 88% -30%,${greenGlow(0.05)},transparent 60%),` +
  V2_TOKENS.bg;

/** Radial green glows for the login screen (bottom-center). */
export const V2_LOGIN_BG =
  `radial-gradient(720px 420px at 50% 118%,${greenGlow(0.13)},transparent 62%),` +
  `radial-gradient(900px 500px at 85% -30%,${greenGlow(0.05)},transparent 60%),` +
  V2_TOKENS.bg;

// Full CSS string injected into V2 pages via <style>.
export const V2_CSS = `
:root {
  --v2-bg: ${V2_TOKENS.bg};
  --v2-panel: ${V2_TOKENS.panel};
  --v2-surface: ${V2_TOKENS.surface};
  --v2-surface-2: ${V2_TOKENS.surface2};
  --v2-chip: ${V2_TOKENS.chip};
  --v2-inset: ${V2_TOKENS.inset};
  --v2-modal: ${V2_TOKENS.modal};
  --v2-line: ${V2_TOKENS.line};
  --v2-line-card: ${V2_TOKENS.lineCard};
  --v2-line-row: ${V2_TOKENS.lineRow};
  --v2-line-2: ${V2_TOKENS.line2};
  --v2-text: ${V2_TOKENS.text};
  --v2-text-body: ${V2_TOKENS.textBody};
  --v2-text-dim: ${V2_TOKENS.textDim};
  --v2-text-mute: ${V2_TOKENS.textMute};
  --v2-text-faint: ${V2_TOKENS.textFaint};
  --v2-accent: ${V2_TOKENS.accent};
  --v2-accent-ink: ${V2_TOKENS.accentInk};
  --v2-warn: ${V2_TOKENS.warn};
  --v2-danger: ${V2_TOKENS.danger};
  --v2-info: ${V2_TOKENS.info};
  --v2-font-sans: ${V2_FONT_FAMILY_SANS};
  --v2-font-mono: ${V2_FONT_FAMILY_MONO};
}

html, body {
  margin: 0; padding: 0;
  background: var(--v2-bg);
  color: var(--v2-text);
  font-family: var(--v2-font-sans);
  font-size: 13.5px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
*, *::before, *::after { box-sizing: border-box; }
button { font-family: inherit; }
a { color: inherit; text-decoration: none; }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: #2e2e2e; border-radius: 999px;
  border: 2px solid transparent; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: #3a3a3a;
  border: 2px solid transparent; background-clip: padding-box;
}

@keyframes v2-fade-up {
  0%   { opacity: 0; transform: translateY(20px); filter: blur(4px); }
  100% { opacity: 1; transform: translateY(0);    filter: blur(0); }
}
.v2-fade {
  opacity: 0;
  animation: v2-fade-up 0.7s cubic-bezier(0.16,1,0.3,1) forwards;
}
@media (prefers-reduced-motion: reduce) {
  .v2-fade { animation: none; opacity: 1; }
}

/* ── Shell ─────────────────────────────────────────────────────── */
.v2-wrap {
  width: 100%;
  max-width: ${V2_TOKENS.maxWidth}px;
  margin: 0 auto;
  box-sizing: border-box;
}
.v2-pad { padding-left: clamp(16px, 3vw, 36px); padding-right: clamp(16px, 3vw, 36px); }

.v2-topbar-rule { border-bottom: 1px solid var(--v2-line); }
.v2-topbar {
  display: flex; align-items: center; gap: 18px;
  padding-top: 14px; padding-bottom: 14px;
  flex-wrap: wrap;
}
.v2-brand { display: flex; align-items: center; gap: 10px; color: var(--v2-text); }
.v2-brand-mark {
  width: 26px; height: 26px; border-radius: 6px;
  background: var(--v2-accent); color: var(--v2-accent-ink);
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 15px;
}
.v2-brand-name { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
.v2-brand-name .dot { color: var(--v2-accent); }

.v2-nav {
  display: flex; align-items: center; gap: clamp(14px, 2vw, 26px);
  flex: 1; justify-content: center; flex-wrap: wrap;
}
.v2-nav a {
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--v2-text-dim); padding-bottom: 3px;
  border-bottom: 1px solid transparent;
  transition: color 0.15s;
}
.v2-nav a:hover { color: var(--v2-text); }
.v2-nav a.active { color: var(--v2-text); border-bottom-color: var(--v2-accent); }

.v2-logout {
  font-size: 10.5px; letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--v2-text-dim); background: transparent; border: none;
  cursor: pointer; padding: 9px 2px; font-family: var(--v2-font-sans);
}
.v2-logout:hover { color: var(--v2-text); }

/* ── Footer ────────────────────────────────────────────────────── */
.v2-footer-rule { border-top: 1px solid var(--v2-line); }
.v2-footer {
  display: flex; align-items: center; gap: 14px;
  padding-top: 12px; padding-bottom: 12px;
  font-family: var(--v2-font-mono); font-size: 10.5px;
  color: var(--v2-text-mute); flex-wrap: wrap;
}
.v2-footer-domain {
  display: inline-flex; align-items: center; gap: 7px;
  color: var(--v2-text); font-weight: 600;
}
.v2-footer-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--v2-accent);
  box-shadow: 0 0 8px ${greenGlow(0.6)};
}
.v2-footer-sep { color: #333333; }
.v2-footer-spacer { flex: 1; }
.v2-footer-warn { color: var(--v2-warn); }

/* ── Card ──────────────────────────────────────────────────────── */
.v2-card {
  background: var(--v2-surface);
  border: 1px solid var(--v2-line-card);
  border-radius: ${V2_TOKENS.radius}px;
  overflow: hidden;
}
.v2-card-head {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--v2-line);
}
.v2-card-title {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase;
}
.v2-card-sub {
  font-family: var(--v2-font-mono); font-size: 10.5px;
  color: var(--v2-text-mute); margin-top: 2px;
}

/* ── Type ──────────────────────────────────────────────────────── */
.v2-eyebrow {
  font-family: var(--v2-font-mono); font-size: 10px;
  color: var(--v2-accent); letter-spacing: 0.2em; text-transform: uppercase;
}
.v2-h1 {
  margin: 0; font-weight: 700; letter-spacing: -0.03em;
  text-transform: uppercase; line-height: 1;
  font-size: clamp(26px, 3vw, 34px);
}
.v2-kbd {
  font-family: var(--v2-font-mono); font-size: 10px;
  color: var(--v2-text-mute); border: 1px solid var(--v2-line-2);
  border-radius: 3px; padding: 2px 6px;
}

/* ── Buttons ───────────────────────────────────────────────────── */
.v2-btn {
  display: inline-block;
  font-family: var(--v2-font-sans); font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  padding: 10px 18px; border-radius: ${V2_TOKENS.radiusBtn}px;
  background: var(--v2-btn3, ${V2_TOKENS.btn3}); border: none;
  color: var(--v2-text); cursor: pointer; text-align: center;
  background: ${V2_TOKENS.btn3};
  transition: filter 0.12s, background 0.12s, color 0.12s;
}
.v2-btn:hover { background: ${V2_TOKENS.btn3Hover}; }
.v2-btn--primary {
  background: var(--v2-accent); color: var(--v2-accent-ink); font-weight: 700;
}
.v2-btn--primary:hover { background: var(--v2-accent); filter: brightness(1.12); }
.v2-btn--secondary {
  background: var(--v2-text); color: #141414; font-weight: 700;
}
.v2-btn--secondary:hover { background: var(--v2-text); filter: brightness(0.88); }
.v2-btn--danger { background: var(--v2-danger); color: var(--v2-accent-ink); font-weight: 700; }
.v2-btn--danger:hover { background: var(--v2-danger); filter: brightness(1.12); }
.v2-btn--danger-outline {
  background: transparent; border: 1px solid rgba(239,68,68,0.45);
  color: var(--v2-danger);
}
.v2-btn--danger-outline:hover { background: rgba(239,68,68,0.08); }
.v2-btn--ghost {
  background: transparent; color: var(--v2-text-dim); font-weight: 400;
  letter-spacing: 0.1em;
}
.v2-btn--ghost:hover { background: transparent; color: var(--v2-text); }

/* ── Chips (filters) ───────────────────────────────────────────── */
.v2-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 10.5px; padding: 5px 12px;
  border-radius: ${V2_TOKENS.radiusBtn}px;
  border: 1px solid var(--v2-line-2); color: #777777;
  letter-spacing: 0.08em; text-transform: uppercase;
  cursor: pointer; text-decoration: none;
  font-family: var(--v2-font-sans); background: transparent;
}
.v2-chip:hover { color: var(--v2-text); }
.v2-chip.active {
  background: ${V2_TOKENS.btn3}; border-color: ${V2_TOKENS.btn3};
  color: var(--v2-text);
}
.v2-chip--mono { font-family: var(--v2-font-mono); text-transform: none; letter-spacing: 0.05em; }

/* ── Outlined mono tag (type/entity/routing markers) ──────────── */
.v2-tag {
  font-family: var(--v2-font-mono); font-size: 9.5px;
  border: 1px solid currentColor; border-radius: ${V2_TOKENS.radiusBtn}px;
  padding: 1px 7px; letter-spacing: 0.05em;
  display: inline-flex; align-items: center; gap: 4px;
  white-space: nowrap;
}

/* ── Inputs ────────────────────────────────────────────────────── */
.v2-input {
  width: 100%; box-sizing: border-box;
  background: var(--v2-inset);
  border: 1px solid var(--v2-line-2);
  border-radius: ${V2_TOKENS.radiusInput}px;
  color: var(--v2-text);
  font-family: var(--v2-font-mono); font-size: 12px;
  padding: 10px 13px; outline: none;
}
.v2-input:focus { border-color: ${greenGlow(0.55)}; }
.v2-input::placeholder { color: var(--v2-text-faint); }

/* ── Presence dot ──────────────────────────────────────────────── */
.v2-dot { display: inline-block; border-radius: 50%; flex-shrink: 0; }

/* ── Toast ─────────────────────────────────────────────────────── */
.v2-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 130; background: var(--v2-modal);
  border: 1px solid ${greenGlow(0.45)}; border-radius: 4px;
  padding: 10px 18px; font-family: var(--v2-font-mono); font-size: 11px;
  color: var(--v2-accent); box-shadow: 0 12px 40px rgba(0,0,0,0.6);
}
.v2-toast--error { border-color: rgba(239,68,68,0.5); color: var(--v2-danger); }
`;
