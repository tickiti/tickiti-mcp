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
  server.registerTool(
    "list_perspectives",
    {
      title: "List perspectives (saved views)",
      description:
        "scope 'mine' (default): the perspectives on the token owner's own index page - empty for an " +
        "account that never opened the UI, which does NOT mean there are none. scope 'all': every " +
        "perspective the owner may see, built-ins included, with conditions and sort orders. Requires settings:read.",
      inputSchema: { scope: z.enum(["mine", "all"]).optional() },
    },
    async ({ scope }) => toToolResult(await callV1("settings/perspectives", scope ? { scope } : {})),
  );
  simpleRead(server, "list_watchlists", "List watchlists", "settings/watchlists");
  server.registerTool(
    "list_stock_responses",
    {
      title: "List stock (canned) responses",
      description:
        "List stock responses (id, title, category, keywords, use count). search filters by title, keywords, " +
        "subject or body; include_content adds each body, is_enabled and ai_relevance. Requires settings:read.",
      inputSchema: {
        search: z.string().optional(),
        include_content: z.boolean().optional(),
      },
    },
    async (args) =>
      toToolResult(
        await callV1(
          "settings/stock-responses",
          Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined)),
        ),
      ),
  );

  // ---- queues ----
  // Uses the tickets-family endpoint (tickets:read) so a ticket-scoped token can
  // enumerate queue names it needs for create_ticket / routing. Queue admin
  // (create/rename/delete) stays under the admin-gated workflow family, reachable
  // via tickiti_call('workflow/queues', …) with a workflow token.
  simpleRead(server, "list_queues", "List ticket queues", "tickets/queues");

  // ---- teams ----
  // Same tickets-family reasoning: a ticket-scoped token needs the team keys that
  // respond_to_ticket's assigned_to_email and query_tickets' "assigned" mode take.
  // Team admin (create/rename/delete) is administration/teams via tickiti_call.
  simpleRead(
    server,
    "list_teams",
    "List teams: each team's name and members, its key 'team:<id>' (assign a ticket to the team, " +
      "or filter on the team's own tickets) and members_key 'team-and-members:<id>' (filter only: " +
      "the team's tickets plus those assigned to any member personally)",
    "tickets/teams",
  );

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
