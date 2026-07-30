import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ToolExtra } from "./polling.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return "image/gif";
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export async function inferContentType(
  filePath: string,
  requested?: string,
): Promise<string> {
  if (requested && requested !== "application/octet-stream") return requested;

  const file = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const sniffed = sniffImageMime(bytes.subarray(0, bytesRead));
    if (sniffed) return sniffed;
  } finally {
    await file.close();
  }

  return (
    MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
    requested ??
    "application/octet-stream"
  );
}

export async function uploadFileStream({
  url,
  filePath,
  contentType,
  requiredHeaders,
  size,
  timeoutMs = 120_000,
  extra,
}: {
  url: string;
  filePath: string;
  contentType: string;
  requiredHeaders: Record<string, string>;
  size: number;
  timeoutMs?: number;
  extra?: ToolExtra;
}): Promise<Response> {
  let uploaded = 0;
  let lastReported = 0;
  const progressToken = extra?._meta?.progressToken;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      uploaded += chunk.length;
      if (
        progressToken !== undefined &&
        extra?.sendNotification &&
        (uploaded - lastReported >= 1024 * 1024 || uploaded === size)
      ) {
        lastReported = uploaded;
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: uploaded,
              total: size,
              message: "uploading",
            },
          })
          .catch(() => undefined);
      }
      callback(null, chunk);
    },
  });
  const nodeStream = createReadStream(filePath).pipe(counter);
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = extra?.signal
    ? AbortSignal.any([extra.signal, timeoutSignal])
    : timeoutSignal;

  return fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...requiredHeaders,
    },
    body,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
