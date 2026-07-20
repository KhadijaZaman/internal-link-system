import { describe, it, expect } from "vitest";
import { isPrivateOrReservedIp, assertPublicUrl } from "./htmlFetch";

describe("isPrivateOrReservedIp", () => {
  it("flags IPv4 private/reserved ranges", () => {
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true); // multicast
    expect(isPrivateOrReservedIp("255.255.255.255")).toBe(true);
  });

  it("allows public IPv4 addresses", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedIp("172.15.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedIp("193.0.0.1")).toBe(false);
  });

  it("flags IPv6 loopback, unspecified, ULA, and link-local", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("::")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows public IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("treats non-IP garbage as reserved (fail closed)", () => {
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
    expect(isPrivateOrReservedIp("")).toBe(true);
  });
});

describe("assertPublicUrl (SSRF guard)", () => {
  it("rejects invalid URLs", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/Disallowed protocol/);
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toThrow(/Disallowed protocol/);
  });

  it("rejects localhost and internal hostnames without DNS", async () => {
    await expect(assertPublicUrl("http://localhost/x")).rejects.toThrow(/Disallowed hostname/);
    await expect(assertPublicUrl("http://api.localhost/x")).rejects.toThrow(
      /Disallowed hostname/,
    );
    await expect(assertPublicUrl("http://db.internal/x")).rejects.toThrow(/Disallowed hostname/);
    await expect(assertPublicUrl("http://printer.local/x")).rejects.toThrow(
      /Disallowed hostname/,
    );
  });

  it("rejects private and metadata IP literals", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/x")).rejects.toThrow(/private\/reserved/);
    await expect(assertPublicUrl("http://10.1.2.3/x")).rejects.toThrow(/private\/reserved/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private\/reserved/,
    );
    await expect(assertPublicUrl("http://192.168.0.10/x")).rejects.toThrow(/private\/reserved/);
  });

  it("accepts a public IP literal and pins the connection to it", async () => {
    const v = await assertPublicUrl("https://8.8.8.8/dns");
    expect(v.pinnedIp).toBe("8.8.8.8");
    expect(v.pinnedFamily).toBe(4);
    expect(v.url.hostname).toBe("8.8.8.8");
  });
});
