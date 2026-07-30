// Offline smoke test: verifies the built MCP boots and exposes the expected
// stable surface without spending credits or requiring network/API access.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist/index.js")],
  env: {
    PATH: process.env.PATH,
    ...(process.env.EACHLABS_ENABLE_EXPERIMENTAL_FLAGS
      ? { EACHLABS_ENABLE_EXPERIMENTAL_FLAGS: process.env.EACHLABS_ENABLE_EXPERIMENTAL_FLAGS }
      : {}),
  },
});
const client = new Client({ name: "offline-smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = new Set(tools.map((tool) => tool.name));
const expected = [
  "search_each_labs",
  "query_docs_filesystem_each_labs",
  "eachlabs_submit_docs_feedback",
  "eachlabs_create_prediction",
  "eachlabs_audio_transcribe",
  "eachlabs_audio_speech",
  "eachlabs_validate_workflow_definition",
  "eachlabs_generate_integration_code",
  "eachlabs_compare_models",
  "eachlabs_diff_model_schema",
  "eachlabs_diff_workflow",
  "eachlabs_summarize_usage",
  "eachlabs_diagnose_run",
  "eachlabs_export_debug_bundle",
  "eachlabs_execute_workflow",
  "eachlabs_api_health",
];
if (!expected.every((name) => names.has(name))) {
  throw new Error(`Missing expected tools: ${expected.filter((name) => !names.has(name)).join(", ")}`);
}
const publicWorkflow = tools.find(
  (tool) => tool.name === "eachlabs_execute_public_workflow_version",
);
const publicProperties = publicWorkflow?.inputSchema?.properties ?? {};
if ("webhook_url" in publicProperties || "webhook_secret" in publicProperties) {
  throw new Error("Undocumented public-workflow webhook fields must not be exposed.");
}
const sense = tools.find((tool) => tool.name === "eachsense_chat_completion");
const timeoutSchema = sense?.inputSchema?.properties?.stream_timeout_seconds;
if (timeoutSchema?.maximum !== 900 || timeoutSchema?.minimum !== 30) {
  throw new Error("each::sense stream timeout contract must be 30-900 seconds.");
}
const flagsEnabled = process.env.EACHLABS_ENABLE_EXPERIMENTAL_FLAGS === "1";
const flagTools = [...names].filter((name) => name.includes("_flag"));
if ((!flagsEnabled && flagTools.length > 0) || (flagsEnabled && flagTools.length !== 6)) {
  throw new Error(
    flagsEnabled
      ? `Expected 6 experimental flag tools, found ${flagTools.length}.`
      : "Experimental flags must not be exposed unless explicitly enabled.",
  );
}

const { prompts } = await client.listPrompts();
if (prompts.length !== 5) throw new Error(`Expected 5 prompts, found ${prompts.length}.`);

const lint = await client.callTool({
  name: "eachlabs_validate_workflow_definition",
  arguments: {
    mode: "structural",
    definition: {
      version: "v1",
      input_schema: {
        type: "object",
        properties: { prompt: { type: "string" } },
      },
      steps: [
        {
          id: "pass",
          type: "pass",
          result: "{{inputs.prompt}}",
        },
      ],
    },
  },
});
const lintBody = JSON.parse(lint.content[0].text);
if (lint.isError || lintBody.valid !== true) {
  throw new Error("Workflow linter failed its structural smoke test.");
}

const workflowDiff = await client.callTool({
  name: "eachlabs_diff_workflow",
  arguments: {
    before_definition: {
      version: "v1",
      steps: [{ id: "generate", type: "model", model: "old-model" }],
    },
    after_definition: {
      version: "v2",
      steps: [{ id: "generate", type: "model", model: "new-model" }],
    },
  },
});
const workflowDiffBody = JSON.parse(workflowDiff.content[0].text);
if (
  workflowDiff.isError ||
  workflowDiffBody.step_changes?.[0]?.kind !== "model_changed"
) {
  throw new Error("Workflow diff failed its local compatibility smoke test.");
}

const blockedRawWrite = await client.callTool({
  name: "eachlabs_raw_api_request",
  arguments: {
    method: "POST",
    path: "/v1/example",
    auth: false,
    body: {},
  },
});
const blockedRawWriteBody = JSON.parse(blockedRawWrite.content[0].text);
if (!blockedRawWrite.isError || blockedRawWriteBody.blocked !== true) {
  throw new Error("Unauthenticated raw writes must be blocked before network access.");
}
await client.close();
console.log(`LOCAL_SMOKE_OK (${tools.length} tools, ${prompts.length} prompts)`);
