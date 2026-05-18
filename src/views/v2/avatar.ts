// Deterministic anime-style portrait avatar for moshi.moshi.
// Successor of the pixel-art generator: SAME public API
// (deriveAvatarSpec / renderAvatarSvgInner / renderAvatarSvg /
// AvatarRenderOptions) and SAME 0–32 coordinate space, so the
// mesh-topology embed `<g transform=… scale(N/32)>{inner}</g>` and the
// V2Avatar component keep working unchanged. Only the art direction
// changes: soft kawaii faces — big eyes with a highlight, blush, rounded
// hair — instead of a pixel grid. Pure function, server-renderable.

// ── FNV-1a 32-bit hash ───────────────────────────────────────────
function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], h: number, salt: string): T {
  const x = (h ^ hash32(salt)) >>> 0;
  return arr[x % arr.length]!;
}

// ── Palettes (soft anime) ────────────────────────────────────────
// [base, shade] per skin tone.
const SKIN: ReadonlyArray<readonly [string, string]> = [
  ["#ffe2cf", "#f3c4a4"],
  ["#ffd4b8", "#eab48c"],
  ["#f0c19a", "#d49b6e"],
  ["#c98e63", "#a86f45"],
  ["#8a5e3c", "#6b4528"],
];

const HAIR = [
  "#3a2a3a", "#5a3a2a", "#8a4a2a", "#c98a3a", "#e8d28a",
  "#ff9ec4", "#a78bfa", "#6ec5e8", "#7ed9c4", "#9a5a8a",
] as const;

// Anime iris colors.
const IRIS = [
  "#7c5cff", "#ff7eb6", "#3ac0b8", "#4f9fe8",
  "#e8913a", "#8a5acb", "#e85a7a", "#3a8f6e",
] as const;

const BG = [
  "#ffe3ef", "#e6f3ec", "#fdeede", "#e3eefc",
  "#efe6fb", "#fde6e6", "#e3f5f0", "#f4ecdd",
  "#eceaf6", "#fdf0dd", "#e6f0fa", "#f6e6f0",
] as const;

const SHIRT = [
  "#ff8fb3", "#5aa0d8", "#5ec8a8", "#e0a83a",
  "#9a7ad8", "#5a5a6a", "#d8b04a", "#c87a8a",
  "#5ab0c8", "#c87ab0", "#7a7a8a", "#5a5a7a",
] as const;

// ── Role kit table ───────────────────────────────────────────────
type Kit = { accessory: Accessory; collar: Collar; tint: string };

type Accessory =
  | "headset" | "glasses" | "shades" | "visor" | "hardhat"
  | "cap" | "beanie" | "beret" | "antenna" | "tie" | "none";

type Collar =
  | "hoodie" | "jacket" | "tech" | "sweater" | "turtle"
  | "overalls" | "workshirt" | "suit" | "shirt" | "polo";

const ROLE_KITS: Record<string, Kit> = {
  "dev-assistant":   { accessory: "headset",  collar: "hoodie",    tint: "#7a8fe0" },
  "triage-agent":    { accessory: "glasses",  collar: "jacket",    tint: "#5aa0d8" },
  "cortex-local":    { accessory: "visor",    collar: "tech",      tint: "#5ec8a8" },
  "product-manager": { accessory: "glasses",  collar: "sweater",   tint: "#e0a83a" },
  "infra":           { accessory: "hardhat",  collar: "overalls",  tint: "#e0a83a" },
  "alert-source":    { accessory: "antenna",  collar: "tech",      tint: "#ff8fb3" },
  "maintenance":     { accessory: "cap",      collar: "overalls",  tint: "#7a7a8a" },
  "security":        { accessory: "shades",   collar: "suit",      tint: "#5a5a6a" },
  "worker":          { accessory: "beanie",   collar: "workshirt", tint: "#8a4a2a" },
  "dev-ops":         { accessory: "headset",  collar: "hoodie",    tint: "#5ec8a8" },
  "engineer":        { accessory: "cap",      collar: "tech",      tint: "#5ab0c8" },
  "data-scientist":  { accessory: "glasses",  collar: "sweater",   tint: "#9a7ad8" },
  "designer":        { accessory: "beret",    collar: "turtle",    tint: "#c87ab0" },
  "ai-researcher":   { accessory: "glasses",  collar: "turtle",    tint: "#7a8fe0" },
  "support":         { accessory: "headset",  collar: "polo",      tint: "#5ec8a8" },
  "sales":           { accessory: "tie",      collar: "suit",      tint: "#5a5a6a" },
  "marketing":       { accessory: "beret",    collar: "jacket",    tint: "#ff8fb3" },
  "qa":              { accessory: "glasses",  collar: "shirt",     tint: "#e0a83a" },
  "manager":         { accessory: "tie",      collar: "suit",      tint: "#7a8fe0" },
  "ceo":             { accessory: "tie",      collar: "suit",      tint: "#5a5a6a" },
  "finance":         { accessory: "tie",      collar: "shirt",     tint: "#3a8f6e" },
  "legal":           { accessory: "glasses",  collar: "suit",      tint: "#5a5a6a" },
  "hr":              { accessory: "none",     collar: "sweater",   tint: "#ff8fb3" },
  "analyst":         { accessory: "glasses",  collar: "shirt",     tint: "#5ab0c8" },
  "researcher":      { accessory: "glasses",  collar: "turtle",    tint: "#9a7ad8" },
  "sre":             { accessory: "visor",    collar: "tech",      tint: "#ff8fb3" },
  "ml":              { accessory: "visor",    collar: "turtle",    tint: "#7a8fe0" },
  "oncall":          { accessory: "cap",      collar: "jacket",    tint: "#ff8fb3" },
  "backend":         { accessory: "beanie",   collar: "hoodie",    tint: "#5ec8a8" },
  "frontend":        { accessory: "headset",  collar: "hoodie",    tint: "#9a7ad8" },
  "mobile":          { accessory: "cap",      collar: "tech",      tint: "#5ab0c8" },
  "platform":        { accessory: "visor",    collar: "jacket",    tint: "#5ec8a8" },
};

function kitFor(role: string | undefined): Kit {
  const r = role?.toLowerCase() ?? "";
  if (ROLE_KITS[r]) return ROLE_KITS[r]!;
  if (/dev|code|engineer/.test(r))   return ROLE_KITS["dev-assistant"]!;
  if (/sec|trust/.test(r))           return ROLE_KITS["security"]!;
  if (/work/.test(r))                return ROLE_KITS["worker"]!;
  if (/maint/.test(r))               return ROLE_KITS["maintenance"]!;
  if (/infra|deploy/.test(r))        return ROLE_KITS["infra"]!;
  if (/alert/.test(r))               return ROLE_KITS["alert-source"]!;
  if (/triage|incident/.test(r))     return ROLE_KITS["triage-agent"]!;
  if (/manag|pm|prod/.test(r))       return ROLE_KITS["product-manager"]!;
  if (/cortex|local|kg/.test(r))     return ROLE_KITS["cortex-local"]!;
  return { accessory: "cap", collar: "shirt", tint: "#5ab0c8" };
}

// ── Color helper ─────────────────────────────────────────────────
function darken(hex: string, f: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${Math.floor(r * f)},${Math.floor(g * f)},${Math.floor(b * f)})`;
}

// ── Avatar spec (pure data) ──────────────────────────────────────
export interface AvatarSpec {
  skin: readonly [string, string];
  hairColor: string;
  hairVariant: number; // 0-7
  eyeVariant: number;  // 0-3
  mouthVariant: number; // 0-3
  iris: string;
  bg: string;
  kit: Kit;
  shirt: string;
}

export function deriveAvatarSpec(agentId: string, role?: string): AvatarSpec {
  const seed = hash32(agentId || "x");
  const kit = kitFor(role);
  return {
    skin: pick(SKIN, seed, "skin"),
    hairColor: pick(HAIR, seed, "hairc"),
    hairVariant: hash32(agentId + "h") % 8,
    eyeVariant: hash32(agentId + "e") % 4,
    mouthVariant: hash32(agentId + "m") % 4,
    iris: pick(IRIS, seed, "iris"),
    bg: pick(BG, seed, "bg"),
    kit,
    shirt: kit.tint || pick(SHIRT, seed, "shirt"),
  };
}

// ── SVG primitives ───────────────────────────────────────────────
const ell = (cx: number, cy: number, rx: number, ry: number, c: string, extra = ""): string =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}"${extra ? " " + extra : ""}/>`;
const pathf = (d: string, c: string, extra = ""): string =>
  `<path d="${d}" fill="${c}"${extra ? " " + extra : ""}/>`;
const rrect = (x: number, y: number, w: number, h: number, r: number, c: string): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${c}"/>`;

// ── Hair (front) ─────────────────────────────────────────────────
function drawHair(out: string[], variant: number, col: string): void {
  const dk = darken(col, 0.78);
  switch (variant) {
    case 0: // soft side-swept
      out.push(pathf("M6 15 C6 6 26 6 26 15 C26 11 22 7 16 7 C11 7 8 10 6 15 Z", col));
      out.push(pathf("M16 7 C13 9 12 12 12 16 C10 13 10 9 13 7 Z", dk));
      break;
    case 1: // rounded bob
      out.push(pathf("M5 17 C5 6 27 6 27 17 C27 12 24 8 16 8 C8 8 5 12 5 17 Z", col));
      out.push(pathf("M5 17 C5 21 6 24 7 25 C6 20 6 17 6 15 Z", dk));
      out.push(pathf("M27 17 C27 21 26 24 25 25 C26 20 26 17 26 15 Z", dk));
      break;
    case 2: // spiky
      out.push(pathf("M6 16 L9 7 L12 13 L16 6 L20 13 L23 7 L26 16 C24 11 20 8 16 8 C12 8 8 11 6 16 Z", col));
      break;
    case 3: // twin tails
      out.push(pathf("M6 15 C6 7 26 7 26 15 C26 11 22 8 16 8 C10 8 6 11 6 15 Z", col));
      out.push(ell(6, 19, 3, 5, col));
      out.push(ell(26, 19, 3, 5, col));
      break;
    case 4: // long straight
      out.push(pathf("M5 16 C5 6 27 6 27 16 L27 25 L24 25 L24 14 C24 11 21 8 16 8 C11 8 8 11 8 14 L8 25 L5 25 Z", col));
      break;
    case 5: // curly poof
      out.push(ell(16, 10, 11, 7, col));
      out.push(ell(8, 13, 4, 4, col));
      out.push(ell(24, 13, 4, 4, col));
      out.push(pathf("M16 10 C12 11 10 14 10 17 C9 13 11 10 16 9 Z", dk));
      break;
    case 6: // undercut / short
      out.push(pathf("M7 14 C8 8 24 8 25 14 C24 10 20 8 16 8 C12 8 8 10 7 14 Z", col));
      out.push(pathf("M16 8 C14 9 13 11 13 14 C12 11 13 9 16 8 Z", dk));
      break;
    default: // 7: bun
      out.push(pathf("M6 15 C6 7 26 7 26 15 C26 11 22 8 16 8 C10 8 6 11 6 15 Z", col));
      out.push(ell(16, 5, 4, 3.5, col));
      out.push(ell(16, 5, 4, 3.5, dk, 'opacity="0.35"'));
  }
}

// ── Eyes ─────────────────────────────────────────────────────────
function drawEyes(out: string[], variant: number, iris: string): void {
  const ink = "#3a2f3f";
  const L = 12, R = 20, y = 17;
  if (variant === 3) {
    // happy closed ^ ^
    out.push(pathf(`M${L - 2} ${y + 1} Q${L} ${y - 2} ${L + 2} ${y + 1}`, "none",
      `stroke="${ink}" stroke-width="1.4" stroke-linecap="round"`));
    out.push(pathf(`M${R - 2} ${y + 1} Q${R} ${y - 2} ${R + 2} ${y + 1}`, "none",
      `stroke="${ink}" stroke-width="1.4" stroke-linecap="round"`));
    return;
  }
  const ry = variant === 2 ? 2.0 : 3.1; // 2 = sleepy/narrow
  for (const cx of [L, R]) {
    out.push(ell(cx, y, 2.3, ry, "#ffffff"));
    out.push(ell(cx, y + 0.3, 1.7, Math.min(ry, 2.3), iris));
    out.push(ell(cx, y + 0.5, 0.9, Math.min(ry - 0.6, 1.4), ink));
    out.push(ell(cx - 0.7, y - 0.8, 0.6, 0.7, "#ffffff")); // sparkle
    if (variant === 1) // upper lid line
      out.push(pathf(`M${cx - 2.4} ${y - 2} Q${cx} ${y - 3.2} ${cx + 2.4} ${y - 2}`,
        "none", `stroke="${ink}" stroke-width="0.9" stroke-linecap="round"`));
  }
}

// ── Mouth ────────────────────────────────────────────────────────
function drawMouth(out: string[], variant: number): void {
  const ink = "#7a4a52";
  switch (variant) {
    case 0: // small smile
      out.push(pathf("M14.5 23 Q16 24.6 17.5 23", "none",
        `stroke="${ink}" stroke-width="1.2" stroke-linecap="round"`));
      break;
    case 1: // tiny dot
      out.push(ell(16, 23.2, 0.8, 0.8, ink));
      break;
    case 2: // cat mouth ω
      out.push(pathf("M14 22.6 Q15 24 16 22.8 Q17 24 18 22.6", "none",
        `stroke="${ink}" stroke-width="1.1" stroke-linecap="round"`));
      break;
    default: // open :D
      out.push(pathf("M14.4 22.6 Q16 25.4 17.6 22.6 Z", ink));
  }
}

// ── Accessory ────────────────────────────────────────────────────
function drawAccessory(out: string[], kind: Accessory): void {
  switch (kind) {
    case "headset":
      out.push(pathf("M6 16 C6 7 26 7 26 16", "none",
        'stroke="#4a4458" stroke-width="1.6" stroke-linecap="round"'));
      out.push(rrect(4.5, 15, 3, 5, 1.4, "#4a4458"));
      out.push(rrect(24.5, 15, 3, 5, 1.4, "#4a4458"));
      out.push(pathf("M6 19 C6 23 9 25 11 25", "none",
        'stroke="#4a4458" stroke-width="1.2" stroke-linecap="round"'));
      out.push(ell(11.5, 25, 1, 1, "#ff8fb3"));
      break;
    case "glasses":
      out.push(rrect(8.5, 14.5, 6, 5, 2.5, "rgba(255,255,255,0.25)"));
      out.push(rrect(17.5, 14.5, 6, 5, 2.5, "rgba(255,255,255,0.25)"));
      out.push(pathf("M8.5 17 h-2 M14.5 16.5 h3 M23.5 17 h2", "none",
        'stroke="#4a4458" stroke-width="1" stroke-linecap="round"'));
      out.push(pathf("M8.5 14.5 a2.5 2.5 0 0 0 0 5 h6 a2.5 2.5 0 0 0 0 -5 Z M17.5 14.5 a2.5 2.5 0 0 0 0 5 h6 a2.5 2.5 0 0 0 0 -5 Z",
        "none", 'stroke="#4a4458" stroke-width="1.1"'));
      break;
    case "shades":
      out.push(rrect(8.5, 14.5, 6, 4.5, 2, "#3a3340"));
      out.push(rrect(17.5, 14.5, 6, 4.5, 2, "#3a3340"));
      out.push(pathf("M14.5 16 h3", "none", 'stroke="#3a3340" stroke-width="1.4"'));
      out.push(ell(10.5, 16, 0.8, 0.8, "rgba(255,255,255,0.55)"));
      out.push(ell(19.5, 16, 0.8, 0.8, "rgba(255,255,255,0.55)"));
      break;
    case "visor":
      out.push(rrect(6, 14, 20, 4.5, 2.2, "rgba(110,197,232,0.55)"));
      out.push(pathf("M7 16.2 h18", "none", 'stroke="#bff0ff" stroke-width="0.8" stroke-linecap="round"'));
      break;
    case "hardhat":
      out.push(pathf("M5 14 C5 7 27 7 27 14 Z", "#f4c43a"));
      out.push(rrect(4, 13.5, 24, 2, 1, "#f4c43a"));
      out.push(rrect(15, 6, 2, 8, 1, "#dba81f"));
      break;
    case "cap":
      out.push(pathf("M6 13 C7 7 25 7 26 13 Z", "#5a8fd8"));
      out.push(pathf("M26 13 C30 13 31 15 31 16 L25 15 Z", "#5a8fd8"));
      out.push(ell(16, 9, 1.1, 1.1, "#ffffff"));
      break;
    case "beanie":
      out.push(pathf("M5 14 C5 6 27 6 27 14 Z", "#9a7ad8"));
      out.push(rrect(4.5, 12.5, 23, 3, 1.5, "#7a5ac8"));
      out.push(ell(16, 5, 1.6, 1.6, "#9a7ad8"));
      break;
    case "beret":
      out.push(ell(15, 9, 9, 4.5, "#3a3340"));
      out.push(ell(22, 6.5, 1.2, 1.2, "#3a3340"));
      break;
    case "antenna":
      out.push(pathf("M16 7 V3", "none", 'stroke="#5a5a6a" stroke-width="1.1" stroke-linecap="round"'));
      out.push(ell(16, 2.4, 1.3, 1.3, "#ff8fb3"));
      out.push(ell(16, 2.4, 1.3, 1.3, "none", 'stroke="#ff8fb3" stroke-width="0.6" opacity="0.5"'));
      break;
    case "tie":
      out.push(pathf("M16 26 l-1.6 2 1.6 4 1.6 -4 Z", "#ff7aa6"));
      out.push(pathf("M16 25.5 l-1.3 1.2 1.3 1 1.3 -1 Z", "#e85a86"));
      break;
    case "none":
      break;
  }
}

// ── Collar / shoulders ───────────────────────────────────────────
function drawCollar(out: string[], kind: Collar, color: string): void {
  const dk = darken(color, 0.78);
  // Soft shoulder shape.
  out.push(pathf("M3 32 C3 26 9 23 16 23 C23 23 29 26 29 32 Z", color));
  out.push(pathf("M3 32 C3 28 5 25 8 24 C5 26 4 29 4 32 Z", dk));
  switch (kind) {
    case "hoodie":
      out.push(pathf("M11 24 C13 27 19 27 21 24 C20 29 12 29 11 24 Z", dk));
      out.push(rrect(15.4, 25, 1.2, 6, 0.6, "#ffffff"));
      break;
    case "jacket":
      out.push(pathf("M16 24 L12 32 M16 24 L20 32", "none", `stroke="${dk}" stroke-width="1.3"`));
      break;
    case "tech":
      out.push(pathf("M16 24 V32", "none", 'stroke="#6ec5e8" stroke-width="1.2"'));
      out.push(ell(16, 28, 0.9, 0.9, "#6ec5e8"));
      break;
    case "sweater":
      out.push(pathf("M8 30 Q16 27 24 30", "none", `stroke="${dk}" stroke-width="1" stroke-dasharray="1.5 1.5"`));
      break;
    case "turtle":
      out.push(pathf("M11 24 C13 21 19 21 21 24 L21 26 C19 23.5 13 23.5 11 26 Z", color));
      break;
    case "overalls":
      out.push(pathf("M12 24 V32 M20 24 V32", "none", `stroke="${dk}" stroke-width="1.2"`));
      out.push(ell(12, 27, 0.8, 0.8, "#f4c43a"));
      out.push(ell(20, 27, 0.8, 0.8, "#f4c43a"));
      break;
    case "workshirt":
      out.push(pathf("M9 27 l3 0 0 4", "none", `stroke="${dk}" stroke-width="1"`));
      break;
    case "suit":
      out.push(pathf("M16 24 L11 32 L13 32 L16 26 Z", dk));
      out.push(pathf("M16 24 L21 32 L19 32 L16 26 Z", dk));
      out.push(pathf("M14 24 h4 v3 h-4 Z", "#ffffff"));
      break;
    case "shirt":
      out.push(pathf("M13 24 L16 27 L19 24", "none", `stroke="#ffffff" stroke-width="1.4"`));
      break;
    case "polo":
      out.push(pathf("M14 24 L16 27 L18 24", "none", `stroke="${dk}" stroke-width="1.2"`));
      out.push(ell(16, 30, 0.6, 0.6, dk));
      break;
  }
}

// ── Compose inner SVG (0–32 space, no <svg> wrapper) ──────────────
export function renderAvatarSvgInner(agentId: string, role?: string): string {
  const s = deriveAvatarSpec(agentId, role);
  const o: string[] = [];

  // Background — soft pastel disc with a lighter top sheen.
  o.push(`<rect x="0" y="0" width="32" height="32" fill="${s.bg}"/>`);
  o.push(ell(16, 9, 20, 13, "rgba(255,255,255,0.35)"));

  // Back hair (so it sits behind the head for long styles).
  if (s.hairVariant === 4 || s.hairVariant === 1 || s.hairVariant === 3) {
    o.push(ell(16, 17, 10, 11, darken(s.hairColor, 0.82)));
  }

  // Shoulders / collar.
  drawCollar(o, s.kit.collar, s.shirt);

  // Neck.
  o.push(rrect(13.5, 21, 5, 4, 1.6, s.skin[1]));

  // Head — soft rounded shape.
  o.push(pathf(
    "M16 7 C22 7 25 11 25 16 C25 21 21 25 16 25 C11 25 7 21 7 16 C7 11 10 7 16 7 Z",
    s.skin[0]));
  // Soft jaw shade.
  o.push(pathf("M9 18 C10 22 13 25 16 25 C19 25 22 22 23 18 C22 21 19 23 16 23 C13 23 10 21 9 18 Z",
    s.skin[1], 'opacity="0.5"'));
  // Ears.
  o.push(ell(7.3, 17, 1.5, 2.2, s.skin[0]));
  o.push(ell(24.7, 17, 1.5, 2.2, s.skin[0]));

  // Blush — the kawaii signature.
  o.push(ell(11, 20, 2, 1.2, "rgba(255,140,170,0.42)"));
  o.push(ell(21, 20, 2, 1.2, "rgba(255,140,170,0.42)"));

  drawEyes(o, s.eyeVariant, s.iris);
  drawMouth(o, s.mouthVariant);
  drawHair(o, s.hairVariant, s.hairColor);
  drawAccessory(o, s.kit.accessory);

  return o.join("");
}

// ── Public API ───────────────────────────────────────────────────
export interface AvatarRenderOptions {
  size?: number;       // display size, default 32
  rounded?: boolean;   // clip to a circle, default false
  ringColor?: string;  // optional outline ring
}

export function renderAvatarSvg(
  agentId: string,
  role?: string,
  opts: AvatarRenderOptions = {}
): string {
  const size = opts.size ?? 32;
  const inner = renderAvatarSvgInner(agentId, role);

  const ringAttr = opts.ringColor
    ? ` style="filter:drop-shadow(0 0 0 ${opts.ringColor})"`
    : "";

  const clip = opts.rounded
    ? `<defs><clipPath id="r"><rect x="0" y="0" width="32" height="32" rx="16" ry="16"/></clipPath></defs><g clip-path="url(#r)">`
    : "";
  const clipEnd = opts.rounded ? "</g>" : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 32 32" width="${size}" height="${size}"${ringAttr}>` +
    clip + inner + clipEnd +
    `</svg>`
  );
}
