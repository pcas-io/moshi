// V2 primitives — Hono JSX components for the SENTINEL Dark dashboard.
// Pair with src/views/v2/tokens.ts (CSS) and src/views/v2/avatar.ts (SVG generator).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_TOKENS, greenGlow } from "./tokens.js";
import { renderAvatarSvg, type AvatarRenderOptions } from "./avatar.js";

// ── Presence ────────────────────────────────────────────────────
export type Presence = "live" | "stale" | "offline" | "never";

export const PRESENCE_COLOR: Record<Presence, string> = {
  live: V2_TOKENS.accent,
  stale: V2_TOKENS.warn,
  offline: "#4a4a4a",
  never: "#4a4a4a",
};

export const V2Dot: FC<{ presence: Presence; size?: number }> = ({ presence, size = 6 }) => {
  const c = PRESENCE_COLOR[presence];
  const glow = presence === "live" ? `box-shadow: 0 0 8px ${greenGlow(0.6)};` : "";
  return (
    <span
      class="v2-dot"
      style={`width:${size}px;height:${size}px;background:${c};${glow}`}
    />
  );
};

// ── Avatar ──────────────────────────────────────────────────────
// The deterministic anime portrait, framed dark: 4px radius + #333 hairline.
export const V2Avatar: FC<{
  agentId: string;
  role?: string;
  size?: number;
  rounded?: boolean;
  ringColor?: string;
  bordered?: boolean;
}> = ({ agentId, role, size = 24, rounded, ringColor, bordered }) => {
  const opts: AvatarRenderOptions = { size, rounded, ringColor };
  const border = bordered ? `border:1px solid ${V2_TOKENS.line2};` : "";
  return (
    <span
      class="v2-avatar"
      style={`display:inline-flex;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;border-radius:4px;overflow:hidden;${border}`}
    >
      {raw(renderAvatarSvg(agentId, role, opts))}
    </span>
  );
};

// ── Card ────────────────────────────────────────────────────────
export const V2Card: FC<{
  title?: string;
  sub?: string;
  right?: any;
  children?: any;
}> = ({ title, sub, right, children }) => {
  return (
    <div class="v2-card">
      {(title || right) && (
        <div class="v2-card-head">
          <div style="flex:1">
            {title && <div class="v2-card-title">{title}</div>}
            {sub && <div class="v2-card-sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      <div>{children}</div>
    </div>
  );
};

// ── Button ──────────────────────────────────────────────────────
export type V2BtnKind =
  | "primary"
  | "secondary"
  | "tertiary"
  | "ghost"
  | "danger"
  | "danger-outline";

export const V2Btn: FC<{
  kind?: V2BtnKind;
  type?: "button" | "submit";
  href?: string;
  onclick?: string;
  children?: any;
}> = ({ kind = "tertiary", type = "button", href, onclick, children }) => {
  const cls = `v2-btn${kind !== "tertiary" ? ` v2-btn--${kind}` : ""}`;
  if (href) return <a class={cls} href={href}>{children}</a>;
  return <button class={cls} type={type} onclick={onclick}>{children}</button>;
};

// ── Outlined mono tag (message types, routing, entities) ────────
export const V2Tag: FC<{ color?: string; children?: any }> = ({ color, children }) => {
  const c = color ?? V2_TOKENS.textDim;
  return (
    <span class="v2-tag" style={`color:${c}`}>
      {children}
    </span>
  );
};

// ── Sparkline (sharp, no curves) ────────────────────────────────
export const V2Spark: FC<{
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fillAlpha?: number;
}> = ({ data, w = 70, h = 18, stroke = V2_TOKENS.accent, fillAlpha = 0 }) => {
  if (data.length === 0) return <svg width={w} height={h} />;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - (v / max) * (h - 1) - 0.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style="display:block">
      {fillAlpha > 0 && (
        <polygon points={`0,${h} ${pts} ${w},${h}`} fill={stroke} opacity={String(fillAlpha)} />
      )}
      <polyline points={pts} fill="none" stroke={stroke} stroke-width="1.25" stroke-linejoin="miter" />
    </svg>
  );
};

// ── Heatmap row (24h activity) ──────────────────────────────────
export const V2Heat: FC<{
  data: number[];
  cell?: number;
  gap?: number;
  max?: number;
}> = ({ data, cell = 10, gap = 2, max }) => {
  const m = max ?? Math.max(1, ...data);
  return (
    <div style={`display:flex;gap:${gap}px`}>
      {data.map((v) => {
        const bg = v === 0
          ? "rgba(255,255,255,0.05)"
          : greenGlow(0.18 + (v / m) * 0.82);
        return (
          <span style={`width:${cell}px;height:${cell}px;border-radius:1px;background:${bg}`} />
        );
      })}
    </div>
  );
};

// ── Shared color maps ───────────────────────────────────────────
// Message-type marker colors, used by Home / Conversations / Messages.
const TYPE_COLORS: Record<string, string> = {
  incident: V2_TOKENS.danger,
  alert: V2_TOKENS.danger,
  incident_response: V2_TOKENS.danger,
  incident_acknowledged: V2_TOKENS.warn,
  deploy_status: V2_TOKENS.info,
  deploy_request: V2_TOKENS.info,
  question: V2_TOKENS.info,
  answer: V2_TOKENS.accent,
  review_result: V2_TOKENS.accent,
  review_request: V2_TOKENS.warn,
  script: V2_TOKENS.script,
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? V2_TOKENS.textDim;
}

// Activity entity marker colors (message/session/agent).
export const ENTITY_COLOR: Record<string, string> = {
  message: V2_TOKENS.accent,
  session: V2_TOKENS.info,
  agent: V2_TOKENS.warn,
};

export function entityColor(entity: string): string {
  return ENTITY_COLOR[entity] ?? V2_TOKENS.textMute;
}

// ── Helpers ─────────────────────────────────────────────────────
export function withAlpha(input: string, a: number): string {
  // Accept #rrggbb, #rgb, or already-rgba — pass-through for rgba/oklch/etc.
  if (input.startsWith("#")) {
    const h = input.slice(1);
    const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(f.slice(0, 2), 16);
    const g = parseInt(f.slice(2, 4), 16);
    const b = parseInt(f.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  if (input.startsWith("rgba(")) {
    return input.replace(/,[^,]+\)$/, `,${a})`);
  }
  if (input.startsWith("rgb(")) {
    return input.replace("rgb(", "rgba(").replace(")", `,${a})`);
  }
  return input;
}
