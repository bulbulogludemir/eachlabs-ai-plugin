import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import {
  EACH_API_BASE_URL,
  MAX_AUDIO_RESPONSE_BYTES,
  MAX_AUDIO_UPLOAD_BYTES,
} from "../config.js";
import { EachlabsError, joinUrl, requireApiKey } from "./http.js";
import { inferContentType } from "./upload.js";

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorPayload(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json")
    ? response.json()
    : response.text();
}

async function responseBytesWithLimit(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new EachlabsError(
        `Audio response exceeded the ${limit}-byte MCP inline limit.`,
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function transcribeAudio(
  {
    filePath,
    model,
    language,
    responseFormat,
    timestampGranularities,
  }: {
    filePath: string;
    model: string;
    language?: string;
    responseFormat: "json" | "verbose_json";
    timestampGranularities?: Array<"word" | "segment">;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new EachlabsError("file_path must point to a regular file.");
  if (info.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new EachlabsError(
      `Audio file is ${info.size} bytes; the transcription limit is 25 MB.`,
    );
  }

  const form = new FormData();
  form.append(
    "file",
    await openAsBlob(filePath, { type: await inferContentType(filePath) }),
  );
  form.append("model", model);
  form.append("response_format", responseFormat);
  if (language) form.append("language", language);
  for (const granularity of timestampGranularities ?? []) {
    form.append("timestamp_granularities[]", granularity);
  }

  const response = await fetch(joinUrl(EACH_API_BASE_URL, "/v1/audio/transcriptions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${requireApiKey()}` },
    body: form,
    signal: combinedSignal(300_000, signal),
  });
  if (!response.ok) {
    throw new EachlabsError(
      `Eachlabs API returned HTTP ${response.status} for /v1/audio/transcriptions`,
      response.status,
      await errorPayload(response),
    );
  }
  return response.json();
}

export async function synthesizeSpeech(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  data: string;
  mimeType: string;
  executionId?: string;
  requestId?: string;
}> {
  const response = await fetch(joinUrl(EACH_API_BASE_URL, "/v1/audio/speech"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: combinedSignal(300_000, signal),
  });
  if (!response.ok) {
    throw new EachlabsError(
      `Eachlabs API returned HTTP ${response.status} for /v1/audio/speech`,
      response.status,
      await errorPayload(response),
    );
  }

  const bytes = await responseBytesWithLimit(response, MAX_AUDIO_RESPONSE_BYTES);
  return {
    data: bytes.toString("base64"),
    mimeType: response.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
    executionId: response.headers.get("x-eachlabs-execution-id") ?? undefined,
    requestId: response.headers.get("x-request-id") ?? undefined,
  };
}
