import {
  EachlabsError,
  abortableSleep,
  joinUrl,
  requireApiKey,
  responseMetadata,
  retryDelayMs,
} from "./http.js";
import type { ToolExtra } from "./polling.js";

const CONNECTION_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SAFE_RAW_EVENT_TYPES = new Set([
  "status",
  "tool_call",
  "message",
  "progress",
  "web_search_query",
  "web_search_citations",
  "complete",
  "execution_started",
  "execution_progress",
  "execution_completed",
]);
const MAX_STREAM_TEXT_CHARS = 1_000_000;
const MAX_EVENTS_PER_BUCKET = 100;

export type NormalizedSenseStream = {
  streamed: true;
  cancelled?: boolean;
  text?: string;
  text_truncated?: boolean;
  generations: unknown[];
  clarification: unknown[];
  workflow: unknown[];
  errors: unknown[];
  raw_safe_events?: unknown[];
  event_count: number;
  connection_attempts: number;
};

export function sseDataFromBlock(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

export function normalizeSenseEvent(
  event: unknown,
  buckets: Pick<
    NormalizedSenseStream,
    "generations" | "clarification" | "workflow" | "errors"
  > & { raw_safe_events?: unknown[] },
): { type: string; textDelta?: string; suppressed: boolean } {
  const record =
    event && typeof event === "object"
      ? (event as Record<string, any>)
      : { value: event };
  const delta = record?.choices?.[0]?.delta;
  const extension =
    record?.eachlabs ?? record?.choices?.[0]?.delta?.eachlabs ?? record;
  const type = String(extension?.type ?? record?.type ?? "");
  const lowered = type.toLowerCase();

  if (lowered.includes("thinking") || lowered.includes("reasoning")) {
    return { type, suppressed: true };
  }

  const push = (target: unknown[], value: unknown) => {
    if (target.length < MAX_EVENTS_PER_BUCKET) target.push(value);
  };
  if (type === "generation_response") {
    push(buckets.generations, extension);
  } else if (type === "clarification_needed") {
    push(buckets.clarification, extension);
  } else if (
    type.startsWith("workflow_") ||
    type.startsWith("execution_")
  ) {
    push(buckets.workflow, extension);
  } else if (type === "error") {
    push(buckets.errors, extension);
  } else if (
    buckets.raw_safe_events &&
    SAFE_RAW_EVENT_TYPES.has(type)
  ) {
    push(buckets.raw_safe_events, extension);
  }

  return {
    type,
    textDelta:
      typeof delta?.content === "string"
        ? delta.content
        : type === "text_response" && typeof extension?.content === "string"
          ? extension.content
          : undefined,
    suppressed: false,
  };
}

async function responsePayload(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json")
    ? response.json()
    : response.text();
}

export async function streamEachSense(
  path: string,
  {
    baseUrl,
    body,
    timeoutSeconds = 900,
    includeRawSafeEvents = false,
    connectionRetries = 2,
    apiKey,
  }: {
    baseUrl: string;
    body: string;
    timeoutSeconds?: number;
    includeRawSafeEvents?: boolean;
    connectionRetries?: number;
    apiKey?: string;
  },
  extra?: ToolExtra,
): Promise<unknown> {
  const url = new URL(joinUrl(baseUrl, path));
  const headers = new Headers({
    Authorization: `Bearer ${apiKey ?? requireApiKey()}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  });
  let response: Response | undefined;
  let activityController: AbortController | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const armTimer = (milliseconds: number, message: string) => {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(
      () => activityController?.abort(new Error(message)),
      milliseconds,
    );
  };

  while (!response) {
    attempts++;
    activityController = new AbortController();
    armTimer(30_000, "Upstream streaming connection timed out.");
    const signal = extra?.signal
      ? AbortSignal.any([extra.signal, activityController.signal])
      : activityController.signal;

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (error) {
      if (activityTimer) clearTimeout(activityTimer);
      throw new EachlabsError(
        `Streaming request to ${url.pathname} failed after dispatch. The result is unknown and the POST was not retried: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        true,
        { attempts, retryable: false },
      );
    }

    if (!response.ok && CONNECTION_RETRY_STATUSES.has(response.status)) {
      const retryable = attempts <= connectionRetries;
      if (!retryable) break;
      const retryAfter = response.headers.get("retry-after");
      await response.body?.cancel().catch(() => undefined);
      if (activityTimer) clearTimeout(activityTimer);
      await abortableSleep(retryDelayMs(attempts, retryAfter), extra?.signal);
      response = undefined;
    }
  }

  if (activityTimer) clearTimeout(activityTimer);
  if (!response) {
    throw new EachlabsError("Streaming request did not return a response.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const retryable = CONNECTION_RETRY_STATUSES.has(response.status);
    throw new EachlabsError(
      `Eachlabs API returned HTTP ${response.status} for ${url.pathname}`,
      response.status,
      await responsePayload(response),
      false,
      responseMetadata(response, attempts, retryable),
    );
  }

  if (!contentType.includes("text/event-stream") || !response.body) {
    return contentType.includes("application/json")
      ? response.json()
      : response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result: NormalizedSenseStream = {
    streamed: true,
    generations: [],
    clarification: [],
    workflow: [],
    errors: [],
    raw_safe_events: includeRawSafeEvents ? [] : undefined,
    event_count: 0,
    connection_attempts: attempts,
  };
  let buffer = "";
  let textOut = "";
  let textTruncated = false;
  const combinedSignal = extra?.signal
    ? AbortSignal.any([extra.signal, activityController!.signal])
    : activityController!.signal;
  const resetIdleTimer = () =>
    armTimer(
      timeoutSeconds * 1000,
      `Upstream stream was idle for ${timeoutSeconds} seconds.`,
    );
  resetIdleTimer();

  const handleData = async (data: string) => {
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    result.event_count++;
    const normalized = normalizeSenseEvent(event, result);
    if (normalized.suppressed) return;
    if (normalized.textDelta) {
      const remaining = MAX_STREAM_TEXT_CHARS - textOut.length;
      if (remaining > 0) {
        textOut += normalized.textDelta.slice(0, remaining);
      }
      if (normalized.textDelta.length > remaining) textTruncated = true;
    }

    const progressToken = extra?._meta?.progressToken;
    if (
      progressToken !== undefined &&
      extra?.sendNotification &&
      normalized.type !== "text_response"
    ) {
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: result.event_count,
            message: normalized.type || "streaming",
          },
        })
        .catch(() => undefined);
    }
  };

  try {
    while (true) {
      if (combinedSignal.aborted) {
        await reader.cancel().catch(() => undefined);
        result.cancelled = Boolean(extra?.signal?.aborted) || undefined;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const data = sseDataFromBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        await handleData(data);
      }
    }
  } catch (error) {
    if (!extra?.signal?.aborted) {
      throw new EachlabsError(
        `Streaming response from ${url.pathname} failed after the stream started and was not retried: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        true,
        { attempts, retryable: false },
      );
    }
  } finally {
    if (activityTimer) clearTimeout(activityTimer);
  }

  buffer += decoder.decode();
  await handleData(sseDataFromBlock(buffer));
  result.text = textOut || undefined;
  result.text_truncated = textTruncated || undefined;
  if (!includeRawSafeEvents) delete result.raw_safe_events;
  return result;
}
