#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertConfig, hasMultipleInstances, instanceList, withInstance } from "./client.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerTicketReadTools } from "./tools/ticket-reads.js";
import { registerReadTools } from "./tools/reads.js";
import { registerSettingsWriteTools } from "./tools/settings-writes.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerAxialSkillTools } from "./tools/axial-skills.js";
import { registerTicketOperationTools } from "./tools/ticket-operations.js";
import { registerAdminTools } from "./tools/admin.js";

export const VERSION = "0.2.0";

/**
 * With more than one instance configured, give every tool an optional `instance`
 * argument and run its calls against that instance. Done once here rather than in
 * each tool, so no tool can miss it.
 */
function addInstanceArgument(server: McpServer): void {
  if (!hasMultipleInstances()) return;
  const names = instanceList().map((i) => i.name);
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: { inputSchema?: Record<string, unknown> } & Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) =>
    register(
      name,
      {
        ...config,
        inputSchema: {
          ...(config.inputSchema ?? {}),
          instance: z
            .enum(names as [string, ...string[]])
            .optional()
            .describe(`Tickiti instance to call (default: ${names[0]}). See list_instances.`),
        },
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const { instance, ...rest } = args ?? {};
        return withInstance(instance as string | undefined, () => handler(rest, extra));
      },
    );
}

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
    version: VERSION,
  });

  addInstanceArgument(server);

  registerTicketTools(server);
  registerTicketReadTools(server);
  registerTicketOperationTools(server);
  registerReadTools(server);
  registerSettingsWriteTools(server);
  registerAdminTools(server);
  registerAxialSkillTools(server);
  registerGenericTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio servers must not write to stdout (it's the JSON-RPC channel).
  console.error(
    `tickiti-mcp ${VERSION} ready (stdio) — instances: ${instanceList().map((i) => i.name).join(", ")}.`,
  );
}

main().catch((err) => {
  console.error("tickiti-mcp failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});

// Belt-and-braces: no single tool handler should be able to take the whole stdio
// server down. Log (never to stdout — that's the JSON-RPC channel) and keep
// serving; individual tools still return proper MCP errors on their own path.
process.on("unhandledRejection", (reason) => {
  console.error("tickiti-mcp unhandledRejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
process.on("uncaughtException", (err) => {
  console.error("tickiti-mcp uncaughtException:", err instanceof Error ? (err.stack ?? err.message) : err);
});
