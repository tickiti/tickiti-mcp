import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * Tickets family — the agent-valuable core, and the family that exercises both
 * bearer auth and idempotency. Backs onto:
 *   POST /api/v1/tickets          (tickets:write)  — create_ticket
 *   POST /api/v1/tickets/respond  (tickets:write)  — respond_to_ticket
 *   POST /api/v1/tickets/query    (tickets:read)   — query_tickets
 *
 * Field names and the "exactly one of" rule mirror ApiController::create_ticket
 * / ::ticket_respond validation. The Idempotency-Key header for the two writes
 * is minted inside callV1 ({ idempotent: true }) — the model never sees it.
 */
export function registerTicketTools(server: McpServer): void {
  server.registerTool(
    "create_ticket",
    {
      title: "Create ticket",
      description:
        "Create a support ticket. Provide originator_email_address and EXACTLY ONE of: " +
        "subject+content, OR template_identifier+data, OR intervention+data+uid. " +
        "Omit queue_name to use the Inbox; queue_name is not allowed with intervention.",
      inputSchema: {
        originator_email_address: z.string().email(),
        subject: z.string().optional().describe("Pair with content (subject+content path)"),
        content: z.string().optional().describe("HTML body; pair with subject"),
        template_identifier: z.string().optional().describe("Template.identifier; pair with data"),
        intervention: z.string().optional().describe("Intervention.name; pair with data and uid"),
        uid: z.string().optional().describe("Required only when intervention is set"),
        data: z
          .record(z.any())
          .optional()
          .describe("Token values for template/intervention paths"),
        queue_name: z.string().optional().describe("TicketQueue.name; omit for Inbox"),
        is_public: z.boolean().optional(),
        use_passed_originator_as_responder: z.boolean().optional(),
      },
    },
    async (args) => {
      // The controller reads subject/content from data.subject / data.content
      // (ApiController::create_ticket validation), and resolves the queue from a
      // top-level queue_name while validating data.queue_name. Assemble the body
      // accordingly so the ergonomic flat inputs land where it expects them.
      const a = args as Record<string, unknown>;
      const body: Record<string, unknown> = {
        originator_email_address: a.originator_email_address,
      };
      if (a.is_public !== undefined) body.is_public = a.is_public;
      if (a.use_passed_originator_as_responder !== undefined) {
        body.use_passed_originator_as_responder = a.use_passed_originator_as_responder;
      }

      const data: Record<string, unknown> = { ...((a.data as Record<string, unknown>) ?? {}) };
      if (a.subject !== undefined) data.subject = a.subject;
      if (a.content !== undefined) data.content = a.content;

      if (a.template_identifier !== undefined) body.template_identifier = a.template_identifier;
      if (a.intervention !== undefined) body.intervention = a.intervention;
      if (a.uid !== undefined) body.uid = a.uid;

      if (a.queue_name !== undefined) {
        body.queue_name = a.queue_name; // used for resolution
        data.queue_name = a.queue_name; // validated for existence
      }

      if (Object.keys(data).length) body.data = data;

      return toToolResult(await callV1("tickets", body, { idempotent: true }));
    },
  );

  server.registerTool(
    "respond_to_ticket",
    {
      title: "Respond to ticket",
      description:
        "Add a response to an existing ticket. Set is_internal=true for a staff-only note. " +
        "To change the ticket's status, pass status: omit it and posting auto-reopens a " +
        "non-open ticket; pass 'on-hold' (with on_hold_until=YYYY-MM-DD) to park it, or " +
        "'open' to reopen/clear a hold. content may be omitted ONLY when supplying a status " +
        "change (a status-only response); otherwise content is required.",
      inputSchema: {
        ticket_number: z.string().describe("Ticket.number (the human ticket reference)"),
        from_email: z.string().email().describe("Author email; added as a participant if new"),
        content: z
          .string()
          .optional()
          .describe("Response body (HTML). Optional only when status is supplied (status-only response)."),
        is_internal: z.boolean().optional(),
        status: z
          .enum(["open", "on-hold"])
          .optional()
          .describe("Set the ticket status. 'on-hold' requires on_hold_until; 'open' clears any hold."),
        on_hold_until: z
          .string()
          .optional()
          .describe("Date (YYYY-MM-DD) to hold until; required when status='on-hold'."),
      },
    },
    async (args) => toToolResult(await callV1("tickets/respond", args, { idempotent: true })),
  );

  server.registerTool(
    "query_tickets",
    {
      title: "Query tickets",
      description:
        "List tickets for a perspective (saved view). Specify perspective_id or " +
        "perspective_name; defaults to the 'All' perspective. Pass a ticket number " +
        "via search_object for a direct lookup.",
      inputSchema: {
        perspective_id: z.number().int().optional(),
        perspective_name: z.string().optional().describe("Resolved server-side via search_object.search_perspective"),
        search_object: z
          .record(z.any())
          .optional()
          .describe(
            "Search payload: { search_perspective?, search_perspective_id?, " +
              "criteria?: [{ mode, tokens: [...] }] }. Same-mode criteria OR together, " +
              "different modes AND. Valid modes: subject, content, subject_content, " +
              "assigned (email), participant, priority, raised (originator email), queue " +
              "(name), status, watchlist (id), hashtag, ticket_number, and the date " +
              "filters created_from / created_to / updated_from / updated_to " +
              "(tokens: ['YYYY-MM-DD'], compared as UTC). get_search_items returns the " +
              "live catalog in `available_modes`.",
          ),
      },
    },
    async (args) => {
      // The controller reads perspective_name out of search_object.search_perspective,
      // so fold the convenience field into the shape it expects.
      const { perspective_name, search_object, ...rest } = args as Record<string, unknown>;
      const body: Record<string, unknown> = { ...rest };
      if (search_object) body.search_object = search_object;
      if (perspective_name) {
        body.search_object = {
          ...(typeof search_object === "object" && search_object ? search_object : {}),
          search_perspective: perspective_name,
        };
      }
      return toToolResult(await callV1("tickets/query", body));
    },
  );
}
