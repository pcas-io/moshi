// moshi.moshi design tokens — "Soft Pastel / Kawaii".
// Successor of the Paper-Glass system: same CSS-var contract + class names
// (pages cascade automatically), only the palette / shape / shadow language
// changes — pastel sakura bg, rounded-everything, soft diffuse glow instead
// of brutalist anchored shadows. The metaphor: a warm chat among agents
// and humans, not an ops console.

export const V2_FONT_FAMILY_SANS =
  "'M PLUS Rounded 1c', 'Baloo 2', -apple-system, system-ui, sans-serif";
export const V2_FONT_FAMILY_MONO = "'JetBrains Mono', ui-monospace, monospace";

export const V2_TOKENS = {
  bg: "#fdf4f8",       // sakura cream
  surface: "#ffffff",
  surface2: "#f7ecf3",
  surface3: "#efe0ea",
  text: "#4a3b4d",     // soft plum ink — never harsh pure black
  textDim: "rgba(74,59,77,0.66)",
  textMute: "rgba(74,59,77,0.42)",
  line: "rgba(120,80,120,0.12)",
  line2: "rgba(120,80,120,0.24)",
  accent: "#ff8fb3",   // sakura pink
  accent2: "#5ec8c0",  // soft mint
  warn: "#e0992f",
  danger: "#ef6f8e",
  info: "#7cb8e8",
  radius: 16,
  radiusXL: 24,
  shellWidth: 1280,
  shellWidthCompact: 1024,
  compactBreakpoint: 1180,
} as const;

// Soft glass: gentle white sheen + diffuse pink-tinted glow. No hard inset
// dark lines, no 1px anchor — the surface floats softly instead of being
// nailed down.
export const V2_GLASS = {
  bg: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(255,250,253,0.82) 30%, rgba(255,246,251,0.72) 100%)",
  bg2: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(255,250,253,0.90) 30%, rgba(255,246,251,0.80) 100%)",
  border: "1px solid rgba(255,143,179,0.20)",
  shadow:
    "0 1px 0 rgba(255,255,255,0.92) inset," +
    " 0 12px 30px rgba(217,130,175,0.16)," +
    " 0 4px 12px rgba(217,130,175,0.10)",
  shadowSm:
    "0 1px 0 rgba(255,255,255,0.88) inset," +
    " 0 6px 16px rgba(217,130,175,0.12)",
  blur: "blur(18px) saturate(150%)",
  // Soft wet highlight along the top edge (mix-blend: screen overlay).
  sheen: "radial-gradient(140% 70% at 50% -10%, rgba(255,255,255,0.62), rgba(255,255,255,0) 55%)",
} as const;

// Buttons: pillowy pink primary with a soft pink glow; airy white secondary.
export const V2_BTN = {
  primaryBg: "linear-gradient(180deg, #ffacc8 0%, #ff8fb3 55%, #ff7aa6 100%)",
  primaryShadow:
    "0 1px 0 rgba(255,255,255,0.55) inset," +
    " 0 8px 20px rgba(255,138,179,0.42)," +
    " 0 2px 6px rgba(255,138,179,0.26)",
  secondaryBg: "linear-gradient(180deg, rgba(255,255,255,0.97), rgba(255,248,252,0.82))",
  secondaryShadow:
    "0 1px 0 rgba(255,255,255,0.95) inset," +
    " 0 4px 12px rgba(217,130,175,0.13)",
} as const;

// Full CSS string injected into V2 pages via <style>.
export const V2_CSS = `
:root {
  --v2-bg: ${V2_TOKENS.bg};
  --v2-surface: ${V2_TOKENS.surface};
  --v2-surface-2: ${V2_TOKENS.surface2};
  --v2-surface-3: ${V2_TOKENS.surface3};
  --v2-text: ${V2_TOKENS.text};
  --v2-text-dim: ${V2_TOKENS.textDim};
  --v2-text-mute: ${V2_TOKENS.textMute};
  --v2-line: ${V2_TOKENS.line};
  --v2-line-2: ${V2_TOKENS.line2};
  --v2-accent: ${V2_TOKENS.accent};
  --v2-accent-2: ${V2_TOKENS.accent2};
  --v2-warn: ${V2_TOKENS.warn};
  --v2-danger: ${V2_TOKENS.danger};
  --v2-info: ${V2_TOKENS.info};
  --v2-radius: ${V2_TOKENS.radius}px;
  --v2-radius-xl: ${V2_TOKENS.radiusXL}px;
  --v2-glass-bg: ${V2_GLASS.bg};
  --v2-glass-bg-2: ${V2_GLASS.bg2};
  --v2-glass-border: ${V2_GLASS.border};
  --v2-glass-shadow: ${V2_GLASS.shadow};
  --v2-glass-shadow-sm: ${V2_GLASS.shadowSm};
  --v2-glass-blur: ${V2_GLASS.blur};
  --v2-sheen: ${V2_GLASS.sheen};
  --v2-btn-primary-bg: ${V2_BTN.primaryBg};
  --v2-btn-primary-shadow: ${V2_BTN.primaryShadow};
  --v2-btn-secondary-bg: ${V2_BTN.secondaryBg};
  --v2-btn-secondary-shadow: ${V2_BTN.secondaryShadow};
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
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
*, *::before, *::after { box-sizing: border-box; }
button { font-family: inherit; }
a { color: inherit; text-decoration: none; }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255,143,179,0.35); border-radius: 999px;
  border: 2px solid transparent; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255,143,179,0.55);
  border: 2px solid transparent; background-clip: padding-box;
}

/* ── Stage (dreamy pastel blobs over sakura cream) ─────────────── */
.v2-stage {
  min-height: 100vh;
  padding: 28px 0;
  background:
    radial-gradient(900px 600px at 12% 8%, rgba(255,143,179,0.16), transparent 60%),
    radial-gradient(760px 520px at 88% 90%, rgba(94,200,192,0.14), transparent 60%),
    radial-gradient(640px 460px at 50% 50%, rgba(167,139,250,0.10), transparent 70%),
    var(--v2-bg);
}

/* Responsive scaler: design renders at fixed width and scales down on
   narrow viewports via CSS transform. JS in V2Layout updates --v2-scale
   and the wrapper height so the document scrolls correctly. */
.v2-scaler {
  margin: 0 auto;
  transform-origin: top center;
  transition: transform 0.08s linear;
  will-change: transform;
}

/* ── Shell ─────────────────────────────────────────────────────── */
.v2-shell {
  width: var(--v2-design-width, ${V2_TOKENS.shellWidth}px);
  min-height: 100vh;
  position: relative;
}
.v2-topbar {
  position: relative;
  margin: 14px 14px 0;
  padding: 10px 14px;
  display: flex; align-items: center; gap: 10px;
  background: var(--v2-glass-bg-2);
  -webkit-backdrop-filter: var(--v2-glass-blur);
  backdrop-filter: var(--v2-glass-blur);
  border: var(--v2-glass-border);
  border-radius: 22px;
  box-shadow: var(--v2-glass-shadow);
  z-index: 40;
}
/* Soft top sheen overlay (absolute, mix-blend: screen). */
.v2-sheen {
  position: absolute; inset: 0; pointer-events: none;
  background: var(--v2-sheen);
  mix-blend-mode: screen;
  border-radius: inherit;
}
.v2-brand { position: relative; display: flex; align-items: center; gap: 10px; padding: 0 6px 0 4px; }
.v2-brand-mark {
  width: 26px; height: 26px; border-radius: 50%;
  background: var(--v2-btn-primary-bg); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 14px; font-family: var(--v2-font-sans);
  letter-spacing: -0.04em;
  box-shadow: var(--v2-btn-primary-shadow);
  text-shadow: 0 1px 0 rgba(255,120,160,0.45);
}
.v2-brand-name { font-size: 14.5px; font-weight: 800; letter-spacing: -0.01em; }
.v2-divider-v {
  position: relative;
  width: 1px; height: 22px;
  background: var(--v2-line-2);
  margin: 0 4px;
}

.v2-nav { position: relative; display: flex; align-items: center; gap: 2px; flex: 1; }
.v2-nav a {
  padding: 7px 14px; border-radius: 999px; font-size: 13px;
  display: flex; align-items: center; gap: 7px;
  color: var(--v2-text-dim); font-weight: 600;
  border: 1px solid transparent;
  transition: background 0.15s, color 0.15s;
}
.v2-nav a:hover { background: rgba(255,143,179,0.12); color: var(--v2-text); }
.v2-nav a.active {
  background: var(--v2-btn-secondary-bg);
  color: var(--v2-text); font-weight: 800;
  border: var(--v2-glass-border);
  box-shadow: var(--v2-btn-secondary-shadow);
}
.v2-nav-badge {
  font-size: 10.5px; font-family: var(--v2-font-mono);
  background: rgba(255,143,179,0.14); color: var(--v2-text-mute);
  padding: 1px 8px; border-radius: 999px; font-weight: 700;
}
.v2-nav a.active .v2-nav-badge {
  background: var(--v2-btn-primary-bg); color: #fff;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
}

.v2-search-btn {
  position: relative;
  background: var(--v2-btn-secondary-bg);
  border: var(--v2-glass-border);
  color: var(--v2-text-dim);
  border-radius: 999px; padding: 7px 14px;
  font-size: 12.5px; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  min-width: 220px;
  box-shadow: var(--v2-btn-secondary-shadow);
}
.v2-search-btn .v2-kbd {
  font-size: 10.5px; color: var(--v2-text-mute);
  font-family: var(--v2-font-mono);
}

/* ── Footer strip ─────────────────────────────────────────────── */
.v2-footer {
  position: relative;
  margin: 14px;
  padding: 8px 16px;
  background: var(--v2-glass-bg-2);
  -webkit-backdrop-filter: var(--v2-glass-blur);
  backdrop-filter: var(--v2-glass-blur);
  border: var(--v2-glass-border);
  border-radius: 18px;
  box-shadow: var(--v2-glass-shadow-sm);
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 11px; color: var(--v2-text-mute);
  font-family: var(--v2-font-mono);
  letter-spacing: 0.02em;
}
.v2-footer > * { position: relative; }
.v2-footer-sep { color: var(--v2-line-2); }
.v2-footer-domain {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--v2-text); font-weight: 700;
}
.v2-footer-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--v2-accent-2);
  box-shadow: 0 0 0 3px rgba(94,200,192,0.22), inset 0 1px 0 rgba(255,255,255,0.45);
}
.v2-footer-warn { color: var(--v2-warn); font-weight: 700; }
.v2-footer-spacer { flex: 1; }

/* ── Card ──────────────────────────────────────────────────────── */
.v2-card {
  position: relative;
  background: var(--v2-glass-bg);
  -webkit-backdrop-filter: var(--v2-glass-blur);
  backdrop-filter: var(--v2-glass-blur);
  border: var(--v2-glass-border);
  border-radius: var(--v2-radius-xl);
  overflow: hidden;
  box-shadow: var(--v2-glass-shadow);
}
.v2-card.lift-sm { box-shadow: var(--v2-glass-shadow-sm); }
.v2-card-head {
  position: relative;
  padding: 13px 18px;
  border-bottom: 1px solid var(--v2-line);
  display: flex; align-items: center; gap: 10px;
}
.v2-card-body { position: relative; }
.v2-card-title {
  font-size: 12px; font-weight: 800;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.v2-card-sub { font-size: 11.5px; color: var(--v2-text-mute); margin-top: 2px; }

/* ── Buttons ───────────────────────────────────────────────────── */
.v2-btn {
  font-family: inherit; font-size: 13px; cursor: pointer;
  padding: 7px 16px; border-radius: 999px;
  background: var(--v2-btn-secondary-bg);
  border: var(--v2-glass-border);
  color: var(--v2-text); font-weight: 700;
  box-shadow: var(--v2-btn-secondary-shadow);
  transition: transform 0.12s ease;
}
.v2-btn:hover { transform: translateY(-1px); }
.v2-btn--primary {
  background: var(--v2-btn-primary-bg);
  border: 1px solid rgba(255,138,179,0.45);
  color: #fff;
  font-weight: 800; padding: 8px 18px; letter-spacing: 0.01em;
  box-shadow: var(--v2-btn-primary-shadow);
  text-shadow: 0 1px 0 rgba(255,120,160,0.40);
}
.v2-btn--ghost {
  background: transparent; border: none; padding: 7px 12px;
  color: var(--v2-text); box-shadow: none; font-weight: 600;
}
.v2-btn--danger-outline {
  background: transparent; color: var(--v2-danger);
  border: 1px solid rgba(239,111,142,0.45);
  box-shadow: none;
}

/* ── Tag ───────────────────────────────────────────────────────── */
.v2-tag {
  font-size: 11px; padding: 3px 10px; border-radius: 999px;
  font-family: var(--v2-font-mono); letter-spacing: 0.02em; font-weight: 700;
  border: 1px solid currentColor;
  display: inline-flex; align-items: center; gap: 4px;
}

/* ── Dot (presence) ────────────────────────────────────────────── */
.v2-dot { display: inline-block; border-radius: 50%; }

/* ── Page heading ──────────────────────────────────────────────── */
.v2-h1 {
  font-size: 25px; font-weight: 800; margin: 0;
  letter-spacing: -0.02em;
}
.v2-page-sub {
  color: var(--v2-text-dim); font-size: 13px; margin-top: 4px;
  font-family: var(--v2-font-mono);
}
.v2-page-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 20px;
}

/* ── Inputs ────────────────────────────────────────────────────── */
.v2-input {
  background: var(--v2-btn-secondary-bg);
  border: var(--v2-glass-border); color: var(--v2-text);
  padding: 9px 14px; font-size: 13px;
  font-family: var(--v2-font-sans);
  border-radius: 999px; outline: none;
  width: 100%;
  box-shadow: inset 0 2px 5px rgba(217,130,175,0.07), inset 0 1px 0 rgba(255,255,255,0.7);
}
.v2-input:focus { border-color: rgba(255,143,179,0.5); }
.v2-input--mono { font-family: var(--v2-font-mono); }
`;
