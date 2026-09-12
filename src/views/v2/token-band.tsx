// The one-time plaintext token band.
//
// Why this exists after the connect flow took over agent creation: resetting a
// token still happens on /agents, and `POST /agents/reset-token` still hands
// back a plaintext value exactly once. Without somewhere to render it, a reset
// would revoke the old token and drop the new one on the floor — the agent
// would be locked out with nothing to paste. So the band stays, reduced to the
// one job it has left, and reuses the connect flow's step-2 wording.

import type { FC } from "hono/jsx";
import { V2_TOKENS } from "./tokens.js";

const T = V2_TOKENS;

export const V2TokenBand: FC<{
  token: string;
  /** Named when we know which agent it belongs to; omitted after a bare create. */
  agentName?: string;
}> = ({ token, agentName }) => (
  <div
    style={`background:${T.greenSoft};border:1px solid ${T.greenLine};border-radius:${T.radiusInner}px;padding:18px;margin-bottom:18px`}
  >
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
      <span style={`font-size:14px;font-weight:600;color:${T.greenDeep}`}>
        {agentName ? `Copy ${agentName}'s new token now` : "Copy this token now"}
      </span>
      <span style={`font-size:12.5px;color:${T.greenDeep}`}>
        It is stored as a SHA-256 hash — we can never show it again.
      </span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap">
      <code
        id="v2-new-token"
        style={`flex:1 1 320px;background:${T.card};border-radius:${T.radiusControl}px;padding:12px 14px;` +
          `font-family:var(--font-mono);font-size:14px;color:${T.greenDeep};word-break:break-all`}
      >
        {token}
      </code>
      <button
        type="button"
        class="d-copy d-solid"
        data-label="Copy token"
        data-copy-from="#v2-new-token"
        style={`background:${T.green};border:1px solid ${T.green};color:#ffffff;font-family:inherit;font-size:14px;` +
          `font-weight:600;padding:11px 18px;border-radius:${T.radiusControl}px;cursor:pointer;white-space:nowrap`}
      >
        Copy token
      </button>
    </div>
    <div style={`margin-top:12px;font-size:14px;color:${T.body}`}>
      Paste it into the agent's client now — it goes offline until you do. Lost it later? Reset the
      token again; the old one stops working immediately.
    </div>
  </div>
);
