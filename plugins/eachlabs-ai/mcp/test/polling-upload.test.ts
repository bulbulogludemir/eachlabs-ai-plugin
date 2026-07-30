import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pollUntilDone } from "../src/core/polling.ts";
import { inferContentType } from "../src/core/upload.ts";

test("polling accepts both documented prediction failure terminal states", async () => {
  for (const status of ["failed", "error"]) {
    const result = await pollUntilDone(
      async () => ({ status }),
      ["success", "failed", "error", "cancelled"],
      1,
      0.01,
    );
    assert.equal(result.completed, true);
    assert.equal(result.last?.status, status);
  }
});

test("polling returns a distinct client-cancelled result", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await pollUntilDone(
    async () => ({ status: "processing" }),
    ["success"],
    1,
    0.01,
    { signal: controller.signal },
  );
  assert.deepEqual(result, {
    completed: false,
    cancelled: true,
    last: undefined,
  });
});

test("upload MIME detection prefers signatures, then extensions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eachlabs-upload-test-"));
  try {
    const disguisedPng = path.join(directory, "image.bin");
    await writeFile(
      disguisedPng,
      Buffer.from("89504e470d0a1a0a0000000000000000", "hex"),
    );
    assert.equal(await inferContentType(disguisedPng), "image/png");

    const audio = path.join(directory, "voice.mp3");
    await writeFile(audio, Buffer.from([0x49, 0x44, 0x33]));
    assert.equal(await inferContentType(audio), "audio/mpeg");
    assert.equal(
      await inferContentType(audio, "audio/custom"),
      "audio/custom",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
