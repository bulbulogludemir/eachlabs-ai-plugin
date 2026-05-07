# each::labs AI Plugin

Open source Codex and Claude Code plugin for each::labs generative media APIs.

The plugin bundles a single `eachlabs` MCP server with:

- official each::labs docs proxy tools
- model discovery and request-schema tools
- prediction creation, polling, cancellation, and upload helpers
- workflow creation, versioning, execution, and polling tools
- each::sense and each::labs LLM Router tools

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
