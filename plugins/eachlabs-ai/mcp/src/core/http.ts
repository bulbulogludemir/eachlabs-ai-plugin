import {
  DEFAULT_TIMEOUT_MS,
  EACH_API_BASE_URL,
  EACH_API_KEY,
} from "../config.js";

export class EachlabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
    readonly ambiguousWrite = false,
  ) {
    super(message);
  }
}

export type AuthMode = "bearer" | "x-api-key";

export type EachRequestOptions = Omit<RequestInit, "signal"> & {
  baseUrl?: string;
  auth?: boolean;
  authMode?: AuthMode;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
};

export function requireApiKey(): string {
  if (!EACH_API_KEY) {
    throw new EachlabsError(
      "Missing API key. Set EACH_API_KEY or EACHLABS_API_KEY before starting the MCP server.",
    );
  }
  return EACH_API_KEY;
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function appendQuery(
  path: string,
  params: Record<string, unknown>,
): string {
  const url = new URL(path, "https://placeholder.local");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
  random = Math.random,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 10_000);
    }

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, Math.min(dateMs - Date.now(), 10_000));
    }
  }

  const base = Math.min(2 ** attempt * 1000, 10_000);
  return Math.min(Math.round(base * (0.75 + random() * 0.5)), 10_000);
}

export function isRetrySafeMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function applyAuthHeaders(
  headers: Headers,
  apiKey: string,
  authMode: AuthMode,
): Headers {
  if (authMode === "x-api-key") {
    headers.set("X-API-Key", apiKey);
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted."));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return "";
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}

export async function eachRequest<T>(
  path: string,
  options: EachRequestOptions = {},
): Promise<T> {
  const {
    baseUrl = EACH_API_BASE_URL,
    auth = true,
    authMode = "bearer",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    signal,
    ...requestInit
  } = options;
  const url = new URL(joinUrl(baseUrl, path));
  const headers = new Headers(requestInit.headers);

  if (auth) {
    applyAuthHeaders(headers, requireApiKey(), authMode);
  }
  if (requestInit.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (requestInit.method ?? "GET").toUpperCase();
  const retrySafe = isRetrySafeMethod(method);
  const maxAttempts = retries + 1;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...requestInit,
        headers,
        signal: requestSignal(timeoutMs, signal),
      });
    } catch (error) {
      if (!retrySafe || attempt >= maxAttempts || signal?.aborted) {
        const ambiguousWrite = !retrySafe;
        throw new EachlabsError(
          ambiguousWrite
            ? `Request to ${url.pathname} failed after dispatch. The write result is unknown; it was not retried automatically. Check execution history before retrying manually.`
            : `Request to ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          undefined,
          ambiguousWrite,
        );
      }
      await abortableSleep(retryDelayMs(attempt, null), signal);
      continue;
    }

    const payload = await readPayload(response);

    if (!response.ok) {
      // A 429 response is documented as rate-limit rejection, so it is safe
      // to retry any method. Ambiguous network failures and 5xx writes are not.
      const retryable =
        response.status === 429 ||
        (response.status >= 500 && retrySafe);
      if (retryable && attempt < maxAttempts) {
        await abortableSleep(
          retryDelayMs(attempt, response.headers.get("retry-after")),
          signal,
        );
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
