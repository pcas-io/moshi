// V2 page layout — SENTINEL Dark app shell with brand, top-nav, ⌘K palette.
// Used by the v2 dashboard pages (Home, Agents, Conversations, Messages, Activity).
// Pages with a hero (Overview) pass `hero` — the top-nav then renders inside
// the hero surface (transparent, no rule); all other pages get a ruled topbar.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_CSS, V2_TOKENS, V2_HERO_BG, V2_GRID_BG } from "./tokens.js";
import { MCP_TOOL_CATALOG } from "../../mcp/catalog.js";

export type V2NavKey = "HOME" | "AGENTS" | "CONVOS" | "MESSAGES" | "LOG";

interface V2LayoutProps {
  title?: string;
  active?: V2NavKey;
  userRole?: string;
  csrfToken?: string;
  /** Hero content rendered below the nav inside the hero surface (Overview). */
  hero?: any;
  /** Skip the .v2-wrap/.v2-pad content wrapper (full-bleed pages like Conversations). */
  fullBleed?: boolean;
  children?: any;
}

const V2_NAV: ReadonlyArray<readonly [V2NavKey, string, string, boolean]> = [
  ["HOME",     "Overview",      "/",              false],
  ["AGENTS",   "Agents",        "/agents",        true ],
  ["CONVOS",   "Conversations", "/conversations", false],
  ["MESSAGES", "Messages",      "/messages",      false],
  ["LOG",      "Activity",      "/activity",      false],
];

const FAVICON = raw(
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' +
  '%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E' +
  '%3Crect width=\'32\' height=\'32\' rx=\'7\' fill=\'%2305e901\'/%3E' +
  '%3Ctext x=\'16\' y=\'23\' text-anchor=\'middle\' fill=\'%230a0a0a\' ' +
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
      it.kind === "mcp" ? V2_TOKENS.accent :
      it.kind === "destructive" ? V2_TOKENS.danger : "#888888";
    const labelColor =
      it.kind === "mcp" ? V2_TOKENS.accent :
      it.kind === "destructive" ? V2_TOKENS.danger : V2_TOKENS.text;
    const labelFamily = it.kind === "mcp" ? "var(--v2-font-mono)" : "var(--v2-font-sans)";
    const labelWeight = it.kind === "mcp" ? "500" : "600";
    const hintC = it.kind === "destructive" ? V2_TOKENS.danger : V2_TOKENS.textMute;
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
        <span>↵ OPEN</span><span>ESC CLOSE</span>
        <span class="v2-palette-foot-spacer"></span>
        <span style="color:${V2_TOKENS.accent}">MESH · ⌘K</span>
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
.v2-palette-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); backdrop-filter: blur(3px); }
.v2-palette-modal { position: relative; width: 560px; max-width: calc(100vw - 32px); background: var(--v2-modal); border: 1px solid var(--v2-line-2); border-radius: 8px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.7); }
.v2-palette-input-wrap { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--v2-line-card); }
.v2-palette-prompt { color: var(--v2-accent); font-family: var(--v2-font-mono); }
#v2-palette-input { flex: 1; background: transparent; border: none; outline: none; color: var(--v2-text); font-size: 13.5px; font-family: var(--v2-font-sans); }
.v2-palette-list { max-height: 340px; overflow-y: auto; }
.v2-pal-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; font-size: 12.5px; cursor: pointer; border-left: 2px solid transparent; text-decoration: none; color: inherit; background: none; border-top: none; border-right: none; border-bottom: none; width: 100%; font-family: inherit; }
.v2-pal-btn { display: flex; align-items: center; gap: 12px; width: 100%; background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; text-align: left; }
.v2-pal-row.v2-pal-active { background: #1f1f1f; border-left-color: var(--v2-accent); }
.v2-pal-icon { width: 22px; height: 22px; border-radius: 4px; background: var(--v2-chip); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-family: var(--v2-font-mono); flex-shrink: 0; }
.v2-pal-text { flex: 1; min-width: 0; }
.v2-pal-label { display: block; font-size: 12.5px; }
.v2-pal-desc { font-size: 10.5px; color: var(--v2-text-mute); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v2-pal-hint { font-size: 10px; font-family: var(--v2-font-mono); flex-shrink: 0; }
.v2-palette-foot { display: flex; gap: 16px; padding: 9px 16px; border-top: 1px solid var(--v2-line-card); font-family: var(--v2-font-mono); font-size: 9.5px; color: var(--v2-text-faint); letter-spacing: 0.08em; }
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
    { kind: "nav", label: "Go to Overview",      href: "/",              hint: "G O" },
    { kind: "nav", label: "Go to Conversations", href: "/conversations", hint: "G C" },
    { kind: "nav", label: "Go to Messages",      href: "/messages",      hint: "G M" },
    { kind: "nav", label: "Go to Activity",      href: "/activity",      hint: "G L" },
  ];
  if (userRole === "admin") {
    items.push({ kind: "nav",    label: "Go to Agents",     href: "/agents",         hint: "G A" });
    items.push({ kind: "action", label: "Register new agent…", href: "/agents?new=1", hint: "N A" });
  }
  for (const tool of MCP_TOOL_CATALOG) {
    items.push({ kind: "mcp", label: tool.name, desc: tool.desc, hint: tool.signature, href: MCP_DOC_URL });
  }
  items.push({ kind: "destructive", label: "Log out", formAction: "/logout", formMethod: "post", hint: "destructive" });
  return items;
}

const FOOTER_LINKS = [
  "Hono · TypeScript",
  "NATS JetStream",
  "SQLite",
  "Coolify @ kai (Hetzner)",
  "Apache 2.0",
] as const;

const Topbar: FC<{ active?: V2NavKey; userRole?: string; csrfToken?: string }> = ({
  active, userRole, csrfToken,
}) => (
  <div class="v2-wrap v2-pad v2-topbar" style="position:relative;z-index:2">
    <a href="/" class="v2-brand">
      <span class="v2-brand-mark">m</span>
      <span class="v2-brand-name">moshi<span class="dot">.</span>moshi</span>
    </a>
    <nav class="v2-nav">
      {V2_NAV.map(([key, label, href, requiresAdmin]) => {
        if (requiresAdmin && userRole !== "admin") return null;
        return (
          <a key={key} href={href} class={active === key ? "active" : ""}>{label}</a>
        );
      })}
    </nav>
    <button
      data-v2-search
      type="button"
      style={`display:flex;align-items:center;gap:10px;background:${V2_TOKENS.btn3};border:none;color:${V2_TOKENS.text};font-family:var(--v2-font-sans);font-size:10.5px;letter-spacing:0.15em;text-transform:uppercase;padding:9px 15px;border-radius:8px;cursor:pointer`}
    >
      <span style="color:#777777">⌕</span>
      <span>Search</span>
      <span style={`font-family:var(--v2-font-mono);color:${V2_TOKENS.textMute};letter-spacing:0.05em;text-transform:none`}>⌘K</span>
    </button>
    <form method="post" action="/logout" style="margin:0">
      {csrfToken && <input type="hidden" name="csrf" value={csrfToken} />}
      <button type="submit" class="v2-logout">Logout</button>
    </form>
  </div>
);

export const V2Layout: FC<V2LayoutProps> = ({
  title, active, userRole, csrfToken, hero, fullBleed, children,
}) => {
  const palette = defaultPaletteItems(userRole);
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ? `${title} — moshi.moshi` : "moshi.moshi — もしもし"}</title>
        {FAVICON}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {raw(`<style>${V2_CSS}${PALETTE_CSS}</style>`)}
        <meta name="color-scheme" content="dark" />
      </head>
      <body>
        <div style="min-height:100vh;display:flex;flex-direction:column">
          {hero ? (
            <div style={`position:relative;overflow:hidden;background:${V2_HERO_BG};display:flex;flex-direction:column`}>
              <div style={`position:absolute;inset:0;background-image:${V2_GRID_BG};background-size:56px 56px;pointer-events:none`} />
              <Topbar active={active} userRole={userRole} csrfToken={csrfToken} />
              {hero}
            </div>
          ) : (
            <div class="v2-topbar-rule">
              <Topbar active={active} userRole={userRole} csrfToken={csrfToken} />
            </div>
          )}
          {fullBleed ? (
            <main style="flex:1;display:flex;flex-direction:column">{children}</main>
          ) : (
            <main style="flex:1">
              <div class="v2-wrap">{children}</div>
            </main>
          )}
          <footer class="v2-footer-rule">
            <div class="v2-wrap v2-pad v2-footer">
              <span class="v2-footer-domain">
                <span class="v2-footer-dot" />
                moshi.enki.run
              </span>
              {FOOTER_LINKS.map((label) => (
                <>
                  <span class="v2-footer-sep">·</span>
                  <span>{label}</span>
                </>
              ))}
              <span class="v2-footer-spacer" />
              <span class="v2-footer-warn">NATS · SINGLE-NODE</span>
            </div>
          </footer>
        </div>
        {raw(paletteMarkup(palette, csrfToken))}
        {PALETTE_SCRIPT}
      </body>
    </html>
  );
};
