import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EACH_DOCS_MCP_URL } from "../config.js";

type DocsConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

let connectionPromise: Promise<DocsConnection> | undefined;

async function createConnection(): Promise<DocsConnection> {
  const client = new Client({
    name: "eachlabs-docs-proxy",
    version: "0.4.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(EACH_DOCS_MCP_URL),
  );
  await client.connect(transport);
  return { client, transport };
}

async function connection(): Promise<DocsConnection> {
  connectionPromise ??= createConnection().catch((error) => {
    connectionPromise = undefined;
    throw error;
  });
  return connectionPromise;
}

async function resetConnection(): Promise<void> {
  const current = connectionPromise;
  connectionPromise = undefined;
  if (!current) return;
  const resolved = await current.catch(() => undefined);
  await resolved?.client.close().catch(() => undefined);
}

export async function callOfficialDocsTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await (await connection()).client.callTool({
      name,
      arguments: args,
    });
  } catch {
    // Official documentation calls are read-only; reconnecting once is safe.
    await resetConnection();
    return (await connection()).client.callTool({ name, arguments: args });
  }
}
