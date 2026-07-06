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
        "To change the ticket's status, pass status: omit it and posting auto-reopens a " +
        "non-open ticket; pass 'on-hold' (with on_hold_until=YYYY-MM-DD) to park it, or " +
        "'open' to reopen/clear a hold. content may be omitted ONLY when supplying a status " +
        "change (a status-only response); otherwise content is required. " +
        "To include inline images, pass `attachments` as local file paths and (optionally) " +
        "place {{attach:<name>}} tokens in `content` where each image should appear. " +
        "To attach downloadable files of any type, pass `files` as local file paths. " +
        "Identify the ticket by ticket_number OR ticket_id (internal DB id) — supply exactly one.",
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
