# each::labs AI Plugin

Open source Codex and Claude Code plugin for each::labs generative media APIs.

[![CI](https://github.com/bulbulogludemir/eachlabs-ai-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/bulbulogludemir/eachlabs-ai-plugin/actions/workflows/ci.yml)

Maintained by [Demir Bülbüloğlu](https://github.com/bulbulogludemir), under the [MIT license](LICENSE). The bundled MCP server is an unofficial integration with each::labs.

Requires Node.js 20 or newer. Model discovery and schema inspection work without an API key; generation and account operations use your own each::labs account and may incur provider charges.

Give this repository to Codex or Claude Code and ask it to install the plugin. The repo contains both marketplace formats, so agents can detect the right installer for their runtime.

The plugin bundles a single `eachlabs` MCP server with:

- official each::labs docs proxy tools
- model discovery and request-schema tools
- credit-free model comparison with provider, input, and p50 latency differences
- breaking-change detection for live model schemas and workflow definitions
- prediction creation, polling, cancellation, and upload helpers
- privacy-conscious usage summaries and deterministic failed-run diagnosis
- dedicated audio transcription and speech generation tools
- workflow creation, versioning, execution, and polling tools
- workflow linting and TypeScript, Python, Go, or cURL integration code generation
- safe extensionless/signed media handling and privacy-safe debug bundles
- each::sense and each::labs LLM Router tools

## Quick Install Prompt

Paste this into Codex or Claude Code:

```text
Install the each::labs plugin from https://github.com/bulbulogludemir/eachlabs-ai-plugin.
Use the marketplace format for your runtime. Do not hardcode my API key.
If authenticated tools are needed, ask me to provide EACH_API_KEY securely.
```

## Security And API Keys

This repository does not include an API key.

- Do not commit `EACH_API_KEY` or `EACHLABS_API_KEY`.
- Do not paste keys into issue comments, screenshots, prompts, or logs.
- Docs lookup and some public catalog checks can work without a key.
- Account actions such as predictions, uploads, workflows, webhooks, each::sense, and LLM Router calls require the user's own key.

Users configure credentials during setup:

- Codex: set `EACH_API_KEY` in the environment before launching Codex.
- Claude Code: enter the API key through the plugin's sensitive `userConfig` prompt.

## Install In Codex

Add the marketplace:

```bash
codex plugin marketplace add bulbulogludemir/eachlabs-ai-plugin
```

Then install `eachlabs-ai` from the `each::labs` marketplace in the Codex Plugins UI.

For authenticated tools, provide an API key in your shell environment before launching Codex:

```bash
export EACH_API_KEY="..."
```

## Install In Claude Code

Add the marketplace:

```bash
claude plugin marketplace add bulbulogludemir/eachlabs-ai-plugin
```

Install the plugin:

```bash
claude plugin install eachlabs-ai@eachlabs-ai
```

Claude Code prompts for the API key through plugin user configuration. You can leave it empty for docs/model-listing-only workflows and configure it later for account actions.

If you configure credentials through the environment instead, use `EACHLABS_API_KEY` when leaving the Claude plugin key empty. A non-empty plugin key takes precedence.

## Try It Without Generating Media

After installation, ask your agent:

- "Find image models with image-to-image support and compare their input schemas. Do not run predictions."
- "Validate this workflow definition in structural mode without calling upstream services."
- "Compare these two workflow definitions and explain which inputs or model steps changed."

Catalog requests need network access. Structural workflow validation and workflow diffs run locally. The [MCP reference](plugins/eachlabs-ai/mcp/README.md) lists the available tools.

## What You Get

- One bundled `eachlabs` MCP server
- Official docs proxy tools: `search_each_labs`, `query_docs_filesystem_each_labs`, `eachlabs_submit_docs_feedback`
- Model search, recommendation, details, schemas, example inputs, and input validation
- Credit-free model comparison across providers, fields, constraints, and catalog p50 latency
- Live model-schema drift and local workflow-definition diffs
- Prediction create, checked create, run-and-wait, status polling, and cancellation
- Usage/cost summaries and deterministic prediction/workflow run diagnosis
- Privacy-safe debug bundles for sharing failures without prompts, outputs, logs, or secrets
- Audio transcription and streamed speech generation
- Presigned upload and local file upload helpers
- Webhook listing and webhook detail lookup
- Workflow category listing, create, update, version upsert, execute, bulk execute, and execution polling
- Public/unlisted workflow version fetch and trigger
- each::sense chat completion, model listing, workflow builder, and session tools
- each::labs LLM Router model listing and chat completions
- Raw API request escape hatch for documented endpoints not yet wrapped
- Guarded signed-media fetching and blocked unauthenticated raw writes
- API health check
- Shared each::labs skill/instructions for agent routing
- Bundled `dist/` build, so users do not need to build the MCP after installing the plugin

Public model discovery, model details, schemas, comparison, recommendation,
validation, and code generation do not require an API key. Predictions,
execution history, usage summaries, workflows, uploads, each::sense, and LLM
Router calls require the user's own key.

## Included Plugin

- `plugins/eachlabs-ai`: Codex and Claude Code plugin manifests, shared skill, bundled MCP server, and assets.

## MCP Development

The MCP server is bundled under `plugins/eachlabs-ai/mcp`.

```bash
cd plugins/eachlabs-ai/mcp
npm install
npm run check
npm run build
```

The committed `dist/` directory lets plugin installs run without a build step.

## Local Smoke Check

```bash
python3 plugins/eachlabs-ai/scripts/smoke_eachlabs.py
```

This checks the public each::labs model listing endpoint and does not require an API key.

## Contributing And Support

See [CONTRIBUTING.md](CONTRIBUTING.md) for reproducible local checks and bug-report guidance. Report problems through [GitHub Issues](https://github.com/bulbulogludemir/eachlabs-ai-plugin/issues). See [CHANGELOG.md](CHANGELOG.md) for maintenance changes.
