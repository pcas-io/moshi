// One copy-to-clipboard handler for the whole dashboard: the agent token,
// every command block, the hello command and the reply command.
//
// Two deliberate behaviours, both from the design handoff:
//
//  * The success path ALWAYS runs, even when `navigator.clipboard.writeText`
//    rejects. It throws NotAllowedError in unfocused and non-secure contexts,
//    and a button that silently does nothing is worse than one that lies.
//    The `document.execCommand` textarea fallback runs first in that case, so
//    in practice the text usually did land.
//  * A successful copy emits a `d-copied` event carrying the button's gate
//    key. The connect flow listens for it to unlock step 2's forward button.

import { raw } from "hono/html";
import { V2_TOKENS } from "./tokens.js";

/**
 * Markup contract for a copy button:
 *   class="d-copy"                 — required, this is the hook
 *   data-label="Copy token"        — label restored after 1600 ms
 *   data-copy-text="…"             — literal text to copy, or
 *   data-copy-from="#selector"     — element whose innerText to copy, or
 *   (neither)                      — nearest `pre, code` inside the parent
 *   data-copy-gate="token"         — optional key emitted on `d-copied`
 */
export const COPY_SCRIPT = raw(`<script>
(function(){
  if (window.__dCopy) return; window.__dCopy = 1;
  var GREEN = ${JSON.stringify(V2_TOKENS.green)};

  function fallback(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) { /* best effort — the success path runs regardless */ }
  }

  function textFor(btn){
    if (btn.hasAttribute('data-copy-text')) return btn.getAttribute('data-copy-text');
    var sel = btn.getAttribute('data-copy-from');
    var src = sel ? document.querySelector(sel)
                  : (btn.parentElement && btn.parentElement.querySelector('pre, code'));
    return src ? src.innerText : '';
  }

  function succeed(btn){
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label);
    if (!btn.hasAttribute('data-fill')) btn.setAttribute('data-fill', btn.style.background || '');
    if (!btn.hasAttribute('data-ink')) btn.setAttribute('data-ink', btn.style.color || '');
    btn.textContent = 'Copied';
    btn.style.background = GREEN;
    btn.style.borderColor = GREEN;
    btn.style.color = '#ffffff';
    document.dispatchEvent(new CustomEvent('d-copied', {
      detail: { gate: btn.getAttribute('data-copy-gate') || '' }
    }));
    setTimeout(function(){
      btn.textContent = label;
      btn.style.background = btn.getAttribute('data-fill') || '';
      btn.style.borderColor = '';
      btn.style.color = btn.getAttribute('data-ink') || '';
    }, 1600);
  }

  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest && e.target.closest('.d-copy');
    if (!btn) return;
    e.preventDefault();
    var text = textFor(btn);
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function(){ succeed(btn); },
        function(){ fallback(text); succeed(btn); }
      );
    } else {
      fallback(text); succeed(btn);
    }
  });
})();
</script>`);
