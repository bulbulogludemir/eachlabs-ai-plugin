import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginRoot = path.dirname(mcpRoot);
const repositoryRoot = path.dirname(path.dirname(pluginRoot));

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const packageVersion = readJson(path.join(mcpRoot, "package.json")).version;
const baseVersion = (version) =>
  typeof version === "string" ? version.split("+")[0] : version;
const versions = new Map([
  ["mcp/package.json", packageVersion],
  [
    ".codex-plugin/plugin.json",
    readJson(path.join(pluginRoot, ".codex-plugin/plugin.json")).version,
  ],
  [
    ".claude-plugin/plugin.json",
    readJson(path.join(pluginRoot, ".claude-plugin/plugin.json")).version,
  ],
]);

const marketplace = readJson(
  path.join(repositoryRoot, ".claude-plugin/marketplace.json"),
);
versions.set(".claude-plugin/marketplace.json", marketplace.version);
versions.set(
  ".claude-plugin/marketplace.json plugin entry",
  marketplace.plugins?.find((plugin) => plugin.name === "eachlabs-ai")?.version,
);

const configSource = fs.readFileSync(
  path.join(mcpRoot, "src/config.ts"),
  "utf8",
);
versions.set(
  "src/config.ts SERVER_VERSION",
  configSource.match(/SERVER_VERSION\s*=\s*"([^"]+)"/)?.[1],
);

const distPath = path.join(mcpRoot, "dist/index.js");
if (fs.existsSync(distPath)) {
  const distSource = fs.readFileSync(distPath, "utf8");
  versions.set(
    "dist/index.js SERVER_VERSION",
    distSource.match(/SERVER_VERSION\s*=\s*"([^"]+)"/)?.[1],
  );
}

const mismatches = [...versions].filter(
  ([, version]) => baseVersion(version) !== baseVersion(packageVersion),
);
if (mismatches.length > 0) {
  console.error(
    `Expected every package surface to use base version ${baseVersion(packageVersion)}:`,
  );
  for (const [surface, version] of mismatches) {
    console.error(`- ${surface}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(
  `VERSION_SYNC_OK (${baseVersion(packageVersion)} base; ${versions.size} package surfaces)`,
);
