// Whose request is this?
//
// The container is reachable through Coolify's proxy only, and the proxy puts
// the address of whoever connected to IT at the end of X-Forwarded-For. In
// production that is a Cloudflare edge, and Cloudflare names the real client
// in CF-Connecting-IP.
//
// But an origin answers whoever finds its address, unless a firewall says
// otherwise. So CF-Connecting-IP is believed only when the last hop is one
// of Cloudflare's published ranges. Everybody else is their own last hop.

import { BlockList, isIP } from "node:net";

// https://www.cloudflare.com/ips-v4 and /ips-v6, read 2026-09-20.
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_V4) cloudflare.addSubnet(range.split("/")[0], Number(range.split("/")[1]), "ipv4");
for (const range of CLOUDFLARE_V6) cloudflare.addSubnet(range.split("/")[0], Number(range.split("/")[1]), "ipv6");

/** Longest spelling of an address: IPv6 with a dotted IPv4 tail. */
const MAX_ADDRESS_CHARS = 45;

/** The eight groups of a VALID IPv6 address (no zone). */
function groupsOf(v6: string): number[] {
  let text = v6;
  // A dotted tail ("::ffff:1.2.3.4") is two groups.
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const [a, b, c, d] = text.slice(cut + 1).split(".").map(Number);
    text = `${text.slice(0, cut + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

/**
 * ONE spelling of an address, or null for anything that is none. The result
 * becomes a map key and part of a log line, so everything a sender can vary
 * is taken out: the zone id (`isIP` accepts one of any length), upper case,
 * leading zeros, "::" in different places, and IPv4 wrapped in IPv6 in any of
 * its forms. IPv6 comes out as eight groups without "::".
 */
function normalise(value: string | undefined): string | null {
  const bare = (value ?? "").trim().split("%")[0];
  if (bare.length === 0 || bare.length > MAX_ADDRESS_CHARS) return null;
  const kind = isIP(bare);
  if (kind === 4) return bare;
  if (kind !== 6) return null;
  const groups = groupsOf(bare);
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  return groups.map((g) => g.toString(16)).join(":");
}

export function isCloudflare(ip: string): boolean {
  const address = normalise(ip);
  if (!address) return false;
  return cloudflare.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

export interface ClientIpOptions {
  /** Is there a proxy in front that appends its peer to X-Forwarded-For?
   *  Without one the headers are whatever the sender typed. */
  behindProxy?: boolean;
}

/**
 * The client's address in its one spelling, or "unknown". Only ever an
 * address the code has parsed: the value becomes a map key and part of a log
 * line.
 */
export function clientIp(
  req: { header: (name: string) => string | undefined },
  socketAddress?: string,
  { behindProxy = true }: ClientIpOptions = {},
): string {
  if (!behindProxy) return normalise(socketAddress) ?? "unknown";
  const forwarded = req.header("x-forwarded-for");
  // The LAST entry is the one the nearest proxy added. Everything before it
  // is whatever the sender liked to claim.
  const hop = normalise(forwarded?.split(",").pop()) ?? normalise(socketAddress);
  if (!hop) return "unknown";
  if (isCloudflare(hop)) return normalise(req.header("cf-connecting-ip")) ?? hop;
  return hop;
}

/**
 * What failures are counted against. An IPv4 address is one client. An IPv6
 * client is its /64: whoever has one address there has all 2^64 of them, and
 * counted per address it was never throttled at all.
 */
export function clientKey(ip: string): string {
  const address = normalise(ip);
  if (!address) return "unknown";
  if (isIP(address) === 4) return address;
  return `${address.split(":").slice(0, 4).join(":")}::/64`;
}

/** For log lines: the network, not the host. */
export function shortIp(ip: string): string {
  const address = normalise(ip);
  if (!address) return "unknown";
  if (isIP(address) === 4) return address.replace(/\.\d+$/, ".x");
  return `${address.split(":").slice(0, 3).join(":")}::/48`;
}
