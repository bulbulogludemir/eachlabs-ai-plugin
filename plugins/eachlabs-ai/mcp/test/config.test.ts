import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const configUrl = new URL("../src/config.ts", import.meta.url).href;

// Load each configuration in its own process: ESM caches environment-derived exports.
function readApiKey(primary: string, alias: string): string {
  return execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import { EACH_API_KEY } from ${JSON.stringify(configUrl)}; process.stdout.write(JSON.stringify(EACH_API_KEY ?? null));`,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, EACH_API_KEY: primary, EACHLABS_API_KEY: alias },
  });
}

test("blank optional plugin key falls back to the environment alias", () => {
  assert.equal(readApiKey("", "test-alias"), '"test-alias"');
  assert.equal(readApiKey("  ", "test-alias"), '"test-alias"');
});

test("configured primary key takes precedence and surrounding whitespace is ignored", () => {
  assert.equal(readApiKey(" test-primary \n", "test-alias"), '"test-primary"');
});

test("blank keys keep the server in unauthenticated mode", () => {
  assert.equal(readApiKey("", "  "), "null");
});
