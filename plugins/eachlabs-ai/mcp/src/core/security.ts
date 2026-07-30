import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type LookupAddress = { address: string; family: number };
type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 ? privateIpv4(mapped) : true;
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

export function parsePublicHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Media URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Media URLs must not contain credentials.");
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local and internal media hosts are blocked.");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("Private media addresses are blocked.");
  }
  return url;
}

export async function assertSafeFetchUrl(
  raw: string,
  lookupFn: LookupFn = lookup as LookupFn,
): Promise<URL> {
  const url = parsePublicHttpsUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(hostname)) {
    const addresses = await lookupFn(hostname, {
      all: true,
      verbatim: true,
    });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new Error("Media host resolves to a private or invalid address.");
    }
  }
  return url;
}

export async function safeMediaFetch(
  raw: string,
  init: RequestInit = {},
): Promise<Response> {
  let current = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const url = await assertSafeFetchUrl(current);
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === 3) {
      throw new Error("Media redirect limit exceeded.");
    }
    current = new URL(location, url).href;
  }
  throw new Error("Media redirect limit exceeded.");
}

export function rawRequestPolicyError(
  method: string,
  authenticated: boolean,
): string | undefined {
  if (!authenticated && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    return "Unauthenticated raw write requests are blocked. Use a first-class public workflow tool or enable authenticated access.";
  }
  return undefined;
}
