# each::labs Codex Plugin

This plugin packages Codex guidance and a bundled each::labs MCP for building with each::api, each::workflows, each::sense, and the LLM Router.

## Contents

- `.codex-plugin/plugin.json`: plugin manifest and UI metadata.
- `.mcp.json`: a single bundled `eachlabs` MCP server.
- `mcp/`: the bundled MCP server source and build output.
- `skills/eachlabs/SKILL.md`: implementation guidance for choosing each::api, each::sense, workflows, or router usage.
- `scripts/smoke_eachlabs.py`: credential-free model-listing smoke check.

## Included MCP Server

`eachlabs` combines:

- official docs proxy tools: `search_each_labs`, `query_docs_filesystem_each_labs`, `eachlabs_submit_docs_feedback`
- action tools for model discovery, schema/workflow drift checks, predictions, audio, privacy-safe debug bundles, workflow linting, TypeScript/Python/Go/cURL code generation, each::sense, and the LLM Router

Signed and extensionless media outputs are recognized. Inline fetches are
HTTPS-only and reject local/private destinations and unsafe redirects. The raw
API escape hatch also blocks unauthenticated writes.

It expects an API key in the runtime environment for account actions:

```bash
export EACH_API_KEY=...
```

The bundled server also accepts `EACHLABS_API_KEY` when run directly, but the plugin passes `EACH_API_KEY`.

Keep `EACHLABS_API_KEY` out of tracked files and logs.

## Rebuild Bundled MCP

```bash
cd plugins/eachlabs-ai/mcp
npm install
npm run build
```

## Local Smoke Check

```bash
python3 plugins/eachlabs-ai/scripts/smoke_eachlabs.py
```

The smoke check calls the public model-listing endpoint and does not require an API key.
