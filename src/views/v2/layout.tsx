// V2 page layout — Soft Pastel app shell with brand, top-nav, ⌘K search button.
// Used by the v2 dashboard pages (Home, Agents, Conversations, Messages, Activity).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_CSS, V2_TOKENS } from "./tokens.js";

export type V2NavKey = "HOME" | "AGENTS" | "CONVOS" | "MESSAGES" | "LOG";

interface V2LayoutProps {
  title?: string;
  active?: V2NavKey;
  userRole?: string;
  csrfToken?: string;
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
  '%3Crect width=\'32\' height=\'32\' rx=\'16\' fill=\'%23ff8fb3\'/%3E' +
  '%3Ctext x=\'16\' y=\'23\' text-anchor=\'middle\' fill=\'%23fff\' ' +
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
    const iconColor = it.kind === "mcp" ? "var(--v2-accent)" : "var(--v2-text-mute)";
    const labelColor = it.kind === "mcp" ? "var(--v2-accent)" : "var(--v2-text)";
    const labelFamily = it.kind === "mcp" ? "var(--v2-font-mono)" : "inherit";
    const labelWeight = it.kind === "mcp" ? "600" : "500";
    const hintC = it.kind === "destructive" ? "var(--v2-danger)" : "var(--v2-text-mute)";
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
.v2-palette { position: fixed; inset: 0; z-index: 100; align-items: flex-start; justify-content: center; padding-top: 80px; }
.v2-palette-overlay { position: absolute; inset: 0; background: rgba(120,80,120,0.22); backdrop-filter: blur(2px); }
.v2-palette-modal { position: relative; width: 540px; background: var(--v2-glass-bg-2); -webkit-backdrop-filter: var(--v2-glass-blur); backdrop-filter: var(--v2-glass-blur); border: var(--v2-glass-border); border-radius: var(--v2-radius-xl); overflow: hidden; box-shadow: var(--v2-glass-shadow); }
.v2-palette-input-wrap { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--v2-line); }
.v2-palette-prompt { color: var(--v2-text-mute); font-family: var(--v2-font-mono); }
#v2-palette-input { flex: 1; background: transparent; border: none; outline: none; color: var(--v2-text); font-size: 14px; font-family: inherit; }
.v2-palette-list { max-height: 320px; overflow-y: auto; }
.v2-pal-row { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; cursor: pointer; border-left: 2px solid transparent; text-decoration: none; color: inherit; background: none; border-top: none; border-right: none; border-bottom: none; width: 100%; font-family: inherit; }
.v2-pal-btn { display: flex; align-items: center; gap: 10px; width: 100%; background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; text-align: left; }
.v2-pal-row.v2-pal-active { background: linear-gradient(180deg, rgba(255,143,179,0.14), rgba(255,143,179,0.06)); border-left-color: var(--v2-accent); }
.v2-pal-icon { width: 20px; height: 20px; border-radius: var(--v2-radius); background: var(--v2-surface-2); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-family: var(--v2-font-mono); flex-shrink: 0; }
.v2-pal-text { flex: 1; min-width: 0; }
.v2-pal-label { display: block; }
.v2-pal-desc { font-size: 11px; color: var(--v2-text-mute); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v2-pal-hint { font-size: 11px; font-family: var(--v2-font-mono); flex-shrink: 0; }
form.v2-pal-row { display: block; padding: 0; }
form.v2-pal-row > .v2-pal-btn { padding: 9px 16px; }
`;

// Mesh MCP-tool reference, surfaced in the palette so agents/operators
// can search by tool name and recall the signature without leaving the
// dashboard. Items navigate to the moshi README anchor for full docs.
const MCP_TOOLS: ReadonlyArray<readonly [string, string, string]> = [
  ["mesh_register", "(role, capabilities, ttl_seconds) → ok",   "Agent declares itself + capabilities for routing"],
  ["mesh_send",     "(to, type, payload, context) → message_id", "Send to agent / broadcast / capability:* — context required"],
  ["mesh_receive",  "(limit?) → messages[]",                     "Pull own inbox (consumer durable per agent)"],
  ["mesh_reply",    "(reply_to, payload, context) → message_id", "Reply on existing thread — correlation_id auto"],
  ["mesh_status",   "() → agents[] {presence, role}",            "Roster + presence (live/stale/offline/never)"],
  ["mesh_history",  "(correlation_id, limit?) → messages[]",     "Thread by correlation_id, oldest-first"],
];

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
  for (const [name, sig, desc] of MCP_TOOLS) {
    items.push({ kind: "mcp", label: name, desc, hint: sig, href: MCP_DOC_URL });
  }
  items.push({ kind: "destructive", label: "Log out", formAction: "/logout", formMethod: "post", hint: "destructive" });
  return items;
}

// Responsive scaler: design renders at fixed width and CSS-scales down
// for narrow viewports. Mirrors the prototype useDesignSize hook but as
// vanilla JS sitting on top of the server-rendered shell.
const SCALER_SCRIPT = raw(`<script>
(function(){
  var DESIGN = ${V2_TOKENS.shellWidth};
  var COMPACT = ${V2_TOKENS.shellWidthCompact};
  var BREAK = ${V2_TOKENS.compactBreakpoint};
  var stage = document.querySelector('.v2-stage');
  var scaler = document.querySelector('.v2-scaler');
  var inner  = document.querySelector('.v2-shell');
  if(!stage || !scaler || !inner) return;
  var raf = 0;
  function compute(){
    var vw = window.innerWidth;
    var compact = vw < BREAK;
    var w = compact ? COMPACT : DESIGN;
    var avail = Math.max(320, vw - 32);
    var scale = Math.min(1, avail / w);
    inner.style.setProperty('--v2-design-width', w + 'px');
    scaler.style.width = w + 'px';
    scaler.style.transform = 'scale(' + scale + ')';
    stage.style.minHeight = (inner.offsetHeight * scale + 56) + 'px';
  }
  function schedule(){
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(compute);
  }
  window.addEventListener('resize', schedule);
  if (window.ResizeObserver) {
    new ResizeObserver(schedule).observe(inner);
  }
  compute();
})();
</script>`);

const FOOTER_LINKS = [
  ["Hono · TypeScript"],
  ["NATS JetStream"],
  ["SQLite"],
  ["Coolify @ kai (Hetzner)"],
  ["Apache 2.0"],
] as const;

export const V2Layout: FC<V2LayoutProps> = ({ title, active, userRole, csrfToken, children }) => {
  const palette = defaultPaletteItems(userRole);
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ? `${title} — moshi.moshi` : "moshi.moshi — もしもし"}</title>
        {FAVICON}
        {/* Fonts via Google CDN. Self-hosting deferred — separate optimisation PR. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;500;700;800&family=Baloo+2:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {raw(`<style>${V2_CSS}${PALETTE_CSS}</style>`)}
        <meta name="color-scheme" content="light" />
      </head>
      <body>
        <div class="v2-stage">
          <div class="v2-scaler">
            <div class="v2-shell">
              <header class="v2-topbar">
                <div class="v2-sheen" style="border-radius:14px" />
                <div class="v2-brand">
                  <div class="v2-brand-mark">m</div>
                  <span class="v2-brand-name">moshi.moshi</span>
                </div>
                <div class="v2-divider-v" />
                <nav class="v2-nav">
                  {V2_NAV.map(([key, label, href, requiresAdmin]) => {
                    if (requiresAdmin && userRole !== "admin") return null;
                    const isActive = active === key;
                    return (
                      <a key={key} href={href} class={isActive ? "active" : ""}>
                        <span>{label}</span>
                      </a>
                    );
                  })}
                </nav>
                <button data-v2-search class="v2-search-btn" type="button">
                  <span style="color:var(--v2-text-mute)">⌕</span>
                  <span style="flex:1;text-align:left">Search…</span>
                  <kbd class="v2-kbd">⌘K</kbd>
                </button>
                {csrfToken && (
                  <form method="post" action="/logout" style="margin-left:8px">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <button type="submit" class="v2-btn v2-btn--ghost" style="font-size:12px">Logout</button>
                  </form>
                )}
              </header>
              <main>{children}</main>
              <footer class="v2-footer">
                <div class="v2-sheen" style="border-radius:10px" />
                <span class="v2-footer-domain">
                  <span class="v2-footer-dot" />
                  moshi.enki.run
                </span>
                {FOOTER_LINKS.map(([label]) => (
                  <>
                    <span class="v2-footer-sep">·</span>
                    <span>{label}</span>
                  </>
                ))}
                <span class="v2-footer-spacer" />
                <span class="v2-footer-warn">NATS · single-node</span>
              </footer>
            </div>
          </div>
        </div>
        {raw(paletteMarkup(palette, csrfToken))}
        {PALETTE_SCRIPT}
        {SCALER_SCRIPT}
      </body>
    </html>
  );
};
