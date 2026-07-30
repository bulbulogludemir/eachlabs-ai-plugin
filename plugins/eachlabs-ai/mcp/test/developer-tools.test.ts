import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDebugBundle,
  compareModelRecords,
  diagnoseRunRecord,
  diffModelSchemas,
  diffWorkflowDefinitions,
  summarizeExecutions,
} from "../src/core/developer-tools.ts";

const imageModel = {
  title: "Fast Image",
  slug: "fast-image",
  provider_name: "Provider A",
  category: { Slug: "text-to-image" },
  output_type: "array",
  p50: 4,
  request_schema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: ["1:1", "16:9"] },
      seed: { type: "integer" },
    },
  },
};

const videoModel = {
  title: "Image Video",
  slug: "image-video",
  provider_name: "Provider B",
  category: { slug: "image-to-video" },
  output_type: "video",
  p50: 18,
  request_schema: {
    type: "object",
    required: ["prompt", "image_url"],
    properties: {
      prompt: { type: "string" },
      image_url: { type: "string", format: "uri" },
      duration: { type: "integer", minimum: 3, maximum: 10 },
      seed: { type: "integer" },
    },
  },
};

test("model comparison is credit-free metadata analysis", () => {
  const result = compareModelRecords(
    [imageModel, videoModel],
    ["image_url"],
    ["duration"],
  );
  assert.deepEqual(result.shared_fields, ["prompt", "seed"]);
  assert.equal(result.fastest_by_catalog_p50?.slug, "fast-image");
  assert.equal(result.models[0].fits_requirements, false);
  assert.equal(result.models[1].fits_requirements, true);
  assert.deepEqual(result.models[1].fields.duration, {
    type: "integer",
    required: false,
    default: null,
    enum: null,
    minimum: 3,
    maximum: 10,
    min_items: null,
    max_items: null,
  });
});

test("usage summary groups cost and runtime without returning outputs", () => {
  const result = summarizeExecutions(
    [
      {
        model: "fast-image",
        status: "success",
        execution_cost: 0.02,
        run_time: 4,
        output: "private-output",
      },
      {
        model: "fast-image",
        status: "error",
        execution_cost: 0.01,
        run_time: 2,
      },
      {
        requested_model: "openai/gpt-4o",
        model: "eachlabs-llm-router",
        status: "success",
        execution_cost: 0.03,
        run_time: 1,
      },
    ],
    "model",
  );
  assert.equal(result.total_cost_usd, 0.06);
  assert.equal(result.successful, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.groups[0].key, "fast-image");
  assert.equal(JSON.stringify(result).includes("private-output"), false);
});

test("run diagnosis separates invalid input from safe retry cases", () => {
  const invalid = diagnoseRunRecord({
    status: "error",
    error: "422 validation error: prompt is required",
  });
  assert.equal(invalid.diagnosis, "invalid_input");
  assert.equal(invalid.safe_to_retry, "no");

  const limited = diagnoseRunRecord({
    status: "error",
    error: "429 provider rate limit",
  });
  assert.equal(limited.diagnosis, "rate_limited");
  assert.equal(limited.safe_to_retry, "yes");
});

test("run diagnosis does not recommend retrying a successful run", () => {
  const healthy = diagnoseRunRecord({ status: "success" });
  assert.equal(healthy.diagnosis, "healthy");
  assert.equal(healthy.safe_to_retry, "no");
});

test("schema diff classifies breaking and compatible changes", () => {
  const result = diffModelSchemas(
    {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        quality: { type: "string", enum: ["draft", "final"] },
        seed: { type: "integer" },
      },
    },
    {
      type: "object",
      required: ["prompt", "image_url"],
      properties: {
        prompt: { type: "string" },
        quality: { type: "string", enum: ["final"] },
        image_url: { type: "string", format: "uri" },
      },
    },
  );
  assert.equal(result.compatible, false);
  assert.ok(result.changes.some((change) => change.kind === "field_removed"));
  assert.ok(
    result.changes.some(
      (change) => change.kind === "field_added" && change.breaking,
    ),
  );
  assert.ok(
    result.changes.some(
      (change) => change.kind === "enum_changed" && change.breaking,
    ),
  );
});

test("workflow diff reports step and input contract changes", () => {
  const result = diffWorkflowDefinitions(
    {
      version: "v1",
      input_schema: {
        type: "object",
        properties: { prompt: { type: "string" } },
      },
      steps: [{ id: "generate", type: "model", model: "old" }],
    },
    {
      version: "v2",
      input_schema: {
        type: "object",
        required: ["image_url"],
        properties: {
          prompt: { type: "string" },
          image_url: { type: "string" },
        },
      },
      steps: [{ id: "generate", type: "model", model: "new" }],
    },
  );
  assert.equal(result.compatible, false);
  assert.equal(result.version_changed, true);
  assert.ok(result.step_changes.some((change) => change.kind === "model_changed"));
  assert.equal(result.input_schema.compatible, false);
});

test("debug bundle excludes prompts, outputs, logs, and secrets", () => {
  const result = buildDebugBundle(
    "prediction",
    {
      id: "run-1",
      status: "error",
      model: "demo",
      prompt: "private",
      input: { image_url: "private" },
      output: "private",
      logs: "private",
      webhook_secret: "private",
      metrics: { cost: 0.1 },
      error: "provider unavailable",
    },
    "0.5.0",
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private"), false);
  assert.equal((result.run as Record<string, unknown>).id, "run-1");
  assert.equal(result.diagnosis.diagnosis, "provider_unavailable");
});
