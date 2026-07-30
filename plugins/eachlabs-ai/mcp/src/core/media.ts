import {
  MAX_EMBED_IMAGE_BYTES,
  MAX_EMBED_TOTAL_BYTES,
  MAX_MEDIA_BLOCKS,
  MEDIA_DOWNLOAD_CONCURRENCY,
} from "../config.js";
import { safeMediaFetch } from "./security.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
    };

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

function isMediaHintKey(key: string): boolean {
  return /(^|_)(output|result|media|image|video|audio|file|url|urls)($|_)/i.test(
    key,
  );
}

function looksLikeSignedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return [...url.searchParams.keys()].some((key) =>
      /^(sig|signature|token|expires|x-amz-signature|x-goog-signature)$/i.test(
        key,
      ),
    );
  } catch {
    return false;
  }
}

export function collectMediaUrls(
  value: unknown,
  found: string[] = [],
  contextKey = "",
): string[] {
  if (typeof value === "string") {
    const extension = urlExtension(value);
    const extensionless = extension === "";
    if (
      value.startsWith("https://") &&
      (MEDIA_MIME_BY_EXTENSION[extension] ||
        (extensionless && (isMediaHintKey(contextKey) || looksLikeSignedUrl(value))))
    ) {
      found.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, found, contextKey);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectMediaUrls(item, found, key);
    }
  }
  return found;
}

async function responseBufferWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function resourceLink(url: string, detectedMime?: string): ContentBlock {
  const extension = urlExtension(url);
  return {
    type: "resource_link",
    uri: url,
    name: decodeURIComponent(url.split("/").pop() ?? url).split("?")[0],
    mimeType: detectedMime ?? MEDIA_MIME_BY_EXTENSION[extension],
  };
}

export async function mediaContentBlocks(
  output: unknown,
  embedImages: boolean,
): Promise<ContentBlock[]> {
  const urls = [...new Set(collectMediaUrls(output))].slice(0, MAX_MEDIA_BLOCKS);
  const results: ContentBlock[] = new Array(urls.length);
  let next = 0;
  let embeddedBytes = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index];
      const extension = urlExtension(url);
      const imageMime = IMAGE_MIME_BY_EXTENSION[extension];

      if (embedImages && (imageMime || extension === "")) {
        try {
          const response = await safeMediaFetch(url, {
            signal: AbortSignal.timeout(15_000),
          });
          const responseMime = (response.headers.get("content-type") ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();
          const resolvedImageMime = responseMime.startsWith("image/")
            ? responseMime
            : imageMime;
          if (!resolvedImageMime) {
            await response.body?.cancel().catch(() => undefined);
            results[index] = resourceLink(url, responseMime || undefined);
            continue;
          }
          const declaredLength = Number(response.headers.get("content-length"));
          const remainingBudget = Math.max(
            0,
            MAX_EMBED_TOTAL_BYTES - embeddedBytes,
          );
          const perImageBudget = Math.min(MAX_EMBED_IMAGE_BYTES, remainingBudget);
          if (
            response.ok &&
            perImageBudget > 0 &&
            (!Number.isFinite(declaredLength) || declaredLength <= perImageBudget)
          ) {
            const buffer = await responseBufferWithLimit(response, perImageBudget);
            if (buffer) {
              embeddedBytes += buffer.byteLength;
              results[index] = {
                type: "image",
                data: buffer.toString("base64"),
                mimeType: resolvedImageMime,
              };
              continue;
            }
          }
        } catch {
          // Fall through to a resource link.
        }
      }

      results[index] = resourceLink(url);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MEDIA_DOWNLOAD_CONCURRENCY, urls.length) },
      worker,
    ),
  );
  return results.filter(Boolean);
}
