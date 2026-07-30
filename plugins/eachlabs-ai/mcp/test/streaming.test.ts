import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSenseEvent,
  sseDataFromBlock,
  streamEachSense,
} from "../src/core/streaming.ts";

function buckets(raw = true) {
  return {
    generations: [] as unknown[],
    clarification: [] as unknown[],
    workflow: [] as unknown[],
    errors: [] as unknown[],
    raw_safe_events: raw ? ([] as unknown[]) : undefined,
  };
}

test("SSE parser joins multiline data fields", () => {
  assert.equal(
    sseDataFromBlock("event: message\ndata: {\"hello\":\ndata: \"world\"}"),
    "{\"hello\":\n\"world\"}",
  );
});

test("sense event normalization suppresses reasoning and categorizes safe events", () => {
  const result = buckets();
  assert.equal(
    normalizeSenseEvent({ type: "thinking_delta", content: "private" }, result)
      .suppressed,
    true,
  );
  normalizeSenseEvent({ type: "generation_response", url: "https://x/image.png" }, result);
  normalizeSenseEvent({ type: "clarification_needed", question: "Style?" }, result);
  normalizeSenseEvent({ type: "workflow_updated", workflow_id: "wf" }, result);
  normalizeSenseEvent({ type: "error", message: "failed" }, result);
  normalizeSenseEvent({ type: "progress", progress: 50 }, result);
  assert.equal(result.generations.length, 1);
  assert.equal(result.clarification.length, 1);
  assert.equal(result.workflow.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.raw_safe_events?.length, 1);
});

test("stream connection retries explicit 429 before consuming SSE", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0.001" },
      });
    }
    return new Response(
      'data: {"type":"generation_response","url":"https://x/out.png"}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  try {
    const result = (await streamEachSense(
      "/chat/completions",
      {
        baseUrl: "https://example.invalid",
        body: "{}",
        apiKey: "test",
        timeoutSeconds: 30,
      },
    )) as { connection_attempts: number; generations: unknown[] };
    assert.equal(calls, 2);
    assert.equal(result.connection_attempts, 2);
    assert.equal(result.generations.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream failures after response start are never retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"progress","progress":1}\n\n'),
        );
        controller.error(new Error("stream disconnected"));
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    await assert.rejects(
      streamEachSense("/chat/completions", {
        baseUrl: "https://example.invalid",
        body: "{}",
        apiKey: "test",
      }),
      /stream started and was not retried/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
