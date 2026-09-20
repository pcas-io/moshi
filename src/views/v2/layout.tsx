// V2 page layout — the "Daylight" app shell: brand lockup, four nav items,
// the ⌘K palette, the Connect-an-agent call to action, and the footer.
// Used by every dashboard page (Home, Agents, Conversations, Log, Connect).
//
// There is no hero variant. Home uses the same ruled header as every other
// page; the dark hero surface and its grid overlay are gone.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_CSS, V2_TOKENS } from "./tokens.js";
import { V2_INTERACTION_CSS } from "./components.js";
import { COPY_SCRIPT } from "./copy-script.js";
import { LIVE_REFRESH_CSS, LIVE_REFRESH_SCRIPT } from "./live-refresh.js";
import { MCP_TOOL_CATALOG } from "../../mcp/catalog.js";

const T = V2_TOKENS;

export type V2NavKey = "HOME" | "AGENTS" | "CONVOS" | "LOG";

interface V2LayoutProps {
  title?: string;
  active?: V2NavKey;
  userRole?: string;
  /** Name shown in the operator badge; first letter is the monogram. */
  userName?: string;
  csrfToken?: string;
  /** Skip the padded container (full-bleed pages like Conversations). */
  fullBleed?: boolean;
  /** Narrower container for Connect (1000px instead of 1400px). */
  narrow?: boolean;
  children?: any;
}

const V2_NAV: ReadonlyArray<readonly [V2NavKey, string, string, boolean]> = [
  ["HOME",     "Home",          "/",              false],
  ["AGENTS",   "Agents",        "/agents",        true ],
  ["CONVOS",   "Conversations", "/conversations", false],
  ["LOG",      "Log",           "/log",           false],
];

const FAVICON = raw(
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' +
  '%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E' +
  '%3Crect width=\'32\' height=\'32\' rx=\'7\' fill=\'%230e8a3e\'/%3E' +
  '%3Ctext x=\'16\' y=\'23\' text-anchor=\'middle\' fill=\'%23ffffff\' ' +
  "font-family='sans-serif' font-size='19' font-weight='800'%3Em%3C/text%3E" +
  "%3C/svg%3E\">"
);

interface PaletteItem {
  label: string;
  hint?: string;
  desc?: string;        // Sub-line under the label (used by mcp items).
  href?: string;
  formAction?: string;
  formMethod?: "post" | "get";
  kind: "nav" | "action" | "destructive" | "mcp";
}

// Bake in the inline palette modal: hidden by default, opened with ⌘K
// or by clicking the search button. List items are server-rendered, the
// vanilla JS layer handles open/close/keyboard navigation/filter.
function paletteMarkup(items: PaletteItem[], csrfToken?: string): string {
  const rows = items.map((it, i) => {
    const icon =
      it.kind === "nav" ? "→" :
      it.kind === "destructive" ? "✕" :
      it.kind === "mcp" ? "⌘" : "+";
    const iconColor =
      it.kind === "mcp" ? T.greenDeep :
      it.kind === "destructive" ? T.red : T.dim;
    const labelColor =
      it.kind === "mcp" ? T.greenDeep :
      it.kind === "destructive" ? T.red : T.ink;
    const labelFamily = it.kind === "mcp" ? "var(--font-mono)" : "var(--font-sans)";
    const labelWeight = it.kind === "mcp" ? "500" : "600";
    const hintC = it.kind === "destructive" ? T.red : T.faint;
    const labelHtml =
      `<span class="v2-pal-label" style="font-family:${labelFamily};font-weight:${labelWeight};color:${labelColor}">${escapeHtml(it.label)}</span>` +
      (it.desc ? `<div class="v2-pal-desc">${escapeHtml(it.desc)}</div>` : "");
    const inner =
      `<span class="v2-pal-icon" style="color:${iconColor}">${icon}</span>` +
      `<div class="v2-pal-text">${labelHtml}</div>` +
      (it.hint ? `<span class="v2-pal-hint" style="color:${hintC}">${escapeHtml(it.hint)}</span>` : "");
    if (it.formAction) {
      const csrf = csrfToken
        ? `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"/>`
        : "";
      return `<form method="${it.formMethod ?? "post"}" action="${escapeHtml(it.formAction)}" class="v2-pal-row" data-i="${i}" data-text="${escapeHtml(it.label.toLowerCase())}">${csrf}<button type="submit" class="v2-pal-btn">${inner}</button></form>`;
    }
    return `<a href="${escapeHtml(it.href ?? "#")}" class="v2-pal-row" data-i="${i}" data-text="${escapeHtml(it.label.toLowerCase())}">${inner}</a>`;
  }).join("");
  return `<div id="v2-palette" class="v2-palette" style="display:none" aria-hidden="true">
    <div class="v2-palette-overlay" data-v2-palette-close></div>
    <div class="v2-palette-modal" role="dialog" aria-label="Command palette">
      <div class="v2-palette-input-wrap">
        <span class="v2-palette-prompt">›</span>
        <input id="v2-palette-input" type="text" placeholder="Type a command, agent, or jump to…" autocomplete="off" />
        <kbd class="v2-kbd">esc</kbd>
      </div>
      <div class="v2-palette-list" id="v2-palette-list">${rows}</div>
      <div class="v2-palette-foot">
        <span>↵ open</span><span>esc close</span>
        <span class="v2-palette-foot-spacer"></span>
        <span style="color:${T.greenText}">moshi · ⌘K</span>
      </div>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const PALETTE_SCRIPT = raw(`<script>
(function(){
  var modal = document.getElementById('v2-palette');
  var input = document.getElementById('v2-palette-input');
  var list  = document.getElementById('v2-palette-list');
  if(!modal || !input || !list) return;
  var rows = Array.prototype.slice.call(list.querySelectorAll('.v2-pal-row'));
  var sel = 0;

  function visible(){ return rows.filter(function(r){ return r.style.display !== 'none'; }); }
  function paint(){
    visible().forEach(function(r, i){ r.classList.toggle('v2-pal-active', i === sel); });
  }
  function open(){
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    input.value = ''; sel = 0; filter(''); paint();
    setTimeout(function(){ input.focus(); }, 0);
  }
  function close(){
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
  function filter(q){
    var t = q.toLowerCase();
    rows.forEach(function(r){
      var match = !t || r.dataset.text.indexOf(t) >= 0;
      r.style.display = match ? '' : 'none';
    });
    sel = 0; paint();
  }
  function activate(){
    var v = visible(); var row = v[sel]; if(!row) return;
    if(row.tagName === 'A'){ window.location.href = row.getAttribute('href'); }
    else { row.querySelector('button').click(); }
  }
  document.addEventListener('keydown', function(e){
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
      e.preventDefault();
      modal.style.display === 'none' ? open() : close();
      return;
    }
    if(modal.style.display === 'none') return;
    if(e.key === 'Escape'){ e.preventDefault(); close(); }
    else if(e.key === 'ArrowDown'){ e.preventDefault(); sel = Math.min(visible().length - 1, sel + 1); paint(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if(e.key === 'Enter'){ e.preventDefault(); activate(); }
  });
  input.addEventListener('input', function(){ filter(input.value); });
  modal.querySelectorAll('[data-v2-palette-close]').forEach(function(el){
    el.addEventListener('click', close);
  });
  rows.forEach(function(r){
    r.addEventListener('mouseenter', function(){
      var v = visible(); sel = v.indexOf(r); paint();
    });
  });
  var btn = document.querySelector('[data-v2-search]');
  if(btn) btn.addEventListener('click', function(e){ e.preventDefault(); open(); });
})();
</script>`);

const PALETTE_CSS = `
.v2-palette { position: fixed; inset: 0; z-index: 100; align-items: flex-start; justify-content: center; padding-top: 90px; }
.v2-palette-overlay { position: absolute; inset: 0; background: rgba(36,33,29,0.32); backdrop-filter: blur(3px); }
.v2-palette-modal { position: relative; width: 560px; max-width: calc(100vw - 32px); background: ${T.card}; border: 1px solid ${T.line}; border-radius: ${T.radiusCard}px; overflow: hidden; box-shadow: 0 24px 60px -20px rgba(36,33,29,0.35); }
.v2-palette-input-wrap { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid ${T.lineSoft}; }
.v2-palette-prompt { color: ${T.greenText}; font-family: var(--font-mono); }
#v2-palette-input { flex: 1; background: transparent; border: none; outline: none; color: ${T.ink}; font-size: 14px; font-family: var(--font-sans); }
.v2-kbd { font-family: var(--font-mono); font-size: 11px; color: ${T.dim}; background: ${T.paper}; border: 1px solid ${T.line}; border-radius: 5px; padding: 1px 5px; }
.v2-palette-list { max-height: 340px; overflow-y: auto; }
.v2-pal-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; font-size: 13.5px; cursor: pointer; border-left: 2px solid transparent; text-decoration: none; color: inherit; background: none; border-top: none; border-right: none; border-bottom: none; width: 100%; font-family: inherit; }
.v2-pal-btn { display: flex; align-items: center; gap: 12px; width: 100%; background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; text-align: left; }
.v2-pal-row.v2-pal-active { background: ${T.sunk}; border-left-color: ${T.green}; }
.v2-pal-icon { width: 22px; height: 22px; border-radius: 6px; background: ${T.subtle}; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-family: var(--font-mono); flex-shrink: 0; }
.v2-pal-text { flex: 1; min-width: 0; }
.v2-pal-label { display: block; font-size: 13.5px; }
.v2-pal-desc { font-size: 12px; color: ${T.faint}; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v2-pal-hint { font-size: 11.5px; font-family: var(--font-mono); flex-shrink: 0; }
.v2-palette-foot { display: flex; gap: 16px; padding: 9px 16px; border-top: 1px solid ${T.lineSoft}; font-family: var(--font-mono); font-size: 11px; color: ${T.faint}; }
.v2-palette-foot-spacer { flex: 1; }
form.v2-pal-row { display: block; padding: 0; }
form.v2-pal-row > .v2-pal-btn { padding: 10px 16px; }
`;

// Mesh MCP-tool reference, surfaced in the palette so agents/operators
// can search by tool name and recall the signature without leaving the
// dashboard. Sourced from src/mcp/catalog.ts, which a test keeps in sync
// with the registered tools. Items navigate to the README for full docs.
const MCP_DOC_URL = "https://github.com/pcas-io/moshi#mcp-tools";

function defaultPaletteItems(userRole?: string): PaletteItem[] {
  const items: PaletteItem[] = [
    { kind: "nav", label: "Go to Home",          href: "/",              hint: "G H" },
    { kind: "nav", label: "Go to Conversations", href: "/conversations", hint: "G C" },
    { kind: "nav", label: "Go to Log",           href: "/log",           hint: "G L" },
  ];
  if (userRole === "admin") {
    items.push({ kind: "nav",    label: "Go to Agents",       href: "/agents",          hint: "G A" });
    items.push({ kind: "action", label: "Connect an agent…",  href: "/agents/connect",  hint: "N A" });
  }
  for (const tool of MCP_TOOL_CATALOG) {
    items.push({ kind: "mcp", label: tool.name, desc: tool.desc, hint: tool.signature, href: MCP_DOC_URL });
  }
  items.push({ kind: "destructive", label: "Sign out", formAction: "/logout", formMethod: "post", hint: "destructive" });
  return items;
}

export const CONTAINER_APP =
  `max-width:${T.maxWidthApp}px;margin:0 auto;padding-left:clamp(${T.gutterMin}px,3vw,${T.gutterMax}px);padding-right:clamp(${T.gutterMin}px,3vw,${T.gutterMax}px)`;
export const CONTAINER_DOC =
  `max-width:${T.maxWidthDoc}px;margin:0 auto;padding-left:clamp(${T.gutterMin}px,3vw,${T.gutterMax}px);padding-right:clamp(${T.gutterMin}px,3vw,${T.gutterMax}px)`;

const NAV_LINK = (active: boolean): string =>
  `font-size:14px;font-weight:${active ? 600 : 400};padding:8px 10px;border-radius:9px;white-space:nowrap;` +
  `color:${active ? T.ink : T.dim};background:${active ? T.subtle : "transparent"}`;

const Topbar: FC<{ active?: V2NavKey; userRole?: string; userName?: string; csrfToken?: string }> = ({
  active, userRole, userName, csrfToken,
}) => (
  <header style={`background:${T.card};border-bottom:1px solid ${T.line}`}>
    <div
      style={`${CONTAINER_APP};display:flex;align-items:center;gap:12px;min-height:64px;padding-top:10px;padding-bottom:10px;flex-wrap:wrap`}
    >
      <a href="/" style={`display:flex;align-items:center;gap:10px;color:${T.ink}`}>
        <span style={`width:30px;height:30px;border-radius:9px;background:${T.green};color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px`}>m</span>
        <span style="font-size:16px;font-weight:600;letter-spacing:-0.01em">
          moshi<span style={`color:${T.green}`}>.</span>moshi
        </span>
      </a>
      {/* The basis is the nav's natural width. Below it the whole nav wraps to
          its own row instead of being squeezed into a narrow three-line column
          beside the buttons — which is what `flex:1` did at around 700px, and
          it grew the header to 143px. On a phone the nav wraps internally. */}
      <nav style="display:flex;align-items:center;gap:4px;flex:1 1 360px;flex-wrap:wrap">
        {V2_NAV.map(([key, label, href, requiresAdmin]) => {
          if (requiresAdmin && userRole !== "admin") return null;
          return <a key={key} href={href} style={NAV_LINK(active === key)}>{label}</a>;
        })}
      </nav>
      <button
        data-v2-search
        type="button"
        style={`display:flex;align-items:center;gap:9px;background:${T.paper};border:1px solid ${T.line};color:${T.dim};font-size:13px;padding:8px 12px;border-radius:9px;cursor:pointer`}
      >
        <span>Search</span>
        <span class="v2-kbd">⌘K</span>
      </button>
      {userRole === "admin" && (
        <a
          class="d-solid"
          href="/agents/connect"
          style={`background:${T.green};color:#ffffff;font-size:14px;font-weight:600;padding:9px 16px;border-radius:9px`}
        >
          Connect an agent
        </a>
      )}
      <form method="post" action="/logout" style="margin:0">
        {csrfToken && <input type="hidden" name="csrf" value={csrfToken} />}
        <button
          class="d-solid"
          type="submit"
          title="Sign out"
          aria-label="Sign out"
          style={`width:32px;height:32px;border-radius:9px;background:${T.subtle};border:1px solid ${T.line};display:flex;align-items:center;justify-content:center;font-family:inherit;font-size:12px;font-weight:600;color:${T.dim};cursor:pointer`}
        >
          {(userName ?? userRole ?? "?").slice(0, 1).toUpperCase()}
        </button>
      </form>
    </div>
  </header>
);

const FOOTER_FACTS = ["NATS JetStream · single node", "SQLite"] as const;

// Sora stops at 600 for body and headings, as the handoff narrowed it. 700 is
// loaded for one glyph only: the brand mark, which README §Sign in pins at
// 22px/700. JetBrains Mono keeps 400/500/600.
const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700" +
  "&family=JetBrains+Mono:wght@400;500;600&display=swap";

export const V2Layout: FC<V2LayoutProps> = ({
  title, active, userRole, userName, csrfToken, fullBleed, narrow, children,
}) => {
  const palette = defaultPaletteItems(userRole);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ? `${title} — moshi.moshi` : "moshi.moshi — もしもし"}</title>
        {FAVICON}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href={FONT_HREF}
          rel="stylesheet"
        />
        {raw(`<style>${V2_CSS}${V2_INTERACTION_CSS}${PALETTE_CSS}${LIVE_REFRESH_CSS}</style>`)}
        <meta name="color-scheme" content="light" />
      </head>
      <body>
        <div style="min-height:100vh;display:flex;flex-direction:column">
          <Topbar active={active} userRole={userRole} userName={userName} csrfToken={csrfToken} />
          {fullBleed ? (
            <main style="flex:1;display:flex;flex-direction:column">{children}</main>
          ) : (
            <main style="flex:1">
              <div style={`${narrow ? CONTAINER_DOC : CONTAINER_APP};padding-top:32px;padding-bottom:56px`}>
                {children}
              </div>
            </main>
          )}
          <footer style={`border-top:1px solid ${T.line};background:${T.card}`}>
            <div
              style={`${CONTAINER_APP};padding-top:18px;padding-bottom:18px;display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:${T.dim};align-items:center`}
            >
              <span style={`display:inline-flex;align-items:center;gap:8px;color:${T.ink};font-weight:600`}>
                <span style={`width:8px;height:8px;border-radius:999px;background:${T.live}`} />
                moshi.enki.run
              </span>
              {FOOTER_FACTS.map((label) => <span key={label}>{label}</span>)}
              <span style="flex:1" />
              <span>Apache 2.0</span>
            </div>
          </footer>
        </div>
        {raw(paletteMarkup(palette, csrfToken))}
        {/* Where live-refresh.ts says "2 new messages". One polite status
            element outside of every live container: the containers themselves
            must not be live regions, a swap replaces their whole subtree. */}
        <div id="d-live-status" role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap" />
        {PALETTE_SCRIPT}
        {COPY_SCRIPT}
        {LIVE_REFRESH_SCRIPT}
      </body>
    </html>
  );
};
