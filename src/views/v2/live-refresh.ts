// The browser half of the live sections.
//
// Every element with `data-live` and `data-live-src` refreshes itself: the
// script fetches the URL, which returns the element's INSIDE rendered by the
// server (src/routes/fragments.tsx), and swaps it in. It renders nothing
// itself, so it cannot disagree with the page about how a row looks.
//
// Markup contract:
//   data-live="name"            — the container; its children get replaced
//   data-live-src="/fragments/…"— where the children come from
//   data-live-mark="rows"       — optional: mark rows not seen before, once
//   data-id="…"                 — on each row, for that comparison
//   data-live-scroll="key"      — on scrollers inside; their position survives
//   data-live-follow="bottom"   — on such a scroller: start at the bottom and
//                                 stay there, until the reader scrolls up
//   data-live-noun="message"    — with data-live-mark: new rows are announced
//                                 in #d-live-status ("2 new messages")
//
// Rules, each of them pinned in tests/views/v2/live-refresh.test.ts:
// - `Accept: text/x-moshi-fragment`, never text/html: with text/html the auth
//   middleware answers an expired session with a redirect to /login, fetch
//   follows it, and the login page lands in the table.
// - The page is served no-store, so the browser never revalidates by itself:
//   the script keeps the ETag per container and sends If-None-Match.
// - 401 reloads the page, once. Anything else that is not 200 text/html
//   leaves the old content alone and doubles the interval, up to a minute.
// - No swap while keyboard focus (:focus-visible) is inside the container or
//   a text selection reaches into it, from wherever it started. A mouse
//   click on a button does not count, or a clicked Copy button would stop the
//   refresh for good; neither does a caret.
// - No swap either while a mouse button or a finger is down on something
//   inside the container: replacing the element between mousedown and
//   mouseup makes the browser drop the click without a trace.
// - A 200 that brings the markup the section already shows replaces nothing.
//   A proxy that rewrites ETags turns every 304 into a 200, and a swap every
//   five seconds resets hover, tooltips and a screen reader's position.
// - The containers carry no aria-live: a swap replaces the whole subtree, and
//   every row would be read again. New rows are counted into one role=status
//   element outside of them.
// - Hidden tab: no requests. Visible again: ask at once.
//
// WHEN to ask: every five seconds, and sooner if GET /sse/messages
// (src/routes/sse.ts) says that something was sent. The stream carries ids
// only; what is shown always comes from the fragments, so the rules above do
// not know whether a stream exists.
//   data-live-thread="id"       — optional: this section shows one thread and
//                                 only asks when an event names that thread
//   data-live-pill              — shown while the stream is open, hidden
//                                 otherwise (the server renders it hidden)
// - Stream open: ask at once (closes the gap between the render and the
//   subscription), then the timer is only a safety net, once a minute.
// - An event asks 300 ms later, once for a burst. A fetch that is already on
//   its way may have read the database before the message: ask again after it.
// - Stream lost: timer on ten seconds while the browser reconnects. A stream
//   the server REFUSED (503 at the connection limit, 503 from the proxy
//   during a deploy) is never retried by the browser, so the script does it:
//   after 30 s, doubling up to five minutes.
// - A failed fetch is retried after ten seconds, then twenty and so on up to
//   a minute, whatever the timer stands at. The browser's "online" event asks
//   at once and reconnects a stream that had been given up on.
// - Hidden tab: the stream is closed. It would hold one of the server's
//   places, and one of the browser's six connections per HTTP/1.1 origin.

import { raw } from "hono/html";
import { V2_TOKENS } from "./tokens.js";

/** A transition, not a keyframe: m-pulse stays the only looping animation,
 *  and the entrance m-rise the only other one (daylight.test.ts counts). */
export const LIVE_REFRESH_CSS = `
.d-new { background-color: ${V2_TOKENS.greenSoft} !important; }
.d-new-fade { transition: background-color 1.8s ease-out; }
@media (prefers-reduced-motion: reduce) { .d-new-fade { transition: none; } }
`;

export const LIVE_REFRESH_SCRIPT = raw(`<script>
(function(){
  if (window.__dLive) return; window.__dLive = 1;
  if (!window.fetch) return;
  var ACCEPT = 'text/x-moshi-fragment';
  var STREAM = '/sse/messages';
  var BASE = 5000, MAX = 60000, WITH_STREAM = 60000, STREAM_LOST = 10000, DEBOUNCE = 300;
  var RETRY = 30000, RETRY_MAX = 300000;
  var base = BASE;
  var found = document.querySelectorAll('[data-live][data-live-src]');
  if (!found.length) return;
  var sections = [];
  for (var i = 0; i < found.length; i++) sections.push({ el: found[i], etag: null, html: null, delay: BASE, fails: 0, timer: null, busy: false, again: false });
  var reloading = false;
  var pressed = null; // what a mouse button or a finger went down on, until it lifts
  var es = null, streamUp = false, pending = null, named = Object.create(null), all = false, retry = null, retryDelay = RETRY;

  function inUse(el) {
    if (pressed && el.contains(pressed)) return true;
    try { if (el.querySelector(':focus-visible')) return true; } catch (e) { /* old browser: no such selector */ }
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) return false;
    // Every range, and "reaches into", not "lies within": a selection dragged
    // from the list into the thread has its common ancestor outside of both.
    for (var i = 0; i < sel.rangeCount; i++) {
      var range = sel.getRangeAt(i);
      if (range.intersectsNode ? range.intersectsNode(el) : el.contains(range.commonAncestorContainer)) return true;
    }
    return false;
  }

  function rowIds(el) {
    // No prototype: an id is the sender's correlation_id, and "constructor" is one.
    var seen = Object.create(null), rows = el.querySelectorAll('[data-id]');
    for (var i = 0; i < rows.length; i++) seen[rows[i].getAttribute('data-id')] = 1;
    return { seen: seen, count: rows.length };
  }

  function atBottom(s) {
    var gap = s.scrollHeight - s.scrollTop - s.clientHeight < 8;
    // Without "follow", a box that was never scrolled is at the top, not at
    // the bottom. With it, a box whose content still fits is both.
    return gap && (s.scrollTop > 0 || s.getAttribute('data-live-follow') === 'bottom');
  }

  function scrollState(el) {
    var saved = {}, list = el.querySelectorAll('[data-live-scroll]');
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      saved[s.getAttribute('data-live-scroll')] = { top: s.scrollTop, left: s.scrollLeft, atBottom: atBottom(s) };
    }
    return saved;
  }

  function restoreScroll(el, saved) {
    var list = el.querySelectorAll('[data-live-scroll]');
    for (var i = 0; i < list.length; i++) {
      var s = list[i], was = saved[s.getAttribute('data-live-scroll')];
      if (!was) continue;
      s.scrollLeft = was.left;
      s.scrollTop = was.atBottom ? Math.max(was.top, s.scrollHeight - s.clientHeight) : was.top;
    }
  }

  function followBottom(el) {
    var list = el.querySelectorAll('[data-live-scroll]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-live-follow') === 'bottom') list[i].scrollTop = Math.max(0, list[i].scrollHeight - list[i].clientHeight);
    }
  }

  function markNew(el, before) {
    if (el.getAttribute('data-live-mark') !== 'rows' || before.count === 0) return;
    var rows = el.querySelectorAll('[data-id]'), fresh = [];
    for (var i = 0; i < rows.length; i++) {
      if (!before.seen[rows[i].getAttribute('data-id')]) fresh.push(rows[i]);
    }
    if (!fresh.length) return;
    // Said before the motion check: the announcement is not an animation.
    var noun = el.getAttribute('data-live-noun'), status = document.getElementById('d-live-status');
    if (noun && status) status.textContent = fresh.length + ' new ' + noun + (fresh.length === 1 ? '' : 's');
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var j = 0; j < fresh.length; j++) fresh[j].classList.add('d-new', 'd-new-fade');
    var raf = window.requestAnimationFrame || function(fn){ return setTimeout(fn, 16); };
    raf(function(){ raf(function(){
      for (var k = 0; k < fresh.length; k++) fresh[k].classList.remove('d-new');
      setTimeout(function(){ for (var m = 0; m < fresh.length; m++) fresh[m].classList.remove('d-new-fade'); }, 2000);
    }); });
  }

  function outOfBand(header) {
    if (!header) return;
    var pairs = header.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('=');
      if (eq < 1) continue;
      var target = document.getElementById(decodeURIComponent(pairs[i].slice(0, eq)));
      if (target) target.textContent = decodeURIComponent(pairs[i].slice(eq + 1).replace(/\\+/g, ' '));
    }
  }

  function pills(root) {
    var list = root.querySelectorAll('[data-live-pill]');
    for (var i = 0; i < list.length; i++) {
      if (streamUp) list[i].removeAttribute('hidden'); else list[i].setAttribute('hidden', '');
    }
  }

  function swap(section, html, oob) {
    var el = section.el, before = rowIds(el), saved = scrollState(el);
    el.innerHTML = html;
    restoreScroll(el, saved);
    markNew(el, before);
    pills(el);
    outOfBand(oob);
  }

  function schedule(section) {
    clearTimeout(section.timer);
    if (reloading) return;
    section.timer = setTimeout(function(){ tick(section); }, section.delay);
  }

  function tick(section) {
    if (reloading) return;
    if (section.busy) { section.again = true; return; }
    if (document.hidden) { schedule(section); return; }
    section.busy = true;
    var headers = { 'Accept': ACCEPT };
    if (section.etag) headers['If-None-Match'] = section.etag;
    window.fetch(section.el.getAttribute('data-live-src'), { headers: headers, credentials: 'same-origin', cache: 'no-store' })
      .then(function(res){
        if (res.status === 401) {
          if (!reloading) { reloading = true; disconnect(); window.location.reload(); }
          return null;
        }
        if (res.status === 304) { section.fails = 0; section.delay = base; return null; }
        var type = res.headers.get('content-type') || '';
        if (res.status !== 200 || type.indexOf('text/html') !== 0) throw new Error('not a fragment');
        var etag = res.headers.get('etag'), oob = res.headers.get('x-moshi-oob');
        return res.text().then(function(html){
          section.fails = 0;
          section.delay = base;
          // In use: keep the old content AND the old ETag, so this version is
          // asked for again instead of being counted as seen. Soon, also
          // when the stream has slowed the timer down to a minute.
          if (inUse(section.el)) { section.delay = BASE; return; }
          if (html === section.html) outOfBand(oob); else swap(section, html, oob);
          section.html = html;
          section.etag = etag;
        });
      })
      // Counted from five seconds, not from the current timer: with the
      // stream open that is a minute, and one failed request would leave a
      // section stale for that long.
      .catch(function(){ section.fails++; section.delay = Math.min(MAX, BASE * Math.pow(2, section.fails)); })
      .then(function(){
        section.busy = false;
        if (section.again) { section.again = false; tick(section); } else schedule(section);
      });
  }

  function askNow(everything) {
    for (var i = 0; i < sections.length; i++) {
      var pin = sections[i].el.getAttribute('data-live-thread');
      if (!everything && pin && !named[pin]) continue;
      clearTimeout(sections[i].timer);
      tick(sections[i]);
    }
  }

  // Only a CHANGE of state moves the timers: while the browser reconnects it
  // reports an error every few seconds, and each one would push them away.
  function setStream(up) {
    if (up === streamUp) return;
    streamUp = up;
    base = up ? WITH_STREAM : STREAM_LOST;
    pills(document);
    for (var i = 0; i < sections.length; i++) sections[i].delay = base;
    if (up) askNow(true);
    else for (var j = 0; j < sections.length; j++) if (!sections[j].busy) schedule(sections[j]);
  }

  function disconnect() {
    clearTimeout(retry); clearTimeout(pending); pending = null;
    if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null; }
  }

  function connect() {
    if (!window.EventSource || es || reloading || document.hidden) return;
    clearTimeout(retry);
    try { es = new window.EventSource(STREAM); } catch (e) { es = null; return; }
    es.onopen = function(){ retryDelay = RETRY; setStream(true); };
    es.onmessage = function(ev){
      try { named[JSON.parse(ev.data).thread_id] = 1; } catch (e) { all = true; }
      if (pending) return;
      pending = setTimeout(function(){
        var everything = all;
        pending = null; all = false;
        askNow(everything);
        named = Object.create(null); // no prototype: a thread can be called 'constructor'
      }, DEBOUNCE);
    };
    es.onerror = function(){
      setStream(false);
      if (es && es.readyState === 2) {
        es = null;
        retry = setTimeout(connect, retryDelay);
        retryDelay = Math.min(RETRY_MAX, retryDelay * 2);
      }
    };
  }

  function down(ev) { pressed = ev && ev.target ? ev.target : null; }
  function up() { pressed = null; }
  document.addEventListener('mousedown', down, true);
  document.addEventListener('touchstart', down, true);
  document.addEventListener('mouseup', up, true);
  document.addEventListener('touchend', up, true);
  document.addEventListener('touchcancel', up, true);

  document.addEventListener('visibilitychange', function(){
    if (reloading) return;
    if (document.hidden) { disconnect(); setStream(false); return; }
    connect();
    for (var i = 0; i < sections.length; i++) { clearTimeout(sections[i].timer); tick(sections[i]); }
  });

  // The network is back: whatever was given up on for now is worth a try.
  if (window.addEventListener) window.addEventListener('online', function(){
    if (reloading || document.hidden) return;
    if (!es) { retryDelay = RETRY; connect(); }
    askNow(true);
  });

  for (var n = 0; n < sections.length; n++) { followBottom(sections[n].el); schedule(sections[n]); }
  connect();
})();
</script>`);
