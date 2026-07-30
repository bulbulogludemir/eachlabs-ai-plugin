import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";

const AjvConstructor = AjvModule as unknown as new (
  options: Record<string, unknown>,
) => { compile(schema: object): ValidateFunction };
const ajv = new AjvConstructor({
  allErrors: true,
  strict: false,
  validateFormats: false,
  allowUnionTypes: true,
});

const compiledSchemas = new WeakMap<object, ValidateFunction>();

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getRequestSchema(model: Record<string, unknown>): unknown {
  return (
    model.request_schema ??
    model.input_schema ??
    model.schema ??
    (model.latest_version as Record<string, unknown> | undefined)?.request_schema
  );
}

export function schemaProperties(
  schema: unknown,
): Record<string, Record<string, unknown>> {
  const properties = schemaRecord(schema)?.properties;
  return properties && typeof properties === "object"
    ? (properties as Record<string, Record<string, unknown>>)
    : {};
}

export function schemaRequired(schema: unknown): string[] {
  const required = schemaRecord(schema)?.required;
  return Array.isArray(required)
    ? required.filter((field): field is string => typeof field === "string")
    : [];
}

export function summarizeJsonSchema(schema: unknown): unknown {
  const candidate = schemaRecord(schema);
  if (!candidate) return schema;
  const properties = schemaProperties(schema);
  const required = schemaRequired(schema);

  if (Object.keys(properties).length === 0) return schema;

  return {
    type: candidate.type ?? "object",
    required,
    fields: Object.entries(properties).map(([name, field]) => ({
      name,
      type: field.type ?? field.anyOf ?? field.oneOf ?? "unknown",
      required: required.includes(name),
      description: field.description,
      default: field.default,
      enum: field.enum,
      examples: field.examples ?? field.example,
      minimum: field.minimum,
      maximum: field.maximum,
      minLength: field.minLength,
      maxLength: field.maxLength,
      pattern: field.pattern,
    })),
  };
}

function exampleForSchema(
  schema: Record<string, unknown>,
  name = "value",
): unknown {
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const alternatives = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alternatives)) {
    const first = alternatives.find((item) => item && typeof item === "object");
    if (first) return exampleForSchema(first as Record<string, unknown>, name);
  }

  const type = schema.type;
  const lowerName = name.toLowerCase();
  const description = String(schema.description ?? "").toLowerCase();

  if (type === "object" || schema.properties) {
    const result: Record<string, unknown> = {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    for (const [key, child] of Object.entries(
      (schema.properties as Record<string, Record<string, unknown>>) ?? {},
    )) {
      if (required.has(key)) result[key] = exampleForSchema(child, key);
    }
    return result;
  }
  if (type === "array") {
    const itemSchema = schemaRecord(schema.items);
    const count = Math.max(0, Number(schema.minItems ?? 0));
    return itemSchema
      ? Array.from({ length: count }, () => exampleForSchema(itemSchema, name))
      : [];
  }
  if (type === "string" || !type) {
    if (lowerName.includes("prompt")) {
      return "A cinematic product photo of a futuristic sneaker on a clean studio background";
    }
    if (
      lowerName.includes("image") ||
      lowerName.includes("url") ||
      description.includes("url") ||
      schema.format === "uri"
    ) {
      return "https://example.com/input.png";
    }
    if (lowerName.includes("aspect") || lowerName.includes("ratio")) return "1:1";
    const minLength = Number(schema.minLength ?? 0);
    return `example_${name}`.padEnd(minLength, "x");
  }
  if (type === "integer") return Math.ceil(Number(schema.minimum ?? 1));
  if (type === "number") return Number(schema.minimum ?? 1);
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

export function generateExampleInput(
  schema: unknown,
  includeOptional: boolean,
  overrides: Record<string, unknown>,
) {
  const properties = schemaProperties(schema);
  const required = new Set(schemaRequired(schema));
  const input: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(properties)) {
    if (includeOptional || required.has(name)) {
      input[name] = exampleForSchema(field, name);
    }
  }

  return { ...input, ...overrides };
}

function formatAjvError(error: ErrorObject) {
  const missing =
    error.keyword === "required"
      ? String((error.params as { missingProperty?: string }).missingProperty ?? "")
      : "";
  const field = [error.instancePath.replace(/^\//, "").replaceAll("/", "."), missing]
    .filter(Boolean)
    .join(".");
  return {
    field: field || "$",
    message: error.message ?? `Schema validation failed (${error.keyword}).`,
    expected: error.params,
  };
}

export function validateAgainstSchema(
  schema: unknown,
  input: Record<string, unknown>,
) {
  if (!schema || typeof schema !== "object") {
    return {
      valid: true,
      errors: [] as Array<ReturnType<typeof formatAjvError>>,
      warnings: [{ field: "$", message: "No documented request schema is available." }],
    };
  }

  let validate = compiledSchemas.get(schema);
  try {
    if (!validate) {
      const compiled = ajv.compile(schema);
      compiledSchemas.set(schema, compiled);
      validate = compiled;
    }
  } catch (error) {
    return {
      valid: true,
      errors: [] as Array<ReturnType<typeof formatAjvError>>,
      warnings: [
        {
          field: "$",
          message: `The documented schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (!validate) {
    throw new Error("Schema validator was not initialized.");
  }
  const valid = Boolean(validate(input));
  const properties = schemaProperties(schema);
  const warnings = Object.keys(input)
    .filter((field) => !properties[field])
    .map((field) => ({
      field,
      message: "Field is not present in the documented request schema.",
    }));

  return {
    valid,
    errors: (validate.errors ?? []).map(formatAjvError),
    warnings,
  };
}
