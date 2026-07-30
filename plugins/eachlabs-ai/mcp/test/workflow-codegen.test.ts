import { test } from "node:test";
import assert from "node:assert/strict";
import { transform } from "esbuild";
import { spawnSync } from "node:child_process";
import { generateIntegrationCode } from "../src/core/codegen.ts";
import { validateWorkflowDefinition } from "../src/core/workflow-validator.ts";

const MODEL_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string" },
    steps: { type: "integer", minimum: 1, maximum: 50 },
  },
};

test("workflow linter catches duplicate IDs, future refs and version mismatch", async () => {
  const result = await validateWorkflowDefinition(
    {
      version: "v2",
      input_schema: {
        type: "object",
        properties: { prompt: { type: "string" } },
      },
      steps: [
        {
          id: "first",
          type: "model",
          model: "demo",
          params: { prompt: "{{later.primary}}" },
        },
        { id: "first", type: "pass", result: "{{inputs.missing}}" },
      ],
    },
    { expectedVersion: "v1" },
  );
  assert.equal(result.valid, false);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("version_mismatch"));
  assert.ok(codes.includes("step_id_duplicate"));
  assert.ok(codes.includes("reference_unavailable"));
  assert.ok(codes.includes("input_reference_unknown"));
});

test("workflow linter validates live model params without static model tables", async () => {
  const result = await validateWorkflowDefinition(
    {
      version: "v1",
      steps: [
        {
          id: "generate",
          type: "model",
          model: "live-model",
          params: { steps: 100 },
        },
      ],
    },
    {
      expectedVersion: "v1",
      modelResolver: async (slug) => {
        assert.equal(slug, "live-model");
        return { request_schema: MODEL_SCHEMA };
      },
    },
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((item) => item.code === "model_params_invalid"),
  );
});

test("workflow policy checks are opt-in warnings", async () => {
  const definition = {
    steps: [
      {
        id: "call",
        type: "http",
        url: "http://example.com",
        api_key: "inline",
      },
    ],
  };
  const normal = await validateWorkflowDefinition(definition);
  const policy = await validateWorkflowDefinition(definition, {
    policyChecks: true,
  });
  assert.equal(normal.diagnostics.some((item) => item.code === "inline_secret"), false);
  assert.equal(policy.valid, true);
  assert.ok(policy.diagnostics.some((item) => item.code === "inline_secret"));
  assert.ok(policy.diagnostics.some((item) => item.code === "insecure_http"));
});

test("parallel branch outputs are available after the parallel step", async () => {
  const result = await validateWorkflowDefinition({
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
    },
    steps: [
      {
        id: "parallel",
        type: "parallel",
        branches: [
          {
            steps: [
              {
                id: "branch_image",
                type: "pass",
                result: "{{inputs.prompt}}",
              },
            ],
          },
        ],
      },
      {
        id: "consume",
        type: "pass",
        result: "{{branch_image.primary}}",
      },
    ],
  });
  assert.equal(result.valid, true);
});

test("TypeScript codegen uses live schema, omits version and compiles", async () => {
  const result = generateIntegrationCode({
    model: "live-model",
    schema: MODEL_SCHEMA,
    language: "typescript",
    mode: "async_polling",
    includeTypes: true,
    includeZod: false,
  });
  assert.match(result.code, /type ModelInput/);
  assert.doesNotMatch(result.code, /version:/);
  assert.match(result.code, /"error"/);
  await transform(result.code, { loader: "ts", format: "esm" });
});

test("webhook codegen uses constant-time header comparison", () => {
  const typescript = generateIntegrationCode({
    model: "live-model",
    schema: MODEL_SCHEMA,
    language: "typescript",
    mode: "webhook",
    framework: "express",
  });
  assert.match(typescript.webhook_handler ?? "", /timingSafeEqual/);
  assert.match(typescript.webhook_handler ?? "", /x-webhook-secret/i);
  assert.doesNotMatch(typescript.webhook_handler ?? "", /createHmac/);

  const python = generateIntegrationCode({
    model: "live-model",
    schema: MODEL_SCHEMA,
    language: "python",
    mode: "webhook",
    framework: "fastapi",
  });
  assert.match(python.webhook_handler ?? "", /hmac\.compare_digest/);
  const syntax = spawnSync("python3", [
    "-c",
    `compile(${JSON.stringify(python.webhook_handler)}, "<generated>", "exec")`,
  ]);
  assert.equal(syntax.status, 0, syntax.stderr.toString());
});
