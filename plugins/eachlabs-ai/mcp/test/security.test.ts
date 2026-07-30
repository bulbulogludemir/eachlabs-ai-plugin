import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeFetchUrl,
  isPrivateAddress,
  parsePublicHttpsUrl,
  rawRequestPolicyError,
} from "../src/core/security.ts";

test("private and local media destinations are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fd00::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.throws(() => parsePublicHttpsUrl("http://cdn.example/image.png"));
  assert.throws(() => parsePublicHttpsUrl("https://localhost/image.png"));
  assert.throws(() => parsePublicHttpsUrl("https://127.0.0.1/image.png"));
  assert.throws(() => parsePublicHttpsUrl("https://[::1]/image.png"));
});

test("DNS answers are checked before media fetches", async () => {
  await assert.rejects(
    assertSafeFetchUrl(
      "https://cdn.example/image.png",
      async () => [{ address: "169.254.169.254", family: 4 }],
    ),
  );
  const safe = await assertSafeFetchUrl(
    "https://cdn.example/image.png",
    async () => [{ address: "203.0.113.10", family: 4 }],
  );
  assert.equal(safe.hostname, "cdn.example");
});

test("raw request policy blocks unauthenticated writes only", () => {
  assert.match(rawRequestPolicyError("POST", false) ?? "", /blocked/i);
  assert.equal(rawRequestPolicyError("GET", false), undefined);
  assert.equal(rawRequestPolicyError("POST", true), undefined);
});
