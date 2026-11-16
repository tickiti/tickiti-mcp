import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { actionEnum, compact, runAction, ticketRef, type ActionSpec } from "./actions.js";

/**
 * What the ticket page and the ticket browser do to a ticket besides replying: the browser's
 * Save over many tickets, the checklist, reminders, pins, restoring a deleted response, @tags,
 * the owner's own bump / read / note, the share link, replies held with Send later, and the
 * Review page's inbound-mail reviews.
 *
 * Every change goes through Tickiti's own services (the ticket engine, ChecklistService,
 * ReminderService, ResponseTagService, ScheduledSendService, ReviewOperations), so history,
 * notifications, cached perspectives and open views follow as they do from the page. "Can see
 * the ticket" below is ApiTicketAccess::canAct: the assignee or a member of the assigned team, a
 * participant, or can_view on its queue; API accounts, sysadmins and the system user are exempt.
 * Customers' tokens are refused.
 */

const ticketNumbers = z.array(z.string()).min(1);

export function registerTicketPlanningTools(server: McpServer): void {
  // ── Bulk update ─────────────────────────────────────────────────────────

  server.registerTool(
    "update_tickets",
    {
      title: "Update many tickets at once (status, queue, assignee, priority, dates)",
      description:
        "The ticket browser's Save over up to 100 tickets, through the ticket engine as the token's owner: each " +
        "ticket gets its history row, notifications, and cached perspectives and open views refresh. Each ticket " +
        "is judged on its own and refusals are listed per ticket without stopping the others. The rule: the owner " +
        "must see the ticket; a queue change needs manage on both the from- and to-queue unless the new assignee " +
        "manages the to-queue; an assignee change needs manage on the target queue unless the new assignee manages " +
        "it (a team manages a queue if any member does; Unassigned manages nothing); status, priority, hold date and " +
        "resolution need manage on the target queue, except that the current assignee (in person or via the team) " +
        "may close with a resolution; start/due dates need manage or being the personal assignee. A queue change " +
        "moves tickets and tasks alike, to any queue but Drafts. A task is never on hold, so on-hold or a hold " +
        "date is refused for each task in the selection. Locked tickets, " +
        "tickets the owner has a draft on, Alert tickets, and closing on a queue that tracks resolutions without one " +
        "are refused. A ticket that does not exist and one the owner cannot see get the same reason ('no such " +
        "ticket, or not one the token owner can see'). Use dry_run first to see what would change. Find the " +
        "tickets with query_tickets. Never fall back to one respond_to_ticket per ticket. Returns updated (or " +
        "would_update), unchanged, refused[{ticket_number, reason}] in the order asked, ignored_params. Requires " +
        "tickets:write and a staff owner.",
      inputSchema: {
        ticket_numbers: ticketNumbers.max(100).describe("The tickets, 1-100, each once"),
        status: z.enum(["open", "on-hold", "closed"]).optional(),
        on_hold_until: z.string().optional().describe("YYYY-MM-DD; needed with on-hold, and alone it implies on-hold"),
        queue: z.string().optional().describe("Target queue by name (or queue_id, not both)"),
        queue_id: z.number().int().optional(),
        assigned_to_email: z.string().optional().describe("A staff email, 'team:<id>' (list_teams) or 'Unassigned'"),
        priority: z.enum(["10", "20", "30", "40", "Low", "Normal", "High", "Urgent"]).optional(),
        resolved: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Resolution category id or name (list_resolutions), with closing; an id is sent as text"),
        start_date: z.string().optional().describe("YYYY-MM-DD, or 'none' to clear"),
        due_date: z.string().optional().describe("YYYY-MM-DD, or 'none' to clear"),
        dry_run: z.boolean().optional().describe("Report what would change and change nothing"),
      },
    },
    // Tickiti validates resolved as a string, so an id given as a number (list_resolutions
    // gives numbers) is sent as its text rather than refused with a 422 for every ticket.
    async (args) => {
      const a = args as Record<string, unknown>;
      return toToolResult(
        await callV1("tickets/update-many", compact({ ...a, resolved: a.resolved === undefined ? undefined : String(a.resolved) })),
      );
    },
  );

  // ── Checklist ───────────────────────────────────────────────────────────

  const checklist: Record<string, ActionSpec> = {
    get: { path: "tickets/checklist", fields: ["ticket_number", "ticket_id"], required: ["ticket_number|ticket_id"] },
    add: {
      path: "tickets/checklist/add",
      fields: ["ticket_number", "ticket_id", "text", "items", "template_id"],
      required: ["ticket_number|ticket_id", "text|items|template_id"],
    },
    update: {
      path: "tickets/checklist/update",
      fields: ["ticket_number", "ticket_id", "item_id", "text", "is_done"],
      required: ["ticket_number|ticket_id", "item_id", "text|is_done"],
    },
    reorder: { path: "tickets/checklist/reorder", fields: ["ticket_number", "ticket_id", "ids"], required: ["ticket_number|ticket_id", "ids"] },
    delete: {
      path: "tickets/checklist/delete",
      fields: ["ticket_number", "ticket_id", "item_id", "all"],
      required: ["ticket_number|ticket_id", "item_id|all"],
    },
  };
  server.registerTool(
    "ticket_checklist",
    {
      title: "Read or change a ticket's checklist",
      description:
        "A ticket's checklist, as on the ticket page. get: the items {id, text, is_done, done_by_name, done_at}, " +
        "progress {done,total} and the checklist templates. add: one item (text), several (items) or a template's " +
        "items (template_id; items already there word for word are skipped); at most 100 items in all. update: " +
        "edit an item's text and/or tick or untick it (is_done; ticking records the token's owner and the time). " +
        "reorder: every item id in the new order. delete: one item (item_id) or all (all: true). Needs sight of the " +
        "ticket. get requires tickets:read; the rest tickets:write.",
      inputSchema: {
        action: actionEnum(checklist),
        ...ticketRef,
        text: z.string().max(500).optional().describe("add: one item; update: the item's new text"),
        items: z.array(z.string().max(500)).min(1).max(100).optional().describe("add: several items"),
        template_id: z.number().int().optional().describe("add: a checklist template's items (checklist_templates list)"),
        item_id: z.number().int().optional().describe("update / delete: the item"),
        is_done: z.boolean().optional().describe("update: tick (true) or untick"),
        ids: z.array(z.number().int()).min(1).optional().describe("reorder: the item ids in their new order"),
        all: z.boolean().optional().describe("delete: clear the whole checklist"),
      },
    },
    async (args) => runAction("ticket_checklist", checklist, args as Record<string, unknown>),
  );

  // ── Reminders ───────────────────────────────────────────────────────────

  const reminders: Record<string, ActionSpec> = {
    list: { path: "tickets/reminders", fields: ["ticket_number", "ticket_id"], required: ["ticket_number|ticket_id"] },
    add: {
      path: "tickets/reminders/add",
      fields: ["ticket_number", "ticket_id", "next_at", "note", "repeat_every", "repeat_unit", "repeat_until", "timezone"],
      required: ["ticket_number|ticket_id", "next_at"],
    },
    delete: { path: "tickets/reminders/delete", fields: ["ticket_number", "ticket_id", "reminder_id"], required: ["ticket_number|ticket_id", "reminder_id"] },
  };
  server.registerTool(
    "ticket_reminders",
    {
      title: "List, add or delete a ticket's reminders",
      description:
        "A ticket's reminders. list: soonest first, with who set each and whether the owner may delete it. add: a " +
        "one-off or repeating reminder owned by the token's owner; it fires for the assignee (every member of an " +
        "assigned team), or for the owner when the ticket is unassigned. Refused on a closed ticket, for a one-off in " +
        "the past, or for a series already over; a series whose start has passed begins at its next occurrence. " +
        "delete: only the reminder's owner, or an admin of at least the owner's rank (admin < sysadmin < superuser). " +
        "Needs sight of the ticket. list requires tickets:read; add and delete tickets:write.",
      inputSchema: {
        action: actionEnum(reminders),
        ...ticketRef,
        next_at: z.string().optional().describe("add: ISO 8601; without an offset it is read in `timezone`"),
        note: z.string().max(255).optional(),
        repeat_every: z.number().int().min(1).max(365).optional().describe("add: with repeat_unit, for a repeating reminder"),
        repeat_unit: z.enum(["day", "week", "month"]).optional(),
        repeat_until: z.string().optional().describe("add: YYYY-MM-DD, the last day of a series"),
        timezone: z.string().optional().describe("add: IANA name (default: the workspace's)"),
        reminder_id: z.number().int().optional().describe("delete: the reminder"),
      },
    },
    async (args) => runAction("ticket_reminders", reminders, args as Record<string, unknown>),
  );

  // ── Responses: pin, restore, @tags ──────────────────────────────────────

  server.registerTool(
    "pin_response",
    {
      title: "Pin or unpin a message or note",
      description:
        "Pin a response (a ticket's message or a task's note) to the top of its ticket or task (pinned: true) or " +
        "unpin it. A task's description is always pinned and listed above any other pinned note: unpinning it is " +
        "refused (422, error 'refused'). Needs sight of the ticket; a " +
        "deleted response cannot be pinned. Returns is_pinned and whether it changed. Requires tickets:write.",
      inputSchema: {
        response_id: z.number().int(),
        pinned: z.boolean().describe("true pins, false unpins"),
      },
    },
    async ({ response_id, pinned }) => toToolResult(await callV1("tickets/response-pin", { response_id, pinned })),
  );

  server.registerTool(
    "restore_response",
    {
      title: "Restore a deleted message or note",
      description:
        "Undo delete_response. Allowed only to an admin or a member of staff who manages the ticket's queue (403 " +
        "for anyone else, the author included). The ticket records who restored it; nobody is notified. Refused " +
        "when the response is not deleted or its ticket is (restore_ticket first). Find deleted responses with " +
        "query_responses include_deleted: true (rows carry `deleted`). Requires tickets:write.",
      inputSchema: { response_id: z.number().int() },
    },
    async ({ response_id }) => toToolResult(await callV1("tickets/response-restore", { response_id })),
  );

  const tags: Record<string, ActionSpec> = {
    list: { path: "tickets/tags", fields: ["ticket_number", "ticket_id", "mine"], required: ["ticket_number|ticket_id"] },
    tag: { path: "tickets/tag", fields: ["response_id", "emails", "comment"], required: ["response_id", "emails"], idempotent: true },
    acknowledge: { path: "tickets/tag-ack", fields: ["response_tag_id"], required: ["response_tag_id"] },
  };
  server.registerTool(
    "ticket_tags",
    {
      title: "@tag staff on a response, list tags, acknowledge a tag",
      description:
        "Staff @tags on a ticket's responses, as the Tag dialog. list: the ticket's tags oldest first (who, by whom, " +
        "comment, acknowledged; mine: only the token owner's). tag: tag up to 20 members of staff on a response; each " +
        "becomes a participant, the ticket turns unread for them and they are notified. acknowledge: only the person " +
        "tagged may acknowledge their own tag (403 for anyone else). Needs sight of the ticket. list requires " +
        "tickets:read; tag and acknowledge tickets:write.",
      inputSchema: {
        action: actionEnum(tags),
        ...ticketRef,
        mine: z.boolean().optional().describe("list: only the tags on the token's owner"),
        response_id: z.number().int().optional().describe("tag: the response to tag them on"),
        emails: z.array(z.string().email()).min(1).max(20).optional().describe("tag: staff email addresses"),
        comment: z.string().max(2000).optional().describe("tag: a note for the people tagged"),
        response_tag_id: z.number().int().optional().describe("acknowledge: the tag (list gives response_tag_id)"),
      },
    },
    async (args) => runAction("ticket_tags", tags, args as Record<string, unknown>),
  );

  // ── The owner's own state on tickets ────────────────────────────────────

  const state: Record<string, ActionSpec> = {
    get: { path: "tickets/user-state", fields: ["ticket_numbers"], required: ["ticket_numbers"] },
    update: { path: "tickets/user-state/update", fields: ["ticket_numbers", "bump", "read", "note"], required: ["ticket_numbers", "bump|read|note"] },
  };
  server.registerTool(
    "my_ticket_state",
    {
      title: "Read or set my bump, read/unread and private note on tickets",
      description:
        "The token owner's OWN per-ticket state, never anyone else's: bumped up or down, read (opened since the last " +
        "material response), and the card preview's private note. update sets any of bump (up|down|none), read " +
        "(true marks read, false unread) and note (null or '' removes it) on every ticket given. All or nothing: a " +
        "ticket that does not exist and one the owner cannot see both refuse the whole call with the same 404 " +
        "('No such ticket, or not one the token owner can see', naming them). get requires tickets:read; update " +
        "tickets:write.",
      inputSchema: {
        action: actionEnum(state),
        ticket_numbers: ticketNumbers.max(500).optional().describe("Up to 500 tickets"),
        bump: z.enum(["up", "down", "none"]).optional(),
        read: z.boolean().optional(),
        note: z.string().max(2000).nullable().optional().describe("Private note on the card preview; null clears it"),
      },
    },
    async (args) => runAction("my_ticket_state", state, args as Record<string, unknown>),
  );

  server.registerTool(
    "get_share_link",
    {
      title: "Get a ticket's share link",
      description:
        "The ticket's permanent share link, as the page's Copy link, created on first request (created: true). With " +
        "response_id the link opens at that message. Not for a task, which a share link does not open (refused). Needs sight of the ticket. Requires " +
        "tickets:write (it may create the link).",
      inputSchema: {
        ...ticketRef,
        response_id: z.number().int().optional().describe("A response on the ticket to open the link at"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/external-link", compact(args as Record<string, unknown>))),
  );

  // ── Send later ──────────────────────────────────────────────────────────

  const scheduled: Record<string, ActionSpec> = {
    list: { path: "tickets/scheduled", fields: ["ticket_number", "ticket_id"] },
    cancel: { path: "tickets/scheduled/cancel", fields: ["ticket_number", "ticket_id"], required: ["ticket_number|ticket_id"] },
    send_now: { path: "tickets/scheduled/send-now", fields: ["ticket_number", "ticket_id"], required: ["ticket_number|ticket_id"] },
    reschedule: {
      path: "tickets/scheduled/reschedule",
      fields: ["ticket_number", "ticket_id", "send_at"],
      required: ["ticket_number|ticket_id", "send_at"],
    },
  };
  server.registerTool(
    "scheduled_replies",
    {
      title: "My replies held with Send later",
      description:
        "The token owner's OWN replies held with Send later, on tickets they can still see. list: all of them, or one " +
        "ticket's, with the reply as held and its status (pending|editing|failed). cancel: the reply is not sent; " +
        "the draft stays, as on the page. send_now: sent now through the same engine as Send (refused while it is " +
        "open in the owner's editor, or when the engine refuses it). reschedule: a new send_at more than 30 seconds " +
        "ahead; a failed one goes back to pending. Scheduling a new reply is not available through the API. From an " +
        "Axial agent task's token, send_now is not carried out (when a held reply reaches the customer is a " +
        "person's choice), as a public reply is not: a task with a ticket gets a 202 with status awaiting_approval " +
        "and an approval card for a member of staff; a reply task, which only reads, gets a 403. list requires " +
        "tickets:read; the rest tickets:write.",
      inputSchema: {
        action: actionEnum(scheduled),
        ...ticketRef,
        send_at: z.string().optional().describe("reschedule: ISO 8601"),
      },
    },
    async (args) => runAction("scheduled_replies", scheduled, args as Record<string, unknown>),
  );

  // ── Inbound-mail reviews ────────────────────────────────────────────────

  server.registerTool(
    "list_reviews",
    {
      title: "List inbound emails held for review",
      description:
        "Tickets the mail fetcher opened from an email it flagged for a person (the Review page): the sender is not a " +
        "participant (non_party_response), a duplicate, or the sender already has an open ticket (existant). Newest " +
        "first, only those whose new ticket the owner can see; existing_ticket is null (state 'hidden' or 'gone') " +
        "when the owner cannot see it. can_keep / can_merge say what resolve_review would allow (can_merge is false " +
        "when the existing entry is a task). ticket_number " +
        "matches the new ticket or the existing one. Requires tickets:read.",
      inputSchema: {
        reason: z.enum(["non_party_response", "duplicate", "existant"]).optional(),
        queue: z.string().optional().describe("The new ticket's queue name"),
        ticket_number: z.union([z.string(), z.number()]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/reviews", compact(args as Record<string, unknown>))),
  );

  server.registerTool(
    "resolve_review",
    {
      title: "Keep or merge a reviewed inbound email",
      description:
        "Resolve one review (list_reviews). keep: the new ticket stays its own ticket; needs sight of it. merge: " +
        "every message on the new ticket, oldest first, with its attachments, and its participants go onto the " +
        "existing ticket (reopened if on hold, its assignee notified) and the new ticket is deleted; needs sight " +
        "of the existing ticket and manage on BOTH tickets' queues. Refused (422) when the existing entry is a " +
        "task: a ticket and a task are never merged, so keep it instead. From an Axial " +
        "agent task's token, a merge that would add anyone not on the staff to the existing ticket (the sender of a " +
        "non_party_response, say) is not carried out, as participants/add is not: a task with a ticket gets a 202 " +
        "with status awaiting_approval and an approval card for a member of staff; a reply task, which only reads, " +
        "gets a 403. Give review_id or the ticket_number under review. Requires tickets:write.",
      inputSchema: {
        review_id: z.number().int().optional(),
        ticket_number: z.union([z.string(), z.number()]).optional().describe("The ticket under review, instead of review_id"),
        decision: z.enum(["keep", "merge"]),
      },
    },
    async (args) => toToolResult(await callV1("tickets/review-resolve", compact(args as Record<string, unknown>))),
  );
}
