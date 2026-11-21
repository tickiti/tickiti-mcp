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

/** The reply's signature, on respond and close (ApiController::ticket_respond). */
const signatureShape = z
  .enum(["system", "personal", "none", "custom"])
  .optional()
  .describe("The reply's signature: system, personal, none, or custom (with signature_custom). Left out, the author's default applies.");
const signatureCustomShape = z
  .string()
  .max(2000)
  .optional()
  .describe("A one-off signature for this reply, with signature: 'custom'.");

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
    }).strict(),
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
    }).strict(),
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
      title: "Create a ticket or task",
      description:
        "Create a support ticket or, with kind: 'task', a task (staff work: its notes are never shown to a customer). " +
        "Provide originator_email_address and EXACTLY ONE of: " +
        "subject+content, OR template_identifier+data, OR intervention+data+uid. " +
        "queue_name is not allowed with intervention (the intervention's own queue is used). " +
        "An entry is a ticket or a task for life (kind), whatever queue it is in: any queue but Drafts holds both. " +
        "Omit queue_name to use the Inbox, or for a task the default queue for new tasks (chosen in System " +
        "settings; tickiti_call('workflow/queues') gives its default_task_queue_id). A queue_name that does not " +
        "exist is refused (422, errors.queue_name), and Drafts, or an intervention's queue that no longer exists, " +
        "under errors.queue. A task is staff work, so it also refuses (422) is_public " +
        "true (pass false: its first note is internal whatever is sent), intervention and uid, customer_name / " +
        "company / other_fields, status on-hold (a task is open or closed, never on hold), an originator or " +
        "participants who are not staff, and use_passed_originator_as_responder unless the originator is the " +
        "token owner and a member of staff. The result carries `kind`. " +
        "is_public is REQUIRED: true = the opening message is customer-visible, false = a staff-only internal note. " +
        "You can set the assignee, priority, status and extra participants at creation, and give a contact form's " +
        "customer_name, company and other_fields. " +
        "The result's `queue` is where the ticket actually landed (with rerouted/reroute_reason if a routing rule moved it), " +
        "and tag_warnings lists any @tag that matched nobody (posted as plain text; pass strict_tags to refuse instead). " +
        "use_passed_originator_as_responder (posting the opening message as an originator other than the token " +
        "owner) needs a key holding tickets:customer_impersonation, which only a System or API-user key can have; " +
        "it is refused (422, errors.use_passed_originator_as_responder) for an internal originator (a staff, " +
        "mailbox or system address, or one in the installation's own domains), with is_public false, with " +
        "intervention or uid unless the call is an intervention with customer_message, and on a task. Such a " +
        "message is never staff, its sender is marked unverified ('api'), and an internal note records which key " +
        "posted it. Where System settings asks contact-form senders to confirm their address, such a message is " +
        "held: the sender is emailed a 4-character code, the result says awaiting_sender_confirmation (with " +
        "sender_code_sent, false when the address has had its codes for now, and sender_confirmation_expires_at) and " +
        "gives no secure_id until the code is entered, staff see it as awaiting the sender's confirmation, and Axial " +
        "does not answer it until they enter the code. sender_confirmed true says the integration's own form already " +
        "confirmed the address, so nothing is held or emailed; it needs a key that also holds " +
        "tickets:sender_confirmed (422, errors.sender_confirmed, otherwise, and in anyone but a customer's name). " +
        "customer_message (HTML, up to 65535 characters) opens an intervention's ticket with the customer's own " +
        "words: only with intervention+data+uid, use_passed_originator_as_responder true and an originator who is " +
        "not the token owner (otherwise 422, errors.customer_message; one with no text is refused too). It is " +
        "posted first, public and in the customer's name, before the intervention's own staff and public " +
        "responses, and the ticket stays in the intervention's queue. It is posted only on a ticket this call " +
        "creates: a uid that matches an earlier ticket gets the intervention's responses alone.",
      inputSchema: {
        originator_email_address: z.string().email(),
        kind: z
          .enum(["ticket", "task"])
          .optional()
          .describe(
            "What to create (default 'ticket'), fixed for life. A task goes in any queue but Drafts (queue_name; " +
              "omitted, the default queue for new tasks), with is_public false, and takes no intervention/uid, " +
              "customer_name, company, other_fields, on-hold status, non-staff originator or participants, or " +
              "posting in someone else's name.",
          ),
        subject: z.string().optional().describe("Pair with content (subject+content path)"),
        content: z.string().optional().describe("HTML body; pair with subject"),
        content_path: contentPathShape,
        template_identifier: z.string().optional().describe("Template.identifier; pair with data"),
        intervention: z.string().optional().describe("Intervention.name; pair with data and uid"),
        uid: z.string().optional().describe("Required only when intervention is set"),
        customer_message: z
          .string()
          .max(65535)
          .optional()
          .describe(
            "Intervention only: the customer's own message (HTML), posted first and public in their name. Needs " +
              "use_passed_originator_as_responder true, an originator other than the token owner and a key holding " +
              "tickets:customer_impersonation; not posted when the uid matches an earlier ticket.",
          ),
        data: z
          .record(z.any())
          .optional()
          .describe("Token values for template/intervention paths"),
        queue_name: z
          .string()
          .optional()
          .describe("TicketQueue.name, any queue but Drafts; omit for the Inbox (a task: the default queue for new tasks)"),
        is_public: z
          .boolean()
          .describe("Visibility of the opening response: true = customer-visible, false = staff-only internal note. Required - there is no safe default."),
        use_passed_originator_as_responder: z
          .boolean()
          .optional()
          .describe(
            "Post the opening response as the originator rather than the token owner. For an originator other than " +
              "the owner this needs a key holding tickets:customer_impersonation and is_public true, with no " +
              "intervention/uid (except an intervention with customer_message); an internal (staff, mailbox, " +
              "system or own-domain) address is refused.",
          ),
        sender_confirmed: z
          .boolean()
          .optional()
          .describe(
            "With use_passed_originator_as_responder in a customer's name: the integration's own form already " +
              "confirmed the address, so the message is not held for the emailed code. Needs a key holding " +
              "tickets:sender_confirmed.",
          ),
        assigned_to_email: z.string().optional().describe("Assign at creation: a staff email or a team key 'team:<id>' (list_teams / list_staff)."),
        priority: z.enum(["10", "20", "30", "40", "Low", "Normal", "High", "Urgent"]).optional().describe("Priority at creation."),
        status: z.enum(["open", "on-hold", "closed"]).optional().describe("Status at creation (default open); a task is never on-hold."),
        on_hold_until: z.string().optional().describe("YYYY-MM-DD; required with status on-hold."),
        participants: z.array(z.string().email()).optional().describe("Extra participants added as the ticket is created (list_staff gives staff addresses); a task takes staff only."),
        strict_tags: z.boolean().optional().describe("Refuse the create if an @tag or #hashtag matches nobody (default: post it as text and report it in tag_warnings)."),
        customer_name: z.string().max(255).optional().describe("The customer's name, as a contact form gives it."),
        company: z.string().max(255).optional().describe("The customer's company."),
        other_fields: z
          .array(z.object({ label: z.string().max(255), value: z.string().max(1000) }).strict())
          .optional()
          .describe("Further form fields, each { label, value }, shown with the customer's details."),
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
      if (a.kind !== undefined) body.kind = a.kind;
      if (a.is_public !== undefined) body.is_public = a.is_public;
      if (a.use_passed_originator_as_responder !== undefined) {
        body.use_passed_originator_as_responder = a.use_passed_originator_as_responder;
      }
      if (a.sender_confirmed !== undefined) body.sender_confirmed = a.sender_confirmed;

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
      // Customer-form extras: top level in the body, not under data.
      for (const k of ["customer_name", "company", "other_fields"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }

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
      if (a.customer_message !== undefined) body.customer_message = a.customer_message; // top level, not under data

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
        "Add a message to an existing ticket, or a note to a task. Set is_internal=true for a staff-only note; " +
        "everything posted on a task is a staff-only note whatever is_internal says. " +
        "You can change ticket attributes in the same call: status ('open' | 'on-hold' | " +
        "'closed'; a task is never on hold, so 'on-hold' or on_hold_until on a task is refused, 422), " +
        "on_hold_until (YYYY-MM-DD, required with 'on-hold'), assigned_to_email " +
        "(staff email, a team key 'team:<id>' from list_teams, or 'Unassigned'), priority " +
        "(Low|Normal|High|Urgent or 10|20|30|40), resolved " +
        "(resolution-category id or name), queue (move it to any queue by name but Drafts, a ticket or a task " +
        "alike; Drafts or a queue that is gone is refused, 422, errors.queue), subject " +
        "(rename the ticket), and add_participants / remove_participants (on a task, staff only: anyone else is " +
        "refused, 422, errors.add_participants). " +
        "With no status given, a PUBLIC reply reopens a closed/on-hold ticket (keep_status: true stops it); an " +
        "internal note or an attribute-only change leaves the status and any hold date alone. on_hold_until on its own " +
        "puts the ticket on hold. content may be omitted ONLY when supplying a status/attribute change. The body " +
        "parameter is `content`: an argument this tool does not list (html, body, message, ...) is refused before " +
        "anything is sent. send_full_email: true emails the customer the reply itself, not just the " +
        "'open the ticket' notification. signature picks the reply's signature (system | personal | none | custom " +
        "with signature_custom); left out, the author's default applies. " +
        "Closing on a queue that tracks resolutions needs `resolved` (list_resolutions). " +
        "To include inline images, pass `attachments` as local file paths and (optionally) " +
        "place {{attach:<name>}} tokens in `content` where each image should appear. " +
        "To attach downloadable files of any type, pass `files` as local file paths. " +
        "Identify the ticket by ticket_number OR ticket_id (internal DB id) — supply exactly one. " +
        "To close a ticket, prefer close_ticket; to edit an existing message or note, use edit_response. " +
        "from_email: a person's token always posts as its owner (another address is replaced by the owner's and " +
        "reported as from_email_replaced). A System or API-user key may post as a member of staff or a system " +
        "address; posting as a customer needs a key holding tickets:customer_impersonation (else 422, " +
        "errors.from_email), never in an internal address (a mailbox, own-domain or staff-lookalike one: 422, " +
        "errors.from_email, as on create), and such a response is never staff and its sender is marked unverified ('api'). " +
        "Where System settings asks contact-form senders to confirm their address, a public message in a customer's " +
        "name is held until they enter the code emailed to them (awaiting_sender_confirmation and sender_code_sent in the result; Axial " +
        "does not answer it until then), unless an email from that address has already arrived on the ticket or " +
        "sender_confirmed is true, which needs a key also holding tickets:sender_confirmed.",
      inputSchema: {
        ticket_number: z
          .string()
          .optional()
          .describe("Ticket.number (the 6-digit human reference); supply this OR ticket_id"),
        ticket_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Ticket.id (internal DB id); supply this OR ticket_number"),
        from_email: z
          .string()
          .email()
          .describe(
            "Author email; added as a participant if new. A person's token posts as its owner whatever is given; " +
              "a customer's address needs a key holding tickets:customer_impersonation; an internal (mailbox, " +
              "own-domain or staff-lookalike) address is refused.",
          ),
        content: z
          .string()
          .optional()
          .describe("The message or note body (HTML). Optional only when a status/attribute change is supplied."),
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
        sender_confirmed: z
          .boolean()
          .optional()
          .describe(
            "In a customer's name: the integration's own form already confirmed the address, so the message is not " +
              "held for the emailed code. Needs a key holding tickets:sender_confirmed.",
          ),
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
          .describe(
            "Move the ticket or task to this queue (TicketQueue.name; must exist, any queue but Drafts; list_queues " +
              "gives the names).",
          ),
        subject: z
          .string()
          .optional()
          .describe("Rename the ticket to this subject."),
        add_participants: z
          .array(z.string().email())
          .optional()
          .describe("Emails to add as participants (on a task, members of staff only)."),
        remove_participants: z
          .array(z.string().email())
          .optional()
          .describe("Emails to remove as participants (the originator can't be removed)."),
        signature: signatureShape,
        signature_custom: signatureCustomShape,
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
        "Close a ticket or task. Optionally pass content to post a final reply (a note, on a task) as it closes, and " +
        "resolved (resolution-category id or name) to record the resolution, queue (move it to any queue by name " +
        "but Drafts; Drafts or a queue that is gone is refused, 422, errors.queue) " +
        "and subject (rename). On a queue that tracks resolutions, " +
        "`resolved` is required (list_resolutions gives the categories). signature / signature_custom " +
        "choose the closing reply's signature, as on respond_to_ticket. from_email is " +
        "optional — defaults to the token owner, and follows respond_to_ticket's rules (a customer's address " +
        "needs a key holding tickets:customer_impersonation). Identify the ticket by ticket_number OR " +
        "ticket_id. Requires tickets:write.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        from_email: z.string().email().optional().describe("Author email; defaults to the token owner"),
        content: z.string().optional().describe("Optional closing reply body (HTML)"),
        is_internal: z.boolean().optional().describe("Post the closing message as staff-only (default public if content given; on a task it is always a staff-only note)"),
        resolved: z.string().optional().describe("Resolution category id or name (resolution-tracking plan)"),
        queue: z.string().optional().describe("Move it to this queue (TicketQueue.name; must exist, not Drafts)."),
        subject: z.string().optional().describe("Rename the ticket to this subject."),
        signature: signatureShape,
        signature_custom: signatureCustomShape,
      },
    },
    async (args) => toToolResult(await callV1("tickets/close", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "edit_response",
    {
      title: "Edit a message or note in place (no notification)",
      description:
        "Change an existing response (a ticket's message or a task's note) in place: replace its body (content / " +
        "content_path), edit part of it (replace: find/replace pairs against the stored body - no need to send the " +
        "whole thing back), and/or change whether it is internal. Sends NO notification - the " +
        "way to silently fix content already on a ticket - unless notify: true with is_internal: " +
        "false, which publishes an internal note and tells the customer (the ticket page's 'Change " +
        "to public'). Demoting a public message does NOT unsend it. A customer's message can " +
        "have its visibility corrected (is_internal alone) but its body is never rewritten; " +
        "audit lines have no body. A note on a task is never made public: is_internal false on a task is refused " +
        "(422, errors.is_internal). A task's description (get_ticket: is_task_description) can be edited but not " +
        "emptied (422, under content or replace). Get the response_id from get_ticket / get_response. " +
        "Requires tickets:write.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id to change (a message or note)"),
        content: z.string().optional().describe("New body (HTML). Inline data: images are extracted to attachments."),
        content_path: contentPathShape,
        replace: z
          .array(
            z.object({
              find: z.string().min(1).describe("Exact text (HTML) in the stored body"),
              replace: z.string().describe("Replacement ('' to delete)"),
              all: z.boolean().optional().describe("Replace every occurrence (else it must occur exactly once)"),
            }).strict(),
          )
          .optional()
          .describe("Edits to the stored body, applied in order. Exclusive with content."),
        is_internal: z
          .boolean()
          .optional()
          .describe("Set the visibility: true = staff-only note, false = visible to the customer (refused on a task)."),
        notify: z.boolean().optional().describe("With is_internal: false on an internal message: publish it AND notify the customer."),
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
      title: "Delete a message or note",
      description:
        "Soft-delete a response (a ticket's message or a task's note) by id; restore_response undoes it. " +
        "Refused (422, error 'refused') for a task's description (get_ticket: is_task_description) and for the " +
        "last message or note on its ticket or task: every ticket or task keeps at least one (audit lines do not " +
        "count). Only its author, an admin or the queue's manager may delete it (403). Get the response_id from " +
        "get_ticket / list_responses. Requires tickets:write.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id to delete (a message or note)"),
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
        "Add one or more participants to a ticket (records a body-less audit entry). Only staff join a task: " +
        "on a task, an address that is not exactly a member of staff's is refused (422, errors.add_participants). " +
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
        "return those tickets). An unknown mode is refused. get_search_modes lists the vocabulary. " +
        "With a subject, content or subject_content criterion, a member of staff's rows carry `matches`: " +
        "for each word, where it was found (the subject, a message or note with its author, date and the text " +
        "around the word, or a tag comment). A ticket keeps the subject of the message that opened it, " +
        "so read the matches, not the subject, to tell what a ticket is about.",
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
              "(tokens: ['YYYY-MM-DD'], compared as UTC). get_search_modes returns the " +
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
