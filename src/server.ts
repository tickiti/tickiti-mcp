#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertConfig } from "./client.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerReadTools } from "./tools/reads.js";
import { registerGenericTools } from "./tools/generic.js";

/**
 * tickiti-mcp — a thin MCP shim over the Tickiti Public API v1.
 *
 *  - tickets family: rich, verified schemas (create/respond/query)
 *  - settings/workflow/reports: named read tools for discoverability
 *  - list_endpoints + tickiti_call: manifest-driven completeness over all 104
 *    v1 endpoints, so the long tail (and all writes) is reachable without
 *    shipping guessed field schemas.
 *
 * The token's Sanctum abilities are the security boundary throughout.
 */
async function main(): Promise<void> {
  assertConfig();

  const server = new McpServer({
    name: "tickiti-mcp",
    version: "0.1.0",
  });

  registerTicketTools(server);
  registerReadTools(server);
  registerGenericTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio servers must not write to stdout (it's the JSON-RPC channel).
  console.error("tickiti-mcp ready (stdio) — tickets + reads + generic registered.");
}

main().catch((err) => {
  console.error("tickiti-mcp failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
