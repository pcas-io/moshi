// V2 primitives — Hono JSX components for the "Daylight" dashboard.
// Pair with src/views/v2/tokens.ts (colours, CSS) and src/views/v2/avatar.ts
// (the deterministic emblem generator).
//
// Pages style themselves with inline `style="…"` attributes. The only CSS
// that lives here is what an inline style cannot express: hover, focus
// rings and row highlights. It is injected once by layout.tsx.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_TOKENS } from "./tokens.js";
import { renderAvatarSvg } from "./avatar.js";

const T = V2_TOKENS;

// ── Presence ────────────────────────────────────────────────────
export type Presence = "live" | "stale" | "offline" | "never";

export const PRESENCE_COLOR: Record<Presence, string> = {
  live: T.presenceLive,
  stale: T.presenceStale,
  offline: T.presenceOffline,
  never: T.presenceOffline,
};

/** The single word shown under an agent's name. Plain language, not state names. */
export const PRESENCE_WORD: Record<Presence, string> = {
  live: "online",
  stale: "quiet",
  offline: "asleep",
  never: "never seen",
};

/** The dot. No glow: on white a shadow only blurs the edge. */
export const V2Dot: FC<{ presence: Presence; size?: number; pulse?: boolean }> = ({
  presence, size = 7, pulse,
}) => (
  <span
    class={pulse && presence === "live" ? "m-pulse" : undefined}
    style={`display:inline-block;flex-shrink:0;width:${size}px;height:${size}px;border-radius:999px;background:${PRESENCE_COLOR[presence]}`}
  />
);

// ── Avatar ──────────────────────────────────────────────────────
/** Corner radius scales with the emblem, per README §Shape. */
export function avatarRadius(size: number): number {
  if (size <= 26) return T.radiusAvatar; // 8
  if (size <= 34) return 10;
  if (size <= 40) return 11;
  if (size <= 46) return 13;
  return 15;
}

/**
 * The emblem. Keyed on the agent NAME, not its id — the monogram is
 * derived from the name, so no id plumbing is needed anywhere.
 */
export const V2Avatar: FC<{
  name: string;
  role?: string | null;
  size?: number;
  bordered?: boolean;
}> = ({ name, role, size = 24, bordered }) => {
  const border = bordered ? `border:1px solid ${T.line};` : "";
  return (
    // The monogram is decoration: the agent's name is always next to it in the
    // markup, so announcing "D E" before it would just be noise.
    <span
      aria-hidden="true"
      style={`display:inline-flex;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;border-radius:${avatarRadius(size)}px;overflow:hidden;${border}`}
    >
      {raw(renderAvatarSvg(name, role ?? undefined, { size }))}
    </span>
  );
};

// ── Card ────────────────────────────────────────────────────────
export const CARD_SHADOW = "0 1px 2px rgba(36,33,29,.04)";
export const RAISED_SHADOW =
  "0 1px 2px rgba(36,33,29,.04), 0 16px 40px -28px rgba(36,33,29,.3)";

export const CARD_STYLE =
  `background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusCard}px;box-shadow:${CARD_SHADOW}`;

export const V2Card: FC<{
  title?: string;
  sub?: any;
  right?: any;
  /** Footer row, rendered on `sunk` under a hairline. */
  foot?: any;
  bodyStyle?: string;
  style?: string;
  children?: any;
}> = ({ title, sub, right, foot, bodyStyle, style, children }) => (
  <div style={`${CARD_STYLE};display:flex;flex-direction:column;overflow:hidden;${style ?? ""}`}>
    {(title || right) && (
      <div
        style={`display:flex;align-items:flex-start;gap:14px;padding:18px 20px 14px;border-bottom:1px solid ${T.lineSoft}`}
      >
        <div style="flex:1;min-width:0">
          {title && <div style={`font-size:16px;font-weight:600;color:${T.ink}`}>{title}</div>}
          {sub && <div style={`margin-top:3px;font-size:13px;color:${T.dim}`}>{sub}</div>}
        </div>
        {right}
      </div>
    )}
    <div style={bodyStyle ?? ""}>{children}</div>
    {foot && (
      <div
        style={`margin-top:auto;display:flex;align-items:center;gap:10px;padding:12px 20px;background:${T.sunk};border-top:1px solid ${T.lineSoft};font-size:13px;color:${T.dim}`}
      >
        {foot}
      </div>
    )}
  </div>
);

// ── Button ──────────────────────────────────────────────────────
export type V2BtnKind =
  | "primary"    // solid green, white label
  | "secondary"  // white fill, lineStrong border
  | "ghost"      // transparent until hover
  | "white"      // white fill on a coloured band
  | "danger"     // red-outlined, destructive
  | "muted";     // the gated look: line fill, dim label

const BTN_BASE =
  "display:inline-flex;align-items:center;justify-content:center;gap:8px;" +
  `border-radius:${T.radiusControl}px;font-family:inherit;font-size:14px;font-weight:600;` +
  "line-height:1;padding:11px 18px;cursor:pointer;text-decoration:none;white-space:nowrap";

const BTN_KIND: Record<V2BtnKind, string> = {
  primary:   `background:${T.green};color:#ffffff;border:1px solid ${T.green}`,
  secondary: `background:${T.card};color:${T.ink};border:1px solid ${T.lineStrong}`,
  ghost:     `background:transparent;color:${T.body};border:1px solid transparent`,
  white:     `background:${T.card};color:${T.ink};border:1px solid ${T.amberLine}`,
  danger:    `background:${T.card};color:${T.red};border:1px solid ${T.redLine}`,
  muted:     `background:${T.line};color:${T.dim};border:1px solid ${T.line};cursor:default`,
};

/** Solid fills darken on hover; ghost buttons grow a fill. Nothing moves. */
const BTN_HOVER_CLASS: Record<V2BtnKind, string> = {
  primary: "d-solid", secondary: "d-solid", white: "d-solid",
  danger: "d-solid", ghost: "d-ghost", muted: "",
};

export const V2Btn: FC<{
  kind?: V2BtnKind;
  type?: "button" | "submit";
  href?: string;
  onclick?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  title?: string;
  id?: string;
  style?: string;
  children?: any;
}> = ({ kind = "secondary", type = "button", href, onclick, name, value, disabled, title, id, style, children }) => {
  const css = `${BTN_BASE};${BTN_KIND[kind]};${style ?? ""}`;
  const cls = BTN_HOVER_CLASS[kind] || undefined;
  if (href) {
    return <a id={id} class={cls} href={href} title={title} style={css}>{children}</a>;
  }
  return (
    <button
      id={id} class={cls} type={type} onclick={onclick} name={name} value={value}
      disabled={disabled} title={title} style={css}
    >
      {children}
    </button>
  );
};

// ── Filled kind pill (message types, audit entities) ────────────
export const V2Pill: FC<{ ink: string; ground: string; mono?: boolean; children?: any }> = ({
  ink, ground, mono, children,
}) => (
  <span
    style={`display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:${T.radiusPill}px;` +
      `background:${ground};color:${ink};font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;` +
      (mono ? "font-family:var(--font-mono);font-weight:500" : "")}
  >
    {children}
  </span>
);

// ── Message-kind display labels (COPY.md §7) ────────────────────
// The raw `type` stays on the wire; only what a reader sees changes.
const KIND_LABELS: Record<string, string> = {
  task_update: "progress",
  deploy_request: "deploy ask",
  deploy_status: "deploy done",
  review_request: "review ask",
  review_result: "review done",
};

export function kindLabel(type: string): string {
  // Own entries only — `type` is agent-controlled, see `kindColors`.
  return Object.hasOwn(KIND_LABELS, type) ? KIND_LABELS[type]! : type;
}

// ── Interaction CSS ─────────────────────────────────────────────
// Injected once by layout.tsx. Everything here is a state an inline
// style cannot reach: hover, focus-visible, and the row highlights.
export const V2_INTERACTION_CSS = `
.d-solid:hover { filter: brightness(0.94); }

/* !important is load-bearing, not laziness. Pages style themselves with
   inline style attributes, and an inline declaration outranks any selector —
   so a plain \`.d-row:hover{background:…}\` silently does nothing on the rows,
   tabs and ghost buttons that set their own background inline, which is all
   of them. \`filter\` needs no escape hatch because nobody sets it inline. */
.d-ghost:hover { background: ${T.subtle} !important; }
.d-row:hover { background: ${T.sunk} !important; }
.d-tab:hover { color: ${T.ink} !important; }

/* The current design has no visible focus style at all. This is it. */
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid ${T.green};
  outline-offset: 2px;
  border-radius: 4px;
}
.d-input:focus {
  outline: none;
  border-color: ${T.greenLine};
  box-shadow: 0 0 0 3px rgba(14,138,62,.12);
}
`;

// ── Shared input style ──────────────────────────────────────────
export const INPUT_STYLE =
  `width:100%;background:${T.paper};border:1px solid ${T.lineStrong};border-radius:${T.radiusControl}px;` +
  `padding:11px 14px;font-family:var(--font-sans);font-size:14px;color:${T.ink}`;

export const MONO_INPUT_STYLE =
  `width:100%;background:${T.paper};border:1px solid ${T.lineStrong};border-radius:${T.radiusControl}px;` +
  `padding:13px 15px;font-family:var(--font-mono);font-size:14px;color:${T.ink}`;
