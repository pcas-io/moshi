// V2 primitives — Hono JSX components for the Soft Pastel dashboard.
// Pair with src/views/v2/tokens.ts (CSS) and src/views/v2/avatar.ts (SVG generator).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_TOKENS, V2_BTN } from "./tokens.js";
import { renderAvatarSvg, type AvatarRenderOptions } from "./avatar.js";

// Specular-sheen overlay used on every glossy surface (cards, KPI tiles,
// palette modal, top-bar). Renders as an absolutely-positioned div with
// `mix-blend-mode: screen` so it brightens the underlying gradient.
export const V2Sheen: FC<{ radius?: number }> = ({ radius }) => (
  <div
    class="v2-sheen"
    style={radius != null ? `border-radius:${radius}px` : ""}
  />
);

// ── Presence ────────────────────────────────────────────────────
export type Presence = "live" | "stale" | "offline" | "never";

const PRESENCE_COLOR: Record<Presence, string> = {
  live: V2_TOKENS.accent2,
  stale: V2_TOKENS.warn,
  offline: V2_TOKENS.textMute,
  never: V2_TOKENS.textMute,
};

export const V2Dot: FC<{ presence: Presence; size?: number }> = ({ presence, size = 7 }) => {
  const c = PRESENCE_COLOR[presence];
  const ring = presence === "live"
    ? `box-shadow: 0 0 0 3px ${withAlpha(c, 0.18)};`
    : "";
  return (
    <span
      class="v2-dot"
      style={`width:${size}px;height:${size}px;background:${c};${ring}`}
    />
  );
};

// ── Avatar ──────────────────────────────────────────────────────
export const V2Avatar: FC<{
  agentId: string;
  role?: string;
  size?: number;
  rounded?: boolean;
  ringColor?: string;
}> = ({ agentId, role, size = 24, rounded, ringColor }) => {
  const opts: AvatarRenderOptions = { size, rounded, ringColor };
  return (
    <span
      class="v2-avatar"
      style={`display:inline-block;width:${size}px;height:${size}px;flex-shrink:0;vertical-align:middle;`}
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
  liftSm?: boolean;
  children?: any;
}> = ({ title, sub, right, liftSm, children }) => {
  return (
    <div class={liftSm ? "v2-card lift-sm" : "v2-card"}>
      <V2Sheen />
      {(title || right) && (
        <div class="v2-card-head">
          <div style="flex:1">
            {title && <div class="v2-card-title">{title}</div>}
            {sub && <div class="v2-card-sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      <div class="v2-card-body">{children}</div>
    </div>
  );
};

// ── Button ──────────────────────────────────────────────────────
export type V2BtnKind = "primary" | "secondary" | "ghost" | "danger-outline";

export const V2Btn: FC<{
  kind?: V2BtnKind;
  type?: "button" | "submit";
  href?: string;
  onclick?: string;
  children?: any;
}> = ({ kind = "secondary", type = "button", href, onclick, children }) => {
  const cls = `v2-btn${kind === "primary" ? " v2-btn--primary"
    : kind === "ghost" ? " v2-btn--ghost"
    : kind === "danger-outline" ? " v2-btn--danger-outline"
    : ""}`;
  if (href) return <a class={cls} href={href}>{children}</a>;
  return <button class={cls} type={type} onclick={onclick}>{children}</button>;
};

// ── Tag (token-tinted glossy pill) ──────────────────────────────
// Two-stop gradient + double inset shadow gives the wet-glass look.
export const V2Tag: FC<{ color?: string; children?: any }> = ({ color, children }) => {
  const c = color ?? V2_TOKENS.textDim;
  const bg = `linear-gradient(180deg, ${withAlpha(c, 0.16)}, ${withAlpha(c, 0.10)})`;
  const border = withAlpha(c, 0.32);
  const shadow = `inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 ${withAlpha(c, 0.08)}`;
  return (
    <span
      class="v2-tag"
      style={`color:${c};background:${bg};border-color:${border};box-shadow:${shadow}`}
    >
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
}> = ({ data, w = 80, h = 18, stroke = V2_TOKENS.accent, fillAlpha = 0 }) => {
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

// ── Heatmap row (24h activity, etc.) ────────────────────────────
export const V2Heat: FC<{
  data: number[];
  cell?: number;
  gap?: number;
  color?: string;
  max?: number;
}> = ({ data, cell = 8, gap = 1, color = V2_TOKENS.accent, max }) => {
  const m = max ?? Math.max(1, ...data);
  return (
    <div style={`display:flex;gap:${gap}px`}>
      {data.map((v) => {
        const a = v === 0 ? 0.07 : 0.22 + (v / m) * 0.78;
        return (
          <div
            style={`width:${cell}px;height:${cell}px;background:${withAlpha(color, a)};`}
          />
        );
      })}
    </div>
  );
};

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
