// V2 Conversations — SENTINEL Dark split-view (list panel + bubble thread).

import type { FC } from "hono/jsx";
import type { ConversationThread } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Avatar, typeColor } from "./components.js";
import { V2_TOKENS, greenGlow } from "./tokens.js";

export interface V2ConversationsProps {
  result: PaginatedResult<ConversationThread>;
  selectedId?: string;
  query?: string;
  /** Only threads this agent took part in (?agent=). */
  filterAgent?: string;
  agentRoles: Record<string, string | null>;
  agentIds: Record<string, string>;
  csrfToken?: string;
  userRole?: string;
}

const MONO = "var(--v2-font-mono)";
const LIVE_WINDOW_MS = 15 * 60_000;

function fmtTime(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function fmtRel(iso: string, now: number = Date.now()): string {
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  return d.toDateString() === now.toDateString() ? `TODAY — ${label}` : label;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function previewPayload(rawStr: string, max: number = 240): string {
  try {
    const o = JSON.parse(rawStr);
    if (typeof o === "string") return clip(o, max);
    if (o && typeof o === "object") {
      for (const k of ["text", "message", "summary", "payload"]) {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "string") return clip(v, max);
      }
    }
  } catch { /* fall through */ }
  return clip(rawStr, max);
}

function hueFor(name: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

const BcBadge: FC<{ size?: number }> = ({ size = 16 }) => (
  <span style={`width:${size}px;height:${size}px;border-radius:3px;background:#2a2a2a;display:inline-flex;align-items:center;justify-content:center;font-size:7.5px;color:${V2_TOKENS.warn};font-family:${MONO};flex-shrink:0`}>BC</span>
);

const ThreadListItem: FC<{
  thread: ConversationThread;
  selected: boolean;
  /** Query string (without "?") carrying the active filters. */
  keepQs?: string;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
  now: number;
}> = ({ thread, selected, keepQs, agentIds, agentRoles, now }) => {
  const a = thread.participants[0];
  const b = thread.participants[1];
  const isBroadcast = a === "broadcast" || b === "broadcast";
  const live = now - new Date(thread.last_activity).getTime() < LIVE_WINDOW_MS;
  const title = b ? `${a} → ${b}` : a ?? "—";
  const href = `/conversations?id=${encodeURIComponent(thread.thread_id)}${keepQs ? `&${keepQs}` : ""}`;

  return (
    <a href={href}
      style={`display:block;padding:12px 18px;border-bottom:1px solid ${V2_TOKENS.lineRow};text-decoration:none;color:inherit;background:${selected ? `linear-gradient(90deg,${greenGlow(0.07)},transparent)` : "transparent"};border-left:2px solid ${selected ? V2_TOKENS.accent : "transparent"}`}>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        {a && (a === "broadcast"
          ? <BcBadge />
          : <V2Avatar agentId={agentIds[a] ?? a} role={agentRoles[a] ?? undefined} size={16} />)}
        <span style={`color:${V2_TOKENS.textFaint};font-size:10px`}>→</span>
        {isBroadcast && a !== "broadcast" ? (
          <BcBadge />
        ) : b ? (
          <V2Avatar agentId={agentIds[b] ?? b} role={agentRoles[b] ?? undefined} size={16} />
        ) : null}
        <span style="font-size:11.5px;font-weight:600;margin-left:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{title}</span>
        <span style="flex:1" />
        <span style={`width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${live ? V2_TOKENS.accent : "transparent"}`} />
        <span style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.textMute};flex-shrink:0`}>{fmtRel(thread.last_activity, now)}</span>
      </div>
      <div style="font-size:12px;color:#cccccc;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;margin-bottom:3px">
        {previewPayload(thread.first_payload, 80)}
      </div>
      <div style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>
        ctx: {thread.first_context ?? "—"}
      </div>
    </a>
  );
};

const ThreadDetail: FC<{
  thread: ConversationThread;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
  now: number;
}> = ({ thread, agentIds, agentRoles, now }) => {
  const firstSender = thread.messages[0]?.from;
  const live = now - new Date(thread.last_activity).getTime() < LIVE_WINDOW_MS;
  const title = thread.participants.length > 1
    ? `${thread.participants[0]} → ${thread.participants[1]}`
    : thread.participants[0] ?? "Empty thread";

  let lastDay = "";
  return (
    <>
      <div style={`display:flex;align-items:center;gap:12px;padding:16px clamp(16px,2.4vw,28px);border-bottom:1px solid ${V2_TOKENS.line};flex-wrap:wrap`}>
        {firstSender && (
          <V2Avatar
            agentId={agentIds[firstSender] ?? firstSender}
            role={agentRoles[firstSender] ?? undefined}
            size={26}
            bordered />
        )}
        <div style="flex:1;min-width:180px">
          <div style="font-size:14px;font-weight:600">{title}</div>
          <div style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};margin-top:2px`}>
            correlation_id · {thread.thread_id} · {thread.message_count} msg · last activity {fmtRel(thread.last_activity, now)}
          </div>
        </div>
        <span style={`font-family:${MONO};font-size:9.5px;color:#888888;border:1px solid ${V2_TOKENS.line2};padding:3px 9px;border-radius:2px;letter-spacing:0.08em`}>READ-ONLY · ADR-004</span>
        {live && (
          <span style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.accent};border:1px solid ${greenGlow(0.4)};padding:3px 9px;border-radius:2px;letter-spacing:0.08em`}>● SSE LIVE</span>
        )}
      </div>

      <div style="flex:1;overflow-y:auto;padding:22px clamp(16px,2.4vw,32px)">
        {thread.messages.map((m) => {
          const isLeft = m.from === thread.participants[0];
          const hue = hueFor(m.from);
          const corner = isLeft ? "border-bottom-left-radius:2px;" : "border-bottom-right-radius:2px;";
          const day = new Date(m.created_at).toDateString();
          const showSep = day !== lastDay;
          lastDay = day;
          const tc = typeColor(m.type);
          return (
            <>
              {showSep && (
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
                  <span style={`flex:1;height:1px;background:${V2_TOKENS.line}`} />
                  <span style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.textFaint};letter-spacing:0.15em`}>{fmtDayLabel(m.created_at)}</span>
                  <span style={`flex:1;height:1px;background:${V2_TOKENS.line}`} />
                </div>
              )}
              <div style={`display:flex;gap:12px;margin-bottom:18px;align-items:flex-end;flex-direction:${isLeft ? "row" : "row-reverse"}`}>
                <V2Avatar agentId={agentIds[m.from] ?? m.from} role={agentRoles[m.from] ?? undefined} size={28} bordered />
                <div style={`max-width:min(70%,760px);display:flex;flex-direction:column;align-items:${isLeft ? "flex-start" : "flex-end"}`}>
                  <div style={`display:flex;align-items:baseline;gap:8px;margin-bottom:5px;flex-direction:${isLeft ? "row" : "row-reverse"}`}>
                    <span style="font-size:12.5px;font-weight:600">{m.from}</span>
                    <span style={`font-family:${MONO};font-size:9.5px;padding:1px 7px;border-radius:2px;border:1px solid ${tc};color:${tc}`}>{m.type}</span>
                    <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute}`}>{fmtTime(m.created_at)}</span>
                  </div>
                  <div style={`background:oklch(0.23 0.035 ${hue});border:1px solid oklch(0.34 0.06 ${hue});border-radius:10px;${corner}padding:11px 15px;font-size:13px;line-height:1.55;color:#e8e8e8;white-space:pre-wrap`}>
                    {previewPayload(m.payload, 4000)}
                  </div>
                  {m.context && (
                    <div style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};margin-top:4px`}>
                      ctx: {clip(m.context, 90)}
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })}
      </div>

      <div style={`padding:12px clamp(16px,2.4vw,28px);border-top:1px solid ${V2_TOKENS.line};font-family:${MONO};font-size:10px;color:${V2_TOKENS.textFaint};display:flex;gap:14px;flex-wrap:wrap`}>
        <span>replies via <span style={`color:${V2_TOKENS.textDim}`}>mesh_reply</span> only — dashboard is read-only (ADR-004)</span>
        <span style="flex:1" />
        <span>payload ≤ 256 KB · context ≤ 2048 chars</span>
      </div>
    </>
  );
};

export const V2ConversationsPage: FC<V2ConversationsProps> = ({
  result, selectedId, query, filterAgent, agentIds, agentRoles, csrfToken, userRole,
}) => {
  const now = Date.now();
  // Search and agent filter are applied in SQL (listConversations), so
  // `result.data` is already the filtered page.
  const filtered = result.data;
  const opened = filtered.find((t) => t.thread_id === selectedId)
    ?? filtered[0]
    ?? null;
  const keep = new URLSearchParams();
  if (query) keep.set("q", query);
  if (filterAgent) keep.set("agent", filterAgent);
  const keepQs = keep.toString();
  const liveCount = filtered.filter((t) => now - new Date(t.last_activity).getTime() < LIVE_WINDOW_MS).length;

  return (
    <V2Layout title="Conversations" active="CONVOS" userRole={userRole} csrfToken={csrfToken} fullBleed>
      <div class="v2-wrap" style={`flex:1;display:flex;flex-wrap:wrap;align-items:stretch;min-height:720px;border-left:1px solid ${V2_TOKENS.line};border-right:1px solid ${V2_TOKENS.line}`}>
        {/* Left: thread list */}
        <div style={`flex:1 1 320px;max-width:400px;min-width:280px;border-right:1px solid ${V2_TOKENS.line};display:flex;flex-direction:column;background:${V2_TOKENS.panel}`}>
          <div style={`padding:20px 18px 14px;border-bottom:1px solid ${V2_TOKENS.line}`}>
            <div class="v2-eyebrow" style="margin-bottom:6px">THREADS — CORRELATION_ID</div>
            <h1 style="margin:0;font-size:20px;font-weight:700;letter-spacing:-0.02em;text-transform:uppercase">Conversations</h1>
            <div style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute};margin-top:4px`}>
              {result.total} total · <span style={`color:${V2_TOKENS.accent}`}>{liveCount} active</span>
            </div>
            <form method="get" action="/conversations" style="margin-top:12px">
              <input class="v2-input" type="text" name="q" placeholder="Search payload, context, message id…" value={query ?? ""} style="font-size:11.5px;padding:9px 12px" />
              {filterAgent && <input type="hidden" name="agent" value={filterAgent} />}
            </form>
            {filterAgent && (
              <div style={`margin-top:8px;display:flex;gap:8px;align-items:center;font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textDim}`}>
                <span>threads with <span style={`color:${V2_TOKENS.accent}`}>{filterAgent}</span></span>
                <a href={`/conversations${query ? `?q=${encodeURIComponent(query)}` : ""}`} style={`color:${V2_TOKENS.textMute};text-decoration:none`}>✕ clear</a>
              </div>
            )}
          </div>
          <div style="flex:1;overflow-y:auto">
            {filtered.length === 0 ? (
              <div style={`padding:34px 18px;text-align:center;font-family:${MONO};font-size:11px;color:${V2_TOKENS.textMute}`}>
                {query || filterAgent ? "なし · no matches" : "しずか · all quiet — no conversations yet"}
              </div>
            ) : (
              filtered.map((t) => (
                <ThreadListItem
                  thread={t}
                  selected={opened?.thread_id === t.thread_id}
                  keepQs={keepQs}
                  agentIds={agentIds}
                  agentRoles={agentRoles}
                  now={now}
                />
              ))
            )}
            {result.has_more && (
              <a href={`/conversations?offset=${result.offset + result.limit}${keepQs ? `&${keepQs}` : ""}`}
                style={`display:block;padding:13px;text-align:center;font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.accent};border-top:1px solid ${V2_TOKENS.lineRow};text-decoration:none;letter-spacing:0.08em`}>
                OLDER →
              </a>
            )}
          </div>
        </div>

        {/* Right: thread detail */}
        <div style="flex:1 1 480px;min-width:0;display:flex;flex-direction:column">
          {opened ? (
            <ThreadDetail thread={opened} agentIds={agentIds} agentRoles={agentRoles} now={now} />
          ) : (
            <div style={`flex:1;display:flex;align-items:center;justify-content:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
              もしもし — pick a conversation on the left.
            </div>
          )}
        </div>
      </div>
    </V2Layout>
  );
};
