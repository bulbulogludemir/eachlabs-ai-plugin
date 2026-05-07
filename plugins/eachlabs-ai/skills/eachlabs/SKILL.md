---
name: eachlabs
description: Use when building, debugging, or explaining integrations with each::labs, eachlabs.ai, each::api, each::workflows, each::sense, the each::labs LLM Router, or the each::labs MCP. Also use for image, video, audio, 3D, or workflow generation tasks that mention Eachlabs or EACHLABS_API_KEY.
---

# each::labs

Use this skill to build practical each::labs integrations in Codex. Prefer current official documentation over memory when endpoint details, model slugs, schemas, or pricing behavior matter.

## Core Surfaces

- each::api: direct REST model execution at `https://api.eachlabs.ai`.
- each::workflows: multi-step pipelines at `https://workflows.eachlabs.run/api/v1`.
- each::sense: OpenAI-compatible generative media agent at `https://eachsense-agent.core.eachlabs.run`.
- LLM Router: OpenAI-compatible LLM access at `https://api.eachlabs.ai/v1`.
- MCP: bundled `eachlabs` server with docs proxy tools plus action tools.

## Docs Workflow

When the bundled eachlabs MCP is available, use it for current docs lookup before implementing or answering precise API questions:

1. Search with `search_each_labs`.
2. Read exact pages with `query_docs_filesystem_each_labs`.
3. Cite or link the public docs URL when reporting user-facing API facts.

If MCP tools are unavailable, use the public docs index at `https://docs.eachlabs.ai/llms.txt`.

Prefer its purpose-built tools over hand-written HTTP calls:

- `eachlabs_search_models`, `eachlabs_get_model`, and `eachlabs_get_model_request_schema` for model discovery and schemas.
- `eachlabs_create_prediction_checked`, `eachlabs_run_model`, and `eachlabs_wait_prediction` for direct generation.
- `eachlabs_create_workflow`, `eachlabs_execute_workflow`, and workflow execution polling tools for workflows.
- `eachsense_chat_completion` and `eachsense_build_workflow` for each::sense.
- `eachlabs_llm_chat_completion` for LLM Router calls.

## Credential Rules

- Never print, log, paste, or summarize `EACHLABS_API_KEY`.
- Never print, log, paste, or summarize `EACH_API_KEY`.
- Use `EACH_API_KEY` or `EACHLABS_API_KEY` for local server-side calls.
- Do not put Eachlabs keys in client-side code, public repositories, screenshots, or build output.
- For direct REST APIs, authenticate with `X-API-Key`.
- For OpenAI-compatible clients against each::sense or the LLM Router, bearer token auth may be used by the SDK.
- Public model listing can be checked without credentials, but live generation and account-specific endpoints need a key.

## Choosing The Right Surface

- Use each::sense when the user wants natural-language media generation, model auto-selection, agent-style orchestration, or multi-turn media work.
- Use each::api when the user names a specific model, needs deterministic schema control, needs webhooks, or wants direct polling of prediction status.
- Use each::workflows when the request involves repeated pipelines, multiple model steps, fallback behavior, branching, bulk runs, or reusable workflow versions.
- Use the LLM Router for text-only LLM routing with OpenAI-compatible clients.
- Use the docs MCP for documentation discovery, not for generation or account operations.

## Direct Prediction Pattern

For each::api direct model execution:

1. Fetch or confirm the model schema before constructing inputs.
2. Send `POST /v1/prediction` with `model`, `version`, and `input`.
3. Poll `GET /v1/prediction/{id}` until `success`, `failed`, or `cancelled`.
4. Prefer webhooks for production integrations that can receive callbacks.
5. Surface model cost, status, output URL, and logs when available.

The default prediction status flow is `starting` to `processing` to a terminal state.

## Safety And Media Handling

- The safety checker is enabled by default.
- Only pass `enable_safety_checker: false` when the user explicitly asks for that behavior and the selected model supports it.
- For each::sense, pass safety-checker options as top-level request fields rather than inside a model `input` object.
- Treat generated media URLs as potentially user-visible artifacts; avoid leaking private prompts, credentials, or webhook secrets.

## Implementation Standards

- Keep examples server-side unless the user explicitly asks for a browser-only prototype.
- Validate generated request bodies against the model `request_schema` when practical.
- Add focused tests around payload construction, status polling, error handling, and webhook signature verification.
- For local smoke tests without credentials, prefer `GET https://api.eachlabs.ai/v1/models?limit=3`.
- For live generation tests, ask before spending credits or creating external artifacts.

## Common Environment

```bash
EACHLABS_API_KEY=...
EACHLABS_API_BASE_URL=https://api.eachlabs.ai
EACHSENSE_BASE_URL=https://eachsense-agent.core.eachlabs.run/v1
EACHLABS_WORKFLOWS_BASE_URL=https://workflows.eachlabs.run/api/v1
```
