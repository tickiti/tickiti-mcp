import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { callV1 } from "../client.js";
import { toToolResult, toAttachmentResult } from "../result.js";

/**
 * Tickets family — read side. Backs onto the tickets:read endpoints added to
 * the Public API v1:
 *   POST /api/v1/tickets/show              (tickets:read) — get_ticket
 *   POST /api/v1/tickets/responses         (tickets:read) — list_responses
 *   POST /api/v1/tickets/responses/query   (tickets:read) — query_responses / export_responses
 *   POST /api/v1/tickets/attachment        (tickets:read) — get_attachment
 *
 * These complement query_tickets (which only lists summary rows): they read a
 * ticket's full thread (public + internal staff notes), bulk-query responses
 * across tickets by date/queue/flags, and download attachment bytes — so an
 * assistant can read-then-respond without leaving the sanctioned API channel.
 */

/** Shared filter shape for the cross-ticket responses query. */
const responseFilterShape = {
  created_from: z
    .string()
    .optional()
    .describe("Responses created on/after — 'YYYY-MM-DD' (>=00:00:00 UTC) or full 'YYYY-MM-DD HH:MM:SS'"),
  created_to: z
    .string()
    .optional()
    .describe("Responses created on/before — 'YYYY-MM-DD' (<=23:59:59 UTC) or full datetime"),
  is_internal: z.boolean().optional().describe("Tri-state: omit for either"),
  staff_response: z.boolean().optional().describe("Tri-state: omit for either"),
  queue: z.array(z.string()).optional().describe("Restrict by queue name(s)"),
  queue_id: z.array(z.number().int()).optional().describe("Restrict by queue id(s)"),
  ticket_number: z.array(z.string()).optional().describe("Restrict to specific ticket number(s)"),
  include_deleted: z.boolean().optional().describe("Include soft-deleted responses (default false)"),
  fields: z
    .array(z.enum(["html", "plain_text", "attachments"]))
    .optional()
    .describe("Heavy fields to include; omit one to skip it server-side. Default: all."),
};

/** Strip undefined keys so the API call body only carries supplied filters. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerTicketReadTools(server: McpServer): void {
  server.registerTool(
    "get_ticket",
    {
      title: "Get a ticket with its full thread",
      description:
        "Fetch one ticket by number with its header and full response thread " +
        "(public + internal staff notes) plus attachment metadata. Requires tickets:read.",
      inputSchema: {
        ticket_number: z.string().describe("Ticket.number (the human ticket reference)"),
      },
    },
    async ({ ticket_number }) =>
      toToolResult(await callV1("tickets/show", { ticket_number })),
  );

  server.registerTool(
    "list_responses",
    {
      title: "List a ticket's responses",
      description:
        "List the responses on a ticket (bodies, public/internal flag, author and " +
        "attachment metadata). Requires tickets:read.",
      inputSchema: {
        ticket_number: z.string().describe("Ticket.number (the human ticket reference)"),
      },
    },
    async ({ ticket_number }) =>
      toToolResult(await callV1("tickets/responses", { ticket_number })),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Download a response attachment",
      description:
        "Download one response attachment's bytes (returned as an embedded resource). " +
        "The attachment must belong to the given ticket. Requires tickets:read. " +
        "Hard-blocked types are refused; review-gated types need confirm=true.",
      inputSchema: {
        ticket_number: z
          .string()
          .describe("Ticket the attachment belongs to (authorisation scope)"),
        response_attachment_id: z
          .union([z.string(), z.number()])
          .describe("ResponseAttachment.id (from get_ticket / list_responses)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to accept a 'review'-gated attachment type"),
      },
    },
    async ({ ticket_number, response_attachment_id, confirm }) => {
      const body: Record<string, unknown> = { ticket_number, response_attachment_id };
      if (confirm) body.intent = "review_ok";
      return toAttachmentResult(await callV1("tickets/attachment", body));
    },
  );

  server.registerTool(
    "query_responses",
    {
      title: "Query responses across tickets",
      description:
        "Bulk-query responses across every queue-authorised ticket, filtered by " +
        "created_at window / queue / internal+staff flags / specific tickets. " +
        "Keyset-paginated: pass back data.next_cursor to get the next page. The " +
        "cross-ticket counterpart to list_responses (single ticket). Requires " +
        "tickets:read. For a full dump to disk, use export_responses instead.",
      inputSchema: {
        ...responseFilterShape,
        limit: z.number().int().min(1).max(1000).optional().describe("Page size (default 200, max 1000)"),
        cursor: z
          .object({ created_at: z.string(), id: z.number().int() })
          .optional()
          .describe("Keyset cursor from a prior page's data.next_cursor"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/responses/query", compact({ ...args }))),
  );

  server.registerTool(
    "export_responses",
    {
      title: "Export responses to an NDJSON file",
      description:
        "Dump every response matching the filters to a local NDJSON file (one JSON " +
        "object per line), paging through the result server-side. Returns only a " +
        "manifest { path, count, pages } — the bodies are written to disk and never " +
        "pass through the model's context, so this is the right tool for large " +
        "exports. Requires tickets:read. The MCP server runs locally, so 'path' is a " +
        "path on this machine; an existing file is overwritten.",
      inputSchema: {
        path: z.string().describe("Absolute local path for the output .ndjson file (overwritten if present)"),
        ...responseFilterShape,
        page_size: z.number().int().min(1).max(1000).optional().describe("Rows per API page (default 500)"),
        max_records: z.number().int().min(1).optional().describe("Optional safety cap on total rows written"),
      },
    },
    async ({ path, page_size, max_records, ...filters }) => {
      const out = createWriteStream(path, { encoding: "utf8", flags: "w" });
      const finished = new Promise<void>((resolve, reject) => {
        out.on("error", reject);
        out.on("finish", () => resolve());
      });

      let cursor: { created_at: string; id: number } | undefined;
      let count = 0;
      let pages = 0;
      const pageSize = page_size ?? 500;

      try {
        for (;;) {
          const body: Record<string, unknown> = compact({ ...filters });
          body.limit = pageSize;
          if (cursor) body.cursor = cursor;

          const r = await callV1("tickets/responses/query", body);
          if (!r.ok) {
            out.end();
            return toToolResult(r); // surface the API error verbatim
          }

          const data = (r.body as { data?: { responses?: unknown[]; next_cursor?: { created_at: string; id: number } | null } }).data;
          const rows = data?.responses ?? [];
          for (const row of rows) {
            if (max_records && count >= max_records) break;
            out.write(JSON.stringify(row) + "\n");
            count++;
          }
          pages++;

          const next = data?.next_cursor ?? null;
          if (!next || (max_records && count >= max_records)) break;
          cursor = next;
        }
      } finally {
        out.end();
      }
      await finished;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, path, count, pages, format: "ndjson" }, null, 2),
          },
        ],
      };
    },
  );
}
