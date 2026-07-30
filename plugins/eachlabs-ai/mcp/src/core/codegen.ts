import {
  generateExampleInput,
  schemaProperties,
  schemaRequired,
} from "./schema.js";

export type CodegenLanguage = "typescript" | "python" | "go" | "curl";
export type CodegenMode = "async_polling" | "webhook" | "synchronous";
export type CodegenFramework =
  | "none"
  | "express"
  | "nextjs"
  | "fastapi"
  | "flask";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tsType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
  }
  if (schema.type === "array") {
    return `${tsType((schema.items as Record<string, unknown>) ?? {})}[]`;
  }
  if (schema.type === "object" || schema.properties) {
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    return `{ ${Object.entries(
      (schema.properties as Record<string, Record<string, unknown>>) ?? {},
    )
      .map(
        ([name, child]) =>
          `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${tsType(child)}`,
      )
      .join("; ")} }`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "string";
}

function zodType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    return `z.enum([${schema.enum.map((item) => JSON.stringify(item)).join(", ")}])`;
  }
  let expression: string;
  if (schema.type === "array") {
    expression = `z.array(${zodType((schema.items as Record<string, unknown>) ?? {})})`;
  } else if (schema.type === "object" || schema.properties) {
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    expression = `z.object({\n${Object.entries(
      (schema.properties as Record<string, Record<string, unknown>>) ?? {},
    )
      .map(([name, child]) => {
        const childExpression = zodType(child);
        return `  ${JSON.stringify(name)}: ${childExpression}${required.has(name) ? "" : ".optional()"},`;
      })
      .join("\n")}\n})`;
  } else if (schema.type === "integer") {
    expression = "z.number().int()";
  } else if (schema.type === "number") {
    expression = "z.number()";
  } else if (schema.type === "boolean") {
    expression = "z.boolean()";
  } else {
    expression = "z.string()";
  }
  if (typeof schema.minimum === "number") expression += `.min(${schema.minimum})`;
  if (typeof schema.maximum === "number") expression += `.max(${schema.maximum})`;
  if (typeof schema.minLength === "number") expression += `.min(${schema.minLength})`;
  if (typeof schema.maxLength === "number") expression += `.max(${schema.maxLength})`;
  return expression;
}

function typescriptWebhookHandler(framework: CodegenFramework): string {
  const verify = `import { timingSafeEqual } from "node:crypto";

function validWebhookSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}`;
  if (framework === "nextjs") {
    return `${verify}

export async function POST(request: Request) {
  if (!validWebhookSecret(request.headers.get("x-webhook-secret"), process.env.EACH_WEBHOOK_SECRET!)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const event = await request.json();
  console.log(event);
  return Response.json({ received: true });
}`;
  }
  return `import express from "express";
${verify}

const app = express();

// Express-compatible handler
app.post("/webhooks/eachlabs", express.json(), (request, response) => {
  if (!validWebhookSecret(request.get("x-webhook-secret") ?? null, process.env.EACH_WEBHOOK_SECRET!)) {
    return response.sendStatus(401);
  }
  console.log(request.body);
  response.json({ received: true });
});

app.listen(3000);`;
}

function pythonWebhookHandler(framework: CodegenFramework): string {
  if (framework === "flask") {
    return `import hmac
import os
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.post("/webhooks/eachlabs")
def eachlabs_webhook():
    received = request.headers.get("X-Webhook-Secret", "")
    if not hmac.compare_digest(received, os.environ["EACH_WEBHOOK_SECRET"]):
        return ("Unauthorized", 401)
    print(request.get_json())
    return jsonify(received=True)`;
  }
  return `import hmac
import os
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()

@app.post("/webhooks/eachlabs")
async def eachlabs_webhook(request: Request, x_webhook_secret: str = Header(default="")):
    if not hmac.compare_digest(x_webhook_secret, os.environ["EACH_WEBHOOK_SECRET"]):
        raise HTTPException(status_code=401)
    print(await request.json())
    return {"received": True}`;
}

function generateTypescript(
  model: string,
  schema: Record<string, unknown>,
  example: Record<string, unknown>,
  mode: CodegenMode,
  includeTypes: boolean,
  includeZod: boolean,
): string {
  const typeBlock = includeTypes
    ? `type ModelInput = ${tsType(schema)};\n`
    : "";
  const zodBlock = includeZod
    ? `import { z } from "zod";\n\nconst ModelInputSchema = ${zodType(schema)};\n`
    : "";
  const endpoint =
    mode === "synchronous" ? "/v1/prediction/run" : "/v1/prediction";
  const webhookFields =
    mode === "webhook"
      ? `,\n    webhook_url: process.env.EACH_WEBHOOK_URL,\n    webhook_secret: process.env.EACH_WEBHOOK_SECRET`
      : "";
  const polling =
    mode === "async_polling"
      ? `
const predictionId = created.predictionID;
for (;;) {
  const statusResponse = await fetch(\`\${API_BASE}/v1/prediction/\${predictionId}\`, { headers });
  if (!statusResponse.ok) throw new Error(await statusResponse.text());
  const prediction = await statusResponse.json();
  if (["success", "failed", "error", "cancelled"].includes(prediction.status)) {
    console.log(prediction);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}`
      : `\nconsole.log(created);`;
  return `${zodBlock}${typeBlock}
const API_BASE = "https://api.eachlabs.ai";
const headers = {
  Authorization: \`Bearer \${process.env.EACH_API_KEY}\`,
  "Content-Type": "application/json",
};

const input${includeTypes ? ": ModelInput" : ""} = ${json(example)};
${includeZod ? "ModelInputSchema.parse(input);\n" : ""}
const response = await fetch(\`\${API_BASE}${endpoint}\`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: ${JSON.stringify(model)},
    input${webhookFields}
  }),
});
if (!response.ok) throw new Error(await response.text());
const created = await response.json();
${polling}`.trim();
}

function generatePython(
  model: string,
  example: Record<string, unknown>,
  mode: CodegenMode,
): string {
  const endpoint =
    mode === "synchronous" ? "/v1/prediction/run" : "/v1/prediction";
  const webhookFields =
    mode === "webhook"
      ? `,
    "webhook_url": os.environ["EACH_WEBHOOK_URL"],
    "webhook_secret": os.environ["EACH_WEBHOOK_SECRET"]`
      : "";
  const polling =
    mode === "async_polling"
      ? `
prediction_id = created["predictionID"]
while True:
    prediction = requests.get(f"{API_BASE}/v1/prediction/{prediction_id}", headers=headers).json()
    if prediction["status"] in ("success", "failed", "error", "cancelled"):
        print(prediction)
        break
    time.sleep(3)`
      : "\nprint(created)";
  return `import json
import os
import time
import requests

API_BASE = "https://api.eachlabs.ai"
headers = {
    "Authorization": f"Bearer {os.environ['EACH_API_KEY']}",
    "Content-Type": "application/json",
}
input_data = json.loads(r'''${json(example)}''')
payload = {
    "model": ${JSON.stringify(model)},
    "input": input_data${webhookFields}
}
response = requests.post(f"{API_BASE}${endpoint}", headers=headers, json=payload)
response.raise_for_status()
created = response.json()
${polling}`.trim();
}

function generateCurl(
  model: string,
  example: Record<string, unknown>,
  mode: CodegenMode,
): string {
  const endpoint =
    mode === "synchronous" ? "/v1/prediction/run" : "/v1/prediction";
  const payload: Record<string, unknown> = { model, input: example };
  if (mode === "webhook") {
    payload.webhook_url = "https://your-app.example/webhooks/eachlabs";
    payload.webhook_secret = "replace-with-a-shared-secret";
  }
  return `curl --fail-with-body -X POST "https://api.eachlabs.ai${endpoint}" \\
  -H "Authorization: Bearer $EACH_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data '${JSON.stringify(payload, null, 2)}'`;
}

function generateGo(
  model: string,
  example: Record<string, unknown>,
  mode: CodegenMode,
): string {
  const endpoint =
    mode === "synchronous" ? "/v1/prediction/run" : "/v1/prediction";
  const webhookFields =
    mode === "webhook"
      ? `
	payload["webhook_url"] = os.Getenv("EACH_WEBHOOK_URL")
	payload["webhook_secret"] = os.Getenv("EACH_WEBHOOK_SECRET")`
      : "";
  const polling =
    mode === "async_polling"
      ? `
	predictionID, _ := created["predictionID"].(string)
	for {
		pollRequest, _ := http.NewRequest("GET", apiBase+"/v1/prediction/"+predictionID, nil)
		pollRequest.Header.Set("Authorization", "Bearer "+os.Getenv("EACH_API_KEY"))
		pollResponse, err := client.Do(pollRequest)
		if err != nil { panic(err) }
		var prediction map[string]any
		if err := json.NewDecoder(pollResponse.Body).Decode(&prediction); err != nil { panic(err) }
		pollResponse.Body.Close()
		status, _ := prediction["status"].(string)
		if status == "success" || status == "failed" || status == "error" || status == "cancelled" {
			fmt.Printf("%+v\\n", prediction)
			break
		}
		time.Sleep(3 * time.Second)
	}`
      : `
	fmt.Printf("%+v\\n", created)`;
  return `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

const apiBase = "https://api.eachlabs.ai"
const inputJSON = ${JSON.stringify(json(example))}

func main() {
	var input map[string]any
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil { panic(err) }
	payload := map[string]any{
		"model": ${JSON.stringify(model)},
		"input": input,
	}${webhookFields}
	body, _ := json.Marshal(payload)
	request, _ := http.NewRequest("POST", apiBase+${JSON.stringify(endpoint)}, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+os.Getenv("EACH_API_KEY"))
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Minute}
	response, err := client.Do(request)
	if err != nil { panic(err) }
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		panic(fmt.Sprintf("EachLabs returned HTTP %d", response.StatusCode))
	}
	var created map[string]any
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil { panic(err) }${polling}
}`.trim();
}

export function generateIntegrationCode({
  model,
  schema,
  language,
  mode,
  framework = "none",
  includeTypes = true,
  includeZod = false,
}: {
  model: string;
  schema: Record<string, unknown>;
  language: CodegenLanguage;
  mode: CodegenMode;
  framework?: CodegenFramework;
  includeTypes?: boolean;
  includeZod?: boolean;
}) {
  const example = generateExampleInput(schema, false, {}) as Record<
    string,
    unknown
  >;
  const code =
    language === "typescript"
      ? generateTypescript(
          model,
          schema,
          example,
          mode,
          includeTypes,
          includeZod,
        )
      : language === "python"
        ? generatePython(model, example, mode)
        : language === "go"
          ? generateGo(model, example, mode)
          : generateCurl(model, example, mode);
  const webhookHandler =
    mode !== "webhook" || framework === "none" || language === "curl"
      ? undefined
      : language === "typescript"
        ? typescriptWebhookHandler(framework)
        : language === "python"
          ? pythonWebhookHandler(framework)
          : undefined;
  return {
    model,
    language,
    mode,
    framework,
    required_fields: schemaRequired(schema),
    available_fields: Object.keys(schemaProperties(schema)),
    code,
    webhook_handler: webhookHandler,
    notes: [
      "Generated from the current live model request schema.",
      "The deprecated prediction version field is intentionally omitted.",
      mode === "webhook"
        ? "X-Webhook-Secret carries the configured secret verbatim; compare it in constant time."
        : undefined,
    ].filter(Boolean),
  };
}
