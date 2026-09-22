// Whose request is this? (src/services/client-ip.ts)
//
// The service sits behind Coolify's proxy, and that behind Cloudflare. But
// an origin answers whoever finds its address, unless a firewall says
// otherwise. So CF-Connecting-IP is a header anybody can send, unless the
// connection to the proxy really came from Cloudflare.

import { describe, it, expect } from "vitest";
import { clientIp, clientKey, isCloudflare, shortIp } from "../../src/services/client-ip";

const req = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] });

describe("isCloudflare", () => {
  it("knows Cloudflare's published ranges, v4 and v6, and nothing else", () => {
    for (const ip of ["188.114.97.3", "104.16.0.1", "172.64.0.0", "172.71.255.255", "162.159.255.255", "2606:4700::1", "2a06:98c7:ffff::1"]) expect(isCloudflare(ip), ip).toBe(true);
    for (const ip of ["203.0.113.7", "172.72.0.0", "172.63.255.255", "104.32.0.0", "10.0.0.1", "127.0.0.1", "2606:4800::1", "::1", "", "not an ip", "188.114.97.3, 1.2.3.4"]) expect(isCloudflare(ip), ip).toBe(false);
  });

  it("sees through an IPv4 address in IPv6 clothing", () => {
    expect(isCloudflare("::ffff:188.114.97.3")).toBe(true);
    expect(isCloudflare("::ffff:203.0.113.7")).toBe(false);
  });
});

describe("clientIp", () => {
  it("believes CF-Connecting-IP when the last hop before the proxy was Cloudflare", () => {
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3", "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 188.114.97.3", "cf-connecting-ip": "2001:db8::7" }))).toBe("2001:db8:0:0:0:0:0:7");
  });

  it("does not believe it when the connection came from anywhere else: that is somebody at the origin's front door", () => {
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.9", "cf-connecting-ip": "203.0.113.7" }))).toBe("198.51.100.9");
    // A forged X-Forwarded-For does not help either: the proxy appends the real peer, and the LAST entry counts.
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3, 198.51.100.9", "cf-connecting-ip": "203.0.113.7" }))).toBe("198.51.100.9");
  });

  it("takes the hop itself when Cloudflare sent no usable client address", () => {
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3" }))).toBe("188.114.97.3");
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3", "cf-connecting-ip": "<script>" }))).toBe("188.114.97.3");
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3", "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }))).toBe("188.114.97.3");
  });

  it("falls back to the socket without a proxy, and to one shared name without either", () => {
    expect(clientIp(req({}), "::ffff:192.0.2.5")).toBe("192.0.2.5");
    expect(clientIp(req({ "x-forwarded-for": "garbage" }), "192.0.2.5")).toBe("192.0.2.5");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("never returns what it was given unchecked: the value ends up in a log line and as a map key", () => {
    for (const hostile of ["constructor", "__proto__", "1.2.3.4\nX: y", "999.1.1.1", " "]) {
      expect(clientIp(req({ "x-forwarded-for": hostile }))).toBe("unknown");
    }
  });
});

describe("shortIp", () => {
  it("drops the host part: enough to see a pattern, not enough to name a person", () => {
    expect(shortIp("203.0.113.77")).toBe("203.0.113.x");
    expect(shortIp("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe("2001:db8:1234::/48");
    expect(shortIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(shortIp("unknown")).toBe("unknown");
    expect(shortIp("junk")).toBe("unknown");
  });
});

describe("clientIp without a proxy in front", () => {
  // `npm run dev`, a port published for debugging, a LAN host: nothing appends
  // the peer there, so the headers are whatever the sender typed.
  it("believes the socket and nothing else", () => {
    const direct = { behindProxy: false };
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }), "192.0.2.10", direct)).toBe("192.0.2.10");
    expect(clientIp(req({ "x-forwarded-for": "188.114.97.3", "cf-connecting-ip": "203.0.113.9" }), "192.0.2.10", direct)).toBe("192.0.2.10");
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.9" }), "188.114.97.3", direct)).toBe("188.114.97.3");
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }), undefined, direct)).toBe("unknown");
  });

  it("believes the proxy when told there is one, which is the default", () => {
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }), "10.0.1.5", { behindProxy: true })).toBe("198.51.100.1");
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }), "10.0.1.5")).toBe("198.51.100.1");
  });
});

describe("what comes out of clientIp is one spelling of one address", () => {
  const viaProxy = (hop: string) => clientIp(req({ "x-forwarded-for": hop }), "10.0.1.5");

  it("drops a zone id, however long", () => {
    expect(viaProxy("fe80::1%en0")).toBe("fe80:0:0:0:0:0:0:1");
    expect(viaProxy("fe80::1%" + "z".repeat(15_000))).toBe("fe80:0:0:0:0:0:0:1");
  });

  it("unwraps an IPv4 address inside IPv6, in every spelling", () => {
    for (const mapped of ["::ffff:1.2.3.4", "::FFFF:1.2.3.4", "::ffff:102:304", "0:0:0:0:0:ffff:1.2.3.4", "0000:0000:0000:0000:0000:ffff:0102:0304"]) {
      expect(viaProxy(mapped), mapped).toBe("1.2.3.4");
    }
  });

  it("writes an IPv6 address one way", () => {
    for (const same of ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0:0:0:0:0:1", "2001:DB8::0:1"]) {
      expect(viaProxy(same), same).toBe("2001:db8:0:0:0:0:0:1");
    }
  });

  it("refuses what is no address", () => {
    for (const bad of ["", " ", "1.2.3", "1.2.3.4.5", "2001:db8:::1", "g::1", "%en0", "x".repeat(100)]) {
      expect(viaProxy(bad), bad).toBe("10.0.1.5");
    }
  });
});

describe("clientKey: what failures are counted against", () => {
  it("an IPv4 address is one client", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("203.0.113.8")).not.toBe(clientKey("203.0.113.7"));
  });

  it("an IPv6 /64 is one client: a host there owns all of it", () => {
    const keys = ["2001:db8:1:1::1", "2001:0db8:0001:0001:ffff:ffff:ffff:ffff", "2001:db8:1:1:0:0:0:9%en0", "2001:DB8:1:1::12c"].map(clientKey);
    expect(new Set(keys)).toEqual(new Set(["2001:db8:1:1::/64"]));
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });

  it("is bounded, whatever goes in", () => {
    expect(clientKey("fe80::1%" + "z".repeat(15_000))).toBe("fe80:0:0:0::/64");
    expect(clientKey("unknown")).toBe("unknown");
    expect(clientKey("x".repeat(10_000))).toBe("unknown");
    expect(clientKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
});
