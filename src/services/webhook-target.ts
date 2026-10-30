// Where a webhook may go, and the one function that calls it.
//
// Any agent can name a URL, and moshi then makes the request from inside its
// own network. So: https only, port 443 only, no credentials in the URL, and
// the host must resolve to public addresses ONLY. A name with one private
// address among public ones is refused, because DNS rebinding works exactly
// that way. The check runs when the hook is set AND before every call, and
// the call connects to the address that was checked (`lookup` is pinned), so
// the name cannot point somewhere else between check and connect. Redirects
// are never followed: a 3xx is a failed delivery.

import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { VERSION } from "../types.js";

export const MAX_URL_LENGTH = 2048;
export const DELIVERY_TIMEOUT_MS = 5_000;
/** DNS has its own bound: getaddrinfo runs on the small libuv pool, and an
 *  agent can name a host whose servers never answer. */
export const DNS_TIMEOUT_MS = 3_000;

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// ::/96 holds ::, ::1 and the deprecated IPv4-compatible form; IPv4-mapped
// addresses are unwrapped and judged as IPv4 before this list is asked.
const V6_BLOCKED: [string, number][] = [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

const blocked = new net.BlockList();
for (const [address, prefix] of V4_BLOCKED) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of V6_BLOCKED) blocked.addSubnet(address, prefix, "ipv6");

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

/** `::ffff:7f00:1` and `::ffff:127.0.0.1` as the IPv4 address they carry. */
function mappedIpv4(ipv6: string): string | null {
  // URL refuses a zone id (`fe80::1%eth0`), which net.isIP accepts; the
  // caller has judged such an address already.
  const canonical = new URL(`http://[${ipv6}]/`).hostname.slice(1, -1);
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  // A zone id only exists for link-local and other scoped addresses.
  if (address.includes("%")) return false;
  const v4 = mappedIpv4(address);
  if (v4 !== null) return !blocked.check(v4, "ipv4");
  return !blocked.check(address, "ipv6");
}

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

/** What a hook URL has to be, before anybody asks DNS about it. */
export function checkUrl(raw: string): UrlCheck {
  const refuse = (reason: string): UrlCheck => ({ ok: false, reason });
  if (raw.length > MAX_URL_LENGTH) return refuse(`the URL is longer than ${MAX_URL_LENGTH} characters`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return refuse("not a URL");
  }
  if (u.protocol !== "https:") return refuse("only https:// URLs are accepted");
  if (u.username || u.password) return refuse("credentials in the URL are not accepted; use the secret");
  if (u.port !== "") return refuse("only the default port 443 is accepted");
  if (raw.includes("#")) return refuse("a URL with a #fragment is not accepted");
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) return refuse("the address is not public (private, loopback, link-local or reserved)");
  } else if (!host.replace(/\.$/, "").includes(".") || INTERNAL_NAME.test(host.replace(/\.$/, ""))) {
    // `localhost.` is localhost: the trailing dot only says "fully qualified".
    return refuse("the host is not a public name");
  }
  return { ok: true, url: u.toString(), host };
}

export type Address = { address: string; family: 4 | 6 };

/** `address` is the first to try (IPv4 first); `addresses` all that were
 *  checked, for a client that falls back from one family to the other. */
export type Resolved =
  | ({ ok: true; addresses?: Address[] } & Address)
  | { ok: false; retryable: boolean; reason: string };

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function bounded(lookup: Lookup, host: string, timeoutMs: number): Promise<{ address: string; family: number }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" })), timeoutMs);
  });
  return Promise.race([lookup(host), late]).finally(() => clearTimeout(timer));
}

/** The addresses to connect to: every address of the name has to be public. */
export async function resolveTarget(host: string, lookup: Lookup = systemLookup, timeoutMs: number = DNS_TIMEOUT_MS): Promise<Resolved> {
  const literal = net.isIP(host);
  if (literal) {
    return isPublicAddress(host)
      ? { ok: true, address: host, family: literal as 4 | 6 }
      : { ok: false, retryable: false, reason: "target_not_public" };
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await bounded(lookup, host, timeoutMs);
  } catch (err) {
    return { ok: false, retryable: true, reason: `dns: ${(err as { code?: string }).code ?? "lookup failed"}` };
  }
  if (answers.length === 0) return { ok: false, retryable: true, reason: "dns: no address" };
  if (!answers.every((a) => isPublicAddress(a.address))) {
    return { ok: false, retryable: false, reason: "target_not_public" };
  }
  // Every answer, IPv4 first: a container without an IPv6 route would fail
  // on every call to a dual-stack host whose resolver lists IPv6 first, and
  // five such calls switch the hook off.
  const addresses: Address[] = answers
    .map((a): Address => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
    .sort((a, b) => a.family - b.family);
  return { ok: true, ...addresses[0], addresses };
}

export type PostResult =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; status?: number; error: string };

/** Only for tests: a local server cannot be reached on a public address and 443. */
export interface PostSeams {
  resolve?: (host: string) => Promise<Resolved>;
  port?: number;
  ca?: string | Buffer;
}

function classify(status: number): PostResult {
  if (status >= 200 && status < 300) return { ok: true, status };
  if (status >= 300 && status < 400) return { ok: false, retryable: false, status, error: `HTTP ${status}: redirects are not followed` };
  const retryable = status === 408 || status === 429 || status >= 500;
  return { ok: false, retryable, status, error: `HTTP ${status}` };
}

/**
 * One POST. Never throws, and never takes longer than `DNS_TIMEOUT_MS` for the
 * lookup plus `timeoutMs` for the request. What it reports as `error`
 * contains no header value: the secret travels in one.
 */
export async function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number = DELIVERY_TIMEOUT_MS,
  seams: PostSeams = {},
): Promise<PostResult> {
  const checked = checkUrl(url);
  if (!checked.ok) return { ok: false, retryable: false, error: checked.reason };
  const target = await (seams.resolve ?? resolveTarget)(checked.host);
  if (!target.ok) return { ok: false, retryable: target.retryable, error: target.reason };
  const u = new URL(checked.url);

  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const finish = (result: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    const req = https.request({
      hostname: checked.host,
      port: seams.port ?? 443,
      path: `${u.pathname}${u.search}`,
      method: "POST",
      agent: false,
      ca: seams.ca,
      servername: net.isIP(checked.host) ? undefined : checked.host,
      // The addresses that were checked, and no other: no second lookup.
      lookup: (_host, options, callback) => {
        if ((options as { all?: boolean }).all) {
          (callback as (err: null, addresses: Address[]) => void)(null, target.addresses ?? [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      },
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "user-agent": `moshi-webhooks/${VERSION}`,
      },
    });
    const timer = setTimeout(() => finish({ ok: false, retryable: true, error: `timeout after ${timeoutMs} ms` }), timeoutMs);
    req.on("response", (res) => {
      res.resume();
      finish(classify(res.statusCode ?? 0));
    });
    req.on("error", (err) => finish({ ok: false, retryable: true, error: String((err as NodeJS.ErrnoException).code ?? err.message).slice(0, 200) }));
    req.end(body);
  });
}
