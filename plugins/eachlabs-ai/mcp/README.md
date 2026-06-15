# eachlabs-mcp

Unofficial enhanced MCP server for each::labs.

It exposes the parts an agent needs to work well with Eachlabs:

- search the model catalog and inspect request schemas before calling models
- create predictions (async, wait-for-result, or synchronous), poll, inspect, and cancel them
- browse the execution history with cost and runtime per run
- upload and delete media files via presigned storage
- inspect webhook deliveries
- create, update, version, trigger, bulk-trigger, and monitor workflows
- fetch and trigger public/unlisted workflow versions
- chat through each::sense and the OpenAI-compatible LLM router

Successful image predictions are returned as inline MCP image content (up to 3 MB each) so they render directly in chat; videos and audio come back as resource links. each::sense streaming is consumed server-side and returned as aggregated text plus notable events, with MCP progress notifications along the way.

## Setup

```bash
npm install
npm run build
```

Other scripts:

```bash
npm test          # unit tests for the pure helpers (URL joining, schema validation, media detection)
npm run smoke     # boots the built server over stdio and exercises public endpoints
npm run update    # git pull + install + rebuild (eachlabs_api_health reports when an update is available)
```

Set one of these environment variables before launching the server:

```bash
export EACH_API_KEY="your-eachlabs-api-key"
```

`EACHLABS_API_KEY` is also accepted.

Optional endpoint overrides:

```bash
export EACH_API_BASE_URL="https://api.eachlabs.ai"
export EACH_WORKFLOWS_BASE_URL="https://workflows.eachlabs.run/api/v1"
```

## MCP Config

Use the built server with any MCP client that supports stdio:

```json
{
  "mcpServers": {
    "eachlabs": {
      "command": "node",
      "args": ["/Users/demir/Projects/eachlabs-mcp/dist/index.js"],
      "env": {
        "EACH_API_KEY": "your-eachlabs-api-key"
      }
    }
  }
}
```

For local development:

```json
{
  "mcpServers": {
    "eachlabs-dev": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/Users/demir/Projects/eachlabs-mcp",
      "env": {
        "EACH_API_KEY": "your-eachlabs-api-key"
      }
    }
  }
}
```

## Tools

Catalog and schemas:

- `search_each_labs`
- `query_docs_filesystem_each_labs`
- `eachlabs_search_models`
- `eachlabs_get_model`
- `eachlabs_get_model_request_schema` (supports `openapi=true` for the per-model OpenAPI schema)
- `eachlabs_generate_example_input`
- `eachlabs_validate_model_input`
- `eachlabs_find_models_by_schema`
- `eachlabs_recommend_models`
- `eachlabs_api_health`

Predictions and history:

- `eachlabs_create_prediction` (modes: `async`, `wait`, `sync`; local input validation built in)
- `eachlabs_get_prediction` (supports `wait=true` to poll until done)
- `eachlabs_cancel_prediction`
- `eachlabs_list_executions`

Storage:

- `eachlabs_presign_upload`
- `eachlabs_upload_file`
- `eachlabs_delete_file`

Webhooks:

- `eachlabs_list_webhooks`
- `eachlabs_get_webhook`

each::flags:

- `eachlabs_list_flags`
- `eachlabs_get_flag`
- `eachlabs_evaluate_flag`
- `eachlabs_create_flag`
- `eachlabs_update_flag`
- `eachlabs_delete_flag`

Workflows:

- `eachlabs_list_workflow_categories`
- `eachlabs_create_workflow`
- `eachlabs_get_workflow`
- `eachlabs_update_workflow`
- `eachlabs_upsert_workflow_version`
- `eachlabs_execute_workflow`
- `eachlabs_bulk_execute_workflow`
- `eachlabs_list_workflow_executions`
- `eachlabs_get_workflow_execution` (supports `wait=true` to poll until done)
- `eachlabs_get_public_workflow_version`
- `eachlabs_execute_public_workflow_version`

each::sense and LLM router:

- `eachsense_chat_completion`
- `eachsense_list_models`
- `eachsense_build_workflow`
- `eachsense_list_sessions`
- `eachsense_get_session`
- `eachsense_delete_session`
- `eachlabs_llm_list_models`
- `eachlabs_llm_chat_completion`

Advanced:

- `eachlabs_raw_api_request`

Prompts (slash commands in supporting clients):

- `eachlabs-generate-media` — guided model-pick → validate → run → show flow
- `eachlabs-build-workflow` — draft, refine, and test-run a workflow

## Agent Usage Pattern

For direct model calls, use this flow:

1. `eachlabs_search_models` with a rough name or category.
2. `eachlabs_get_model_request_schema` for the selected slug.
3. `eachlabs_create_prediction` with valid `input` — `mode: "wait"` for short jobs, `mode: "async"` plus `eachlabs_get_prediction` for long ones.

For workflows, fetch or create the workflow, trigger it, then poll with `eachlabs_get_workflow_execution`.

## Notes

The model list endpoint is public in the current API. Model details, predictions, webhooks, and workflows require `X-API-Key`; the LLM router uses `Authorization: Bearer`.

The workflows API documents no `GET /workflows` list endpoint, so there is no list-workflows tool — use `eachlabs_get_workflow` with a known ID or slug, or `eachlabs_list_executions` to discover workflow IDs from past runs.

The each::flags public docs were not yet visible in the docs index when this support was added, but the authenticated API surface appears under `/v1/flags`. Flags tools therefore expose `path` and `body` overrides so clients can adapt to the exact upstream contract without falling back to a fully raw request.

All tools surface upstream API errors as structured tool errors (status plus the upstream payload), retry transparently on 429/transient 5xx, and time out individual HTTP requests after 60 seconds (5 minutes for chat and sense calls).
