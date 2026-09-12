// Deterministic monogram emblem avatar for moshi.moshi — "daylight" set.
// Drop-in replacement for src/views/v2/avatar.ts.
//
// SAME 0–32 coordinate space as the portrait generator it replaces, so any
// embed of the form <g transform="scale(N/32)">{inner}</g> keeps working.
//
// ONE BREAKING CHANGE: the first argument is now the agent NAME, not its
// ULID. The monogram is derived from the name, so the id is no longer
// needed anywhere — see design_handoff/IMPLEMENTATION.md, step 4.

// ── FNV-1a 32-bit hash ───────────────────────────────────────────
function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ── Field / ink pairs ────────────────────────────────────────────
// Every ink measures >= 4.5:1 on its own field (WCAG AA for the 11px
// monogram). Do not swap an ink onto a different field without
// re-measuring.
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#e6efe8", "#0f7a45"],
  ["#eaeef6", "#3f5490"],
  ["#f2eade", "#96601f"],
  ["#e7eef5", "#2f5f8a"],
  ["#f3e9ee", "#8f4463"],
  ["#e7efee", "#1f6f67"],
  ["#eff0e3", "#6c6c1f"],
  ["#ecebf3", "#564080"],
];

// ── Role stripe colours ──────────────────────────────────────────
// The 8px stripe along the bottom edge is the only role signal on the
// emblem. Muted on purpose: it must not compete with the presence dot.
const ROLE_STRIPE: Record<string, string> = {
  "dev-assistant": "#5f7fb0",
  "dev-ops": "#4f9a80",
  "triage-agent": "#4f8fa8",
  "cortex-local": "#4f9a80",
  "product-manager": "#a8823f",
  "infra": "#b08a3a",
  "alert-source": "#c07a8a",
  "maintenance": "#7a7a8a",
  "security": "#5a6270",
  "worker": "#8a6a4a",
  "engineer": "#5f7fb0",
  "data-scientist": "#6f5f9a",
  "designer": "#a8607f",
  "ai-researcher": "#5f7fb0",
  "support": "#4f9a80",
  "sales": "#5a6270",
  "marketing": "#c07a8a",
  "qa": "#8a9a4a",
  "manager": "#5f7fb0",
  "finance": "#2f7a5f",
  "legal": "#5a6270",
  "analyst": "#4f8fa8",
  "researcher": "#6f5f9a",
  "sre": "#c07a8a",
  "ml": "#5f7fb0",
  "oncall": "#c07a8a",
  "backend": "#4f9a80",
  "frontend": "#6f5f9a",
  "mobile": "#4f8fa8",
  "platform": "#4f9a80",
};
const STRIPE_FALLBACK = "#8a8578";

/** Same fuzzy role matching as the portrait generator, so existing roles keep their colour. */
function stripeFor(role: string | undefined): string {
  const r = role?.toLowerCase() ?? "";
  if (ROLE_STRIPE[r]) return ROLE_STRIPE[r]!;
  if (/dev|code|engineer/.test(r))  return ROLE_STRIPE["dev-assistant"]!;
  if (/sec|trust/.test(r))          return ROLE_STRIPE["security"]!;
  if (/infra|deploy/.test(r))       return ROLE_STRIPE["infra"]!;
  if (/alert/.test(r))              return ROLE_STRIPE["alert-source"]!;
  if (/triage|incident/.test(r))    return ROLE_STRIPE["triage-agent"]!;
  if (/manag|pm|prod/.test(r))      return ROLE_STRIPE["product-manager"]!;
  if (/cortex|local|kg/.test(r))    return ROLE_STRIPE["cortex-local"]!;
  if (/qa|test/.test(r))            return ROLE_STRIPE["qa"]!;
  return STRIPE_FALLBACK;
}

/**
 * Two characters, upper case.
 * Multi-segment names take one letter per segment ("dex-eu" -> DE,
 * "triage-1" -> T1); single-segment names take the first two
 * ("scout" -> SC). Non-alphanumerics are dropped.
 */
export function initialsFor(name: string): string {
  const segs = name.split(/[-_.\s]+/).filter(Boolean);
  const raw = segs.length > 1
    ? segs.slice(0, 2).map((s) => s[0]!).join("")
    : (segs[0] ?? name).slice(0, 2);
  const clean = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return clean || "??";
}

// ── Avatar spec (pure data) ──────────────────────────────────────
export interface AvatarSpec {
  field: string;
  ink: string;
  stripe: string;
  initials: string;
  /** 0 | 90 | 180 | 270 — rotation of the background arc motif. */
  rotation: number;
}

export function deriveAvatarSpec(agentName: string, role?: string): AvatarSpec {
  const seed = agentName || "x";
  const [field, ink] = PALETTE[hash32(seed + "e") % PALETTE.length]!;
  return {
    field,
    ink,
    stripe: stripeFor(role),
    initials: initialsFor(seed),
    rotation: (hash32(seed + "r") % 4) * 90,
  };
}

// ── Compose inner SVG (0–32 space, no <svg> wrapper) ─────────────
export function renderAvatarSvgInner(agentName: string, role?: string): string {
  const s = deriveAvatarSpec(agentName, role);
  return (
    `<rect x="0" y="0" width="32" height="32" fill="${s.field}"/>` +
    `<g transform="rotate(${s.rotation} 16 16)" opacity="0.15">` +
      `<path d="M4.67 24.67 A15.33 15.33 0 0 1 24.67 4.67" fill="none" stroke="${s.ink}" stroke-width="2.5" stroke-linecap="round"/>` +
      `<path d="M9.67 26 A12 12 0 0 1 26 9.67" fill="none" stroke="${s.ink}" stroke-width="2.5" stroke-linecap="round"/>` +
      `<circle cx="7" cy="7" r="2.17" fill="${s.ink}"/>` +
    `</g>` +
    `<text x="16" y="19.17" text-anchor="middle" font-family="Sora, system-ui, sans-serif" ` +
      `font-size="11" font-weight="600" letter-spacing="-0.4" fill="${s.ink}">${s.initials}</text>` +
    `<rect x="0" y="29.33" width="32" height="2.67" fill="${s.stripe}"/>`
  );
}

// ── Public API ───────────────────────────────────────────────────
export interface AvatarRenderOptions {
  /** Display size in px, default 32. */
  size?: number;
  /** Clip to a circle. Clips the role stripe into a crescent — prefer the default. */
  rounded?: boolean;
}

export function renderAvatarSvg(
  agentName: string,
  role?: string,
  opts: AvatarRenderOptions = {},
): string {
  const size = opts.size ?? 32;
  const inner = renderAvatarSvgInner(agentName, role);
  const clip = opts.rounded
    ? '<defs><clipPath id="r"><rect width="32" height="32" rx="16" ry="16"/></clipPath></defs><g clip-path="url(#r)">'
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">` +
    clip + inner + (opts.rounded ? "</g>" : "") +
    "</svg>"
  );
}
