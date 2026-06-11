#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const EACH_API_BASE_URL = process.env.EACH_API_BASE_URL ?? "https://api.eachlabs.ai";
const EACH_WORKFLOWS_BASE_URL =
  process.env.EACH_WORKFLOWS_BASE_URL ?? "https://workflows.eachlabs.run/api/v1";
const EACH_SENSE_BASE_URL =
  process.env.EACH_SENSE_BASE_URL ?? "https://eachsense-agent.core.eachlabs.run";
const EACH_SENSE_V1_BASE_URL = process.env.EACH_SENSE_V1_BASE_URL ?? `${EACH_SENSE_BASE_URL}/v1`;
const EACH_DOCS_MCP_URL = process.env.EACH_DOCS_MCP_URL ?? "https://docs.eachlabs.ai/mcp";
const EACH_API_KEY = process.env.EACH_API_KEY ?? process.env.EACHLABS_API_KEY;

const DEFAULT_TIMEOUT_MS = 60_000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_EMBED_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_BLOCKS = 8;
const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/bulbulogludemir/eachlabs-ai-plugin/main/plugins/eachlabs-ai/mcp/package.json";
const SERVER_VERSION = "0.3.0";

const PREDICTION_TERMINAL_STATUSES = ["success", "failed", "cancelled"];
const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

class EachlabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
  }
}

const jsonObjectSchema = z.record(z.unknown());
const chatMessageSchema = z.object({
  role: z.string().describe("Message role, usually system, user, assistant, or tool."),
  content: z.unknown().describe("Message content. Strings and structured multimodal content are supported."),
});

function requireApiKey(): string {
  if (!EACH_API_KEY) {
    throw new EachlabsError(
      "Missing API key. Set EACH_API_KEY or EACHLABS_API_KEY before starting the MCP server.",
    );
  }
  return EACH_API_KEY;
}

function compact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string };

type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function text(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : compact(value),
      },
    ],
  };
}

function errorText(value: unknown): ToolResult {
  return { ...text(value), isError: true };
}

function passthroughMcpResult(value: unknown): ToolResult {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  ) {
    return value as ToolResult;
  }

  return text(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `new URL(path, base)` drops the base's own path (e.g. /api/v1) when path
// starts with "/", so URLs must be joined by string concatenation instead.
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function eachRequest<T>(
  path: string,
  options: RequestInit & {
    baseUrl?: string;
    auth?: boolean;
    bearer?: boolean;
    timeoutMs?: number;
    retries?: number;
  } = {},
): Promise<T> {
  const url = new URL(joinUrl(options.baseUrl ?? EACH_API_BASE_URL, path));
  const headers = new Headers(options.headers);

  if (options.auth !== false) {
    if (options.bearer) {
      headers.set("Authorization", `Bearer ${requireApiKey()}`);
    } else {
      headers.set("X-API-Key", requireApiKey());
    }
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (options.method ?? "GET").toUpperCase();
  const maxAttempts = (options.retries ?? 2) + 1;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw new EachlabsError(
          `Request to ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(2 ** attempt * 1000);
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      // A 429 was never processed, so any method may retry; a 5xx may have
      // had side effects, so only GETs retry automatically.
      const retryable =
        response.status === 429 || (response.status >= 500 && method === "GET");
      if (retryable && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delaySeconds = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt,
          10,
        );
        await sleep(delaySeconds * 1000);
        continue;
      }
      throw new EachlabsError(
        `Eachlabs API returned HTTP ${response.status} for ${url.pathname}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }
}

export function appendQuery(path: string, params: Record<string, unknown>): string {
  const url = new URL(path, "https://placeholder.local");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

export function summarizeJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const candidate = schema as Record<string, unknown>;
  const properties = candidate.properties;
  const required = Array.isArray(candidate.required) ? candidate.required : [];

  if (!properties || typeof properties !== "object") {
    return schema;
  }

  const fields = Object.entries(properties as Record<string, Record<string, unknown>>).map(
    ([name, field]) => ({
      name,
      type: field.type ?? field.anyOf ?? field.oneOf ?? "unknown",
      required: required.includes(name),
      description: field.description,
      default: field.default,
      enum: field.enum,
      examples: field.examples ?? field.example,
    }),
  );

  return {
    type: candidate.type ?? "object",
    required,
    fields,
  };
}

function getRequestSchema(model: Record<string, unknown>): unknown {
  return (
    model.request_schema ??
    model.input_schema ??
    model.schema ??
    (model.latest_version as Record<string, unknown> | undefined)?.request_schema
  );
}

function schemaProperties(schema: unknown): Record<string, Record<string, unknown>> {
  if (!schema || typeof schema !== "object") return {};
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return {};
  return properties as Record<string, Record<string, unknown>>;
}

function schemaRequired(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as Record<string, unknown>).required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

function exampleForField(name: string, field: Record<string, unknown>): unknown {
  if (Array.isArray(field.examples) && field.examples.length > 0) return field.examples[0];
  if ("example" in field) return field.example;
  if (Array.isArray(field.enum) && field.enum.length > 0) return field.enum[0];

  const type = field.type;
  const lowerName = name.toLowerCase();
  const description = String(field.description ?? "").toLowerCase();

  if (type === "string" || !type) {
    if (lowerName.includes("prompt")) return "A cinematic product photo of a futuristic sneaker on a clean studio background";
    if ("default" in field && typeof field.default === "string" && field.default !== "false") {
      return field.default;
    }
    if (lowerName.includes("image") || lowerName.includes("url") || description.includes("url")) {
      return "https://example.com/input.png";
    }
    if (lowerName.includes("aspect")) return "1:1";
    if (lowerName.includes("ratio")) return "1:1";
    return `example_${name}`;
  }
  if ("default" in field) return field.default;
  if (type === "number") return field.minimum ?? 1;
  if (type === "integer") return field.minimum ?? 1;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};

  return null;
}

export function generateExampleInput(schema: unknown, includeOptional: boolean, overrides: Record<string, unknown>) {
  const properties = schemaProperties(schema);
  const required = new Set(schemaRequired(schema));
  const input: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(properties)) {
    if (includeOptional || required.has(name)) {
      input[name] = exampleForField(name, field);
    }
  }

  return { ...input, ...overrides };
}

export function validateAgainstSchema(schema: unknown, input: Record<string, unknown>) {
  const properties = schemaProperties(schema);
  const required = schemaRequired(schema);
  const errors: Array<{ field: string; message: string; expected?: unknown; actual?: unknown }> = [];
  const warnings: Array<{ field: string; message: string }> = [];

  for (const field of required) {
    if (!(field in input) || input[field] === undefined || input[field] === null || input[field] === "") {
      errors.push({ field, message: "Required field is missing or empty." });
    }
  }

  for (const [field, value] of Object.entries(input)) {
    const property = properties[field];
    if (!property) {
      warnings.push({ field, message: "Field is not present in the documented request schema." });
      continue;
    }

    const expected = property.type;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (typeof expected === "string") {
      const normalizedExpected = expected === "integer" ? "number" : expected;
      if (expected !== "null" && actual !== normalizedExpected) {
        errors.push({ field, message: "Field type does not match schema.", expected, actual });
      }
      if (expected === "integer" && typeof value === "number" && !Number.isInteger(value)) {
        errors.push({ field, message: "Field must be an integer.", expected, actual });
      }
    }

    if (Array.isArray(property.enum) && !property.enum.includes(value as never)) {
      errors.push({ field, message: "Field is not one of the documented enum values.", expected: property.enum, actual: value });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

let modelCache:
  | { models: Array<Record<string, unknown>>; complete: boolean; fetchedAt: number }
  | undefined;

async function getAllModels(maxModels: number): Promise<Array<Record<string, unknown>>> {
  const cached = modelCache;
  if (
    cached &&
    Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS &&
    (cached.complete || cached.models.length >= maxModels)
  ) {
    return cached.models.slice(0, maxModels);
  }

  const pageSize = 100;
  const models: Array<Record<string, unknown>> = [];
  let complete = false;

  for (let offset = 0; models.length < maxModels; offset += pageSize) {
    const page = await eachRequest<unknown>(appendQuery("/v1/models", { limit: pageSize, offset }), {
      auth: false,
    });
    if (!Array.isArray(page) || page.length === 0) {
      complete = true;
      break;
    }
    models.push(...(page as Array<Record<string, unknown>>));
    if (page.length < pageSize) {
      complete = true;
      break;
    }
  }

  modelCache = { models, complete, fetchedAt: Date.now() };
  return models.slice(0, maxModels);
}

export function trimModel(model: Record<string, unknown>) {
  return {
    title: model.title,
    slug: model.slug,
    version: model.version,
    output_type: model.output_type,
    request_fields: Object.keys(schemaProperties(getRequestSchema(model))),
  };
}

function scoreModel(model: Record<string, unknown>, terms: string[], requiredFields: string[], outputType?: string) {
  const title = String(model.title ?? "").toLowerCase();
  const slug = String(model.slug ?? "").toLowerCase();
  const provider = String(model.provider ?? "").toLowerCase();
  const haystack = `${title} ${slug} ${provider}`;
  const schema = getRequestSchema(model);
  const fields = new Set(Object.keys(schemaProperties(schema)));
  let score = 0;

  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(term)) score += 4;
    for (const field of fields) {
      if (field.toLowerCase().includes(term)) score += 1;
    }
  }

  for (const field of requiredFields) {
    if (fields.has(field)) score += 6;
  }

  if (outputType && String(model.output_type ?? "").toLowerCase().includes(outputType.toLowerCase())) {
    score += 5;
  }

  return score;
}

async function getModelBySlug(slug: string): Promise<Record<string, unknown>> {
  return eachRequest<Record<string, unknown>>(appendQuery("/v1/model", { slug }));
}

async function callOfficialDocsTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: "eachlabs-unofficial-docs-proxy", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(EACH_DOCS_MCP_URL));

  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  ...IMAGE_MIME_BY_EXTENSION,
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};

function urlExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    return dot === -1 ? "" : pathname.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

export function collectMediaUrls(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value) && MEDIA_MIME_BY_EXTENSION[urlExtension(value)]) {
      found.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectMediaUrls(item, found);
  }
  return found;
}

async function mediaContentBlocks(output: unknown, embedImages: boolean): Promise<ContentBlock[]> {
  const urls = [...new Set(collectMediaUrls(output))].slice(0, MAX_MEDIA_BLOCKS);
  const blocks: ContentBlock[] = [];

  for (const url of urls) {
    const extension = urlExtension(url);
    const imageMime = IMAGE_MIME_BY_EXTENSION[extension];

    if (imageMime && embedImages) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const declaredLength = Number(response.headers.get("content-length"));
        if (response.ok && (!Number.isFinite(declaredLength) || declaredLength <= MAX_EMBED_IMAGE_BYTES)) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength <= MAX_EMBED_IMAGE_BYTES) {
            blocks.push({ type: "image", data: buffer.toString("base64"), mimeType: imageMime });
            continue;
          }
        }
      } catch {
        // fall through to a link block
      }
    }

    blocks.push({
      type: "resource_link",
      uri: url,
      name: decodeURIComponent(url.split("/").pop() ?? url).split("?")[0],
      mimeType: MEDIA_MIME_BY_EXTENSION[extension],
    });
  }

  return blocks;
}

async function predictionToolResult(
  value: unknown,
  prediction: Record<string, unknown> | undefined,
  includeMedia: boolean,
  embedImages: boolean,
): Promise<ToolResult> {
  const base = text(value);
  if (!includeMedia || !prediction) return base;
  const status = String(prediction.status ?? "").toLowerCase();
  if (status !== "success") return base;

  const media = await mediaContentBlocks(prediction.output, embedImages);
  return media.length > 0 ? { content: [...base.content, ...media] } : base;
}

// Subset of the SDK's RequestHandlerExtra that the poll helper relies on.
type ToolExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
};

async function pollUntilDone(
  fetchCurrent: () => Promise<Record<string, unknown>>,
  terminalStatuses: string[],
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  extra?: ToolExtra,
): Promise<{ completed: boolean; last?: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: Record<string, unknown> | undefined;

  while (Date.now() <= deadline) {
    if (extra?.signal?.aborted) break;
    last = await fetchCurrent();
    const status = String(last.status ?? "").toLowerCase();
    if (terminalStatuses.includes(status)) {
      return { completed: true, last };
    }

    const progressToken = extra?._meta?.progressToken;
    if (progressToken !== undefined && extra?.sendNotification) {
      const elapsedSeconds = Math.round(timeoutSeconds - (deadline - Date.now()) / 1000);
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: elapsedSeconds, total: timeoutSeconds, message: status },
        })
        .catch(() => undefined);
    }

    await sleep(pollIntervalSeconds * 1000);
  }

  return { completed: false, last };
}

// Consumes an SSE response server-side: concatenates OpenAI-style text deltas,
// keeps non-delta events (status, generation_response, complete, ...), and
// bridges them to MCP progress notifications. Falls back to plain JSON when
// the upstream answers without text/event-stream.
async function eachRequestStreaming(
  path: string,
  options: { baseUrl: string; body: string; timeoutMs?: number },
  extra?: ToolExtra,
): Promise<unknown> {
  const url = new URL(joinUrl(options.baseUrl, path));
  const headers = new Headers({
    "X-API-Key": requireApiKey(),
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  });

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    throw new EachlabsError(
      `Eachlabs API returned HTTP ${response.status} for ${url.pathname}`,
      response.status,
      payload,
    );
  }

  if (!contentType.includes("text/event-stream") || !response.body) {
    return contentType.includes("application/json") ? response.json() : response.text();
  }

  const progressToken = extra?._meta?.progressToken;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textOut = "";
  let eventCount = 0;
  const events: unknown[] = [];

  const handleData = async (data: string) => {
    if (data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      events.push(data);
      return;
    }
    eventCount++;

    const record = event as Record<string, any>;
    const delta = record?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") textOut += delta.content;

    // Keep everything that is not a plain text/thinking delta chunk.
    const extension = record?.eachlabs ?? record?.choices?.[0]?.delta?.eachlabs;
    const extensionType = String(extension?.type ?? record?.type ?? "");
    const isDeltaChunk =
      typeof delta?.content === "string" || extensionType.includes("delta");
    if (!isDeltaChunk && events.length < 100) {
      events.push(extension ?? event);
    }

    if (progressToken !== undefined && extra?.sendNotification && !isDeltaChunk) {
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: eventCount,
            message: extensionType || "streaming",
          },
        })
        .catch(() => undefined);
    }
  };

  while (true) {
    if (extra?.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        await handleData(line.slice(5).trim());
      }
    }
  }

  return {
    streamed: true,
    text: textOut || undefined,
    events,
    event_count: eventCount,
  };
}

const server = new McpServer(
  {
    name: "eachlabs-mcp",
    version: SERVER_VERSION,
  },
  {
    instructions: [
      "Unofficial MCP server for the each::labs platform (models, predictions, workflows, each::sense, LLM router).",
      "Typical model-run flow: eachlabs_search_models -> eachlabs_get_model_request_schema -> eachlabs_create_prediction (mode 'wait' for short jobs, 'async' + eachlabs_get_prediction for long ones).",
      "Media inputs must be URLs; upload local files first with eachlabs_upload_file.",
      "Requires EACH_API_KEY (or EACHLABS_API_KEY) in the environment for everything except the public model catalog and docs search.",
    ].join("\n"),
  },
);

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const write = { readOnlyHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function registerTool(
  name: string,
  config: { title: string; description: string; annotations: Record<string, boolean> },
  inputSchema: z.ZodRawShape,
  handler: (args: any, extra: any) => Promise<ToolResult>,
) {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema,
      annotations: config.annotations,
    },
    (async (args: any, extra: any) => {
      try {
        return await handler(args, extra);
      } catch (error) {
        if (error instanceof EachlabsError) {
          return errorText({
            error: error.message,
            status: error.status ?? null,
            upstream: error.payload ?? null,
          });
        }
        return errorText({
          error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }) as any,
  );
}

// --- Official docs proxy -----------------------------------------------------

registerTool(
  "search_each_labs",
  {
    title: "Search each::labs docs",
    description:
      "Search across the each::labs knowledge base to find relevant information, code examples, API references, and guides. This mirrors the official each::labs MCP documentation search tool.",
    annotations: { ...readOnly },
  },
  {
    query: z.string().min(1).describe("Search query"),
  },
  async ({ query }) => passthroughMcpResult(await callOfficialDocsTool("search_each_labs", { query })),
);

registerTool(
  "query_docs_filesystem_each_labs",
  {
    title: "Query each::labs docs filesystem",
    description:
      "Run a read-only shell-like query against the official each::labs virtual documentation filesystem. Supports commands such as rg, tree, ls, cat, head, jq, sed, and awk. This mirrors the official each::labs MCP docs filesystem tool.",
    annotations: { ...readOnly },
  },
  {
    command: z
      .string()
      .min(1)
      .describe("Read-only shell command for the virtual docs filesystem, e.g. `tree / -L 2` or `head -80 /quickstart.mdx`."),
  },
  async ({ command }) =>
    passthroughMcpResult(await callOfficialDocsTool("query_docs_filesystem_each_labs", { command })),
);

// --- Model catalog and schemas -----------------------------------------------

registerTool(
  "eachlabs_search_models",
  {
    title: "Search model catalog",
    description:
      "Search and paginate the each::labs model catalog. Returns trimmed entries (title, slug, version, output_type, request field names) by default; set full=true for raw catalog records including complete request schemas.",
    annotations: { ...readOnly },
  },
  {
    name: z.string().optional().describe("Case-insensitive model name or slug search."),
    limit: z.number().int().min(1).max(500).default(25),
    offset: z.number().int().min(0).default(0),
    full: z.boolean().default(false).describe("Return raw catalog records instead of trimmed summaries."),
  },
  async ({ name, limit, offset, full }) => {
    const result = await eachRequest<unknown>(appendQuery("/v1/models", { name, limit, offset }), {
      auth: false,
    });
    if (!full && Array.isArray(result)) {
      return text({
        models: (result as Array<Record<string, unknown>>).map(trimModel),
        count: result.length,
        note: "Trimmed view. Use eachlabs_get_model_request_schema for full field details.",
      });
    }
    return text(result);
  },
);

registerTool(
  "eachlabs_get_model",
  {
    title: "Get model details",
    description: "Fetch full metadata for a model slug, including provider, versions, and request schema when available.",
    annotations: { ...readOnly },
  },
  {
    slug: z.string().min(1).describe("Model slug, for example flux-2-max."),
  },
  async ({ slug }) => text(await getModelBySlug(slug)),
);

registerTool(
  "eachlabs_get_model_request_schema",
  {
    title: "Get model request schema",
    description:
      "Return the model request schema in a compact field-by-field form so an agent can build valid prediction input. Set openapi=true to fetch the official per-model OpenAPI 3.0 schema (inputs and outputs) instead.",
    annotations: { ...readOnly },
  },
  {
    slug: z.string().min(1),
    raw: z.boolean().default(false).describe("Return the raw JSON schema instead of the compact summary."),
    openapi: z
      .boolean()
      .default(false)
      .describe("Fetch GET /v1/models/{slug}/schemas/openapi — the full OpenAPI schema including output types."),
  },
  async ({ slug, raw, openapi }) => {
    if (openapi) {
      return text({
        slug,
        openapi_schema: await eachRequest(`/v1/models/${slug}/schemas/openapi`),
      });
    }

    const model = await getModelBySlug(slug);
    const schema = getRequestSchema(model);

    return text({
      slug,
      schema: raw ? schema ?? null : summarizeJsonSchema(schema),
      raw_available: Boolean(schema),
    });
  },
);

registerTool(
  "eachlabs_generate_example_input",
  {
    title: "Generate example model input",
    description: "Generate a best-effort valid example input object for a model from its documented request_schema.",
    annotations: { ...readOnly },
  },
  {
    slug: z.string().min(1),
    include_optional: z.boolean().default(false),
    overrides: jsonObjectSchema.default({}).describe("Values to merge into the generated example input."),
  },
  async ({ slug, include_optional, overrides }) => {
    const model = await getModelBySlug(slug);
    const schema = getRequestSchema(model);

    return text({
      slug,
      input: generateExampleInput(schema, include_optional, overrides),
      schema: summarizeJsonSchema(schema),
      note: "Generated locally from schema defaults, examples, enums, and type hints. Replace placeholder URLs/prompts before running paid predictions.",
    });
  },
);

registerTool(
  "eachlabs_validate_model_input",
  {
    title: "Validate model input",
    description: "Validate model input locally against the documented request_schema before creating a prediction.",
    annotations: { ...readOnly },
  },
  {
    slug: z.string().min(1),
    input: jsonObjectSchema,
  },
  async ({ slug, input }) => {
    const model = await getModelBySlug(slug);
    const schema = getRequestSchema(model);

    return text({
      slug,
      ...validateAgainstSchema(schema, input),
      schema: summarizeJsonSchema(schema),
    });
  },
);

registerTool(
  "eachlabs_find_models_by_schema",
  {
    title: "Find models by schema fields",
    description:
      "Find models by catalog text, output type, and request_schema field names such as prompt, image_url, aspect_ratio, duration, or seed.",
    annotations: { ...readOnly },
  },
  {
    query: z.string().optional().describe("Text to match against model title, slug, or provider."),
    required_fields: z.array(z.string()).default([]).describe("Fields that must exist in the request schema."),
    any_fields: z.array(z.string()).default([]).describe("At least one of these fields should exist in the request schema."),
    output_type: z.string().optional(),
    max_scan: z.number().int().min(1).max(1000).default(500),
    limit: z.number().int().min(1).max(100).default(25),
  },
  async ({ query, required_fields, any_fields, output_type, max_scan, limit }) => {
    const models = await getAllModels(max_scan);
    const queryLower = query?.toLowerCase();

    const matches = models
      .filter((model) => {
        const schema = getRequestSchema(model);
        const fields = new Set(Object.keys(schemaProperties(schema)));
        const title = String(model.title ?? "").toLowerCase();
        const slug = String(model.slug ?? "").toLowerCase();
        const provider = String(model.provider ?? "").toLowerCase();

        if (queryLower && !`${title} ${slug} ${provider}`.includes(queryLower)) return false;
        if (output_type && !String(model.output_type ?? "").toLowerCase().includes(output_type.toLowerCase())) {
          return false;
        }
        if (required_fields.some((field: string) => !fields.has(field))) return false;
        if (any_fields.length > 0 && !any_fields.some((field: string) => fields.has(field))) return false;
        return true;
      })
      .slice(0, limit)
      .map(trimModel);

    return text({ matches, scanned: models.length });
  },
);

registerTool(
  "eachlabs_recommend_models",
  {
    title: "Recommend models",
    description: "Recommend models for a use case by scoring catalog text, output type, and request_schema fields.",
    annotations: { ...readOnly },
  },
  {
    use_case: z.string().min(1).describe("Example: text to image, image to video, voice cloning, background removal."),
    output_type: z.string().optional(),
    required_fields: z.array(z.string()).default([]),
    max_scan: z.number().int().min(1).max(1000).default(500),
    limit: z.number().int().min(1).max(20).default(10),
  },
  async ({ use_case, output_type, required_fields, max_scan, limit }) => {
    const terms = use_case
      .toLowerCase()
      .split(/[^a-z0-9_:-]+/g)
      .filter(Boolean);
    const models = await getAllModels(max_scan);

    const recommendations = models
      .map((model) => ({
        score: scoreModel(model, terms, required_fields, output_type),
        ...trimModel(model),
      }))
      .filter((model) => model.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return text({
      use_case,
      recommendations,
      scanned: models.length,
      note: "Local ranking heuristic. Confirm the selected model with eachlabs_get_model_request_schema before running it.",
    });
  },
);

// --- Predictions ---------------------------------------------------------------

registerTool(
  "eachlabs_create_prediction",
  {
    title: "Create prediction",
    description:
      "Run a model. mode 'async' (default) returns a prediction ID to poll with eachlabs_get_prediction; 'wait' creates then polls until done; 'sync' uses POST /v1/prediction/run for models that support synchronous execution (others return 400). Input is validated locally against the model's request_schema first unless validate_input=false.",
    annotations: { ...write },
  },
  {
    model: z.string().min(1).describe("Model slug or identifier."),
    input: jsonObjectSchema.describe(
      "Model-specific request parameters. enable_safety_checker (supported models only) also goes in here.",
    ),
    mode: z.enum(["async", "wait", "sync"]).default("async"),
    validate_input: z
      .boolean()
      .default(true)
      .describe("Validate input against the model request_schema before creating. Skipped if no schema is documented."),
    webhook_url: z.string().url().optional(),
    webhook_secret: z.string().optional().describe("HMAC-SHA256 secret used to sign webhook deliveries."),
    timeout_seconds: z.number().int().min(1).max(1800).default(300).describe("Only used for mode 'wait' and 'sync'."),
    poll_interval_seconds: z.number().min(0.5).max(30).default(3).describe("Only used for mode 'wait'."),
    include_media: z
      .boolean()
      .default(true)
      .describe("Attach successful outputs as media content blocks (inline images, links for video/audio)."),
    embed_images: z
      .boolean()
      .default(true)
      .describe("Inline image outputs up to 3 MB as image content; larger ones become resource links."),
  },
  async (
    {
      model,
      input,
      mode,
      validate_input,
      webhook_url,
      webhook_secret,
      timeout_seconds,
      poll_interval_seconds,
      include_media,
      embed_images,
    },
    extra,
  ) => {
    if (validate_input) {
      const modelDetails = await getModelBySlug(model);
      const schema = getRequestSchema(modelDetails);
      if (schema) {
        const validation = validateAgainstSchema(schema, input);
        if (!validation.valid) {
          return errorText({
            created: false,
            validation,
            schema: summarizeJsonSchema(schema),
          });
        }
      }
    }

    const body = JSON.stringify({ model, input, webhook_url, webhook_secret });

    if (mode === "sync") {
      const result = await eachRequest<Record<string, unknown>>("/v1/prediction/run", {
        method: "POST",
        body,
        timeoutMs: Math.max(timeout_seconds * 1000, DEFAULT_TIMEOUT_MS),
      });
      return predictionToolResult(result, result, include_media, embed_images);
    }

    const created = await eachRequest<Record<string, unknown>>("/v1/prediction", {
      method: "POST",
      body,
    });
    if (mode === "async") return text(created);

    const predictionId = String(created.predictionID ?? created.id ?? created.prediction_id ?? "");
    if (!predictionId) {
      return text({ created, warning: "Prediction response did not include a prediction ID; cannot wait." });
    }

    const { completed, last } = await pollUntilDone(
      () => eachRequest<Record<string, unknown>>(`/v1/prediction/${predictionId}`),
      PREDICTION_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    if (!completed) return text({ created, status: "timeout", last });
    return predictionToolResult({ created, final: last }, last, include_media, embed_images);
  },
);

registerTool(
  "eachlabs_get_prediction",
  {
    title: "Get prediction",
    description:
      "Get the current status, output, logs, cost, and related URLs for a prediction. Set wait=true to poll until it reaches a terminal status (success, failed, cancelled) or times out.",
    annotations: { ...readOnly },
  },
  {
    prediction_id: z.string().min(1),
    wait: z.boolean().default(false),
    timeout_seconds: z.number().int().min(1).max(1800).default(300).describe("Only used when wait=true."),
    poll_interval_seconds: z.number().min(0.5).max(30).default(3).describe("Only used when wait=true."),
    include_media: z
      .boolean()
      .default(true)
      .describe("Attach successful outputs as media content blocks (inline images, links for video/audio)."),
    embed_images: z
      .boolean()
      .default(true)
      .describe("Inline image outputs up to 3 MB as image content; larger ones become resource links."),
  },
  async ({ prediction_id, wait, timeout_seconds, poll_interval_seconds, include_media, embed_images }, extra) => {
    if (!wait) {
      const prediction = await eachRequest<Record<string, unknown>>(`/v1/prediction/${prediction_id}`);
      return predictionToolResult(prediction, prediction, include_media, embed_images);
    }

    const { completed, last } = await pollUntilDone(
      () => eachRequest<Record<string, unknown>>(`/v1/prediction/${prediction_id}`),
      PREDICTION_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    if (!completed) return text({ status: "timeout", prediction_id, last });
    return predictionToolResult(last, last, include_media, embed_images);
  },
);

registerTool(
  "eachlabs_cancel_prediction",
  {
    title: "Cancel prediction",
    description: "Cancel a running prediction. Best-effort for upstream providers.",
    annotations: { ...write, idempotentHint: true },
  },
  {
    prediction_id: z.string().min(1),
  },
  async ({ prediction_id }) =>
    text(await eachRequest(`/v1/prediction/${prediction_id}/cancel`, { method: "POST" })),
);

registerTool(
  "eachlabs_list_executions",
  {
    title: "List execution history",
    description:
      "List prediction and workflow execution history for the API key, with per-execution cost and runtime. Filter by model slug, status, workflow, or time window.",
    annotations: { ...readOnly },
  },
  {
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    model: z.string().optional().describe("Filter by model slug."),
    status: z.string().optional().describe("Comma-separated statuses, e.g. success,failed."),
    workflow_id: z.string().optional(),
    workflow_execution_id: z.string().optional(),
    from: z.string().optional().describe("RFC 3339 start of time window, e.g. 2026-06-01T00:00:00Z."),
    to: z.string().optional().describe("RFC 3339 end of time window."),
  },
  async ({ limit, offset, model, status, workflow_id, workflow_execution_id, from, to }) =>
    text(
      await eachRequest(
        appendQuery("/v1/executions", { limit, offset, model, status, workflow_id, workflow_execution_id, from, to }),
      ),
    ),
);

// --- Storage -------------------------------------------------------------------

registerTool(
  "eachlabs_presign_upload",
  {
    title: "Presign file upload",
    description:
      "Request a presigned upload URL for media files, then PUT bytes to presigned_url (echoing required_headers) and pass public_url to model inputs.",
    annotations: { ...write },
  },
  {
    content_type: z.string().min(1).describe("MIME type, e.g. image/png, video/mp4, audio/mpeg."),
    file_type: z.enum(["image", "video", "audio", "other"]).default("other"),
    expires_in_seconds: z.number().int().min(1).optional().describe("Optional retention control for the stored file."),
  },
  async ({ content_type, file_type, expires_in_seconds }) =>
    text(
      await eachRequest("/v1/upload/presign", {
        method: "POST",
        body: JSON.stringify({ content_type, file_type, expires_in_seconds }),
      }),
    ),
);

registerTool(
  "eachlabs_upload_file",
  {
    title: "Upload local file",
    description:
      "Upload a local file through Eachlabs presigned storage and return the public_url for model inputs. Max documented upload size is 100 MB.",
    annotations: { ...write },
  },
  {
    file_path: z.string().min(1).describe("Absolute local file path."),
    content_type: z.string().min(1).describe("MIME type, e.g. image/png, video/mp4, audio/mpeg."),
    file_type: z.enum(["image", "video", "audio", "other"]).default("other"),
    expires_in_seconds: z.number().int().min(1).optional().describe("Optional retention control for the stored file."),
  },
  async ({ file_path, content_type, file_type, expires_in_seconds }) => {
    const info = await stat(file_path);
    if (info.size > MAX_UPLOAD_BYTES) {
      return errorText({
        uploaded: false,
        error: `File is ${info.size} bytes; the documented upload limit is 100 MB.`,
      });
    }

    const presign = await eachRequest<Record<string, unknown>>("/v1/upload/presign", {
      method: "POST",
      body: JSON.stringify({ content_type, file_type, expires_in_seconds }),
    });
    const presignedUrl = String(presign.presigned_url ?? "");
    if (!presignedUrl) {
      return errorText({ uploaded: false, presign, error: "presigned_url missing from response." });
    }

    const requiredHeaders =
      presign.required_headers && typeof presign.required_headers === "object"
        ? (presign.required_headers as Record<string, string>)
        : {};
    const bytes = await readFile(file_path);
    const uploadResponse = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": content_type,
        ...requiredHeaders,
      },
      body: bytes,
    });

    if (!uploadResponse.ok) {
      return errorText({
        uploaded: false,
        status: uploadResponse.status,
        response: await uploadResponse.text(),
        presign,
      });
    }

    return text({
      uploaded: true,
      public_url: presign.public_url,
      id: presign.id,
      expires_at: presign.expires_at,
    });
  },
);

registerTool(
  "eachlabs_delete_file",
  {
    title: "Delete uploaded file",
    description:
      "Permanently delete an uploaded file by the ID returned from presign/upload. Idempotent; returns 409 if the upload is still processing.",
    annotations: { ...destructive, idempotentHint: true },
  },
  {
    file_id: z.string().min(1).describe("File ID from the presign response."),
  },
  async ({ file_id }) => {
    const result = await eachRequest<unknown>(`/v1/files/${file_id}`, { method: "DELETE" });
    return text(result === "" ? { deleted: true, file_id } : result);
  },
);

// --- Webhooks --------------------------------------------------------------------

registerTool(
  "eachlabs_list_webhooks",
  {
    title: "List webhook deliveries",
    description: "List recent webhook deliveries for the authenticated organization.",
    annotations: { ...readOnly },
  },
  {
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  },
  async ({ limit, offset }) => text(await eachRequest(appendQuery("/v1/webhooks", { limit, offset }))),
);

registerTool(
  "eachlabs_get_webhook",
  {
    title: "Get webhook delivery",
    description: "Get webhook details and delivery attempts by execution ID.",
    annotations: { ...readOnly },
  },
  {
    execution_id: z.string().min(1),
  },
  async ({ execution_id }) => text(await eachRequest(`/v1/webhooks/${execution_id}`)),
);

// --- Workflows ---------------------------------------------------------------------

registerTool(
  "eachlabs_list_workflow_categories",
  {
    title: "List workflow categories",
    description: "List workflow categories available for creating or organizing workflows.",
    annotations: { ...readOnly },
  },
  {},
  async () => text(await eachRequest("/categories", { baseUrl: EACH_WORKFLOWS_BASE_URL })),
);

registerTool(
  "eachlabs_create_workflow",
  {
    title: "Create workflow",
    description: "Create a workflow with its initial version. Use model request schemas to build model-step params.",
    annotations: { ...write },
  },
  {
    workflow: jsonObjectSchema.describe(
      "CreateWorkflowRequest body from the each::workflows API, including name, description, categories, and definition.",
    ),
  },
  async ({ workflow }) =>
    text(
      await eachRequest("/workflows", {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "POST",
        body: JSON.stringify(workflow),
      }),
    ),
);

registerTool(
  "eachlabs_get_workflow",
  {
    title: "Get workflow",
    description:
      "Fetch workflow metadata and versions by workflow ID or slug. Note: the workflows API has no list endpoint; you must know the ID or slug.",
    annotations: { ...readOnly },
  },
  {
    workflow_id: z.string().min(1).describe("Workflow UUID or slug."),
  },
  async ({ workflow_id }) =>
    text(await eachRequest(`/workflows/${workflow_id}`, { baseUrl: EACH_WORKFLOWS_BASE_URL })),
);

registerTool(
  "eachlabs_update_workflow",
  {
    title: "Update workflow",
    description:
      "Update workflow metadata such as name, description, categories, locked, or production. Fails with 403 if the workflow is locked.",
    annotations: { ...destructive },
  },
  {
    workflow_id: z.string().min(1),
    updates: jsonObjectSchema.describe("UpdateWorkflowRequest body."),
  },
  async ({ workflow_id, updates }) =>
    text(
      await eachRequest(`/workflows/${workflow_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "PUT",
        body: JSON.stringify(updates),
      }),
    ),
);

registerTool(
  "eachlabs_upsert_workflow_version",
  {
    title: "Upsert workflow version",
    description:
      "Create or update a workflow version, including definition steps, input_schema, fallback config, and sharing flags. Locked versions are immutable; the upserted version becomes latest.",
    annotations: { ...destructive },
  },
  {
    workflow_id: z.string().min(1),
    version_id: z.string().min(1),
    body: jsonObjectSchema.describe("UpsertVersionRequest body."),
  },
  async ({ workflow_id, version_id, body }) =>
    text(
      await eachRequest(`/workflows/${workflow_id}/versions/${version_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "PUT",
        body: JSON.stringify(body),
      }),
    ),
);

registerTool(
  "eachlabs_execute_workflow",
  {
    title: "Execute workflow",
    description:
      "Execute an each::workflows workflow with input parameters. Returns an execution_id to poll with eachlabs_get_workflow_execution.",
    annotations: { ...write },
  },
  {
    workflow_id: z.string().min(1),
    inputs: jsonObjectSchema.default({}),
    version_id: z.string().optional().describe("Defaults to the latest version."),
    webhook_url: z.string().url().optional(),
  },
  async ({ workflow_id, inputs, version_id, webhook_url }) =>
    text(
      await eachRequest(`/${workflow_id}/trigger`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "POST",
        body: JSON.stringify({ version_id, inputs, webhook_url }),
      }),
    ),
);

registerTool(
  "eachlabs_bulk_execute_workflow",
  {
    title: "Bulk execute workflow",
    description: "Trigger a workflow up to 10 times in one bulk operation. Returns a bulk_id plus per-item executions.",
    annotations: { ...write },
  },
  {
    workflow_id: z.string().min(1),
    inputs: z
      .array(jsonObjectSchema)
      .min(1)
      .max(10)
      .describe("One input object per execution; the API allows 1-10 items."),
    version_id: z.string().optional(),
    webhook_url: z.string().url().optional(),
  },
  async ({ workflow_id, inputs, version_id, webhook_url }) =>
    text(
      await eachRequest(`/${workflow_id}/bulk-trigger`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "POST",
        body: JSON.stringify({ version_id, inputs, webhook_url }),
      }),
    ),
);

registerTool(
  "eachlabs_list_workflow_executions",
  {
    title: "List workflow executions",
    description: "List executions for a specific workflow, optionally filtered by bulk_id.",
    annotations: { ...readOnly },
  },
  {
    workflow_id: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    bulk_id: z.string().optional(),
  },
  async ({ workflow_id, limit, offset, bulk_id }) =>
    text(
      await eachRequest(appendQuery(`/workflows/${workflow_id}/executions`, { limit, offset, bulk_id }), {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
      }),
    ),
);

registerTool(
  "eachlabs_get_workflow_execution",
  {
    title: "Get workflow execution",
    description:
      "Get status and per-step details for a workflow execution. Set wait=true to poll until it reaches a terminal status (completed, failed, cancelled) or times out.",
    annotations: { ...readOnly },
  },
  {
    execution_id: z.string().min(1),
    wait: z.boolean().default(false),
    timeout_seconds: z.number().int().min(1).max(3600).default(600).describe("Only used when wait=true."),
    poll_interval_seconds: z.number().min(0.5).max(30).default(5).describe("Only used when wait=true."),
  },
  async ({ execution_id, wait, timeout_seconds, poll_interval_seconds }, extra) => {
    const fetchExecution = () =>
      eachRequest<Record<string, unknown>>(`/executions/${execution_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
      });

    if (!wait) return text(await fetchExecution());

    const { completed, last } = await pollUntilDone(
      fetchExecution,
      WORKFLOW_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    return text(completed ? last : { status: "timeout", execution_id, last });
  },
);

registerTool(
  "eachlabs_get_public_workflow_version",
  {
    title: "Get public workflow version",
    description: "Fetch a public or unlisted workflow version by organization nickname, workflow slug, and version ID.",
    annotations: { ...readOnly },
  },
  {
    nickname: z.string().min(1).describe("Organization nickname without @."),
    slug: z.string().min(1),
    version_id: z.string().min(1),
  },
  async ({ nickname, slug, version_id }) =>
    text(
      await eachRequest(`/public/@${nickname}/workflows/${slug}/versions/${version_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        auth: false,
      }),
    ),
);

registerTool(
  "eachlabs_execute_public_workflow_version",
  {
    title: "Execute public workflow version",
    description: "Trigger a public or unlisted workflow version by organization nickname, workflow slug, and version ID.",
    annotations: { ...write },
  },
  {
    nickname: z.string().min(1).describe("Organization nickname without @."),
    slug: z.string().min(1),
    version_id: z.string().min(1),
    inputs: jsonObjectSchema.default({}),
    webhook_url: z.string().url().optional(),
  },
  async ({ nickname, slug, version_id, inputs, webhook_url }) =>
    text(
      await eachRequest(`/public/@${nickname}/workflows/${slug}/versions/${version_id}/trigger`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "POST",
        body: JSON.stringify({ inputs, webhook_url }),
      }),
    ),
);

// --- each::sense -----------------------------------------------------------------

registerTool(
  "eachsense_chat_completion",
  {
    title: "each::sense chat completion",
    description:
      "Call the each::sense OpenAI-compatible chat completions endpoint (agentic media generation, workflow help). For plain LLM routing across providers use eachlabs_llm_chat_completion instead. Upstream SSE is consumed server-side and returned as aggregated text plus notable events.",
    annotations: { ...write },
  },
  {
    model: z.string().min(1).default("eachsense/beta"),
    messages: z.array(chatMessageSchema).min(1),
    stream: z
      .boolean()
      .default(true)
      .describe(
        "Use upstream streaming, aggregated server-side (recommended: progress notifications, no idle timeout). false requests a single buffered JSON response.",
      ),
    session_id: z.string().optional().describe("Continue an existing each::sense session."),
    mode: z.enum(["max", "eco"]).optional(),
    behavior: z.enum(["agent", "plan", "ask"]).optional(),
    image_urls: z.array(z.string().url()).max(4).optional().describe("Up to 4 input image URLs."),
    web_search: z.boolean().optional(),
    workflow_id: z.string().optional(),
    version_id: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).optional(),
    extra: jsonObjectSchema.default({}).describe("Additional provider-specific request fields."),
  },
  async (
    {
      model,
      messages,
      stream,
      session_id,
      mode,
      behavior,
      image_urls,
      web_search,
      workflow_id,
      version_id,
      tools,
      tool_choice,
      temperature,
      max_tokens,
      extra,
    },
    handlerExtra,
  ) => {
    const payload = {
      model,
      messages,
      session_id,
      mode,
      behavior,
      image_urls,
      web_search,
      workflow_id,
      version_id,
      tools,
      tool_choice,
      temperature,
      max_tokens,
      ...extra,
    };

    if (stream) {
      return text(
        await eachRequestStreaming(
          "/chat/completions",
          { baseUrl: EACH_SENSE_V1_BASE_URL, body: JSON.stringify({ ...payload, stream: true }) },
          handlerExtra,
        ),
      );
    }

    return text(
      await eachRequest("/chat/completions", {
        baseUrl: EACH_SENSE_V1_BASE_URL,
        method: "POST",
        timeoutMs: 300_000,
        body: JSON.stringify({ ...payload, stream: false }),
      }),
    );
  },
);

registerTool(
  "eachsense_list_models",
  {
    title: "List each::sense models",
    description: "List each::sense OpenAI-compatible exposed models.",
    annotations: { ...readOnly },
  },
  {},
  async () => text(await eachRequest("/models", { baseUrl: EACH_SENSE_V1_BASE_URL })),
);

registerTool(
  "eachsense_build_workflow",
  {
    title: "each::sense workflow builder",
    description: "Use each::sense Workflow Builder to create or update a multi-step AI workflow from natural language.",
    annotations: { ...write },
  },
  {
    message: z.string().min(1).describe("Workflow description or modification instruction."),
    workflow_id: z.string().optional(),
    version_id: z.string().optional(),
    session_id: z.string().optional(),
    stream: z
      .boolean()
      .default(false)
      .describe("Consume upstream streaming server-side for progress notifications; the final result is the same."),
  },
  async ({ message, workflow_id, version_id, session_id, stream }, handlerExtra) => {
    const payload = { message, workflow_id, version_id, session_id };

    if (stream) {
      return text(
        await eachRequestStreaming(
          "/workflow",
          { baseUrl: EACH_SENSE_BASE_URL, body: JSON.stringify({ ...payload, stream: true }) },
          handlerExtra,
        ),
      );
    }

    return text(
      await eachRequest("/workflow", {
        baseUrl: EACH_SENSE_BASE_URL,
        method: "POST",
        timeoutMs: 300_000,
        body: JSON.stringify({ ...payload, stream: false }),
      }),
    );
  },
);

registerTool(
  "eachsense_list_sessions",
  {
    title: "List each::sense sessions",
    description: "List each::sense sessions if the sessions API is enabled for the account.",
    annotations: { ...readOnly },
  },
  {
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  },
  async ({ limit, offset }) =>
    text(
      await eachRequest(appendQuery("/sessions", { limit, offset }), {
        baseUrl: EACH_SENSE_BASE_URL,
      }),
    ),
);

registerTool(
  "eachsense_get_session",
  {
    title: "Get each::sense session",
    description: "Get each::sense session memory (conversation history and generated media URLs) by session_id.",
    annotations: { ...readOnly },
  },
  {
    session_id: z.string().min(1),
  },
  async ({ session_id }) =>
    text(
      await eachRequest(appendQuery("/memory", { session_id }), {
        baseUrl: EACH_SENSE_BASE_URL,
      }),
    ),
);

registerTool(
  "eachsense_delete_session",
  {
    title: "Delete each::sense session",
    description: "Delete or clear an each::sense session by ID if the sessions API is enabled for the account.",
    annotations: { ...destructive, idempotentHint: true },
  },
  {
    session_id: z.string().min(1),
  },
  async ({ session_id }) =>
    text(
      await eachRequest(appendQuery("/memory", { session_id }), {
        baseUrl: EACH_SENSE_BASE_URL,
        method: "DELETE",
      }),
    ),
);

// --- LLM router ---------------------------------------------------------------------

registerTool(
  "eachlabs_llm_list_models",
  {
    title: "List LLM router catalog",
    description:
      "Fetch the curated LLM router model catalog (GET /v1/llm-router/model-catalog): 300+ chat models across OpenAI, Anthropic, Google, Meta, and others with routing metadata.",
    annotations: { ...readOnly },
  },
  {},
  async () => text(await eachRequest("/v1/llm-router/model-catalog")),
);

registerTool(
  "eachlabs_llm_chat_completion",
  {
    title: "LLM router chat completion",
    description:
      "Call the Eachlabs OpenAI-compatible LLM router (POST api.eachlabs.ai/v1/chat/completions, Bearer auth) with any supported model in provider/model-name format. Responses are buffered (non-streaming). Set webhook_url for async result delivery instead.",
    annotations: { ...write },
  },
  {
    model: z.string().min(1).describe("provider/model-name, e.g. openai/gpt-5 or anthropic/claude-sonnet-4-6."),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).optional(),
    webhook_url: z
      .string()
      .url()
      .optional()
      .describe("Sent as X-Eachlabs-Webhook-Url for asynchronous result delivery."),
    extra: jsonObjectSchema.default({}),
  },
  async ({ model, messages, temperature, max_tokens, webhook_url, extra }) =>
    text(
      await eachRequest("/v1/chat/completions", {
        method: "POST",
        bearer: true,
        timeoutMs: 300_000,
        headers: webhook_url ? { "X-Eachlabs-Webhook-Url": webhook_url } : undefined,
        body: JSON.stringify({ model, messages, temperature, max_tokens, stream: false, ...extra }),
      }),
    ),
);

// --- Advanced -------------------------------------------------------------------------

registerTool(
  "eachlabs_raw_api_request",
  {
    title: "Raw API request",
    description:
      "Advanced escape hatch for documented Eachlabs endpoints (https://docs.eachlabs.ai) not yet wrapped by a first-class MCP tool. Requires an API key except when auth=false.",
    annotations: { ...destructive },
  },
  {
    target: z.enum(["api", "sense", "sense_v1", "workflows"]).default("api"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1).describe("Endpoint path, for example /v1/models or /workflows/{id}."),
    query: jsonObjectSchema.default({}),
    body: z.unknown().optional(),
    auth: z.boolean().default(true),
    bearer: z.boolean().default(false).describe("Use Authorization: Bearer instead of X-API-Key."),
  },
  async ({ target, method, path, query, body, auth, bearer }) => {
    const baseUrl =
      target === "workflows"
        ? EACH_WORKFLOWS_BASE_URL
        : target === "sense_v1"
          ? EACH_SENSE_V1_BASE_URL
          : target === "sense"
            ? EACH_SENSE_BASE_URL
            : EACH_API_BASE_URL;
    const requestPath = appendQuery(path.startsWith("/") ? path : `/${path}`, query);

    return text(
      await eachRequest(requestPath, {
        baseUrl,
        method,
        auth,
        bearer,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  },
);

registerTool(
  "eachlabs_api_health",
  {
    title: "API health check",
    description: "Check that the MCP server is configured and can reach public catalog endpoints. Does not expose the API key.",
    annotations: { ...readOnly },
  },
  {},
  async () => {
    const catalog = await eachRequest<unknown>(appendQuery("/v1/models", { limit: 1, offset: 0 }), {
      auth: false,
    });

    let update: Record<string, unknown> = { current_version: SERVER_VERSION };
    try {
      const response = await fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const remote = (await response.json()) as { version?: string };
        update = {
          current_version: SERVER_VERSION,
          latest_version: remote.version ?? "unknown",
          update_available: Boolean(remote.version && remote.version !== SERVER_VERSION),
          how_to_update: "git pull && npm install && npm run build (or `npm run update`)",
        };
      }
    } catch {
      update.update_check = "unreachable";
    }

    return text({
      api_base_url: EACH_API_BASE_URL,
      workflows_base_url: EACH_WORKFLOWS_BASE_URL,
      sense_base_url: EACH_SENSE_BASE_URL,
      api_key_configured: Boolean(EACH_API_KEY),
      catalog_probe: Array.isArray(catalog) ? { reachable: true, sample_size: catalog.length } : catalog,
      update,
    });
  },
);

// --- Prompts --------------------------------------------------------------------------

server.registerPrompt(
  "eachlabs-generate-media",
  {
    title: "Generate media with each::labs",
    description: "Guided flow: pick a model, validate input, run the prediction, and show the result.",
    argsSchema: {
      description: z.string().describe("What to generate, e.g. 'a cinematic video of a sunrise over Istanbul'."),
      output_type: z.string().optional().describe("Desired output type: image, video, or audio."),
    },
  },
  ({ description, output_type }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Generate the following with each::labs: ${description}`,
            output_type ? `Desired output type: ${output_type}.` : "",
            "Steps: 1) find candidate models with eachlabs_recommend_models or eachlabs_search_models;",
            "2) inspect the chosen model with eachlabs_get_model_request_schema;",
            "3) run it with eachlabs_create_prediction (mode 'wait' unless it is a long video job);",
            "4) show the resulting media and report the cost from the prediction metrics.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "eachlabs-build-workflow",
  {
    title: "Build an each::labs workflow",
    description: "Create a multi-step each::labs workflow from a natural-language description and test-run it.",
    argsSchema: {
      description: z.string().describe("What the workflow should do, step by step if known."),
    },
  },
  ({ description }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Build an each::labs workflow that does the following: ${description}`,
            "Prefer eachsense_build_workflow to draft it, then inspect the result with eachlabs_get_workflow,",
            "refine versions via eachlabs_upsert_workflow_version if needed, and finally test it with",
            "eachlabs_execute_workflow plus eachlabs_get_workflow_execution (wait=true).",
          ].join("\n"),
        },
      },
    ],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio transport when executed directly (node dist/index.js or
// the eachlabs-mcp bin); importing this module (e.g. from tests) must not.
const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error: unknown) => {
    if (error instanceof EachlabsError) {
      console.error(
        JSON.stringify(
          {
            error: error.message,
            status: error.status,
            payload: error.payload,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
