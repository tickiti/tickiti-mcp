import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult, toAttachmentResult } from "../result.js";

/**
 * Tickets family — read side. Backs onto the tickets:read endpoints added to
 * the Public API v1:
 *   POST /api/v1/tickets/show        (tickets:read) — get_ticket
 *   POST /api/v1/tickets/responses   (tickets:read) — list_responses
 *   POST /api/v1/tickets/attachment  (tickets:read) — get_attachment
 *
 * These complement query_tickets (which only lists summary rows): they read a
 * ticket's full thread (public + internal staff notes) and download attachment
 * bytes, so an assistant can read-then-respond without leaving the sanctioned
 * API channel.
 */
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
}
