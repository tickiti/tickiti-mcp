import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import {
  inlineImagesIntoContent,
  resolveContent,
  uploadOutOfLineFiles,
  SUPPORTED_IMAGE_EXTS,
  type InlineAttachment,
  type OutOfLineFile,
} from "../attachments.js";

/** Shared Zod field: a body read from a local file instead of passed inline. */
const contentPathShape = z
  .string()
  .optional()
  .describe(
    "Path to a local file holding the HTML body, instead of `content` (give one). Use it for long bodies - " +
      "the shim reads the file, so the text never has to be emitted verbatim.",
  );

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
        "Omit queue_name to use the Inbox; queue_name is not allowed with intervention. " +
        "is_public is REQUIRED: true = the opening response is customer-visible, false = a staff-only internal note. " +
        "You can set the assignee, priority, status and extra participants at creation. " +
        "The result's `queue` is where the ticket actually landed (with rerouted/reroute_reason if a routing rule moved it), " +
        "and tag_warnings lists any @tag that matched nobody (posted as plain text; pass strict_tags to refuse instead).",
      inputSchema: {
        originator_email_address: z.string().email(),
        subject: z.string().optional().describe("Pair with content (subject+content path)"),
        content: z.string().optional().describe("HTML body; pair with subject"),
        content_path: contentPathShape,
        template_identifier: z.string().optional().describe("Template.identifier; pair with data"),
        intervention: z.string().optional().describe("Intervention.name; pair with data and uid"),
        uid: z.string().optional().describe("Required only when intervention is set"),
        data: z
          .record(z.any())
          .optional()
          .describe("Token values for template/intervention paths"),
        queue_name: z.string().optional().describe("TicketQueue.name; omit for Inbox"),
        is_public: z
          .boolean()
          .describe("Visibility of the opening response: true = customer-visible, false = staff-only internal note. Required - there is no safe default."),
        use_passed_originator_as_responder: z.boolean().optional().describe("Post the opening response as the originator rather than the token owner."),
        assigned_to_email: z.string().optional().describe("Assign at creation: a staff email or a team key 'team:<id>' (list_teams / list_staff)."),
        priority: z.enum(["10", "20", "30", "40", "Low", "Normal", "High", "Urgent"]).optional().describe("Priority at creation."),
        status: z.enum(["open", "on-hold", "closed"]).optional().describe("Status at creation (default open)."),
        on_hold_until: z.string().optional().describe("YYYY-MM-DD; required with status on-hold."),
        participants: z.array(z.string().email()).optional().describe("Extra participants added as the ticket is created (list_staff gives staff addresses)."),
        strict_tags: z.boolean().optional().describe("Refuse the create if an @tag or #hashtag matches nobody (default: post it as text and report it in tag_warnings)."),
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
      const content = resolveContent(a.content, a.content_path);
      if (content !== undefined) data.content = content;
      const PRIORITY: Record<string, string> = { Low: "10", Normal: "20", High: "30", Urgent: "40" };
      if (a.assigned_to_email !== undefined) data.assigned_to_email = a.assigned_to_email;
      if (a.priority !== undefined) data.priority = PRIORITY[String(a.priority)] ?? a.priority;
      if (a.status !== undefined) data.status = a.status;
      if (a.on_hold_until !== undefined) data.on_hold_until = a.on_hold_until;
      if (a.participants !== undefined) body.participants = a.participants;
      if (a.strict_tags !== undefined) body.strict_tags = a.strict_tags;

      // Inline images: embed the local files as data-URIs in the body. The
      // server (create_ticket → TicketActionService) converts them to cid:
      // attachments, exactly like respond_to_ticket.
      if (Array.isArray(a.attachments) && a.attachments.length) {
        data.content = inlineImagesIntoContent(
          String(data.content ?? ""),
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
        body.queue_name = a.queue_name; // the server now takes it top-level alone
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
        "(staff email, a team key 'team:<id>' from list_teams, or 'Unassigned'), priority " +
        "(Low|Normal|High|Urgent or 10|20|30|40), resolved " +
        "(resolution-category id or name), queue (move the ticket to a queue by name), subject " +
        "(rename the ticket), and add_participants / remove_participants. " +
        "With no status given, a PUBLIC reply reopens a closed/on-hold ticket (keep_status: true stops it); an " +
        "internal note or an attribute-only change leaves the status and any hold date alone. on_hold_until on its own " +
        "puts the ticket on hold. content may be omitted ONLY when supplying a status/attribute change. The body " +
        "parameter is `content` (a body sent as html/body/message is refused); any other unknown parameter is listed " +
        "in the result's ignored_params. send_full_email: true emails the customer the reply itself, not just the " +
        "'open the ticket' notification. Closing on a queue that tracks resolutions needs `resolved` (list_resolutions). " +
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
        content_path: contentPathShape,
        is_internal: z.boolean().optional(),
        send_full_email: z
          .boolean()
          .optional()
          .describe("Email the customer the reply itself (full thread email) rather than the short notification - for customers whose mail app can't open the ticket page."),
        keep_status: z
          .boolean()
          .optional()
          .describe("Leave the ticket's status as it is even for a public reply (no auto-reopen)."),
        status: z
          .enum(["open", "on-hold", "closed"])
          .optional()
          .describe("Set the ticket status. 'on-hold' requires on_hold_until; 'open'/'closed' clear any hold."),
        on_hold_until: z
          .string()
          .optional()
          .describe("Date (YYYY-MM-DD) to hold until. On its own it puts the ticket on hold."),
        assigned_to_email: z
          .string()
          .optional()
          .describe(
            "Reassign the ticket to this staff email, to a team by its key 'team:<id>' (see " +
              "list_teams; every member then counts as the assignee), or 'Unassigned' to clear.",
          ),
        priority: z
          .string()
          .optional()
          .describe("Set priority: Low|Normal|High|Urgent (or 10|20|30|40)."),
        resolved: z
          .string()
          .optional()
          .describe("Resolution category (id or name); requires the resolution-tracking plan."),
        queue: z
          .string()
          .optional()
          .describe("Move the ticket to this queue (TicketQueue.name; must exist). Use list_queues for names."),
        subject: z
          .string()
          .optional()
          .describe("Rename the ticket to this subject."),
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
      const { attachments, files, content_path, ...rest } = args as Record<string, unknown>;
      const body: Record<string, unknown> = { ...rest };
      const content = resolveContent(rest.content, content_path);
      if (content !== undefined) body.content = content;
      if (Array.isArray(attachments) && attachments.length) {
        body.content = inlineImagesIntoContent(
          String(body.content ?? ""),
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
        "resolved (resolution-category id or name) to record the resolution, queue (move the " +
        "ticket to a queue by name) and subject (rename). On a queue that tracks resolutions, " +
        "`resolved` is required (list_resolutions gives the categories). from_email is " +
        "optional — defaults to the token owner. Identify the ticket by ticket_number OR " +
        "ticket_id. Requires tickets:write.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        from_email: z.string().email().optional().describe("Author email; defaults to the token owner"),
        content: z.string().optional().describe("Optional closing reply body (HTML)"),
        is_internal: z.boolean().optional().describe("Post the closing note as staff-only (default public if content given)"),
        resolved: z.string().optional().describe("Resolution category id or name (resolution-tracking plan)"),
        queue: z.string().optional().describe("Move the ticket to this queue (TicketQueue.name; must exist)."),
        subject: z.string().optional().describe("Rename the ticket to this subject."),
      },
    },
    async (args) => toToolResult(await callV1("tickets/close", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "edit_response",
    {
      title: "Edit a response in place (no notification)",
      description:
        "Change an existing response in place: replace its body (content / content_path), edit " +
        "part of it (replace: find/replace pairs against the stored body - no need to send the " +
        "whole thing back), and/or change whether it is internal. Sends NO notification - the " +
        "way to silently fix content already on a ticket - unless notify: true with is_internal: " +
        "false, which publishes an internal note and tells the customer (the ticket page's 'Change " +
        "to public'). Demoting a public response does NOT unsend it. A customer's response can " +
        "have its visibility corrected (is_internal alone) but its body is never rewritten; " +
        "audit-only rows have no body. Get the response_id from get_ticket / get_response. " +
        "Requires tickets:write.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id to change"),
        content: z.string().optional().describe("New response body (HTML). Inline data: images are extracted to attachments."),
        content_path: contentPathShape,
        replace: z
          .array(
            z.object({
              find: z.string().min(1).describe("Exact text (HTML) in the stored body"),
              replace: z.string().describe("Replacement ('' to delete)"),
              all: z.boolean().optional().describe("Replace every occurrence (else it must occur exactly once)"),
            }),
          )
          .optional()
          .describe("Edits to the stored body, applied in order. Exclusive with content."),
        is_internal: z.boolean().optional().describe("Set the response's visibility: true = staff-only note, false = visible to the customer."),
        notify: z.boolean().optional().describe("With is_internal: false on an internal response: publish it AND notify the customer."),
      },
    },
    async ({ response_id, content, content_path, replace, is_internal, notify }) =>
      toToolResult(
        await callV1(
          "tickets/response-update",
          compact({ response_id, content: resolveContent(content, content_path), replace, is_internal, notify }),
          { idempotent: true },
        ),
      ),
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
        "perspective_name; defaults to the 'All' perspective. Pass ticket numbers " +
        "via search_object for a direct lookup (several numbers in one ticket_number criterion " +
        "return those tickets). An unknown mode is refused. get_search_modes lists the vocabulary.",
      inputSchema: {
        perspective_id: z.number().int().optional(),
        row_limit: z.number().int().min(1).max(5000).optional().describe("Rows to return (default 100)."),
        perspective_name: z.string().optional().describe("Resolved server-side via search_object.search_perspective"),
        search_object: z
          .record(z.any())
          .optional()
          .describe(
            "Search payload: { search_perspective?, search_perspective_id?, " +
              "criteria?: [{ mode, tokens: [...], match?: 'all'|'any' }] }. Same-mode criteria OR together, " +
              "different modes AND. Several tokens in one text criterion must ALL match unless match: 'any'; " +
              "the single-value modes (ticket_number, queue, status, assigned, ...) match any token. Valid modes: subject, content, subject_content, " +
              "assigned (a staff email — also matches that person's teams' tickets; a team " +
              "key 'team:<id>' — the team's own tickets; 'team-and-members:<id>' — the " +
              "team's and its members' own; or 'Unassigned'), participant, priority, raised " +
              "(originator email), queue " +
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
