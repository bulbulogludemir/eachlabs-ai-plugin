import {
  getRequestSchema,
  schemaProperties,
} from "./schema.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function categoryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const item = record(value);
  const category = item?.slug ?? item?.Slug ?? item?.name ?? item?.Name;
  return category === undefined ? undefined : String(category);
}

function requiredFields(model: JsonRecord): string[] {
  const schema = record(getRequestSchema(model));
  return Array.isArray(schema?.required)
    ? schema.required.map(String)
    : [];
}

export function modelDeveloperSummary(model: JsonRecord) {
  const schema = getRequestSchema(model);
  const p50 = numberValue(model.p50);
  return {
    title: model.title ?? model.name,
    slug: model.slug,
    provider: model.provider_name ?? model.provider ?? null,
    category: categoryValue(model.category) ?? null,
    description:
      typeof model.description === "string"
        ? model.description.slice(0, 320)
        : null,
    version: model.version,
    output_type: model.output_type,
    p50_seconds: p50 > 0 ? p50 : null,
    required_fields: requiredFields(model),
    request_fields: Object.keys(schemaProperties(schema)),
  };
}

function compactFieldSchema(value: unknown) {
  const field = record(value) ?? {};
  return {
    type: field.type ?? null,
    required: false,
    default: field.default ?? null,
    enum: Array.isArray(field.enum) ? field.enum : null,
    minimum: field.minimum ?? null,
    maximum: field.maximum ?? null,
    min_items: field.minItems ?? null,
    max_items: field.maxItems ?? null,
  };
}

export function compareModelRecords(
  models: JsonRecord[],
  required: string[] = [],
  focus: string[] = [],
) {
  const summaries = models.map(modelDeveloperSummary);
  const fieldSets = summaries.map(
    (summary) => new Set(summary.request_fields),
  );
  const sharedFields =
    fieldSets.length === 0
      ? []
      : [...fieldSets[0]].filter((field) =>
          fieldSets.every((fields) => fields.has(field)),
        );
  const allFields = [...new Set(summaries.flatMap((item) => item.request_fields))];
  const usefulDefaults = [
    "prompt",
    "negative_prompt",
    "image_url",
    "image_urls",
    "aspect_ratio",
    "duration",
    "seed",
    "num_images",
    "output_format",
    "enable_safety_checker",
  ];
  const matrixFields = [
    ...new Set([
      ...required,
      ...focus,
      ...usefulDefaults.filter((field) => allFields.includes(field)),
    ]),
  ];

  const compared = models.map((model, index) => {
    const summary = summaries[index];
    const properties = schemaProperties(getRequestSchema(model));
    const requiredByModel = new Set(summary.required_fields);
    const missingRequiredFields = required.filter(
      (field) => !summary.request_fields.includes(field),
    );
    return {
      ...summary,
      fits_requirements: missingRequiredFields.length === 0,
      missing_required_fields: missingRequiredFields,
      fields: Object.fromEntries(
        matrixFields.map((field) => [
          field,
          properties[field]
            ? {
                ...compactFieldSchema(properties[field]),
                required: requiredByModel.has(field),
              }
            : null,
        ]),
      ),
    };
  });

  const withLatency = compared.filter(
    (item) => typeof item.p50_seconds === "number",
  );
  const fastest = withLatency.sort(
    (a, b) => Number(a.p50_seconds) - Number(b.p50_seconds),
  )[0];

  return {
    models: compared,
    shared_fields: sharedFields,
    differing_fields: allFields.filter(
      (field) => !sharedFields.includes(field),
    ),
    fastest_by_catalog_p50: fastest
      ? { slug: fastest.slug, p50_seconds: fastest.p50_seconds }
      : null,
    note:
      "Catalog p50 is a latency signal, not a price or quality guarantee. This comparison does not run predictions or spend credits.",
  };
}

type UsageGroup = {
  executions: number;
  total_cost_usd: number;
  total_runtime_seconds: number;
  successful: number;
  failed: number;
};

function statusKind(status: string): "successful" | "failed" | "other" {
  if (["success", "completed"].includes(status)) return "successful";
  if (["error", "failed"].includes(status)) return "failed";
  return "other";
}

function groupKey(
  execution: JsonRecord,
  groupBy: "model" | "workflow" | "status",
): string {
  if (groupBy === "workflow") {
    return String(execution.workflow_id ?? "direct-model");
  }
  if (groupBy === "status") {
    return String(execution.status ?? "unknown");
  }
  return String(
    execution.requested_model ??
      execution.model ??
      "unknown-model",
  );
}

export function summarizeExecutions(
  executions: JsonRecord[],
  groupBy: "model" | "workflow" | "status" = "model",
  top = 10,
) {
  const groups = new Map<string, UsageGroup>();
  let totalCost = 0;
  let totalRuntime = 0;
  let successful = 0;
  let failed = 0;

  for (const execution of executions) {
    const cost = numberValue(
      execution.execution_cost ??
        execution.cost ??
        record(execution.metrics)?.cost,
    );
    const runtime = numberValue(
      execution.run_time ??
        execution.runtime ??
        record(execution.metrics)?.predict_time,
    );
    const kind = statusKind(
      String(execution.status ?? "").toLowerCase(),
    );
    totalCost += cost;
    totalRuntime += runtime;
    if (kind === "successful") successful++;
    if (kind === "failed") failed++;

    const key = groupKey(execution, groupBy);
    const current = groups.get(key) ?? {
      executions: 0,
      total_cost_usd: 0,
      total_runtime_seconds: 0,
      successful: 0,
      failed: 0,
    };
    current.executions++;
    current.total_cost_usd += cost;
    current.total_runtime_seconds += runtime;
    if (kind === "successful") current.successful++;
    if (kind === "failed") current.failed++;
    groups.set(key, current);
  }

  const round = (value: number) => Number(value.toFixed(6));
  const summarizedGroups = [...groups.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
      total_cost_usd: round(value.total_cost_usd),
      total_runtime_seconds: round(value.total_runtime_seconds),
      average_cost_usd: round(value.total_cost_usd / value.executions),
      average_runtime_seconds: round(
        value.total_runtime_seconds / value.executions,
      ),
    }))
    .sort(
      (a, b) =>
        b.total_cost_usd - a.total_cost_usd ||
        b.executions - a.executions,
    )
    .slice(0, top);

  return {
    sampled_executions: executions.length,
    total_cost_usd: round(totalCost),
    total_runtime_seconds: round(totalRuntime),
    average_cost_usd:
      executions.length > 0 ? round(totalCost / executions.length) : 0,
    average_runtime_seconds:
      executions.length > 0 ? round(totalRuntime / executions.length) : 0,
    successful,
    failed,
    other: executions.length - successful - failed,
    success_rate:
      executions.length > 0
        ? round(successful / executions.length)
        : null,
    grouped_by: groupBy,
    groups: summarizedGroups,
    note:
      "Summary excludes prompts, inputs, outputs, and logs. Costs reflect returned execution history only.",
  };
}

function diagnosticText(value: unknown): string {
  const item = record(value);
  const candidates = [
    item?.error_classification,
    item?.error,
    item?.message,
    item?.logs,
    record(item?.output)?.error,
    Array.isArray(item?.output)
      ? record(item?.output[0])?.error
      : undefined,
  ];
  return candidates
    .filter((candidate) => typeof candidate === "string")
    .join(" ")
    .slice(0, 4_000)
    .toLowerCase();
}

export function diagnoseRunRecord(value: unknown) {
  const item = record(value) ?? {};
  const status = String(item.status ?? "unknown").toLowerCase();
  const details = diagnosticText(item);
  let diagnosis = "unknown_failure";
  let safeToRetry: "yes" | "no" | "unknown" = "unknown";
  let actions = [
    "Inspect the returned status, logs, and upstream error details.",
    "Check execution history before creating another paid run.",
  ];

  if (["success", "completed"].includes(status)) {
    diagnosis = "healthy";
    safeToRetry = "no";
    actions = ["No retry is needed; inspect the output and reported cost."];
  } else if (status === "cancelled") {
    diagnosis = "cancelled";
    safeToRetry = "unknown";
    actions = [
      "Confirm whether cancellation was user-requested or provider-side.",
      "Check execution history before starting a replacement run.",
    ];
  } else if (/moderation|nsfw|safety|content.?policy/.test(details)) {
    diagnosis = "content_moderation";
    safeToRetry = "no";
    actions = [
      "Revise the prompt or input media to comply with the selected model policy.",
      "Do not disable the safety checker unless the user explicitly requests it and the model supports it.",
    ];
  } else if (/invalid|validation|schema|required|unprocessable|422/.test(details)) {
    diagnosis = "invalid_input";
    safeToRetry = "no";
    actions = [
      "Fetch the current model request schema.",
      "Validate the input locally, then retry only after correcting the payload.",
    ];
  } else if (/rate.?limit|429|too many requests/.test(details)) {
    diagnosis = "rate_limited";
    safeToRetry = "yes";
    actions = [
      "Honor Retry-After or wait with bounded backoff.",
      "Reuse the existing run ID if one was created; do not duplicate a paid write blindly.",
    ];
  } else if (/timeout|timed out|deadline/.test(details)) {
    diagnosis = "execution_timeout";
    safeToRetry = "unknown";
    actions = [
      "Check whether the original run is still present in execution history.",
      "For long jobs, use async mode and poll instead of creating another synchronous run.",
    ];
  } else if (/provider.?auth|unauthorized provider|provider credential/.test(details)) {
    diagnosis = "provider_auth";
    safeToRetry = "no";
    actions = [
      "Treat this as an upstream provider credential/routing issue.",
      "Do not rotate the EachLabs API key unless the API itself returned an authentication error.",
    ];
  } else if (/unavailable|overloaded|502|503|504|provider.?error/.test(details)) {
    diagnosis = "provider_unavailable";
    safeToRetry = "unknown";
    actions = [
      "Check execution history to determine whether the write was accepted.",
      "Retry only after confirming no paid run is already in progress.",
    ];
  } else if (/unauthorized|invalid api key|401|forbidden|403/.test(details)) {
    diagnosis = "eachlabs_auth";
    safeToRetry = "no";
    actions = [
      "Verify the server-side EachLabs API key and Bearer authentication.",
      "Do not expose or paste the key into prompts or logs.",
    ];
  }

  return {
    status,
    diagnosis,
    safe_to_retry: safeToRetry,
    recommended_actions: actions,
    evidence_present: details.length > 0,
    note:
      "This is deterministic local triage from the returned run record. It does not create or retry a run.",
  };
}

type SchemaChange = {
  path: string;
  kind: string;
  breaking: boolean;
  before?: unknown;
  after?: unknown;
};

function fieldMap(
  schema: unknown,
  prefix = "",
  parentRequired = new Set<string>(),
  result = new Map<string, JsonRecord & { required: boolean }>(),
) {
  const item = record(schema) ?? {};
  const properties = record(item.properties) ?? {};
  const required = new Set(
    Array.isArray(item.required) ? item.required.map(String) : [],
  );
  for (const [name, value] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const field = record(value) ?? {};
    result.set(path, { ...field, required: required.has(name) });
    if (field.type === "object" || field.properties) {
      fieldMap(field, path, required, result);
    }
  }
  void parentRequired;
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffModelSchemas(baseline: unknown, current: unknown) {
  const before = fieldMap(baseline);
  const after = fieldMap(current);
  const changes: SchemaChange[] = [];

  for (const [path, field] of before) {
    const next = after.get(path);
    if (!next) {
      changes.push({ path, kind: "field_removed", breaking: true });
      continue;
    }
    if (field.type !== next.type) {
      changes.push({
        path,
        kind: "type_changed",
        breaking: true,
        before: field.type,
        after: next.type,
      });
    }
    if (!field.required && next.required) {
      changes.push({ path, kind: "became_required", breaking: true });
    } else if (field.required && !next.required) {
      changes.push({ path, kind: "became_optional", breaking: false });
    }
    const beforeEnum = Array.isArray(field.enum) ? field.enum : undefined;
    const afterEnum = Array.isArray(next.enum) ? next.enum : undefined;
    if (!sameJson(beforeEnum, afterEnum)) {
      const removed = beforeEnum?.filter(
        (value) => !afterEnum?.some((candidate) => sameJson(candidate, value)),
      ) ?? [];
      changes.push({
        path,
        kind: "enum_changed",
        breaking: removed.length > 0 || (beforeEnum === undefined && afterEnum !== undefined),
        before: beforeEnum,
        after: afterEnum,
      });
    }
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "format", "default"] as const) {
      if (sameJson(field[key], next[key])) continue;
      const beforeValue = field[key];
      const afterValue = next[key];
      const lowerBound = key === "minimum" || key === "minLength";
      const upperBound = key === "maximum" || key === "maxLength";
      const breaking =
        (key === "format" && afterValue !== undefined) ||
        (lowerBound &&
          afterValue !== undefined &&
          (beforeValue === undefined ||
            numberValue(afterValue) > numberValue(beforeValue))) ||
        (upperBound &&
          afterValue !== undefined &&
          (beforeValue === undefined ||
            numberValue(afterValue) < numberValue(beforeValue)));
      changes.push({
        path,
        kind: `${key}_changed`,
        breaking,
        before: field[key],
        after: next[key],
      });
    }
  }

  for (const [path, field] of after) {
    if (!before.has(path)) {
      changes.push({
        path,
        kind: "field_added",
        breaking: field.required,
      });
    }
  }

  const breaking = changes.filter((change) => change.breaking);
  return {
    compatible: breaking.length === 0,
    breaking_change_count: breaking.length,
    change_count: changes.length,
    changes,
    note:
      "Breaking classification is a local compatibility heuristic. Confirm provider semantics before deployment.",
  };
}

function workflowSteps(definition: unknown): JsonRecord[] {
  const item = record(definition);
  return Array.isArray(item?.steps)
    ? item.steps.map(record).filter((step): step is JsonRecord => Boolean(step))
    : [];
}

export function diffWorkflowDefinitions(before: unknown, after: unknown) {
  const beforeRecord = record(before) ?? {};
  const afterRecord = record(after) ?? {};
  const left = new Map(
    workflowSteps(before).map((step) => [String(step.id ?? ""), step]),
  );
  const right = new Map(
    workflowSteps(after).map((step) => [String(step.id ?? ""), step]),
  );
  const changes: Array<Record<string, unknown>> = [];

  for (const [id, step] of left) {
    const next = right.get(id);
    if (!next) {
      changes.push({ step_id: id, kind: "step_removed", breaking: true });
      continue;
    }
    for (const key of ["type", "model"] as const) {
      if (!sameJson(step[key], next[key])) {
        changes.push({
          step_id: id,
          kind: `${key}_changed`,
          breaking: true,
          before: step[key],
          after: next[key],
        });
      }
    }
    if (!sameJson(step.params, next.params)) {
      changes.push({
        step_id: id,
        kind: "params_changed",
        breaking: false,
      });
    }
  }
  for (const id of right.keys()) {
    if (!left.has(id)) {
      changes.push({ step_id: id, kind: "step_added", breaking: false });
    }
  }

  const inputSchema = diffModelSchemas(
    beforeRecord.input_schema ?? {},
    afterRecord.input_schema ?? {},
  );
  const versionChanged = !sameJson(beforeRecord.version, afterRecord.version);
  return {
    compatible:
      changes.every((change) => change.breaking !== true) &&
      inputSchema.compatible,
    version_changed: versionChanged,
    before_version: beforeRecord.version ?? null,
    after_version: afterRecord.version ?? null,
    step_changes: changes,
    input_schema: inputSchema,
    note:
      "Workflow diff is local and does not mutate or execute either definition.",
  };
}

function debugValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => debugValue(item, depth + 1));
  const item = record(value);
  if (!item) return value;
  const blocked = /api.?key|authorization|password|secret|token|prompt|input|output|logs|media/i;
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 80)
      .map(([key, child]) => [key, debugValue(child, depth + 1)]),
  );
}

export function buildDebugBundle(
  kind: "prediction" | "workflow",
  run: unknown,
  serverVersion: string,
) {
  return {
    format: "eachlabs-debug-bundle/v1",
    server_version: serverVersion,
    kind,
    diagnosis: diagnoseRunRecord(run),
    run: debugValue(run),
    privacy:
      "Prompts, inputs, outputs, logs, media URLs, credentials, secrets, and tokens are excluded.",
  };
}
