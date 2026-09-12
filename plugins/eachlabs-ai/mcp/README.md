# eachlabs-mcp

Unofficial enhanced MCP server for each::labs.

It exposes the parts an agent needs to work well with Eachlabs:

- search the model catalog and inspect request schemas before calling models
- compare live models by provider, category, input constraints, and catalog p50 latency without spending credits
- detect breaking drift between a saved schema and the current live model schema
- create predictions (async, wait-for-result, or synchronous), poll, inspect, and cancel them
- browse the execution history with cost and runtime per run
- summarize usage without returning prompts or outputs, and diagnose failed runs without retrying them
- transcribe local audio and generate streamed speech audio
- upload and delete media files via presigned storage
- inspect webhook deliveries
- create, update, version, trigger, bulk-trigger, and monitor workflows
- lint workflow definitions locally or against live model schemas before mutation
- diff workflow definitions before publishing a new version
- generate deterministic TypeScript, Python, Go, or cURL integrations from live model schemas
- export privacy-safe debug bundles that omit prompts, inputs, outputs, logs, media URLs, and secrets
- fetch and trigger public/unlisted workflow versions
- chat through each::sense and the OpenAI-compatible LLM router

Successful image predictions are returned as inline MCP image content (up to 3 MB each) so they render directly in chat; videos and audio come back as resource links. Extensionless signed media URLs are supported. Inline media fetches require HTTPS, reject local/private destinations, re-check redirects, and keep strict byte/concurrency limits. each::sense streaming is consumed server-side and returned as aggregated text plus notable events, with MCP progress notifications along the way.

## Setup

```bash
npm install
npm run build
```

Other scripts:

```bash
npm test          # unit tests for the pure helpers (URL joining, schema validation, media detection)
npm run smoke     # boots the built server over stdio and exercises public endpoints
npm run update    # refresh npm dependencies and rebuild a source checkout
npm run build:debug # rebuild with an external source map
```

Set one of these environment variables before launching the server:

```bash
export EACH_API_KEY="your-eachlabs-api-key"
```

`EACHLABS_API_KEY` is also accepted. Blank values are ignored; a non-empty `EACH_API_KEY` takes precedence.

Optional endpoint overrides:

```bash
export EACH_API_BASE_URL="https://api.eachlabs.ai"
export EACH_WORKFLOWS_BASE_URL="https://workflows.eachlabs.run/api/v1"
export EACH_SENSE_BASE_URL="https://eachsense-agent.core.eachlabs.run"
```

## MCP Config

Use the built server with any MCP client that supports stdio:

```json
{
  "mcpServers": {
    "eachlabs": {
      "command": "node",
      "args": ["/absolute/path/to/eachlabs-ai-plugin/plugins/eachlabs-ai/mcp/dist/index.js"],
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
      "cwd": "/absolute/path/to/eachlabs-ai-plugin/plugins/eachlabs-ai/mcp",
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
- `eachlabs_submit_docs_feedback`
- `eachlabs_search_models`
- `eachlabs_get_model`
- `eachlabs_get_model_request_schema` (supports `openapi=true` for the per-model OpenAPI schema)
- `eachlabs_generate_example_input`
- `eachlabs_validate_model_input`
- `eachlabs_find_models_by_schema`
- `eachlabs_recommend_models`
- `eachlabs_compare_models` (read-only; does not run predictions)
- `eachlabs_diff_model_schema` (compares a saved baseline with the current live schema)
- `eachlabs_diff_workflow` (local step and input-contract diff)
- `eachlabs_generate_integration_code`
- `eachlabs_api_health`

Predictions and history:

- `eachlabs_create_prediction` (modes: `async`, `wait`, `sync`; local input validation built in)
- `eachlabs_get_prediction` (supports `wait=true` to poll until done)
- `eachlabs_cancel_prediction`
- `eachlabs_list_executions`
- `eachlabs_summarize_usage` (groups cost, runtime, success, and failure without returning prompts/outputs)
- `eachlabs_diagnose_run` (prediction/workflow triage; never retries automatically)
- `eachlabs_export_debug_bundle` (shareable diagnostics with sensitive payloads removed)

Audio:

- `eachlabs_audio_transcribe` (multipart upload, 25 MB maximum)
- `eachlabs_audio_speech` (returns an inline MCP audio block)

Storage:

- `eachlabs_presign_upload`
- `eachlabs_upload_file`
- `eachlabs_delete_file`

Webhooks:

- `eachlabs_list_webhooks`
- `eachlabs_get_webhook`

Experimental each::flags (only registered with `EACHLABS_ENABLE_EXPERIMENTAL_FLAGS=1`):

- `eachlabs_list_flags`
- `eachlabs_get_flag`
- `eachlabs_evaluate_flag`
- `eachlabs_create_flag`
- `eachlabs_update_flag`
- `eachlabs_delete_flag`

Workflows:

- `eachlabs_validate_workflow_definition`
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
- `eachlabs-choose-model` — compare candidates without spending credits
- `eachlabs-debug-run` — diagnose a run without automatically retrying paid work
- `eachlabs-developer-checkup` — credit-free production-readiness review

## Agent Usage Pattern

For direct model calls, use this flow:

1. `eachlabs_search_models` with a rough name or category.
2. `eachlabs_get_model_request_schema` for the selected slug.
3. `eachlabs_create_prediction` with valid `input` — `mode: "wait"` for short jobs, `mode: "async"` plus `eachlabs_get_prediction` for long ones.

For workflows, fetch or create the workflow, trigger it, then poll with `eachlabs_get_workflow_execution`.

## Notes

The model list, model detail, and LLM Router catalog endpoints are public in the current API. Model details, schemas, recommendations, comparisons, validation, schema drift checks, and code generation therefore work without a key. Authenticated REST calls use `Authorization: Bearer`. The raw request tool retains an explicit `x-api-key` compatibility mode for legacy endpoints and blocks unauthenticated write methods.

each::sense streaming uses a configurable 30–900 second idle timeout, retries only explicit pre-stream `429/502/503/504` responses, suppresses reasoning events, and returns normalized generation, clarification, workflow, and error buckets.

Workflow creation/version upsert validates definitions by default. `structural` mode is local-only; `live` mode also resolves models and checks params against current request schemas. Optional policy warnings are off unless explicitly requested.

The workflows API documents no `GET /workflows` list endpoint, so there is no list-workflows tool — use `eachlabs_get_workflow` with a known ID or slug, or `eachlabs_list_executions` to discover workflow IDs from past runs.

The each::flags routes are not present in the current public OpenAPI/docs surface. They are therefore disabled by default and clearly experimental when enabled.

All tools surface upstream API errors as structured tool errors (status plus the upstream payload). Safe read requests retry transient failures; dispatched writes are not retried after network ambiguity. Individual HTTP requests time out after 60 seconds (5 minutes for chat and sense calls).
