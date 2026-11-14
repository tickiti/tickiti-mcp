#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertConfig, instanceList, withInstance } from "./client.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerTicketReadTools } from "./tools/ticket-reads.js";
import { registerReadTools } from "./tools/reads.js";
import { registerSettingsWriteTools } from "./tools/settings-writes.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerAxialSkillTools, registerAxialSuggestionTools } from "./tools/axial-skills.js";
import { registerAxialChatTools } from "./tools/axial-chat.js";
import { registerTicketOperationTools } from "./tools/ticket-operations.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerReplyAttachmentTools } from "./tools/reply-attachments.js";
import { registerTicketPlanningTools } from "./tools/ticket-planning.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerAxialPanelTools } from "./tools/axial-panel.js";
import { registerAccountTools } from "./tools/account.js";

export const VERSION = "0.3.0";

/** Keys that are a body under another name; the refusal says the body is `content`. */
const BODY_ALIASES = new Set(["html", "body", "message", "text"]);

/**
 * Every tool's input, made strict at one point so no tool can miss it:
 *
 *  - An unknown argument is refused with an error naming it and the arguments the tool
 *    takes. The SDK builds a tool's schema as a zod object that strips unknown keys and
 *    hands the handler what is left, so `respond_to_ticket {html: ...}` reached Tickiti
 *    with no body and posted an empty audit row (#365176 response 77905), and
 *    `tickiti_call {params: {...}}` sent nothing at all. Tickiti's own 422 for html and
 *    its ignored_params never saw those keys. Free-form fields (payload, data, filters,
 *    search_object) stay free-form; it is the tool's own argument names that are checked.
 *  - Every tool takes an optional `instance`, one of the configured names, and its calls
 *    go to that instance. A server with one instance takes it too, but only that instance's
 *    name: a call naming it is accepted, and one naming any other is refused before anything
 *    is sent.
 */
function strictRegistration(server: McpServer): void {
  const names = instanceList().map((i) => i.name);
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: { inputSchema?: z.ZodRawShape } & Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) => {
    const shape: z.ZodRawShape = { ...(config.inputSchema ?? {}) };
    shape.instance = z
      .enum(names as [string, ...string[]])
      .optional()
      .describe(
        names.length > 1
          ? `Tickiti instance to call (default: ${names[0]}). See list_instances.`
          : `Tickiti instance to call: only ${names[0]} is configured. See list_instances.`,
      );
    const accepted = Object.keys(shape);
    const inputSchema = z
      .object(shape, {
        errorMap: (issue, ctx) => {
          if (issue.code !== z.ZodIssueCode.unrecognized_keys) return { message: ctx.defaultError };
          const keys = issue.keys.map((k) => `'${k}'`).join(", ");
          const alias =
            issue.keys.some((k) => BODY_ALIASES.has(k)) && accepted.includes("content")
              ? " The body is `content` (or content_path)."
              : "";
          return {
            message:
              `Unknown argument${issue.keys.length > 1 ? "s" : ""} ${keys}: nothing was sent.${alias} ` +
              `${name} takes: ${accepted.length ? accepted.join(", ") : "no arguments"}.`,
          };
        },
      })
      .strict();
    return register(name, { ...config, inputSchema }, async (args: Record<string, unknown>, extra: unknown) => {
      const { instance, ...rest } = args ?? {};
      return withInstance(instance as string | undefined, () => handler(rest, extra));
    });
  };
}

/**
 * tickiti-mcp — a thin MCP shim over the Tickiti Public API v1.
 *
 *  - tickets family: rich, verified schemas (create/respond/query)
 *  - settings/workflow/reports: named read tools for discoverability
 *  - list_endpoints + tickiti_call: manifest-driven completeness over every v1
 *    endpoint (src/generated/manifest.ts), with each one's body fields read from
 *    Tickiti's own validation rules (src/generated/body-fields.ts), so the long
 *    tail (and all writes) is reachable without hand-kept field schemas.
 *
 * The token's Sanctum abilities are the security boundary throughout.
 */
async function main(): Promise<void> {
  assertConfig();

  const server = new McpServer({
    name: "tickiti-mcp",
    version: VERSION,
  });

  strictRegistration(server);

  registerTicketTools(server);
  registerTicketReadTools(server);
  registerTicketOperationTools(server);
  registerTicketPlanningTools(server);
  registerReadTools(server);
  registerSettingsWriteTools(server);
  registerWorkflowTools(server);
  registerAccountTools(server);
  registerAdminTools(server);
  registerAxialSkillTools(server);
  registerAxialSuggestionTools(server);
  registerAxialChatTools(server);
  registerAxialPanelTools(server);
  registerReplyAttachmentTools(server);
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
