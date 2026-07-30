import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthHeaders,
  eachRequest,
  isRetrySafeMethod,
  retryDelayMs,
} from "../src/core/http.ts";

test("Bearer is the modern auth default and legacy X-API-Key remains explicit", () => {
  const bearer = applyAuthHeaders(new Headers(), "secret", "bearer");
  assert.equal(bearer.get("authorization"), "Bearer secret");
  assert.equal(bearer.get("x-api-key"), null);

  const legacy = applyAuthHeaders(new Headers(), "secret", "x-api-key");
  assert.equal(legacy.get("x-api-key"), "secret");
  assert.equal(legacy.get("authorization"), null);
});

test("only read-only HTTP methods are safe for automatic network retries", () => {
  assert.equal(isRetrySafeMethod("GET"), true);
  assert.equal(isRetrySafeMethod("head"), true);
  assert.equal(isRetrySafeMethod("POST"), false);
  assert.equal(isRetrySafeMethod("DELETE"), false);
});

test("Retry-After seconds and jittered backoff are bounded", () => {
  assert.equal(retryDelayMs(1, "2", () => 0), 2000);
  assert.equal(retryDelayMs(10, null, () => 1), 10000);
});

test("a dispatched POST network failure is not retried and is marked ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("connection reset");
  };
  try {
    await assert.rejects(
      eachRequest("/write", {
        baseUrl: "https://example.invalid",
        method: "POST",
        auth: false,
        body: "{}",
        retries: 2,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "ambiguousWrite" in error &&
        error.ambiguousWrite === true,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
