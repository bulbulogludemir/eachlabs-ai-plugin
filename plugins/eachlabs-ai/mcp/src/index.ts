#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  DEFAULT_TIMEOUT_MS,
  ENABLE_EXPERIMENTAL_FLAGS,
  EACH_API_BASE_URL,
  EACH_API_KEY,
  EACH_SENSE_BASE_URL,
  EACH_SENSE_V1_BASE_URL,
  EACH_WORKFLOWS_BASE_URL,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MODEL_CACHE_TTL_MS,
  PREDICTION_TERMINAL_STATUSES,
  SERVER_VERSION,
  UPDATE_CHECK_URL,
  WORKFLOW_TERMINAL_STATUSES,
} from "./config.js";
import {
  EachlabsError,
  appendQuery,
  eachRequest,
  joinUrl,
  requireApiKey,
} from "./core/http.js";
import { callOfficialDocsTool } from "./core/docs-client.js";
import { synthesizeSpeech, transcribeAudio } from "./core/audio.js";
import { generateIntegrationCode } from "./core/codegen.js";
import {
  buildDebugBundle,
  compareModelRecords,
  diagnoseRunRecord,
  diffModelSchemas,
  diffWorkflowDefinitions,
  modelDeveloperSummary,
  summarizeExecutions,
} from "./core/developer-tools.js";
import {
  type ContentBlock,
  collectMediaUrls,
  mediaContentBlocks,
} from "./core/media.js";
import {
  type ToolExtra,
  pollUntilDone,
} from "./core/polling.js";
import {
  generateExampleInput,
  getRequestSchema,
  schemaProperties,
  summarizeJsonSchema,
  validateAgainstSchema,
} from "./core/schema.js";
import { streamEachSense } from "./core/streaming.js";
import { inferContentType, uploadFileStream } from "./core/upload.js";
import { validateWorkflowDefinition } from "./core/workflow-validator.js";
import { rawRequestPolicyError } from "./core/security.js";

export { appendQuery, joinUrl } from "./core/http.js";
export { collectMediaUrls } from "./core/media.js";
export {
  buildDebugBundle,
  compareModelRecords,
  diagnoseRunRecord,
  diffModelSchemas,
  diffWorkflowDefinitions,
  modelDeveloperSummary,
  summarizeExecutions,
} from "./core/developer-tools.js";
export {
  generateExampleInput,
  summarizeJsonSchema,
  validateAgainstSchema,
} from "./core/schema.js";

const jsonObjectSchema = z.record(z.unknown());
const chatMessageSchema = z.object({
  role: z.string().describe("Message role, usually system, user, assistant, or tool."),
  content: z.unknown().describe("Message content. Strings and structured multimodal content are supported."),
});

function compact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function workflowTriggerPath(
  workflowId: string,
  versionId: string,
  bulk = false,
): string {
  return `/v1/workflows/${bulk ? "bulk-trigger" : "trigger"}/${encodeURIComponent(workflowId)}/${encodeURIComponent(versionId)}`;
}

export function workflowExecutionPath(executionId: string): string {
  return `/v1/workflows/executions/${encodeURIComponent(executionId)}`;
}

async function resolveWorkflowVersionId(
  workflowId: string,
  requested?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (requested) return requested;
  const workflow = await eachRequest<Record<string, unknown>>(
    `/workflows/${encodeURIComponent(workflowId)}`,
    { baseUrl: EACH_WORKFLOWS_BASE_URL, signal },
  );
  const latest =
    workflow.latest_version_id ??
    (workflow.latest_version as Record<string, unknown> | undefined)?.id ??
    (workflow.latestVersion as Record<string, unknown> | undefined)?.id;
  if (latest) return String(latest);

  const versions = Array.isArray(workflow.versions)
    ? (workflow.versions as Array<Record<string, unknown>>)
    : [];
  const fallback = versions.find((version) => version.latest === true) ?? versions.at(-1);
  const id = fallback?.id ?? fallback?.version_id;
  if (!id) {
    throw new EachlabsError(
      "version_id was omitted and the workflow response did not expose a latest version ID.",
    );
  }
  return String(id);
}

export function flagPath(path: string, flagKey?: string): string {
  const normalized = normalizePath(path);
  if (!flagKey) {
    if (normalized.includes("{flag_key}") || normalized.includes(":flag_key")) {
      throw new EachlabsError("flag_key is required when the flags path contains a flag key placeholder.");
    }
    return normalized;
  }

  const encoded = encodeURIComponent(flagKey);
  if (normalized.includes("{flag_key}")) return normalized.replaceAll("{flag_key}", encoded);
  if (normalized.includes(":flag_key")) return normalized.replaceAll(":flag_key", encoded);
  return `${normalized.replace(/\/+$/, "")}/${encoded}`;
}

export function flagActionPath(path: string, flagKey?: string): string {
  return path.includes("{flag_key}") || path.includes(":flag_key") ? flagPath(path, flagKey) : normalizePath(path);
}

export function buildFlagEvaluationBody({
  flag_key,
  context,
  default_value,
  extra,
  body,
}: {
  flag_key?: string;
  context?: Record<string, unknown>;
  default_value?: unknown;
  extra?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): Record<string, unknown> {
  if (body) return body;

  const payload: Record<string, unknown> = {
    ...(extra ?? {}),
  };
  if (flag_key) payload.flag_key = flag_key;
  if (context && Object.keys(context).length > 0) payload.context = context;
  if (default_value !== undefined) payload.default_value = default_value;

  return payload;
}

let modelCache:
  | { models: Array<Record<string, unknown>>; complete: boolean; fetchedAt: number }
  | undefined;
let modelFetchPromise:
  | Promise<{ models: Array<Record<string, unknown>>; complete: boolean }>
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

  modelFetchPromise ??= (async () => {
    const pageSize = 100;
    const models: Array<Record<string, unknown>> = [];
    let complete = false;

    for (let offset = 0; models.length < maxModels; offset += pageSize) {
      const page = await eachRequest<unknown>(
        appendQuery("/v1/models", { limit: pageSize, offset }),
        { auth: false },
      );
      const pageItems = Array.isArray(page)
        ? page
        : page &&
            typeof page === "object" &&
            Array.isArray((page as { items?: unknown }).items)
          ? (page as { items: Array<Record<string, unknown>> }).items
          : [];
      if (pageItems.length === 0) {
        complete = true;
        break;
      }
      models.push(...pageItems);
      if (pageItems.length < pageSize) {
        complete = true;
        break;
      }
    }

    return { models, complete };
  })();

  let result: { models: Array<Record<string, unknown>>; complete: boolean };
  try {
    result = await modelFetchPromise;
  } finally {
    modelFetchPromise = undefined;
  }
  modelCache = { ...result, fetchedAt: Date.now() };
  if (!result.complete && result.models.length < maxModels) {
    return getAllModels(maxModels);
  }
  return result.models.slice(0, maxModels);
}

export function trimModel(model: Record<string, unknown>) {
  return modelDeveloperSummary(model);
}

function scoreModel(model: Record<string, unknown>, terms: string[], requiredFields: string[], outputType?: string) {
  const title = String(model.title ?? "").toLowerCase();
  const slug = String(model.slug ?? "").toLowerCase();
  const provider = String(model.provider_name ?? model.provider ?? "").toLowerCase();
  const description = String(model.description ?? "").toLowerCase();
  const category =
    model.category && typeof model.category === "object"
      ? String(
          (model.category as Record<string, unknown>).slug ??
            (model.category as Record<string, unknown>).Slug ??
            (model.category as Record<string, unknown>).name ??
            (model.category as Record<string, unknown>).Name ??
            "",
        ).toLowerCase()
      : String(model.category ?? "").toLowerCase();
  const haystack = `${title} ${slug} ${provider} ${category} ${description}`;
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
  return eachRequest<Record<string, unknown>>(
    appendQuery("/v1/model", { slug }),
    { auth: false },
  );
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
      "Dedicated audio APIs are available through eachlabs_audio_transcribe and eachlabs_audio_speech.",
      "Developer helpers can diff live model schemas and workflow definitions, generate Go/TypeScript/Python/cURL integrations, and export privacy-safe debug bundles.",
      "Undocumented each::flags tools are experimental and only registered when EACHLABS_ENABLE_EXPERIMENTAL_FLAGS=1.",
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
            ambiguous_write: error.ambiguousWrite || undefined,
            request: error.requestMetadata,
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

registerTool(
  "eachlabs_submit_docs_feedback",
  {
    title: "Submit each::labs docs feedback",
    description:
      "Submit focused feedback about an official each::labs documentation page through the official docs MCP.",
    annotations: { ...write, idempotentHint: false },
  },
  {
    path: z.string().min(1).describe("Documentation path the feedback applies to."),
    feedback: z.string().min(1).describe("Specific correction or improvement request."),
  },
  async ({ path, feedback }) =>
    passthroughMcpResult(
      await callOfficialDocsTool("submit_feedback", { path, feedback }),
    ),
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
        openapi_schema: await eachRequest(
          `/v1/models/${encodeURIComponent(slug)}/schemas/openapi`,
          { auth: false },
        ),
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
        const provider = String(model.provider_name ?? model.provider ?? "").toLowerCase();
        const description = String(model.description ?? "").toLowerCase();
        const category =
          model.category && typeof model.category === "object"
            ? JSON.stringify(model.category).toLowerCase()
            : String(model.category ?? "").toLowerCase();

        if (
          queryLower &&
          !`${title} ${slug} ${provider} ${description} ${category}`.includes(
            queryLower,
          )
        ) {
          return false;
        }
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

registerTool(
  "eachlabs_compare_models",
  {
    title: "Compare models without running them",
    description:
      "Compare 2-10 live catalog models by provider, category, p50 latency, required inputs, field constraints, and capability fit. Read-only and does not spend credits.",
    annotations: { ...readOnly },
  },
  {
    models: z
      .array(z.string().min(1))
      .min(2)
      .max(10)
      .describe("Model slugs to compare."),
    required_fields: z
      .array(z.string())
      .default([])
      .describe("Input fields every suitable model must support."),
    focus_fields: z
      .array(z.string())
      .default([])
      .describe("Extra fields to include in the compact constraint matrix."),
  },
  async ({ models, required_fields, focus_fields }) => {
    const uniqueModels = [...new Set(models as string[])];
    const settled = await Promise.allSettled(
      uniqueModels.map((slug) => getModelBySlug(slug)),
    );
    const loaded: Array<Record<string, unknown>> = [];
    const errors: Array<{ slug: string; error: string }> = [];

    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      } else {
        errors.push({
          slug: uniqueModels[index],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }

    if (loaded.length < 2) {
      return errorText({
        compared: false,
        error: "At least two model records must be loaded for comparison.",
        model_errors: errors,
      });
    }
    return text({
      ...compareModelRecords(loaded, required_fields, focus_fields),
      model_errors: errors,
    });
  },
);

registerTool(
  "eachlabs_diff_model_schema",
  {
    title: "Diff a live model schema",
    description:
      "Compare a saved baseline request schema with the model's current live schema. Classifies removed fields, new required fields, narrowed enums, type changes, and tighter constraints as potentially breaking. Does not run a prediction.",
    annotations: { ...readOnly },
  },
  {
    model: z.string().min(1).describe("Live EachLabs model slug."),
    baseline_schema: jsonObjectSchema.describe(
      "Previously saved request_schema to compare against the current live schema.",
    ),
  },
  async ({ model, baseline_schema }) => {
    const details = await getModelBySlug(model);
    const current = getRequestSchema(details);
    if (!current || typeof current !== "object") {
      return errorText({
        compared: false,
        error: `Model '${model}' has no live request schema.`,
      });
    }
    return text({
      model,
      ...diffModelSchemas(baseline_schema, current),
      current_schema: current,
    });
  },
);

registerTool(
  "eachlabs_diff_workflow",
  {
    title: "Diff workflow definitions",
    description:
      "Compare two workflow definitions locally before publishing a version. Highlights added/removed steps, model/type changes, parameter changes, and input-schema compatibility. Does not mutate or execute a workflow.",
    annotations: { ...readOnly },
  },
  {
    before_definition: jsonObjectSchema,
    after_definition: jsonObjectSchema,
  },
  async ({ before_definition, after_definition }) =>
    text(diffWorkflowDefinitions(before_definition, after_definition)),
);

registerTool(
  "eachlabs_generate_integration_code",
  {
    title: "Generate model integration code",
    description:
      "Generate deterministic TypeScript, Python, Go, or cURL integration code from the model's current live request schema. Static model/version tables are never used.",
    annotations: { ...readOnly },
  },
  {
    model: z.string().min(1).describe("Live EachLabs model slug."),
    language: z.enum(["typescript", "python", "go", "curl"]),
    mode: z
      .enum(["async_polling", "webhook", "synchronous"])
      .default("async_polling"),
    framework: z
      .enum(["none", "express", "nextjs", "fastapi", "flask"])
      .default("none")
      .describe("Optional webhook-handler framework."),
    include_types: z.boolean().default(true),
    include_zod: z
      .boolean()
      .default(false)
      .describe("TypeScript only. Generate a Zod input validator."),
  },
  async ({ model, language, mode, framework, include_types, include_zod }) => {
    const validFramework =
      framework === "none" ||
      (language === "typescript" &&
        ["express", "nextjs"].includes(framework)) ||
      (language === "python" && ["fastapi", "flask"].includes(framework));
    if (!validFramework) {
      return errorText({
        generated: false,
        error: `Framework '${framework}' is not compatible with language '${language}'.`,
      });
    }
    if (framework !== "none" && mode !== "webhook") {
      return errorText({
        generated: false,
        error: "A framework handler is only generated in webhook mode.",
      });
    }
    const details = await getModelBySlug(model);
    const schema = getRequestSchema(details);
    if (!schema || typeof schema !== "object") {
      return errorText({
        generated: false,
        error: `Model '${model}' has no live request schema.`,
      });
    }
    return text(
      generateIntegrationCode({
        model,
        schema: schema as Record<string, unknown>,
        language,
        mode,
        framework,
        includeTypes: include_types,
        includeZod: include_zod,
      }),
    );
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
    webhook_secret: z
      .string()
      .optional()
      .describe(
        "Shared secret delivered verbatim in X-Webhook-Secret. Verify it with a constant-time string comparison; it is not an HMAC body signature.",
      ),
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

    const { completed, cancelled, last } = await pollUntilDone(
      () => eachRequest<Record<string, unknown>>(`/v1/prediction/${predictionId}`, { signal: extra?.signal }),
      PREDICTION_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    if (!completed) return text({ created, status: cancelled ? "cancelled_by_client" : "timeout", last });
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
      const prediction = await eachRequest<Record<string, unknown>>(`/v1/prediction/${prediction_id}`, {
        signal: extra?.signal,
      });
      return predictionToolResult(prediction, prediction, include_media, embed_images);
    }

    const { completed, cancelled, last } = await pollUntilDone(
      () => eachRequest<Record<string, unknown>>(`/v1/prediction/${prediction_id}`, { signal: extra?.signal }),
      PREDICTION_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    if (!completed) return text({ status: cancelled ? "cancelled_by_client" : "timeout", prediction_id, last });
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
    status: z
      .string()
      .optional()
      .describe("Comma-separated statuses: created, starting, success, error."),
    error_classification: z
      .array(
        z.enum([
          "content_moderation",
          "execution_timeout",
          "invalid_user_input",
          "invalid_model_config",
          "provider_auth",
          "provider_error",
          "provider_rate_limit",
          "provider_unavailable",
          "internal_error",
          "unknown",
        ]),
      )
      .optional()
      .describe("Filter failed executions by one or more canonical error classifications."),
    workflow_id: z.string().optional(),
    workflow_execution_id: z.string().optional(),
    from: z.string().optional().describe("RFC 3339 start of time window, e.g. 2026-06-01T00:00:00Z."),
    to: z.string().optional().describe("RFC 3339 end of time window."),
  },
  async ({ limit, offset, model, status, error_classification, workflow_id, workflow_execution_id, from, to }) =>
    text(
      await eachRequest(
        appendQuery("/v1/executions", {
          limit,
          offset,
          model,
          status,
          error_classification: error_classification?.join(","),
          workflow_id,
          workflow_execution_id,
          from,
          to,
        }),
      ),
    ),
);

registerTool(
  "eachlabs_summarize_usage",
  {
    title: "Summarize usage and cost",
    description:
      "Summarize authenticated execution history without returning prompts or outputs. Groups spend, runtime, success, and failure counts by model, workflow, or status.",
    annotations: { ...readOnly },
  },
  {
    max_records: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
    group_by: z.enum(["model", "workflow", "status"]).default("model"),
    top: z.number().int().min(1).max(50).default(10),
    model: z.string().optional(),
    status: z
      .string()
      .optional()
      .describe("Comma-separated statuses: created, starting, success, error."),
    workflow_id: z.string().optional(),
    from: z.string().optional().describe("RFC 3339 start of time window."),
    to: z.string().optional().describe("RFC 3339 end of time window."),
  },
  async ({
    max_records,
    offset,
    group_by,
    top,
    model,
    status,
    workflow_id,
    from,
    to,
  }) => {
    const executions: Array<Record<string, unknown>> = [];
    let nextOffset = offset;
    let upstreamTotal: number | undefined;

    while (executions.length < max_records) {
      const limit = Math.min(100, max_records - executions.length);
      const response = await eachRequest<unknown>(
        appendQuery("/v1/executions", {
          limit,
          offset: nextOffset,
          model,
          status,
          workflow_id,
          from,
          to,
        }),
      );
      const page = Array.isArray(response)
        ? (response as Array<Record<string, unknown>>)
        : response &&
            typeof response === "object" &&
            Array.isArray(
              (response as { executions?: unknown }).executions,
            )
          ? (
              response as {
                executions: Array<Record<string, unknown>>;
              }
            ).executions
          : [];
      if (
        response &&
        typeof response === "object" &&
        Number.isFinite(
          Number((response as { total_count?: unknown }).total_count),
        )
      ) {
        upstreamTotal = Number(
          (response as { total_count?: unknown }).total_count,
        );
      }
      executions.push(...page);
      nextOffset += page.length;
      if (
        page.length < limit ||
        (upstreamTotal !== undefined &&
          nextOffset >= upstreamTotal)
      ) {
        break;
      }
    }

    return text({
      ...summarizeExecutions(executions, group_by, top),
      requested_offset: offset,
      upstream_total_count: upstreamTotal ?? null,
      sampled_all_matching:
        upstreamTotal === undefined
          ? executions.length < max_records
          : offset + executions.length >= upstreamTotal,
    });
  },
);

registerTool(
  "eachlabs_diagnose_run",
  {
    title: "Diagnose a failed run",
    description:
      "Fetch a prediction or workflow execution and return deterministic local triage with safe retry guidance. Does not create or retry work.",
    annotations: { ...readOnly },
  },
  {
    kind: z.enum(["prediction", "workflow"]),
    run_id: z.string().min(1),
    include_raw: z
      .boolean()
      .default(false)
      .describe(
        "Include the full upstream run record, which may contain prompts, outputs, or logs.",
      ),
  },
  async ({ kind, run_id, include_raw }) => {
    const run =
      kind === "workflow"
        ? await eachRequest<Record<string, unknown>>(
            workflowExecutionPath(run_id),
          )
        : await eachRequest<Record<string, unknown>>(
            `/v1/prediction/${encodeURIComponent(run_id)}`,
          );
    return text({
      kind,
      run_id,
      ...diagnoseRunRecord(run),
      ...(include_raw ? { raw: run } : {}),
    });
  },
);

registerTool(
  "eachlabs_export_debug_bundle",
  {
    title: "Export privacy-safe debug bundle",
    description:
      "Fetch a prediction or workflow execution and return a shareable diagnostic bundle. Prompts, inputs, outputs, logs, media URLs, credentials, secrets, and tokens are excluded.",
    annotations: { ...readOnly },
  },
  {
    kind: z.enum(["prediction", "workflow"]),
    run_id: z.string().min(1),
  },
  async ({ kind, run_id }) => {
    const run =
      kind === "workflow"
        ? await eachRequest<Record<string, unknown>>(
            workflowExecutionPath(run_id),
          )
        : await eachRequest<Record<string, unknown>>(
            `/v1/prediction/${encodeURIComponent(run_id)}`,
          );
    return text(buildDebugBundle(kind, run, SERVER_VERSION));
  },
);

// --- Audio ---------------------------------------------------------------------

registerTool(
  "eachlabs_audio_transcribe",
  {
    title: "Transcribe audio",
    description:
      "Transcribe a local audio file through POST /v1/audio/transcriptions. Files are sent as multipart form data and must be 25 MB or smaller.",
    annotations: { ...write },
  },
  {
    file_path: z.string().min(1).describe("Absolute path to a local audio file."),
    model: z.string().min(1).default("openai/whisper-large-v3"),
    language: z.string().min(2).optional().describe("Optional language code."),
    response_format: z.enum(["json", "verbose_json"]).default("json"),
    timestamp_granularities: z
      .array(z.enum(["word", "segment"]))
      .max(2)
      .optional()
      .describe("Timestamp detail; use verbose_json when requesting timestamps."),
  },
  async (
    { file_path, model, language, response_format, timestamp_granularities },
    extra,
  ) =>
    text(
      await transcribeAudio(
        {
          filePath: file_path,
          model,
          language,
          responseFormat: response_format,
          timestampGranularities: timestamp_granularities,
        },
        extra?.signal,
      ),
    ),
);

registerTool(
  "eachlabs_audio_speech",
  {
    title: "Generate speech audio",
    description:
      "Generate speech through POST /v1/audio/speech and return the streamed MP3 or PCM response as an MCP audio block.",
    annotations: { ...write },
  },
  {
    model: z.string().min(1),
    input: z.string().min(1).max(2000),
    voice: z.string().min(1),
    format: z.enum(["mp3", "pcm"]).default("mp3"),
    speed: z.number().min(0.25).max(4).optional(),
    instructions: z.string().max(1000).optional(),
  },
  async ({ model, input, voice, format, speed, instructions }, extra) => {
    const audio = await synthesizeSpeech(
      { model, input, voice, format, speed, instructions },
      extra?.signal,
    );
    return {
      content: [
        {
          type: "text",
          text: compact({
            generated: true,
            execution_id: audio.executionId,
            request_id: audio.requestId,
            mime_type: audio.mimeType,
          }),
        },
        { type: "audio", data: audio.data, mimeType: audio.mimeType },
      ],
    };
  },
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
    expires_in_seconds: z.number().int().min(60).max(31_536_000).optional().describe("Optional retention control for the stored file."),
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
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe("Optional MIME type. Inferred from the file signature or extension when omitted."),
    file_type: z.enum(["image", "video", "audio", "other"]).default("other"),
    expires_in_seconds: z.number().int().min(60).max(31_536_000).optional().describe("Optional retention control for the stored file."),
    timeout_seconds: z.number().int().min(10).max(600).default(120),
  },
  async ({ file_path, content_type, file_type, expires_in_seconds, timeout_seconds }, extra) => {
    const info = await stat(file_path);
    if (!info.isFile()) {
      return errorText({ uploaded: false, error: "file_path must point to a regular file." });
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      return errorText({
        uploaded: false,
        error: `File is ${info.size} bytes; the documented upload limit is 100 MB.`,
      });
    }

    const resolvedContentType = await inferContentType(file_path, content_type);
    const presign = await eachRequest<Record<string, unknown>>("/v1/upload/presign", {
      method: "POST",
      body: JSON.stringify({ content_type: resolvedContentType, file_type, expires_in_seconds }),
      signal: extra?.signal,
    });
    const presignedUrl = String(presign.presigned_url ?? "");
    if (!presignedUrl) {
      return errorText({ uploaded: false, presign, error: "presigned_url missing from response." });
    }

    const requiredHeaders =
      presign.required_headers && typeof presign.required_headers === "object"
        ? (presign.required_headers as Record<string, string>)
        : {};
    const uploadResponse = await uploadFileStream({
      url: presignedUrl,
      filePath: file_path,
      contentType: resolvedContentType,
      requiredHeaders,
      size: info.size,
      timeoutMs: timeout_seconds * 1000,
      extra,
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

// --- each::flags --------------------------------------------------------------------

if (ENABLE_EXPERIMENTAL_FLAGS) {
registerTool(
  "eachlabs_list_flags",
  {
    title: "List each::flags",
    description:
      "List each::flags feature flags for the authenticated organization. The public docs for this beta surface may lag the API; use query/path overrides if Eachlabs publishes a more specific shape.",
    annotations: { ...readOnly },
  },
  {
    query: jsonObjectSchema.default({}).describe("Query string parameters, for example limit, offset, environment, or project."),
    path: z.string().min(1).default("/v1/flags").describe("Flags list endpoint path."),
  },
  async ({ query, path }) => text(await eachRequest(appendQuery(normalizePath(path), query))),
);

registerTool(
  "eachlabs_get_flag",
  {
    title: "Get each::flags flag",
    description:
      "Fetch one each::flags feature flag by key. The default path is /v1/flags/{flag_key}; override path if upstream docs use another route.",
    annotations: { ...readOnly },
  },
  {
    flag_key: z.string().min(1).describe("Feature flag key."),
    query: jsonObjectSchema.default({}).describe("Optional query string parameters, such as environment."),
    path: z
      .string()
      .min(1)
      .default("/v1/flags/{flag_key}")
      .describe("Path template. Supports {flag_key} or :flag_key placeholders; otherwise flag_key is appended."),
  },
  async ({ flag_key, query, path }) => text(await eachRequest(appendQuery(flagPath(path, flag_key), query))),
);

registerTool(
  "eachlabs_evaluate_flag",
  {
    title: "Evaluate each::flags flag",
    description:
      "Evaluate an each::flags feature flag for a context. Defaults to POST /v1/flags/evaluate with {flag_key, context, default_value}; pass body/path to match the exact upstream contract if needed.",
    annotations: { ...write, idempotentHint: true },
  },
  {
    flag_key: z
      .string()
      .min(1)
      .optional()
      .describe("Feature flag key. Optional when body already contains the upstream-required identifier."),
    context: jsonObjectSchema.default({}).describe("Evaluation context such as user, tenant, environment, or attributes."),
    default_value: z.unknown().optional().describe("Fallback value if the flag cannot be evaluated."),
    extra: jsonObjectSchema.default({}).describe("Additional fields to merge into the default evaluation body."),
    body: jsonObjectSchema.optional().describe("Exact upstream request body. When provided, it replaces flag_key/context/default_value/extra."),
    path: z
      .string()
      .min(1)
      .default("/v1/flags/evaluate")
      .describe("Evaluation endpoint path. Supports {flag_key} or :flag_key placeholders."),
  },
  async ({ flag_key, context, default_value, extra, body, path }) => {
    if (!body && !flag_key) {
      return errorText({
        evaluated: false,
        error: "Provide flag_key, or pass body with the exact upstream evaluation payload.",
      });
    }

    return text(
      await eachRequest(flagActionPath(path, flag_key), {
        method: "POST",
        body: JSON.stringify(buildFlagEvaluationBody({ flag_key, context, default_value, extra, body })),
      }),
    );
  },
);

registerTool(
  "eachlabs_create_flag",
  {
    title: "Create each::flags flag",
    description:
      "Create an each::flags feature flag. This changes live flag configuration for the authenticated organization; confirm target environment/project before using.",
    annotations: { ...write },
  },
  {
    flag: jsonObjectSchema.describe("Create flag request body from the each::flags API."),
    path: z.string().min(1).default("/v1/flags").describe("Create flag endpoint path."),
  },
  async ({ flag, path }) =>
    text(
      await eachRequest(normalizePath(path), {
        method: "POST",
        body: JSON.stringify(flag),
      }),
    ),
);

registerTool(
  "eachlabs_update_flag",
  {
    title: "Update each::flags flag",
    description:
      "Update an each::flags feature flag. This may change live routing or rollout behavior; confirm the intended environment/project before using.",
    annotations: { ...destructive },
  },
  {
    flag_key: z
      .string()
      .min(1)
      .optional()
      .describe("Feature flag key. Optional only when path is already the exact upstream endpoint."),
    updates: jsonObjectSchema.describe("Update flag request body from the each::flags API."),
    method: z.enum(["PATCH", "PUT"]).default("PATCH"),
    path: z
      .string()
      .min(1)
      .default("/v1/flags/{flag_key}")
      .describe("Update path or template. Supports {flag_key} or :flag_key placeholders; otherwise flag_key is appended."),
  },
  async ({ flag_key, updates, method, path }) =>
    text(
      await eachRequest(flagPath(path, flag_key), {
        method,
        body: JSON.stringify(updates),
      }),
    ),
);

registerTool(
  "eachlabs_delete_flag",
  {
    title: "Delete each::flags flag",
    description:
      "Delete or archive an each::flags feature flag by key. This is a live configuration mutation and may be irreversible depending on the upstream API.",
    annotations: { ...destructive },
  },
  {
    flag_key: z.string().min(1).describe("Feature flag key."),
    path: z
      .string()
      .min(1)
      .default("/v1/flags/{flag_key}")
      .describe("Delete path or template. Supports {flag_key} or :flag_key placeholders; otherwise flag_key is appended."),
  },
  async ({ flag_key, path }) =>
    text(await eachRequest(flagPath(path, flag_key), { method: "DELETE" })),
);
}

// --- Workflows ---------------------------------------------------------------------

registerTool(
  "eachlabs_validate_workflow_definition",
  {
    title: "Validate workflow definition",
    description:
      "Lint a workflow definition before mutation. Checks step IDs/types, JSON Schema, references, branches, choices, version consistency, retry/timeout bounds, and optionally live model schemas.",
    annotations: { ...readOnly },
  },
  {
    definition: jsonObjectSchema,
    expected_version: z.string().min(1).optional(),
    mode: z
      .enum(["structural", "live"])
      .default("live")
      .describe("Live mode also resolves every model and validates its params against the current request schema."),
    policy_checks: z
      .boolean()
      .default(false)
      .describe("Optional static warnings for inline secrets and plain-HTTP endpoints; no external security scan is run."),
  },
  async ({ definition, expected_version, mode, policy_checks }) =>
    text(
      await validateWorkflowDefinition(definition, {
        expectedVersion: expected_version,
        modelResolver: mode === "live" ? getModelBySlug : undefined,
        policyChecks: policy_checks,
      }),
    ),
);

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
      "Current CreateWorkflowRequest body: name plus an optional definition. Other metadata fields are not accepted by the current route.",
    ),
    validate_definition: z.boolean().default(true),
    validation_mode: z.enum(["structural", "live"]).default("live"),
    policy_checks: z.boolean().default(false),
  },
  async ({ workflow, validate_definition, validation_mode, policy_checks }) => {
    const unsupportedFields = Object.keys(workflow).filter(
      (field) => !["name", "definition"].includes(field),
    );
    if (typeof workflow.name !== "string" || !workflow.name.trim()) {
      return errorText({
        created: false,
        error: "Current workflow creation requires a non-empty name.",
      });
    }
    if (unsupportedFields.length > 0) {
      return errorText({
        created: false,
        error: "Current workflow creation accepts only name and definition.",
        unsupported_fields: unsupportedFields,
      });
    }
    const definition = workflow.definition;
    if (validate_definition && definition !== undefined) {
      const validation = await validateWorkflowDefinition(definition, {
        modelResolver:
          validation_mode === "live" ? getModelBySlug : undefined,
        policyChecks: policy_checks,
      });
      if (!validation.valid) {
        return errorText({ created: false, validation });
      }
    }
    return text(
      await eachRequest("/v1/workflows", {
        method: "POST",
        body: JSON.stringify(workflow),
      }),
    );
  },
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
    validate_definition: z.boolean().default(true),
    validation_mode: z.enum(["structural", "live"]).default("live"),
    policy_checks: z.boolean().default(false),
  },
  async ({
    workflow_id,
    version_id,
    body,
    validate_definition,
    validation_mode,
    policy_checks,
  }) => {
    if (
      body.version_id !== undefined &&
      String(body.version_id) !== version_id
    ) {
      return errorText({
        updated: false,
        error: "body.version_id must match the version_id path parameter.",
        expected: version_id,
        received: body.version_id,
      });
    }
    if (!body.definition || typeof body.definition !== "object") {
      return errorText({
        updated: false,
        error: "Current version upsert requires body.definition.",
      });
    }
    if (validate_definition) {
      const validation = await validateWorkflowDefinition(body.definition, {
        expectedVersion: version_id,
        modelResolver:
          validation_mode === "live" ? getModelBySlug : undefined,
        policyChecks: policy_checks,
      });
      if (!validation.valid) {
        return errorText({ updated: false, validation });
      }
    }
    return text(
      await eachRequest(`/workflows/${workflow_id}/versions/${version_id}`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
  },
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
    webhook_secret: z.string().min(1).optional(),
  },
  async ({ workflow_id, inputs, version_id, webhook_url, webhook_secret }, extra) => {
    const resolvedVersion = await resolveWorkflowVersionId(
      workflow_id,
      version_id,
      extra?.signal,
    );
    return text(
      await eachRequest(workflowTriggerPath(workflow_id, resolvedVersion), {
        method: "POST",
        body: JSON.stringify({ inputs, webhook_url, webhook_secret }),
        signal: extra?.signal,
      }),
    );
  },
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
    webhook_secret: z.string().min(1).optional(),
  },
  async ({ workflow_id, inputs, version_id, webhook_url, webhook_secret }, extra) => {
    const resolvedVersion = await resolveWorkflowVersionId(
      workflow_id,
      version_id,
      extra?.signal,
    );
    return text(
      await eachRequest(workflowTriggerPath(workflow_id, resolvedVersion, true), {
        method: "POST",
        body: JSON.stringify({ inputs, webhook_url, webhook_secret }),
        signal: extra?.signal,
      }),
    );
  },
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
      await eachRequest(appendQuery(`/v1/workflows/${workflow_id}/executions`, { limit, offset, bulk_id }), {
        baseUrl: EACH_API_BASE_URL,
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
      eachRequest<Record<string, unknown>>(workflowExecutionPath(execution_id), {
        signal: extra?.signal,
      });

    if (!wait) return text(await fetchExecution());

    const { completed, cancelled, last } = await pollUntilDone(
      fetchExecution,
      WORKFLOW_TERMINAL_STATUSES,
      timeout_seconds,
      poll_interval_seconds,
      extra,
    );
    return text(
      completed
        ? last
        : { status: cancelled ? "cancelled_by_client" : "timeout", execution_id, last },
    );
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
  },
  async ({ nickname, slug, version_id, inputs }) =>
    text(
      await eachRequest(`/public/@${nickname}/workflows/${slug}/versions/${version_id}/trigger`, {
        baseUrl: EACH_WORKFLOWS_BASE_URL,
        method: "POST",
        auth: false,
        body: JSON.stringify({
          api_key: requireApiKey(),
          inputs,
        }),
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
        "Use upstream streaming, aggregated server-side with progress notifications. false requests a single buffered JSON response.",
      ),
    stream_timeout_seconds: z
      .number()
      .int()
      .min(30)
      .max(900)
      .default(900)
      .describe("Idle timeout for streaming responses. Each event resets the timer."),
    include_raw_safe_events: z
      .boolean()
      .default(false)
      .describe("Include bounded non-reasoning status/tool/progress events in raw_safe_events."),
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
    enable_safety_checker: z
      .boolean()
      .optional()
      .describe("Top-level each::sense safety-checker control."),
    extra: jsonObjectSchema.default({}).describe("Additional provider-specific request fields."),
  },
  async (
    {
      model,
      messages,
      stream,
      stream_timeout_seconds,
      include_raw_safe_events,
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
      enable_safety_checker,
      extra,
    },
    handlerExtra,
  ) => {
    const payload = {
      ...extra,
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
      enable_safety_checker,
    };

    if (stream) {
      return text(
        await streamEachSense(
          "/chat/completions",
          {
            baseUrl: EACH_SENSE_V1_BASE_URL,
            body: JSON.stringify({ ...payload, stream: true }),
            timeoutSeconds: stream_timeout_seconds,
            includeRawSafeEvents: include_raw_safe_events,
          },
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
    stream_timeout_seconds: z.number().int().min(30).max(900).default(900),
    include_raw_safe_events: z.boolean().default(false),
  },
  async (
    {
      message,
      workflow_id,
      version_id,
      session_id,
      stream,
      stream_timeout_seconds,
      include_raw_safe_events,
    },
    handlerExtra,
  ) => {
    const payload = { message, workflow_id, version_id, session_id };

    if (stream) {
      return text(
        await streamEachSense(
          "/workflow",
          {
            baseUrl: EACH_SENSE_BASE_URL,
            body: JSON.stringify({ ...payload, stream: true }),
            timeoutSeconds: stream_timeout_seconds,
            includeRawSafeEvents: include_raw_safe_events,
          },
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
    auth_mode: z
      .enum(["bearer", "x-api-key"])
      .default("bearer")
      .describe("Bearer is the current documented default; x-api-key is retained for legacy endpoints."),
    bearer: z
      .boolean()
      .optional()
      .describe("Deprecated compatibility switch. true maps to bearer; false maps to x-api-key."),
  },
  async ({ target, method, path, query, body, auth, auth_mode, bearer }) => {
    const policyError = rawRequestPolicyError(method, auth);
    if (policyError) {
      return errorText({
        blocked: true,
        error: policyError,
      });
    }
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
        authMode:
          bearer === undefined
            ? auth_mode
            : bearer
              ? "bearer"
              : "x-api-key",
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
    const [catalogResult, updateResult] = await Promise.allSettled([
      eachRequest<unknown>(appendQuery("/v1/models", { limit: 1, offset: 0 }), {
        auth: false,
        timeoutMs: 5000,
        retries: 0,
      }),
      fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(5000) }),
    ]);

    const catalog =
      catalogResult.status === "fulfilled"
        ? Array.isArray(catalogResult.value)
          ? { reachable: true, sample_size: catalogResult.value.length }
          : { reachable: true, response: catalogResult.value }
        : {
            reachable: false,
            error:
              catalogResult.reason instanceof Error
                ? catalogResult.reason.message
                : String(catalogResult.reason),
          };

    let update: Record<string, unknown> = { current_version: SERVER_VERSION };
    try {
      if (updateResult.status === "rejected") throw updateResult.reason;
      const response = updateResult.value;
      if (response.ok) {
        const remote = (await response.json()) as { version?: string };
        update = {
          current_version: SERVER_VERSION,
          latest_version: remote.version ?? "unknown",
          update_available: Boolean(remote.version && remote.version !== SERVER_VERSION),
          how_to_update:
            "Marketplace installs: update through the Codex/Claude plugin marketplace. Source checkouts: npm ci && npm run build.",
        };
      } else {
        update.update_check = `HTTP ${response.status}`;
      }
    } catch (error) {
      update.update_check =
        error instanceof Error ? error.message : "unreachable";
    }

    return text({
      api_base_url: EACH_API_BASE_URL,
      workflows_base_url: EACH_WORKFLOWS_BASE_URL,
      sense_base_url: EACH_SENSE_BASE_URL,
      api_key_configured: Boolean(EACH_API_KEY),
      catalog_probe: catalog,
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

server.registerPrompt(
  "eachlabs-choose-model",
  {
    title: "Choose an each::labs model",
    description:
      "Find and compare suitable models without running predictions or spending credits.",
    argsSchema: {
      use_case: z
        .string()
        .describe(
          "What the developer needs, e.g. 'image-to-video with a duration control'.",
        ),
      required_fields: z
        .string()
        .optional()
        .describe("Optional comma-separated required input fields."),
    },
  },
  ({ use_case, required_fields }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Choose the best each::labs model for: ${use_case}`,
            required_fields
              ? `Required input fields: ${required_fields}.`
              : "",
            "Do not run a prediction. Search or recommend candidates, compare the strongest 2-5 with eachlabs_compare_models,",
            "and explain the recommendation using provider, request fields, constraints, output type, and catalog p50 latency.",
            "State clearly that p50 is not a price or quality guarantee.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "eachlabs-debug-run",
  {
    title: "Debug an each::labs run",
    description:
      "Diagnose a prediction or workflow execution without automatically retrying paid work.",
    argsSchema: {
      kind: z.enum(["prediction", "workflow"]),
      run_id: z.string().describe("Prediction ID or workflow execution ID."),
    },
  },
  ({ kind, run_id }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Diagnose this each::labs ${kind} run: ${run_id}`,
            "Use eachlabs_diagnose_run first. Explain the evidence, likely cause, and safest next action.",
            "Do not create or retry a paid run automatically. Check execution history before recommending a retry when the write result may be ambiguous.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "eachlabs-developer-checkup",
  {
    title: "Audit an each::labs integration",
    description:
      "Review a model or workflow integration for schema drift, safe retries, observability, and production readiness without spending credits.",
    argsSchema: {
      target: z
        .string()
        .describe("Model slug, workflow definition, or integration description to review."),
    },
  },
  ({ target }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Audit this each::labs integration for developer readiness: ${target}`,
            "Do not run paid predictions. Inspect the live model schema where applicable, compare it with any supplied baseline,",
            "validate and diff workflow definitions, check async polling/webhook behavior, and generate a privacy-safe debug bundle for failed run IDs.",
            "Call out breaking schema changes, ambiguous-write retry risks, secret handling, media URL safety, observability gaps, and the exact pre-production checks.",
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
