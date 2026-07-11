import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import {
  inlineImagesIntoContent,
  uploadOutOfLineFiles,
  SUPPORTED_IMAGE_EXTS,
  type InlineAttachment,
  type OutOfLineFile,
} from "../attachments.js";

/** Strip undefined keys so the API call body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Shared Zod shape for the inline-image attachments param on the write tools. */
const attachmentsShape = z
  .array(
    z.object({
      path: z.string().describe("Path to an image file on the machine running the MCP (this dev box). The shim reads and base64-encodes it — never pass base64 yourself."),
      name: z.string().optional().describe("Placeholder key / display hint; defaults to the file's basename."),
      placeholder: z
        .string()
        .optional()
        .describe("Token in `content` to replace with this image (controls position). Defaults to {{attach:<name>}}; if absent from the body, the image is appended at the end."),
    }),
  )
  .optional()
  .describe(
    "Inline images to embed in the body. Pass local file PATHS; the shim reads each file and embeds it as a data-URI which the server stores as a cid: attachment. " +
      "Supported: " + SUPPORTED_IMAGE_EXTS.join(", ") + ". For downloadable (non-inline) file attachments of any type, use `files` instead.",
  );

/** Shared Zod shape for out-of-line (downloadable) file attachments. */
const filesShape = z
  .array(
    z.object({
      path: z.string().describe("Path to a file on the machine running the MCP (this dev box). The shim uploads it — never pass base64 yourself."),
      name: z.string().optional().describe("Attachment display name; defaults to the file's basename."),
    }),
  )
  .optional()
  .describe(
    "Files to attach as downloadable (out-of-line) attachments — ANY file type (pdf, csv, zip, logs, images-as-downloads, …), up to 25 MB each. " +
      "The shim uploads each file and references it on the response; it is stored as a normal attachment, NOT embedded in the body. " +
      "For images embedded inline in the body, use `attachments` instead.",
  );

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
        attachments: attachmentsShape,
        files: filesShape,
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

      // Inline images: embed the local files as data-URIs in the body. The
      // server (create_ticket → TicketActionService) converts them to cid:
      // attachments, exactly like respond_to_ticket.
      if (Array.isArray(a.attachments) && a.attachments.length) {
        data.content = inlineImagesIntoContent(
          String((a.content as string | undefined) ?? data.content ?? ""),
          a.attachments as InlineAttachment[],
        );
      }

      // Out-of-line files: upload each and reference by sha256 in the top-level
      // `attachments` field (create_ticket stores them non-inline on the first
      // response). Distinct from inline images, which are embedded in the body.
      if (Array.isArray(a.files) && a.files.length) {
        body.attachments = await uploadOutOfLineFiles(a.files as OutOfLineFile[]);
      }

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
        "You can change ticket attributes in the same call: status ('open' | 'on-hold' | " +
        "'closed'), on_hold_until (YYYY-MM-DD, required with 'on-hold'), assigned_to_email " +
        "(email or 'Unassigned'), priority (Low|Normal|High|Urgent or 10|20|30|40), resolved " +
        "(resolution-category id or name), and add_participants / remove_participants. " +
        "Omitting status auto-reopens a non-open ticket on post. content may be omitted ONLY " +
        "when supplying a status/attribute change; otherwise content is required. " +
        "To include inline images, pass `attachments` as local file paths and (optionally) " +
        "place {{attach:<name>}} tokens in `content` where each image should appear. " +
        "To attach downloadable files of any type, pass `files` as local file paths. " +
        "Identify the ticket by ticket_number OR ticket_id (internal DB id) — supply exactly one. " +
        "To close a ticket, prefer close_ticket; to edit an existing response, use edit_response.",
      inputSchema: {
        ticket_number: z
          .string()
          .optional()
          .describe("Ticket.number (the 6-digit human reference); supply this OR ticket_id"),
        ticket_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Ticket.id (internal DB id); supply this OR ticket_number"),
        from_email: z.string().email().describe("Author email; added as a participant if new"),
        content: z
          .string()
          .optional()
          .describe("Response body (HTML). Optional only when a status/attribute change is supplied."),
        is_internal: z.boolean().optional(),
        status: z
          .enum(["open", "on-hold", "closed"])
          .optional()
          .describe("Set the ticket status. 'on-hold' requires on_hold_until; 'open'/'closed' clear any hold."),
        on_hold_until: z
          .string()
          .optional()
          .describe("Date (YYYY-MM-DD) to hold until; required when status='on-hold'."),
        assigned_to_email: z
          .string()
          .optional()
          .describe("Reassign the ticket to this staff email, or 'Unassigned' to clear."),
        priority: z
          .string()
          .optional()
          .describe("Set priority: Low|Normal|High|Urgent (or 10|20|30|40)."),
        resolved: z
          .string()
          .optional()
          .describe("Resolution category (id or name); requires the resolution-tracking plan."),
        add_participants: z
          .array(z.string().email())
          .optional()
          .describe("Emails to add as participants."),
        remove_participants: z
          .array(z.string().email())
          .optional()
          .describe("Emails to remove as participants (the originator can't be removed)."),
        attachments: attachmentsShape,
        files: filesShape,
      },
    },
    async (args) => {
      const { attachments, files, ...rest } = args as Record<string, unknown>;
      const body: Record<string, unknown> = { ...rest };
      if (Array.isArray(attachments) && attachments.length) {
        body.content = inlineImagesIntoContent(
          String(rest.content ?? ""),
          attachments as InlineAttachment[],
        );
      }
      // Out-of-line files: upload each and reference by sha256 (stored non-inline).
      if (Array.isArray(files) && files.length) {
        body.attachments = await uploadOutOfLineFiles(files as OutOfLineFile[]);
      }
      return toToolResult(await callV1("tickets/respond", body, { idempotent: true }));
    },
  );

  server.registerTool(
    "close_ticket",
    {
      title: "Close (and optionally resolve) a ticket",
      description:
        "Close a ticket. Optionally pass content to post a final reply as it closes, and " +
        "resolved (resolution-category id or name) to record the resolution. from_email is " +
        "optional — defaults to the token owner. Identify the ticket by ticket_number OR " +
        "ticket_id. Requires tickets:write.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        from_email: z.string().email().optional().describe("Author email; defaults to the token owner"),
        content: z.string().optional().describe("Optional closing reply body (HTML)"),
        is_internal: z.boolean().optional().describe("Post the closing note as staff-only (default public if content given)"),
        resolved: z.string().optional().describe("Resolution category id or name (resolution-tracking plan)"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/close", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "edit_response",
    {
      title: "Edit a response in place (no notification)",
      description:
        "Rewrite an existing staff response's body. Sends NO notification — the correct way " +
        "to silently fix content already on a ticket (e.g. swap a stale link) without emailing " +
        "the customer. Staff responses only; customer and audit-only responses can't be edited. " +
        "Get the response_id from get_ticket / list_responses. Requires tickets:write.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id to rewrite"),
        content: z.string().describe("New response body (HTML). Inline data: images are extracted to attachments."),
      },
    },
    async ({ response_id, content }) =>
      toToolResult(await callV1("tickets/response-update", { response_id, content }, { idempotent: true })),
  );

  server.registerTool(
    "delete_response",
    {
      title: "Delete a response",
      description:
        "Soft-delete a response by id. Get the response_id from get_ticket / list_responses. " +
        "Requires tickets:write.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id to delete"),
      },
    },
    async ({ response_id }) =>
      toToolResult(await callV1("tickets/response-delete", { response_id }, { idempotent: true })),
  );

  server.registerTool(
    "add_participants",
    {
      title: "Add ticket participants",
      description:
        "Add one or more participants to a ticket (records a body-less audit entry). " +
        "from_email is optional (defaults to the token owner). Identify the ticket by " +
        "ticket_number OR ticket_id. Requires tickets:write.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        participants: z.array(z.string().email()).min(1).describe("Emails to add"),
        from_email: z.string().email().optional().describe("Author email; defaults to the token owner"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/participants/add", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "remove_participants",
    {
      title: "Remove ticket participants",
      description:
        "Remove one or more participants from a ticket (records a body-less audit entry). " +
        "The ticket originator can't be removed. from_email is optional (defaults to the token " +
        "owner). Identify the ticket by ticket_number OR ticket_id. Requires tickets:write.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        participants: z.array(z.string().email()).min(1).describe("Emails to remove"),
        from_email: z.string().email().optional().describe("Author email; defaults to the token owner"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/participants/remove", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
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
