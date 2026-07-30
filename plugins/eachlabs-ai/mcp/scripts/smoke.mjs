// MCP smoke test: boots the built server over stdio and exercises public paths.
// Run with: npm run smoke (requires npm run build first; no API key needed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist/index.js")],
  env: { PATH: process.env.PATH, ...(process.env.EACH_API_KEY ? { EACH_API_KEY: process.env.EACH_API_KEY } : {}) },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { tools } = await client.listTools();
check("stable tool count", tools.length === 50, `${tools.length} tools`);
check(
  "experimental flags hidden by default",
  [
    "eachlabs_list_flags",
    "eachlabs_get_flag",
    "eachlabs_evaluate_flag",
    "eachlabs_create_flag",
    "eachlabs_update_flag",
    "eachlabs_delete_flag",
  ].every((name) => !tools.some((tool) => tool.name === name)),
);
check("audio tools registered", ["eachlabs_audio_transcribe", "eachlabs_audio_speech"].every(
  (name) => tools.some((tool) => tool.name === name),
));
check(
  "developer tools registered",
  [
    "eachlabs_validate_workflow_definition",
    "eachlabs_generate_integration_code",
    "eachlabs_compare_models",
    "eachlabs_diff_model_schema",
    "eachlabs_diff_workflow",
    "eachlabs_summarize_usage",
    "eachlabs_diagnose_run",
    "eachlabs_export_debug_bundle",
  ].every(
    (name) => tools.some((tool) => tool.name === name),
  ),
);
check(
  "annotations present",
  tools.every((tool) => tool.annotations?.readOnlyHint !== undefined),
);
check("titles present", tools.every((tool) => tool.title ?? tool.annotations?.title));

const { prompts } = await client.listPrompts();
check("prompts registered", prompts.length === 5, prompts.map((prompt) => prompt.name).join(","));

const health = await client.callTool({ name: "eachlabs_api_health", arguments: {} });
const healthBody = JSON.parse(health.content[0].text);
check("health reachable", healthBody.catalog_probe?.reachable === true);
check("update check ran", Boolean(healthBody.update?.current_version));

const search = await client.callTool({ name: "eachlabs_search_models", arguments: { name: "flux", limit: 3 } });
const searchBody = JSON.parse(search.content[0].text);
check("public model search", !(search.isError ?? false) && searchBody.models?.length > 0);
if (searchBody.models?.length >= 2) {
  const comparison = await client.callTool({
    name: "eachlabs_compare_models",
    arguments: {
      models: searchBody.models.slice(0, 2).map((model) => model.slug),
      focus_fields: ["prompt", "image_url", "image_urls"],
    },
  });
  const comparisonBody = JSON.parse(comparison.content[0].text);
  check(
    "credit-free model comparison",
    !(comparison.isError ?? false) && comparisonBody.models?.length === 2,
  );
}

const docs = await client.callTool({
  name: "search_each_labs",
  arguments: { query: "audio transcriptions workflow trigger" },
});
check(
  "official docs MCP proxy",
  !(docs.isError ?? false) && docs.content.some((block) => block.type === "text" && block.text.length > 0),
);

if (!process.env.EACH_API_KEY && searchBody.models?.[0]?.slug) {
  const detail = await client.callTool({
    name: "eachlabs_get_model",
    arguments: { slug: searchBody.models[0].slug },
  });
  check(
    "public model details need no key",
    !(detail.isError ?? false) && JSON.parse(detail.content[0].text).slug === searchBody.models[0].slug,
  );
}

await client.close();
console.log(failures === 0 ? "SMOKE_OK" : `SMOKE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
