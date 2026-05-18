// V2 Conversations — Soft Pastel split-view (list + bubble thread).
// Replaces the v1 accordion in src/views/conversations.tsx.

import type { FC } from "hono/jsx";
import type { ConversationThread } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Btn, V2Avatar } from "./components.js";
import { V2_TOKENS } from "./tokens.js";

export interface V2ConversationsProps {
  result: PaginatedResult<ConversationThread>;
  selectedId?: string;
  query?: string;
  agentRoles: Record<string, string | null>;
  agentIds: Record<string, string>;
  csrfToken?: string;
  userRole?: string;
}

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

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function previewPayload(raw: string, max: number = 240): string {
  try {
    const o = JSON.parse(raw);
    if (typeof o === "string") return clip(o, max);
    if (o && typeof o === "object") {
      for (const k of ["text", "message", "summary", "payload"]) {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "string") return clip(v, max);
      }
    }
  } catch { /* fall through */ }
  return clip(raw, max);
}

function hueFor(name: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

const PARTICIPANT_LIMIT = 2; // a → b shown explicitly; rest folded

const ThreadListItem: FC<{
  thread: ConversationThread;
  selected: boolean;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
}> = ({ thread, selected, agentIds, agentRoles }) => {
  const a = thread.participants[0];
  const b = thread.participants[1];
  const aId = a ? (agentIds[a] ?? a) : "";
  const aRole = a ? agentRoles[a] : null;
  const bId = b ? (agentIds[b] ?? b) : "";
  const bRole = b ? agentRoles[b] : null;
  const isBroadcast = b === "broadcast" || (a === "broadcast");

  return (
    <a href={`/conversations?id=${encodeURIComponent(thread.thread_id)}`}
      style={`display:block;padding:11px 18px;border-bottom:1px solid ${V2_TOKENS.line};text-decoration:none;color:inherit;background:${selected ? `linear-gradient(180deg, rgba(255,143,179,0.14), rgba(255,143,179,0.06))` : "transparent"};border-left:2px solid ${selected ? V2_TOKENS.accent : "transparent"}`}>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        {a && <V2Avatar agentId={aId} role={aRole ?? undefined} size={16} />}
        <span style={`color:${V2_TOKENS.textMute};font-size:11px`}>→</span>
        {isBroadcast || !b ? (
          <span style={`width:16px;height:16px;border-radius:${V2_TOKENS.radius}px;background:${V2_TOKENS.surface3};display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>BC</span>
        ) : (
          <V2Avatar agentId={bId} role={bRole ?? undefined} size={16} />
        )}
        <div style="flex:1" />
        <span style={`font-size:11px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>{fmtRel(thread.last_activity)}</span>
      </div>
      <div style={`font-size:13px;font-weight:500;margin-bottom:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden`}>
        {clip(previewPayload(thread.first_payload), 80)}
      </div>
      <div style={`font-size:12px;color:${V2_TOKENS.textDim};line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden`}>
        {thread.first_context ?? ""}
      </div>
    </a>
  );
};

const ThreadDetail: FC<{
  thread: ConversationThread;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
}> = ({ thread, agentIds, agentRoles }) => {
  const firstSender = thread.messages[0]?.from;
  return (
    <>
      <div style={`padding:16px 28px;border-bottom:1px solid ${V2_TOKENS.line};display:flex;align-items:center;gap:12px`}>
        {firstSender && (
          <V2Avatar
            agentId={agentIds[firstSender] ?? firstSender}
            role={agentRoles[firstSender] ?? undefined}
            size={26} />
        )}
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600">
            {thread.participants.length > 0 ? thread.participants.slice(0, PARTICIPANT_LIMIT).join(" → ") : "Empty thread"}
          </div>
          <div style={`font-size:11.5px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>
            correlation_id · {thread.thread_id} · {thread.message_count} msg · last activity {fmtRel(thread.last_activity)}
          </div>
        </div>
        <span class="v2-tag" style={`color:${V2_TOKENS.textMute};background:linear-gradient(180deg, ${V2_TOKENS.surface2}, ${V2_TOKENS.surface3});border-color:${V2_TOKENS.line2};box-shadow:inset 0 1px 0 rgba(255,255,255,0.55)`}>read-only · ADR-004</span>
      </div>

      <div style="flex:1;padding:24px 32px;overflow-y:auto">
        {thread.messages.map((m) => {
          const a = thread.participants[0];
          const isLeft = m.from === a;
          const hue = hueFor(m.from);
          // Bubble: 2-stop oklch gradient + oklch border + 4-layer shadow + sheen overlay
          const tintBg = `linear-gradient(180deg, oklch(0.97 0.05 ${hue}) 0%, oklch(0.93 0.07 ${hue}) 100%)`;
          const tintBorder = `oklch(0.87 0.05 ${hue})`;
          const corner = isLeft ? "border-bottom-left-radius:6px;" : "border-bottom-right-radius:6px;";
          const bubbleShadow =
            "0 1px 0 rgba(255,255,255,0.85) inset," +
            " 0 6px 16px rgba(217,130,175,0.14)";
          return (
            <div style={`display:flex;flex-direction:${isLeft ? "row" : "row-reverse"};gap:12px;margin-bottom:18px;align-items:flex-end`}>
              <V2Avatar agentId={agentIds[m.from] ?? m.from} role={agentRoles[m.from] ?? undefined} size={28} />
              <div style={`max-width:70%;display:flex;flex-direction:column;align-items:${isLeft ? "flex-start" : "flex-end"}`}>
                <div style={`display:flex;align-items:baseline;gap:8px;margin-bottom:5px;flex-direction:${isLeft ? "row" : "row-reverse"}`}>
                  <span style="font-weight:600;font-size:12.5px">{m.from}</span>
                  <span style={`font-size:10.5px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>{fmtTime(m.created_at)}</span>
                </div>
                <div style={`position:relative;background:${tintBg};border:1px solid ${tintBorder};border-radius:18px;${corner}padding:11px 15px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;box-shadow:${bubbleShadow}`}>
                  <span class="v2-sheen" style="border-radius:18px" />
                  <span style="position:relative">{previewPayload(m.payload, 4000)}</span>
                </div>
                {m.context && (
                  <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};margin-top:4px;font-family:${V2_TOKENS.text}`}>
                    ctx: {clip(m.context, 90)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

export const V2ConversationsPage: FC<V2ConversationsProps> = ({
  result, selectedId, query, agentIds, agentRoles, csrfToken, userRole,
}) => {
  const filtered = query
    ? result.data.filter((t) => {
        const q = query.toLowerCase();
        return t.first_payload.toLowerCase().includes(q)
          || t.first_context?.toLowerCase().includes(q)
          || t.participants.some((p) => p.toLowerCase().includes(q));
      })
    : result.data;
  const opened = filtered.find((t) => t.thread_id === selectedId)
    ?? filtered[0]
    ?? null;
  const liveCount = filtered.filter((t) => Date.now() - new Date(t.last_activity).getTime() < 15 * 60_000).length;

  return (
    <V2Layout title="Conversations" active="CONVOS" userRole={userRole} csrfToken={csrfToken}>
      <div style={`display:grid;grid-template-columns:340px 1fr;height:calc(100vh - 80px);min-height:760px`}>
        {/* Left: list */}
        <div style={`border-right:1px solid ${V2_TOKENS.line};display:flex;flex-direction:column;background:rgba(255,255,255,0.4)`}>
          <div style={`padding:20px 18px 12px;border-bottom:1px solid ${V2_TOKENS.line}`}>
            <h1 style="font-size:18px;font-weight:700;margin:0;letter-spacing:-0.02em">Conversations</h1>
            <div style={`font-size:12.5px;color:${V2_TOKENS.textMute};margin-top:3px;font-family:${V2_TOKENS.text}`}>
              {result.total} total · {liveCount} active
            </div>
            <form method="get" action="/conversations" style="margin-top:12px">
              <input class="v2-input" type="text" name="q" placeholder="Search payload, ctx, agent…" value={query ?? ""} />
              {selectedId && <input type="hidden" name="id" value={selectedId} />}
            </form>
          </div>
          <div style="flex:1;overflow-y:auto">
            {filtered.length === 0 ? (
              <div style={`padding:40px 20px;text-align:center;color:${V2_TOKENS.textMute};font-size:12.5px`}>
                {query ? "なし · No matches." : "しずか · noch ganz ruhig hier — keine Conversations."}
              </div>
            ) : (
              filtered.map((t) => (
                <ThreadListItem
                  thread={t}
                  selected={opened?.thread_id === t.thread_id}
                  agentIds={agentIds}
                  agentRoles={agentRoles}
                />
              ))
            )}
            {result.has_more && (
              <a href={`/conversations?offset=${result.offset + result.limit}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
                style={`display:block;padding:14px;text-align:center;font-size:12px;color:${V2_TOKENS.textDim};border-top:1px solid ${V2_TOKENS.line};text-decoration:none`}>
                Older →
              </a>
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div style="display:flex;flex-direction:column">
          {opened ? (
            <ThreadDetail thread={opened} agentIds={agentIds} agentRoles={agentRoles} />
          ) : (
            <div style={`flex:1;display:flex;align-items:center;justify-content:center;color:${V2_TOKENS.textMute};font-size:13px`}>
              もしもし — wähl links eine Conversation.
            </div>
          )}
        </div>
      </div>
    </V2Layout>
  );
};
