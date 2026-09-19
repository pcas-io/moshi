// The live-thread half of Home: the bubble geometry, and the small script
// that appends new messages as they arrive over SSE.
//
// Server and client build the same bubble from the same style strings, which
// is the only reason this lives in its own module — a second, hand-copied set
// of styles in the script is exactly how the two drift apart.

import { raw } from "hono/html";
import { V2_FONT_FAMILY_MONO, V2_TOKENS } from "./tokens.js";

const T = V2_TOKENS;

const BUBBLE_BASE =
  `border-radius:13px;padding:11px 14px;font-size:14px;line-height:1.6;color:${T.ink};white-space:pre-wrap`;

/** Bubble edges are softer than `greenLine`/`line`, which read as panel rules. */
export function bubbleStyle(isMine: boolean): string {
  return isMine
    ? `${BUBBLE_BASE};background:${T.greenSoft};border:1px solid #cfe9d7;border-bottom-right-radius:5px`
    : `${BUBBLE_BASE};background:${T.subtle};border:1px solid #eae3d7;border-bottom-left-radius:5px`;
}

export function rowStyle(isMine: boolean): string {
  return `display:flex;gap:11px;align-items:flex-end;flex-direction:${isMine ? "row-reverse" : "row"}`;
}

export function colStyle(isMine: boolean): string {
  return `max-width:80%;display:flex;flex-direction:column;align-items:${isMine ? "flex-end" : "flex-start"}`;
}

export function headStyle(isMine: boolean): string {
  return `display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-direction:${isMine ? "row-reverse" : "row"}`;
}

export const TIME_STYLE = `font-family:${V2_FONT_FAMILY_MONO};font-size:11px;color:${T.faint}`;

/** The scroll container the script appends into. */
export const THREAD_BOX_ID = "v2-live-thread";

/** Longest payload a bubble shows. Shared so the server render and the SSE
 *  append cannot disagree about where a long message stops. */
export const PREVIEW_MAX = 240;

/** `<` is escaped so no agent name or payload can close the script tag. */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Subscribes to `/sse/threads/:id` and appends bubbles that match the
 * server-rendered ones. The emblem comes from a name→SVG map baked in at
 * render time: the generator is server-side, and there is no hidden avatar
 * pool to clone from anymore.
 */
export function threadScript(
  correlationId: string,
  mine: string,
  emblems: Record<string, string>,
): ReturnType<typeof raw> {
  return raw(`<script>
(function(){
  if (typeof EventSource === 'undefined') return;
  var box = document.getElementById(${jsLiteral(THREAD_BOX_ID)});
  if (!box) return;
  var thread = ${jsLiteral(correlationId)};
  var mine = ${jsLiteral(mine)};
  // Emblem markup comes from our own generator: palette constants plus
  // initials stripped to [A-Za-z0-9]. No agent-supplied text reaches it.
  var emblems = ${jsLiteral(emblems)};
  var style = ${jsLiteral({
    rowMine: rowStyle(true), rowTheirs: rowStyle(false),
    colMine: colStyle(true), colTheirs: colStyle(false),
    headMine: headStyle(true), headTheirs: headStyle(false),
    bubbleMine: bubbleStyle(true), bubbleTheirs: bubbleStyle(false),
    time: TIME_STYLE,
    avatar: "display:inline-flex;width:28px;height:28px;flex-shrink:0;border-radius:10px;" +
      "overflow:hidden;border:1px solid " + T.line + ";background:" + T.subtle,
  })};

  function seen(id) {
    for (var i = 0; i < box.children.length; i++) {
      if (box.children[i].getAttribute('data-msg-id') === id) return true;
    }
    return false;
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(iso) {
    var d = new Date(iso);
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }
  // Mirrors previewPayload() in home.tsx, cap included. Without the cap the
  // same message renders clipped on load and in full when it arrives live,
  // in the one module whose whole job is server/client parity.
  var PREVIEW_MAX = ${PREVIEW_MAX};
  function preview(s) {
    if (!s) return '';
    try {
      var o = JSON.parse(s);
      if (typeof o === 'string') return o.slice(0, PREVIEW_MAX);
      if (o && typeof o === 'object') {
        var keys = ['text', 'message', 'summary', 'payload'];
        for (var i = 0; i < keys.length; i++) {
          if (typeof o[keys[i]] === 'string') return o[keys[i]].slice(0, PREVIEW_MAX);
        }
      }
    } catch (e) { /* not JSON */ }
    return s.slice(0, PREVIEW_MAX);
  }
  function el(tag, css, text) {
    var node = document.createElement(tag);
    node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildBubble(msg) {
    var isMine = String(msg.from).toLowerCase() === mine;
    var row = el('div', isMine ? style.rowMine : style.rowTheirs);
    row.setAttribute('data-msg-id', msg.id);

    var avatar = el('span', style.avatar);
    var who = String(msg.from).toLowerCase();
    // Own entries only: an agent may be called "constructor".
    var emblem = Object.prototype.hasOwnProperty.call(emblems, who) ? emblems[who] : null;
    if (emblem) avatar.innerHTML = emblem;

    var col = el('div', isMine ? style.colMine : style.colTheirs);
    var head = el('div', isMine ? style.headMine : style.headTheirs);
    head.appendChild(el('span', 'font-size:13px;font-weight:600', msg.from));
    head.appendChild(el('span', style.time, fmtTime(msg.created_at)));
    col.appendChild(head);
    col.appendChild(el('div', isMine ? style.bubbleMine : style.bubbleTheirs, preview(msg.payload)));

    row.appendChild(avatar);
    row.appendChild(col);
    return row;
  }

  var source = new EventSource('/sse/threads/' + encodeURIComponent(thread));
  source.addEventListener('message', function(ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (!msg || seen(msg.id)) return;
      var empty = box.querySelector('[data-empty]');
      if (empty) empty.remove();
      box.appendChild(buildBubble(msg));
      box.scrollTop = box.scrollHeight;
    } catch (e) { /* malformed event — keep the connection */ }
  });
  window.addEventListener('beforeunload', function(){ source.close(); });
})();
</script>`);
}
