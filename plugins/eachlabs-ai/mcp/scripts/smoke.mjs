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
check("tool count", tools.length === 45, `${tools.length} tools`);
check(
  "flags tools registered",
  [
    "eachlabs_list_flags",
    "eachlabs_get_flag",
    "eachlabs_evaluate_flag",
    "eachlabs_create_flag",
    "eachlabs_update_flag",
    "eachlabs_delete_flag",
  ].every((name) => tools.some((tool) => tool.name === name)),
);
check(
  "annotations present",
  tools.every((tool) => tool.annotations?.readOnlyHint !== undefined),
);
check("titles present", tools.every((tool) => tool.title ?? tool.annotations?.title));

const { prompts } = await client.listPrompts();
check("prompts registered", prompts.length === 2, prompts.map((prompt) => prompt.name).join(","));

const health = await client.callTool({ name: "eachlabs_api_health", arguments: {} });
const healthBody = JSON.parse(health.content[0].text);
check("health reachable", healthBody.catalog_probe?.reachable === true);
check("update check ran", Boolean(healthBody.update?.current_version));

const search = await client.callTool({ name: "eachlabs_search_models", arguments: { name: "flux", limit: 3 } });
check("public model search", !(search.isError ?? false) && JSON.parse(search.content[0].text).models?.length > 0);

if (!process.env.EACH_API_KEY) {
  const err = await client.callTool({ name: "eachlabs_get_model", arguments: { slug: "flux-2-max" } });
  check("missing-key error surfaced", err.isError === true && err.content[0].text.includes("Missing API key"));
}

await client.close();
console.log(failures === 0 ? "SMOKE_OK" : `SMOKE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
