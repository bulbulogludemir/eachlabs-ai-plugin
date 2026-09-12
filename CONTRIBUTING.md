# Contributing

Bug fixes, documentation corrections, and reproducible compatibility reports are welcome. For larger changes, open an issue first to discuss scope.

## Local checks

Use Node.js 20 or newer. From the repository root:

```bash
cd plugins/eachlabs-ai/mcp
npm ci
npm run check
npm run check:test
npm test
npm run build
npm run check:versions
node scripts/smoke-local.mjs
```

These checks use local fixtures and do not require an each::labs API key or paid generations. The separate `npm run smoke` command calls public upstream endpoints.

The plugin ships `mcp/dist/index.js` so users can install it without building. Include the rebuilt bundle when changing runtime code or its dependencies. Keep the package, lockfile, server, plugin manifests, and Claude marketplace versions aligned when preparing a release.

## Reporting a bug

Use [GitHub Issues](https://github.com/bulbulogludemir/eachlabs-ai-plugin/issues). Include your client and plugin versions, Node.js version, operating system, reproduction steps, and expected versus actual behavior. Use synthetic inputs and redact credentials, signed URLs, prompts, and customer data.

Add a focused regression test for behavior fixes. Keep unrelated changes out of the same pull request. Never include API keys or real user payloads in fixtures, logs, screenshots, or commits.
