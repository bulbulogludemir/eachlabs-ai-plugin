#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const EACH_API_BASE_URL = process.env.EACH_API_BASE_URL ?? "https://api.eachlabs.ai";
const EACH_WORKFLOWS_BASE_URL =
  process.env.EACH_WORKFLOWS_BASE_URL ?? "https://workflows.eachlabs.run/api/v1";
const EACH_SENSE_BASE_URL =
  process.env.EACH_SENSE_BASE_URL ?? "https://eachsense-agent.core.eachlabs.run";
const EACH_SENSE_V1_BASE_URL = process.env.EACH_SENSE_V1_BASE_URL ?? `${EACH_SENSE_BASE_URL}/v1`;
const EACH_DOCS_MCP_URL = process.env.EACH_DOCS_MCP_URL ?? "https://docs.eachlabs.ai/mcp";
const EACH_API_KEY = process.env.EACH_API_KEY ?? process.env.EACHLABS_API_KEY;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : compact(value),
      },
    ],
  };
}

function passthroughMcpResult(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  ) {
    return value as {
      content: Array<{ type: "text"; text: string }>;
    };
  }

  return text(value);
}

async function eachRequest<T>(
  path: string,
  options: RequestInit & { baseUrl?: string; auth?: boolean } = {},
): Promise<T> {
  const baseUrl = options.baseUrl ?? EACH_API_BASE_URL;
  const url = new URL(path, baseUrl);
  const headers = new Headers(options.headers);

  if (options.auth !== false) {
    headers.set("X-API-Key", requireApiKey());
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new EachlabsError(
      `Eachlabs API returned HTTP ${response.status} for ${url.pathname}`,
      response.status,
      payload,
    );
  }

  return payload as T;
}

function appendQuery(path: string, params: Record<string, unknown>): string {
  const url = new URL(path, "https://placeholder.local");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

function summarizeJsonSchema(schema: unknown): unknown {
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

function generateExampleInput(schema: unknown, includeOptional: boolean, overrides: Record<string, unknown>) {
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

function validateAgainstSchema(schema: unknown, input: Record<string, unknown>) {
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

async function getAllModels(maxModels: number): Promise<Array<Record<string, unknown>>> {
  const pageSize = Math.min(100, maxModels);
  const models: Array<Record<string, unknown>> = [];

  for (let offset = 0; models.length < maxModels; offset += pageSize) {
    const page = await eachRequest<unknown>(appendQuery("/v1/models", { limit: pageSize, offset }), {
      auth: false,
    });
    if (!Array.isArray(page) || page.length === 0) break;
    models.push(...(page as Array<Record<string, unknown>>));
    if (page.length < pageSize) break;
  }

  return models.slice(0, maxModels);
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
  const client = new Client({ name: "eachlabs-unofficial-docs-proxy", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(EACH_DOCS_MCP_URL));

  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

const server = new McpServer({
  name: "eachlabs-mcp",
  version: "0.1.0",
});

server.tool(
  "search_each_labs",
  "Search across the each::labs knowledge base to find relevant information, code examples, API references, and guides. This mirrors the official each::labs MCP documentation search tool.",
  {
    query: z.string().min(1).describe("Search query"),
  },
  async ({ query }) => passthroughMcpResult(await callOfficialDocsTool("search_each_labs", { query })),
);

server.tool(
  "query_docs_filesystem_each_labs",
  "Run a read-only shell-like query against the official each::labs virtual documentation filesystem. Supports commands such as rg, tree, ls, cat, head, jq, sed, and awk. This mirrors the official each::labs MCP docs filesystem tool.",
  {
    command: z
      .string()
      .min(1)
      .describe("Read-only shell command for the virtual docs filesystem, e.g. `tree / -L 2` or `head -80 /quickstart.mdx`."),
  },
  async ({ command }) =>
    passthroughMcpResult(
      await callOfficialDocsTool("query_docs_filesystem_each_labs", { command }),
    ),
);

server.tool(
  "eachlabs_search_models",
  "Search and paginate the each::labs model catalog. Use this before selecting a generation/editing/audio/video model.",
  {
    name: z.string().optional().describe("Case-insensitive model name or slug search."),
    limit: z.number().int().min(1).max(500).default(25),
    offset: z.number().int().min(0).default(0),
  },
  async ({ name, limit, offset }) => {
    const result = await eachRequest(
      appendQuery("/v1/models", { name, limit, offset }),
      { auth: false },
    );
    return text(result);
  },
);

server.tool(
  "eachlabs_get_model",
  "Fetch full metadata for a model slug, including provider, versions, and request schema when available.",
  {
    slug: z.string().min(1).describe("Model slug, for example flux-2-max."),
  },
  async ({ slug }) => text(await getModelBySlug(slug)),
);

server.tool(
  "eachlabs_get_model_request_schema",
  "Return the model request schema in a compact field-by-field form so an agent can build valid prediction input.",
  {
    slug: z.string().min(1),
    raw: z.boolean().default(false).describe("Return the raw JSON schema instead of the compact summary."),
  },
  async ({ slug, raw }) => {
    const model = await getModelBySlug(slug);
    const schema = getRequestSchema(model);

    return text({
      slug,
      schema: raw ? schema ?? null : summarizeJsonSchema(schema),
      raw_available: Boolean(schema),
    });
  },
);

server.tool(
  "eachlabs_generate_example_input",
  "Generate a best-effort valid example input object for a model from its documented request_schema.",
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

server.tool(
  "eachlabs_validate_model_input",
  "Validate model input locally against the documented request_schema before creating a prediction.",
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

server.tool(
  "eachlabs_find_models_by_schema",
  "Find models by catalog text, output type, and request_schema field names such as prompt, image_url, aspect_ratio, duration, or seed.",
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
        if (required_fields.some((field) => !fields.has(field))) return false;
        if (any_fields.length > 0 && !any_fields.some((field) => fields.has(field))) return false;
        return true;
      })
      .slice(0, limit)
      .map((model) => ({
        title: model.title,
        slug: model.slug,
        version: model.version,
        output_type: model.output_type,
        request_fields: Object.keys(schemaProperties(getRequestSchema(model))),
      }));

    return text({ matches, scanned: models.length });
  },
);

server.tool(
  "eachlabs_recommend_models",
  "Recommend models for a use case by scoring catalog text, output type, and request_schema fields.",
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
        title: model.title,
        slug: model.slug,
        version: model.version,
        output_type: model.output_type,
        request_fields: Object.keys(schemaProperties(getRequestSchema(model))),
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

server.tool(
  "eachlabs_create_prediction",
  "Create an async prediction for a model. First call eachlabs_get_model_request_schema to build the input correctly.",
  {
    model: z.string().min(1).describe("Model slug or identifier."),
    input: jsonObjectSchema.describe("Model-specific request parameters."),
    version: z.string().optional(),
    webhook_url: z.string().url().optional(),
    webhook_secret: z.string().optional(),
  },
  async ({ model, input, version, webhook_url, webhook_secret }) =>
    text(
      await eachRequest("/v1/prediction", {
        method: "POST",
        body: JSON.stringify({ model, input, version, webhook_url, webhook_secret }),
      }),
    ),
);

server.tool(
  "eachlabs_create_prediction_checked",
  "Validate input against request_schema, then create a prediction only if validation passes unless allow_warnings is false and warnings exist.",
  {
    model: z.string().min(1).describe("Model slug or identifier."),
    input: jsonObjectSchema.describe("Model-specific request parameters."),
    version: z.string().optional(),
    webhook_url: z.string().url().optional(),
    webhook_secret: z.string().optional(),
    allow_warnings: z.boolean().default(true),
  },
  async ({ model, input, version, webhook_url, webhook_secret, allow_warnings }) => {
    const modelDetails = await getModelBySlug(model);
    const schema = getRequestSchema(modelDetails);
    const validation = validateAgainstSchema(schema, input);

    if (!validation.valid || (!allow_warnings && validation.warnings.length > 0)) {
      return text({
        created: false,
        validation,
        schema: summarizeJsonSchema(schema),
      });
    }

    const prediction = await eachRequest("/v1/prediction", {
      method: "POST",
      body: JSON.stringify({ model, input, version, webhook_url, webhook_secret }),
    });

    return text({ created: true, validation, prediction });
  },
);

server.tool(
  "eachlabs_run_model",
  "Create a prediction and wait for completion in one call. Useful for simple model runs after validating input.",
  {
    model: z.string().min(1),
    input: jsonObjectSchema,
    version: z.string().optional(),
    webhook_url: z.string().url().optional(),
    webhook_secret: z.string().optional(),
    timeout_seconds: z.number().int().min(1).max(1800).default(300),
    poll_interval_seconds: z.number().min(0.5).max(30).default(3),
  },
  async ({ model, input, version, webhook_url, webhook_secret, timeout_seconds, poll_interval_seconds }) => {
    const created = await eachRequest<Record<string, unknown>>("/v1/prediction", {
      method: "POST",
      body: JSON.stringify({ model, input, version, webhook_url, webhook_secret }),
    });
    const predictionId = String(created.id ?? created.prediction_id ?? "");
    if (!predictionId) return text({ created, warning: "Prediction response did not include id/prediction_id." });

    const deadline = Date.now() + timeout_seconds * 1000;
    let last: Record<string, unknown> | undefined;
    while (Date.now() <= deadline) {
      last = await eachRequest<Record<string, unknown>>(`/v1/prediction/${predictionId}`);
      const status = String(last.status ?? "").toLowerCase();
      if (["success", "failed", "cancelled"].includes(status)) {
        return text({ created, final: last });
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
    }

    return text({ created, status: "timeout", last });
  },
);

server.tool(
  "eachlabs_get_prediction",
  "Get the current status, output, logs, cost, and related URLs for a prediction.",
  {
    prediction_id: z.string().min(1),
  },
  async ({ prediction_id }) => text(await eachRequest(`/v1/prediction/${prediction_id}`)),
);

server.tool(
  "eachlabs_wait_prediction",
  "Poll a prediction until it succeeds, fails, is cancelled, or times out.",
  {
    prediction_id: z.string().min(1),
    timeout_seconds: z.number().int().min(1).max(1800).default(300),
    poll_interval_seconds: z.number().min(0.5).max(30).default(3),
  },
  async ({ prediction_id, timeout_seconds, poll_interval_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    let last: Record<string, unknown> | undefined;

    while (Date.now() <= deadline) {
      last = await eachRequest<Record<string, unknown>>(`/v1/prediction/${prediction_id}`);
      const status = String(last.status ?? "").toLowerCase();
      if (["success", "failed", "cancelled"].includes(status)) {
        return text(last);
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
    }

    return text({
      status: "timeout",
      prediction_id,
      last,
    });
  },
);

server.tool(
  "eachlabs_cancel_prediction",
  "Cancel a running prediction.",
  {
    prediction_id: z.string().min(1),
  },
  async ({ prediction_id }) =>
    text(await eachRequest(`/v1/prediction/${prediction_id}/cancel`, { method: "POST" })),
);

server.tool(
  "eachlabs_presign_upload",
  "Request a presigned upload URL for media files, then PUT bytes to presigned_url and pass public_url to model inputs.",
  {
    content_type: z.string().min(1).describe("MIME type, e.g. image/png, video/mp4, audio/mpeg."),
    file_type: z.enum(["image", "video", "audio", "other"]).default("other"),
  },
  async ({ content_type, file_type }) =>
    text(
      await eachRequest("/v1/upload/presign", {
        method: "POST",
        body: JSON.stringify({ content_type, file_type }),
      }),
    ),
);

server.tool(
  "eachlabs_upload_file",
  "Upload a local file through Eachlabs presigned storage and return the public_url for model inputs. Max documented upload size is 100 MB.",
  {
    file_path: z.string().min(1).describe("Absolute local file path."),
    content_type: z.string().min(1).describe("MIME type, e.g. image/png, video/mp4, audio/mpeg."),
    file_type: z.enum(["image", "video", "audio", "other"]).default("other"),
  },
  async ({ file_path, content_type, file_type }) => {
    const presign = await eachRequest<Record<string, unknown>>("/v1/upload/presign", {
      method: "POST",
      body: JSON.stringify({ content_type, file_type }),
    });
    const presignedUrl = String(presign.presigned_url ?? "");
    if (!presignedUrl) {
      return text({ uploaded: false, presign, error: "presigned_url missing from response." });
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
      return text({
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

server.tool(
  "eachlabs_list_webhooks",
  "List recent webhook deliveries for the authenticated organization.",
  {
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  },
  async ({ limit, offset }) => text(await eachRequest(appendQuery("/v1/webhooks", { limit, offset }))),
);

server.tool(
  "eachlabs_get_webhook",
  "Get webhook details and delivery attempts by execution ID.",
  {
    execution_id: z.string().min(1),
  },
  async ({ execution_id }) => text(await eachRequest(`/v1/webhooks/${execution_id}`)),
);

server.tool(
  "eachlabs_list_workflow_categories",
  "List workflow categories available for creating or organizing workflows.",
  {},
  async () => text(await eachRequest("/categories", { baseUrl: EACH_WORKFLOWS_BASE_URL })),
);

server.tool(
  "eachlabs_create_workflow",
  "Create a workflow with its initial version. Use model request schemas to build model-step params.",
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

server.tool(
  "eachlabs_update_workflow",
  "Update workflow metadata such as name, description, categories, locked, or production.",
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

server.tool(
  "eachlabs_upsert_workflow_version",
  "Create or update a workflow version, including definition steps, input_schema, fallback config, and sharing flags.",
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

server.tool(
  "eachlabs_list_workflows",
  "Deprecated placeholder. The public workflows API does not expose a list-workflows endpoint; use eachlabs_get_workflow when you know the ID or slug.",
  {
    note: z.string().optional(),
  },
  async () =>
    text({
      error: "No GET /workflows endpoint is documented by each::workflows.",
      alternatives: ["eachlabs_get_workflow", "eachlabs_create_workflow", "eachlabs_list_workflow_categories"],
    }),
);

server.tool(
  "eachlabs_get_workflow",
  "Fetch workflow metadata and versions by workflow ID.",
  {
    workflow_id: z.string().min(1),
  },
  async ({ workflow_id }) =>
    text(await eachRequest(`/workflows/${workflow_id}`, { baseUrl: EACH_WORKFLOWS_BASE_URL })),
);

server.tool(
  "eachlabs_execute_workflow",
  "Execute an each::workflows workflow with input parameters.",
  {
    workflow_id: z.string().min(1),
    inputs: jsonObjectSchema.default({}),
    version_id: z.string().optional(),
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

server.tool(
  "eachlabs_bulk_execute_workflow",
  "Trigger a workflow multiple times in one bulk operation.",
  {
    workflow_id: z.string().min(1),
    inputs: z.array(jsonObjectSchema).min(1).describe("One input object per execution."),
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

server.tool(
  "eachlabs_list_workflow_executions",
  "List executions for a specific workflow, optionally filtered by bulk_id.",
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

server.tool(
  "eachlabs_get_workflow_execution",
  "Get status and step details for a workflow execution.",
  {
    execution_id: z.string().min(1),
  },
  async ({ execution_id }) =>
    text(await eachRequest(`/executions/${execution_id}`, { baseUrl: EACH_WORKFLOWS_BASE_URL })),
);

server.tool(
  "eachlabs_wait_workflow_execution",
  "Poll a workflow execution until it completes, fails, is cancelled, or times out.",
  {
    execution_id: z.string().min(1),
    timeout_seconds: z.number().int().min(1).max(3600).default(600),
    poll_interval_seconds: z.number().min(0.5).max(30).default(5),
  },
  async ({ execution_id, timeout_seconds, poll_interval_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    let last: Record<string, unknown> | undefined;

    while (Date.now() <= deadline) {
      last = await eachRequest<Record<string, unknown>>(`/executions/${execution_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
      });
      const status = String(last.status ?? "").toLowerCase();
      if (["completed", "failed", "cancelled"].includes(status)) {
        return text(last);
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
    }

    return text({
      status: "timeout",
      execution_id,
      last,
    });
  },
);

server.tool(
  "eachlabs_get_public_workflow_version",
  "Fetch a public or unlisted workflow version by organization nickname, workflow slug, and version ID.",
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

server.tool(
  "eachlabs_execute_public_workflow_version",
  "Trigger a public or unlisted workflow version by organization nickname, workflow slug, and version ID.",
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

server.tool(
  "eachsense_chat_completion",
  "Call the each::sense OpenAI-compatible chat completions endpoint. Use for agent/chat/tool workflows when the API key has each::sense access.",
  {
    model: z.string().min(1).default("each/sense"),
    messages: z.array(chatMessageSchema).min(1),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).optional(),
    stream: z.boolean().default(false).describe("Streaming is not consumed by this MCP tool; leave false unless the API returns buffered JSON."),
    extra: jsonObjectSchema.default({}).describe("Additional provider-specific request fields."),
  },
  async ({ model, messages, tools, tool_choice, temperature, max_tokens, stream, extra }) =>
    text(
      await eachRequest("/chat/completions", {
        baseUrl: EACH_SENSE_V1_BASE_URL,
        method: "POST",
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice,
          temperature,
          max_tokens,
          stream,
          ...extra,
        }),
      }),
    ),
);

server.tool(
  "eachsense_list_models",
  "List each::sense OpenAI-compatible exposed models.",
  {},
  async () => text(await eachRequest("/models", { baseUrl: EACH_SENSE_V1_BASE_URL })),
);

server.tool(
  "eachlabs_llm_list_models",
  "List OpenAI-compatible LLM Router models if the /v1/models route is enabled for the account.",
  {},
  async () => text(await eachRequest("/v1/models", { baseUrl: EACH_API_BASE_URL })),
);

server.tool(
  "eachlabs_llm_chat_completion",
  "Call the Eachlabs OpenAI-compatible LLM router chat completions endpoint with any supported model.",
  {
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).optional(),
    stream: z.boolean().default(false).describe("Streaming is not consumed by this MCP tool; leave false unless the API returns buffered JSON."),
    extra: jsonObjectSchema.default({}),
  },
  async ({ model, messages, temperature, max_tokens, stream, extra }) =>
    text(
      await eachRequest("/chat/completions", {
        baseUrl: EACH_SENSE_BASE_URL,
        method: "POST",
        body: JSON.stringify({ model, messages, temperature, max_tokens, stream, ...extra }),
      }),
    ),
);

server.tool(
  "eachsense_build_workflow",
  "Use each::sense Workflow Builder to create or update a multi-step AI workflow from natural language.",
  {
    message: z.string().min(1).describe("Workflow description or modification instruction."),
    workflow_id: z.string().optional(),
    version_id: z.string().optional(),
    session_id: z.string().optional(),
    stream: z.boolean().default(false).describe("This MCP tool expects buffered JSON, so false is recommended."),
  },
  async ({ message, workflow_id, version_id, session_id, stream }) =>
    text(
      await eachRequest("/workflow", {
        baseUrl: EACH_SENSE_BASE_URL,
        method: "POST",
        body: JSON.stringify({ message, workflow_id, version_id, session_id, stream }),
      }),
    ),
);

server.tool(
  "eachsense_list_sessions",
  "List each::sense sessions if the sessions API is enabled for the account.",
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

server.tool(
  "eachsense_get_session",
  "Get each::sense session memory by session_id.",
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

server.tool(
  "eachsense_delete_session",
  "Delete or clear an each::sense session by ID if the sessions API is enabled for the account.",
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

server.tool(
  "eachlabs_raw_api_request",
  "Advanced escape hatch for documented Eachlabs endpoints not yet wrapped by a first-class MCP tool. Requires an API key except when auth=false.",
  {
    target: z.enum(["api", "sense", "sense_v1", "workflows"]).default("api"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1).describe("Endpoint path, for example /v1/models or /workflows/{id}."),
    query: jsonObjectSchema.default({}),
    body: z.unknown().optional(),
    auth: z.boolean().default(true),
  },
  async ({ target, method, path, query, body, auth }) => {
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
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  },
);

server.tool(
  "eachlabs_api_health",
  "Check that the MCP server is configured and can reach public catalog endpoints. Does not expose the API key.",
  {},
  async () => {
    const catalog = await eachRequest(appendQuery("/v1/models", { limit: 1, offset: 0 }), {
      auth: false,
    });
    return text({
      api_base_url: EACH_API_BASE_URL,
      workflows_base_url: EACH_WORKFLOWS_BASE_URL,
      api_key_configured: Boolean(EACH_API_KEY),
      catalog_probe: catalog,
    });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

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
