import { checkJsonSchema, getRequestSchema, validateAgainstSchema } from "./schema.js";

export type WorkflowDiagnostic = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
};

export type WorkflowModelResolver = (
  slug: string,
) => Promise<Record<string, unknown>>;

const STEP_TYPES = new Set([
  "model",
  "http",
  "python",
  "parallel",
  "choice",
  "pass",
]);
const CHOICE_OPERATORS = new Set([
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "string_matches",
  "array_contains",
  "array_length_equals",
  "is_null",
  "is_not_null",
  "in",
  "not_in",
]);
const TEMPLATE_REFERENCE = /\{\{\s*([a-zA-Z0-9_-]+)(?:\.([^}]+))?\s*\}\}/g;
const CONDITION_REFERENCE = /^\$\.([a-zA-Z0-9_-]+)(?:\.|$)/;
const SECRET_FIELD = /(api[_-]?key|secret|token|password|authorization)/i;

function objectRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function stepId(step: Record<string, any>): string {
  return String(step.step_id ?? step.id ?? "");
}

function collectTemplateReferences(
  value: unknown,
  output: Array<{ root: string; tail?: string }> = [],
): Array<{ root: string; tail?: string }> {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_REFERENCE)) {
      output.push({ root: match[1], tail: match[2]?.trim() });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectTemplateReferences(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectTemplateReferences(item, output);
    }
  }
  return output;
}

function nestedStepArrays(step: Record<string, any>): Array<{
  steps: unknown[];
  path: string;
}> {
  const result: Array<{ steps: unknown[]; path: string }> = [];
  const add = (candidate: unknown, path: string) => {
    if (Array.isArray(candidate)) result.push({ steps: candidate, path });
    else if (Array.isArray(objectRecord(candidate)?.steps)) {
      result.push({ steps: objectRecord(candidate)!.steps, path: `${path}.steps` });
    }
  };
  if (Array.isArray(step.branches)) {
    step.branches.forEach((branch: unknown, index: number) =>
      add(branch, `.branches[${index}]`),
    );
  }
  add(step.condition_met_branch, ".condition_met_branch");
  add(step.default_branch, ".default_branch");
  if (Array.isArray(step.choices)) {
    step.choices.forEach((choice: unknown, index: number) =>
      add(choice, `.choices[${index}]`),
    );
  }
  return result;
}

function inspectCondition(
  condition: unknown,
  available: Set<string>,
  inputFields: Set<string>,
  path: string,
  diagnostics: WorkflowDiagnostic[],
) {
  const record = objectRecord(condition);
  if (!record) {
    diagnostics.push({
      severity: "error",
      code: "choice_condition_missing",
      path,
      message: "Choice steps require a condition object.",
    });
    return;
  }
  for (const logical of ["and", "or"]) {
    if (Array.isArray(record[logical])) {
      record[logical].forEach((item: unknown, index: number) =>
        inspectCondition(item, available, inputFields, `${path}.${logical}[${index}]`, diagnostics),
      );
      return;
    }
  }
  if (record.not) {
    inspectCondition(record.not, available, inputFields, `${path}.not`, diagnostics);
    return;
  }
  if (!CHOICE_OPERATORS.has(String(record.operator ?? ""))) {
    diagnostics.push({
      severity: "warning",
      code: "choice_operator_unknown",
      path: `${path}.operator`,
      message: `Operator '${String(record.operator ?? "")}' is not in the documented operator set.`,
    });
  }
  const match = String(record.expression ?? "").match(CONDITION_REFERENCE);
  if (!match) {
    diagnostics.push({
      severity: "error",
      code: "choice_expression_invalid",
      path: `${path}.expression`,
      message: "Choice expressions must use $.inputs.field or $.step_id.field syntax.",
    });
  } else if (match[1] === "inputs") {
    const field = String(record.expression ?? "").split(".")[2];
    if (inputFields.size > 0 && field && !inputFields.has(field)) {
      diagnostics.push({
        severity: "error",
        code: "input_reference_unknown",
        path: `${path}.expression`,
        message: `Choice expression references undefined workflow input '${field}'.`,
      });
    }
  } else if (!available.has(match[1])) {
    diagnostics.push({
      severity: "error",
      code: "reference_unavailable",
      path: `${path}.expression`,
      message: `Choice expression references unavailable step '${match[1]}'.`,
    });
  }
}

function inspectPolicy(
  value: unknown,
  path: string,
  diagnostics: WorkflowDiagnostic[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectPolicy(item, `${path}[${index}]`, diagnostics),
    );
    return;
  }
  const record = objectRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    const itemPath = `${path}.${key}`;
    if (SECRET_FIELD.test(key) && typeof item === "string" && item.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "inline_secret",
        path: itemPath,
        message: "Possible inline secret; use runtime configuration instead.",
      });
    }
    if (
      (key === "url" || key === "endpoint") &&
      typeof item === "string" &&
      item.startsWith("http://")
    ) {
      diagnostics.push({
        severity: "warning",
        code: "insecure_http",
        path: itemPath,
        message: "Plain HTTP endpoint detected; prefer HTTPS.",
      });
    }
    inspectPolicy(item, itemPath, diagnostics);
  }
}

export async function validateWorkflowDefinition(
  definition: unknown,
  {
    expectedVersion,
    modelResolver,
    policyChecks = false,
  }: {
    expectedVersion?: string;
    modelResolver?: WorkflowModelResolver;
    policyChecks?: boolean;
  } = {},
) {
  const diagnostics: WorkflowDiagnostic[] = [];
  const workflow = objectRecord(definition);
  if (!workflow) {
    return {
      valid: false,
      diagnostics: [
        {
          severity: "error",
          code: "definition_invalid",
          path: "$",
          message: "Workflow definition must be a JSON object.",
        },
      ] satisfies WorkflowDiagnostic[],
      stats: { steps: 0, models: 0 },
    };
  }

  if (
    expectedVersion &&
    workflow.version !== undefined &&
    String(workflow.version) !== expectedVersion
  ) {
    diagnostics.push({
      severity: "error",
      code: "version_mismatch",
      path: "$.version",
      message: `Definition version '${String(workflow.version)}' must match '${expectedVersion}'.`,
    });
  }
  if (workflow.input_schema !== undefined) {
    const schemaCheck = checkJsonSchema(workflow.input_schema);
    if (!schemaCheck.valid) {
      diagnostics.push({
        severity: "error",
        code: "input_schema_invalid",
        path: "$.input_schema",
        message: schemaCheck.error ?? "Invalid JSON Schema.",
      });
    }
  }

  const rootSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const inputFields = new Set(
    Object.keys(objectRecord(objectRecord(workflow.input_schema)?.properties) ?? {}),
  );
  if (!Array.isArray(workflow.steps)) {
    diagnostics.push({
      severity: "error",
      code: "steps_missing",
      path: "$.steps",
      message: "Workflow definition requires a steps array.",
    });
  }

  const allIds = new Set<string>();
  const modelSteps: Array<{
    model: string;
    params: Record<string, unknown>;
    path: string;
  }> = [];
  let stepCount = 0;

  const walk = (
    rawSteps: unknown[],
    inherited: Set<string>,
    basePath: string,
  ): Set<string> => {
    const available = new Set(inherited);
    rawSteps.forEach((rawStep, index) => {
      const path = `${basePath}[${index}]`;
      const step = objectRecord(rawStep);
      if (!step) {
        diagnostics.push({
          severity: "error",
          code: "step_invalid",
          path,
          message: "Step must be a JSON object.",
        });
        return;
      }
      stepCount++;
      const id = stepId(step);
      if (!id) {
        diagnostics.push({
          severity: "error",
          code: "step_id_missing",
          path,
          message: "Step requires id or step_id.",
        });
      } else if (allIds.has(id)) {
        diagnostics.push({
          severity: "error",
          code: "step_id_duplicate",
          path,
          message: `Step ID '${id}' is duplicated.`,
        });
      } else {
        allIds.add(id);
      }

      const type = String(step.type ?? "");
      if (!STEP_TYPES.has(type)) {
        diagnostics.push({
          severity: "error",
          code: "step_type_unsupported",
          path: `${path}.type`,
          message: `Unsupported step type '${type}'.`,
        });
      }
      const directStep = { ...step };
      delete directStep.branches;
      delete directStep.condition_met_branch;
      delete directStep.default_branch;
      delete directStep.choices;
      for (const reference of collectTemplateReferences(directStep)) {
        if (reference.root === "inputs") {
          const field = reference.tail?.split(".")[0];
          if (inputFields.size > 0 && field && !inputFields.has(field)) {
            diagnostics.push({
              severity: "error",
              code: "input_reference_unknown",
              path,
              message: `Template references undefined workflow input '${field}'.`,
            });
          }
        } else if (!available.has(reference.root)) {
          diagnostics.push({
            severity: "error",
            code: "reference_unavailable",
            path,
            message: `Template references unavailable or later step '${reference.root}'.`,
          });
        }
      }
      if (type === "choice") {
        inspectCondition(
          step.condition,
          available,
          inputFields,
          `${path}.condition`,
          diagnostics,
        );
        for (const branchName of [
          "condition_met_branch",
          "default_branch",
        ]) {
          const branch = objectRecord(step[branchName]);
          if (!branch || !Array.isArray(branch.steps)) {
            diagnostics.push({
              severity: "error",
              code: "choice_branch_invalid",
              path: `${path}.${branchName}`,
              message: `${branchName} must be an object containing a steps array.`,
            });
          }
        }
      }
      if (type === "parallel") {
        if (
          !Array.isArray(step.branches) ||
          step.branches.length < 1 ||
          step.branches.length > 40
        ) {
          diagnostics.push({
            severity: "error",
            code: "parallel_branches_invalid",
            path: `${path}.branches`,
            message: "Parallel steps require between 1 and 40 branches.",
          });
        } else {
          step.branches.forEach((branch: unknown, branchIndex: number) => {
            if (!Array.isArray(objectRecord(branch)?.steps)) {
              diagnostics.push({
                severity: "error",
                code: "parallel_branch_invalid",
                path: `${path}.branches[${branchIndex}]`,
                message: "Each parallel branch must contain a steps array.",
              });
            }
          });
        }
      }
      if (type === "model") {
        const model = String(step.model ?? "");
        if (!model) {
          diagnostics.push({
            severity: "error",
            code: "model_missing",
            path: `${path}.model`,
            message: "Model step requires a model slug.",
          });
        } else {
          modelSteps.push({
            model,
            params: objectRecord(step.params) ?? {},
            path,
          });
        }
        const fallback = objectRecord(step.fallback);
        const fallbackModel = String(fallback?.model ?? "");
        if (fallback?.enabled && fallbackModel) {
          modelSteps.push({
            model: fallbackModel,
            params: objectRecord(fallback.params) ?? {},
            path: `${path}.fallback`,
          });
        }
      }
      const retry = objectRecord(step.retry);
      if (retry?.max_attempts !== undefined) {
        const attempts = Number(retry.max_attempts);
        if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
          diagnostics.push({
            severity: "error",
            code: "retry_bounds",
            path: `${path}.retry.max_attempts`,
            message: "max_attempts must be an integer from 1 to 10.",
          });
        }
      }
      const timeout = step.timeout_seconds ?? step.timeout;
      if (timeout !== undefined && (Number(timeout) < 1 || Number(timeout) > 900)) {
        diagnostics.push({
          severity: "error",
          code: "timeout_bounds",
          path: `${path}.timeout_seconds`,
          message: "Step timeout must be between 1 and 900 seconds.",
        });
      }

      for (const nested of nestedStepArrays(step)) {
        const nestedAvailable = walk(
          nested.steps,
          available,
          `${path}${nested.path}`,
        );
        if (type === "parallel") {
          for (const nestedId of nestedAvailable) available.add(nestedId);
        }
      }
      if (id) available.add(id);
    });
    return available;
  };
  walk(rootSteps, new Set(), "$.steps");

  if (modelResolver) {
    const cache = new Map<string, Promise<Record<string, unknown>>>();
    const resolve = (slug: string) => {
      const existing = cache.get(slug);
      if (existing) return existing;
      const request = modelResolver(slug);
      cache.set(slug, request);
      return request;
    };
    await Promise.all(
      modelSteps.map(async ({ model, params, path }) => {
        try {
          const details = await resolve(model);
          const schema = getRequestSchema(details);
          if (!schema) {
            diagnostics.push({
              severity: "warning",
              code: "model_schema_missing",
              path: `${path}.model`,
              message: `Model '${model}' exists but has no documented request schema.`,
            });
            return;
          }
          const validation = validateAgainstSchema(schema, params);
          for (const error of validation.errors) {
            diagnostics.push({
              severity: "error",
              code: "model_params_invalid",
              path: `${path}.params.${error.field}`,
              message: error.message,
            });
          }
          for (const warning of validation.warnings) {
            diagnostics.push({
              severity: "warning",
              code: "model_params_unknown",
              path: `${path}.params.${warning.field}`,
              message: warning.message,
            });
          }
        } catch (error) {
          diagnostics.push({
            severity: "error",
            code: "model_not_found",
            path: `${path}.model`,
            message: `Could not resolve model '${model}': ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }),
    );
  }

  if (policyChecks) inspectPolicy(workflow, "$", diagnostics);
  return {
    valid: !diagnostics.some((item) => item.severity === "error"),
    diagnostics,
    stats: {
      steps: stepCount,
      models: new Set(modelSteps.map((item) => item.model)).size,
      errors: diagnostics.filter((item) => item.severity === "error").length,
      warnings: diagnostics.filter((item) => item.severity === "warning").length,
    },
  };
}
