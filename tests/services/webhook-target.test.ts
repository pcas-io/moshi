// Where a webhook may go (src/services/webhook-target.ts): https on 443, to a
// public address, checked again on every call and pinned to what was checked.

import { describe, it, expect } from "vitest";
import { checkUrl, isPublicAddress, resolveTarget } from "../../src/services/webhook-target";

describe("checkUrl", () => {
  it("takes an https URL on the default port and normalises it", () => {
    const r = checkUrl("https://Hooks.Example.com/trigger/abc?x=1");
    expect(r).toEqual({ ok: true, url: "https://hooks.example.com/trigger/abc?x=1", host: "hooks.example.com" });
    expect(checkUrl("https://hooks.example.com:443/t")).toMatchObject({ ok: true, url: "https://hooks.example.com/t" });
  });

  it("refuses the acceptance criteria's targets: http, localhost, 127.0.0.1, 10.x, 169.254.x", () => {
    for (const bad of [
      "http://hooks.example.com/t",
      "https://localhost/t",
      "https://127.0.0.1/t",
      "https://10.1.2.3/t",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(checkUrl(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("refuses other ports, credentials, fragments, single-label and internal names", () => {
    for (const bad of [
      "https://hooks.example.com:8443/t",
      "https://user:pw@hooks.example.com/t",
      "https://hooks.example.com/t#frag",
      "https://intranet/t",
      "https://printer.local/t",
      "https://db.internal/t",
      "https://app.localhost/t",
      "https://localhost./t",
      "https://printer.local./t",
      "https://[::1]/t",
      "https://[fd00::1]/t",
      "https://[::ffff:127.0.0.1]/t",
      "ftp://hooks.example.com/t",
      "not a url",
      `https://hooks.example.com/${"a".repeat(2100)}`,
    ]) {
      expect(checkUrl(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("takes a public IP literal", () => {
    expect(checkUrl("https://93.184.215.14/t")).toMatchObject({ ok: true, host: "93.184.215.14" });
    expect(checkUrl("https://[2606:4700::1111]/t")).toMatchObject({ ok: true, host: "2606:4700::1111" });
  });
});

describe("isPublicAddress", () => {
  it("refuses every private, local, shared, reserved and documentation range", () => {
    for (const ip of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254",
      "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1",
      "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1",
      "2001:db8::1", "2001::1", "2002:c000:0204::1", "64:ff9b::7f00:1", "100::1",
      "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("takes public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("calls an address with a zone id not public, and does not throw on it", () => {
    expect(isPublicAddress("fe80::1%eth0")).toBe(false);
    expect(isPublicAddress("2606:4700::1111%eth0")).toBe(false);
  });

  it("refuses what is not an address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("resolveTarget", () => {
  const lookup = (answers: Record<string, string[]>) => async (host: string) => {
    const found = answers[host];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  it("hands over every checked address, IPv4 first, for a dual-stack host listed IPv6 first", async () => {
    const r = await resolveTarget("hooks.example.com", lookup({ "hooks.example.com": ["2606:4700::1111", "93.184.215.14"] }));
    expect(r).toEqual({
      ok: true, address: "93.184.215.14", family: 4,
      addresses: [{ address: "93.184.215.14", family: 4 }, { address: "2606:4700::1111", family: 6 }],
    });
  });

  it("gives up on a lookup that does not answer, as something that may pass", async () => {
    const silent = () => new Promise<never>(() => { /* a black-holed name server */ });
    const started = Date.now();
    expect(await resolveTarget("slow.example.com", silent, 50)).toEqual({ ok: false, retryable: true, reason: "dns: ETIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses a name with ANY private address: rebinding hides one among public ones", async () => {
    const r = await resolveTarget("rebind.example.com", lookup({ "rebind.example.com": ["93.184.215.14", "127.0.0.1"] }));
    expect(r).toMatchObject({ ok: false, retryable: false });
  });

  it("says a failed lookup may pass, a private answer will not", async () => {
    expect(await resolveTarget("gone.example.com", lookup({}))).toMatchObject({ ok: false, retryable: true });
    expect(await resolveTarget("inner.example.com", lookup({ "inner.example.com": ["10.0.0.5"] }))).toMatchObject({ ok: false, retryable: false });
  });

  it("checks an IP literal without asking DNS", async () => {
    const never = async () => { throw new Error("asked DNS"); };
    expect(await resolveTarget("93.184.215.14", never)).toEqual({ ok: true, address: "93.184.215.14", family: 4 });
    expect(await resolveTarget("10.0.0.5", never)).toMatchObject({ ok: false, retryable: false });
  });
});
