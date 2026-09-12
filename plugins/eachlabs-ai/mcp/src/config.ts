export const EACH_API_BASE_URL =
  process.env.EACH_API_BASE_URL ??
  process.env.EACHLABS_API_BASE_URL ??
  "https://api.eachlabs.ai";

export const EACH_WORKFLOWS_BASE_URL =
  process.env.EACH_WORKFLOWS_BASE_URL ??
  process.env.EACHLABS_WORKFLOWS_BASE_URL ??
  "https://workflows.eachlabs.run/api/v1";

export const EACH_SENSE_BASE_URL =
  process.env.EACH_SENSE_BASE_URL ??
  process.env.EACHSENSE_BASE_URL ??
  "https://eachsense-agent.core.eachlabs.run";

export const EACH_SENSE_V1_BASE_URL =
  process.env.EACH_SENSE_V1_BASE_URL ?? `${EACH_SENSE_BASE_URL}/v1`;

export const EACH_DOCS_MCP_URL =
  process.env.EACH_DOCS_MCP_URL ?? "https://docs.eachlabs.ai/mcp";

export const EACH_API_KEY =
  process.env.EACH_API_KEY?.trim() || process.env.EACHLABS_API_KEY?.trim() || undefined;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_EMBED_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_EMBED_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_MEDIA_BLOCKS = 8;
export const MEDIA_DOWNLOAD_CONCURRENCY = 3;
export const MAX_AUDIO_RESPONSE_BYTES = 12 * 1024 * 1024;
export const ENABLE_EXPERIMENTAL_FLAGS =
  process.env.EACHLABS_ENABLE_EXPERIMENTAL_FLAGS === "1";

export const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/bulbulogludemir/eachlabs-ai-plugin/main/plugins/eachlabs-ai/mcp/package.json";

export const SERVER_VERSION = "0.5.1";

// The prediction detail reference still documents `failed`, while the July 7
// changelog and execution history reference use `error`. Treat both as
// terminal until the upstream documentation is fully consistent.
export const PREDICTION_TERMINAL_STATUSES = [
  "success",
  "failed",
  "error",
  "cancelled",
];

export const WORKFLOW_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "error",
  "cancelled",
];
