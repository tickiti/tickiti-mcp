import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * Named read convenience tools across the settings / workflow / reports
 * families. These are thin front doors to the corresponding v1 read endpoints —
 * safe to surface because reads take little or no input. Writes for these
 * families go through tickiti_call (the family controllers are pure passthru to
 * the UI controllers, so we don't ship guessed write schemas). The `filters`
 * passthrough lets reports/queries carry their UI payload unchanged.
 */
export function registerReadTools(server: McpServer): void {
  // ---- settings ----
  simpleRead(server, "list_perspectives", "List saved perspectives (views)", "settings/perspectives");
  simpleRead(server, "list_watchlists", "List watchlists", "settings/watchlists");
  simpleRead(server, "list_stock_responses", "List stock (canned) responses", "settings/stock-responses");

  // ---- workflow ----
  simpleRead(server, "list_queues", "List ticket queues", "workflow/queues");

  server.registerTool(
    "list_workflow",
    {
      title: "List workflow configuration",
      description:
        "List a plan-gated workflow collection: resolution-categories, interventions, or escalations. " +
        "Returns 403 if the instance's plan does not include the feature.",
      inputSchema: {
        kind: z.enum(["resolution-categories", "interventions", "escalations"]),
        filters: z.record(z.any()).optional(),
      },
    },
    async ({ kind, filters }) => toToolResult(await callV1(`workflow/${kind}`, filters ?? {})),
  );

  // ---- reports (read-only family) ----
  server.registerTool(
    "run_report",
    {
      title: "Run an analytics report",
      description:
        "Run a Tickiti analytics report (requires the reports plan + admin). " +
        "'meta' returns the filterable queues; the others accept date/queue filters via `filters`.",
      inputSchema: {
        report: z.enum(["meta", "resolutions", "volumes", "response-times", "agent-activity"]),
        filters: z.record(z.any()).optional().describe("e.g. { from, to, queue_id }"),
      },
    },
    async ({ report, filters }) => toToolResult(await callV1(`reports/${report}`, filters ?? {})),
  );
}

/** Register a read tool that POSTs an optional free-form filter payload. */
function simpleRead(server: McpServer, name: string, description: string, path: string): void {
  server.registerTool(
    name,
    {
      title: description,
      description,
      inputSchema: { filters: z.record(z.any()).optional().describe("Optional filter/query payload") },
    },
    async ({ filters }) => toToolResult(await callV1(path, filters ?? {})),
  );
}
