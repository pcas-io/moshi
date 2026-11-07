// Who did an audited action, from where, as a route knows it: the actor, the
// origin, and the client address hashed the way `registration_audit` hashes it
// (`hashIP`, src/auth.ts). The address itself never reaches a row or a log.

import type { Context } from "hono";
import { hashIP } from "../auth.js";
import { clientIp } from "./client-ip.js";
import type { AuditBy, AuditOrigin } from "./activity.js";

/** `hashIP` of the request's client, or null when no address is known. */
export function requestIpHash(c: Context): string | null {
  // Unset outside createApp (route tests that mount one router): believe the
  // proxy headers like the sign-in guard's default does.
  const behindProxy = (c.get("behindProxy" as never) as boolean | undefined) ?? true;
  const peer = (c.get("peerAddress" as never) as string | undefined) ?? undefined;
  const ip = clientIp(c.req, peer, { behindProxy });
  return ip === "unknown" ? null : hashIP(ip);
}

export function auditBy(c: Context, actor: string, origin: AuditOrigin): AuditBy {
  return { actor, origin, ip_hash: requestIpHash(c) };
}
