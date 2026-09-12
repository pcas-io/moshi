// Shared furniture for the connect flow: the button styles every step
// repeats, the two copy-button variants, and the one place that knows how
// a step URL is spelled.
//
// Split out of connect.tsx so that file and connect-verify.tsx both stay
// inside the 700-line budget without either importing the other.

import type { FC } from "hono/jsx";
import { V2_TOKENS } from "./tokens.js";
import type { ConnectClientKey } from "./connect-clients.js";

export const T = V2_TOKENS;
export const MONO = "var(--font-mono)";
/** White used as ink on a green fill — T.card's value, but not its role. */
export const ON_GREEN = "#ffffff";

export type ConnectStep = 1 | 2 | 3 | 4;

// ── Button and surface styles (spec §2/§3) ──────────────────────
export const GHOST_BTN =
  `display:inline-flex;align-items:center;background:transparent;border:none;color:${T.dim};` +
  `font-size:15px;padding:12px 14px;border-radius:${T.radiusControl}px;cursor:pointer`;
export const PRIMARY_BTN =
  `display:inline-flex;align-items:center;background:${T.green};border:none;color:${ON_GREEN};` +
  `font-size:15px;font-weight:600;padding:12px 22px;border-radius:${T.radiusControl}px;cursor:pointer`;
export const COPY_LIGHT =
  `flex:0 0 auto;background:${T.green};border:none;border-radius:${T.radiusControl}px;color:${ON_GREEN};` +
  "font-size:14px;font-weight:600;cursor:pointer;padding:13px 20px";
export const COPY_DARK =
  `position:absolute;top:12px;right:12px;background:${T.codeBtn};border:none;` +
  `border-radius:${T.radiusAvatar}px;color:${ON_GREEN};font-size:12px;font-weight:600;` +
  "cursor:pointer;padding:6px 11px";
export const CARD =
  `background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusCard}px`;
export const ACTION_ROW = "display:flex;gap:10px;margin-top:22px;justify-content:flex-end";

export const GhostLink: FC<{ href: string; children?: unknown }> = ({ href, children }) => (
  <a class="d-ghost" href={href} style={GHOST_BTN}>{children}</a>
);

export const PrimaryLink: FC<{ href: string; children?: unknown }> = ({ href, children }) => (
  <a class="d-solid" href={href} style={PRIMARY_BTN}>{children}</a>
);

/** Inline monospace run inside a sentence — family only, no ground. */
export const M: FC<{ size?: number; ground?: boolean; children?: unknown }> = ({
  size, ground, children,
}) => (
  <span
    style={`font-family:${MONO}` +
      (size ? `;font-size:${size}px` : "") +
      (ground ? `;background:${T.subtle};padding:1px 6px;border-radius:5px` : "")}
  >
    {children}
  </span>
);

/** Step and client are the only page state, and both live in the URL. */
export function stepHref(
  step: ConnectStep,
  s: string | undefined,
  client: ConnectClientKey,
): string {
  const q = [`step=${step}`];
  if (s) q.push(`s=${encodeURIComponent(s)}`);
  q.push(`client=${client}`);
  return `/agents/connect?${q.join("&")}`;
}

// ── Copy buttons ────────────────────────────────────────────────
// One shared handler (copy-script.ts) picks these up by class and copies
// the sibling <pre>/<code>. `gate` unlocks step 2's forward button.
export const CopyBtn: FC<{ label: string; style: string; gate?: string }> = ({
  label, style, gate,
}) => (
  <button
    type="button"
    class="d-copy d-solid"
    data-label={label}
    data-copy-gate={gate}
    style={style}
  >
    {label}
  </button>
);

export const CommandBlock: FC<{ code: string }> = ({ code }) => (
  <div style={`position:relative;background:${T.codeBg};border-radius:${T.radiusCode}px;padding:16px 18px`}>
    <CopyBtn label="Copy" style={COPY_DARK} />
    <pre
      style={`font-family:${MONO};font-size:13px;line-height:1.75;color:${T.codeInk};` +
        "overflow-x:auto;padding-right:80px"}
    >{code}</pre>
  </div>
);

/** JSON that is safe to drop inside a <script>: only `<` can end it early. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
