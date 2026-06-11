import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinUrl,
  appendQuery,
  summarizeJsonSchema,
  generateExampleInput,
  validateAgainstSchema,
  trimModel,
  collectMediaUrls,
} from "../src/index.ts";

test("joinUrl preserves base path prefixes", () => {
  assert.equal(
    joinUrl("https://workflows.eachlabs.run/api/v1", "/workflows"),
    "https://workflows.eachlabs.run/api/v1/workflows",
  );
  assert.equal(
    joinUrl("https://eachsense-agent.core.eachlabs.run/v1", "/chat/completions"),
    "https://eachsense-agent.core.eachlabs.run/v1/chat/completions",
  );
  assert.equal(joinUrl("https://api.eachlabs.ai", "/v1/models"), "https://api.eachlabs.ai/v1/models");
});

test("joinUrl normalizes slashes", () => {
  assert.equal(joinUrl("https://api.eachlabs.ai/", "/v1/models"), "https://api.eachlabs.ai/v1/models");
  assert.equal(joinUrl("https://api.eachlabs.ai", "v1/models"), "https://api.eachlabs.ai/v1/models");
});

test("appendQuery adds defined params and skips empty ones", () => {
  assert.equal(
    appendQuery("/v1/models", { name: "flux", limit: 25, offset: 0, skip: undefined, empty: "" }),
    "/v1/models?name=flux&limit=25&offset=0",
  );
  assert.equal(appendQuery("/v1/models", {}), "/v1/models");
});

const SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "Text prompt" },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9"], default: "1:1" },
    steps: { type: "integer", minimum: 10 },
    guidance: { type: "number", default: 7.5 },
  },
};

test("summarizeJsonSchema flattens properties into fields", () => {
  const summary = summarizeJsonSchema(SCHEMA) as { required: string[]; fields: Array<{ name: string; required: boolean }> };
  assert.deepEqual(summary.required, ["prompt"]);
  assert.equal(summary.fields.length, 4);
  const prompt = summary.fields.find((field) => field.name === "prompt");
  assert.equal(prompt?.required, true);
});

test("summarizeJsonSchema passes through non-objects", () => {
  assert.equal(summarizeJsonSchema(null), null);
  assert.deepEqual(summarizeJsonSchema({ type: "object" }), { type: "object" });
});

test("generateExampleInput fills required fields and applies overrides", () => {
  const input = generateExampleInput(SCHEMA, false, {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(input), ["prompt"]);
  assert.match(String(input.prompt), /cinematic/);

  const withOptional = generateExampleInput(SCHEMA, true, { steps: 42 }) as Record<string, unknown>;
  assert.equal(withOptional.aspect_ratio, "1:1");
  assert.equal(withOptional.guidance, 7.5);
  assert.equal(withOptional.steps, 42);
});

test("validateAgainstSchema flags missing required, type and enum violations", () => {
  const bad = validateAgainstSchema(SCHEMA, { aspect_ratio: "4:3", steps: 1.5, unknown_field: 1 });
  assert.equal(bad.valid, false);
  const messages = bad.errors.map((error) => `${error.field}:${error.message}`);
  assert.ok(messages.some((entry) => entry.startsWith("prompt:Required")));
  assert.ok(messages.some((entry) => entry.startsWith("aspect_ratio:Field is not one of")));
  assert.ok(messages.some((entry) => entry.startsWith("steps:Field must be an integer")));
  assert.equal(bad.warnings.length, 1);
  assert.equal(bad.warnings[0].field, "unknown_field");
});

test("validateAgainstSchema accepts valid input", () => {
  const good = validateAgainstSchema(SCHEMA, { prompt: "hello", aspect_ratio: "16:9", steps: 20 });
  assert.equal(good.valid, true);
  assert.equal(good.errors.length, 0);
});

test("trimModel reduces a catalog record to essentials", () => {
  const trimmed = trimModel({
    title: "Flux",
    slug: "flux-2-max",
    version: "1",
    output_type: "image",
    provider: "bfl",
    request_schema: SCHEMA,
    huge_field: "x".repeat(10_000),
  });
  assert.deepEqual(Object.keys(trimmed), ["title", "slug", "version", "output_type", "request_fields"]);
  assert.deepEqual(trimmed.request_fields, ["prompt", "aspect_ratio", "steps", "guidance"]);
});

test("collectMediaUrls finds media URLs in nested output shapes", () => {
  const urls = collectMediaUrls({
    output: [
      "https://cdn.eachlabs.ai/out/image.png",
      { video: "https://cdn.eachlabs.ai/out/clip.mp4?sig=abc" },
    ],
    logs: "https://example.com/not-media",
    nested: { audio: "https://cdn.eachlabs.ai/out/voice.mp3" },
  });
  assert.deepEqual(urls, [
    "https://cdn.eachlabs.ai/out/image.png",
    "https://cdn.eachlabs.ai/out/clip.mp4?sig=abc",
    "https://cdn.eachlabs.ai/out/voice.mp3",
  ]);
});

test("collectMediaUrls ignores non-URL strings and unknown extensions", () => {
  assert.deepEqual(collectMediaUrls("plain text"), []);
  assert.deepEqual(collectMediaUrls("https://example.com/page.html"), []);
  assert.deepEqual(collectMediaUrls(null), []);
});
