import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * Tickets family — the operations that used to be web-UI-only, and the lookups a
 * ticket-scoped token needs:
 *   delete / restore, merge, link / unlink, move / copy / split responses,
 *   change the originator, remove one attachment, read one response by id,
 *   staff addresses, resolution categories, the search vocabulary, and what this
 *   token can do.
 *
 * Restructuring a ticket (delete, restore, merge, move, originator, attachment
 * delete) needs the token owner to manage its queue, as in the ticket browser; the
 * system user and API accounts are exempt.
 */

/** Strip undefined keys so the API call body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const ticketRef = {
  ticket_number: z.string().optional().describe("Ticket.number; supply this OR ticket_id"),
  ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
};

export function registerTicketOperationTools(server: McpServer): void {
  server.registerTool(
    "delete_tickets",
    {
      title: "Delete tickets",
      description:
        "Delete tickets (soft delete, as the ticket browser's Delete; restore_ticket undoes it). Select by " +
        "ticket_numbers, or every ticket raised by originator_email (optionally only in one queue) - e.g. all " +
        "the newsletters from one sender in one call. dry_run: true lists what would be deleted without deleting. " +
        "All-or-nothing: if any selected ticket may not be deleted, none is. Requires tickets:write and, for a " +
        "person's token, managing each ticket's queue.",
      inputSchema: {
        ticket_numbers: z.array(z.string()).max(1000).optional().describe("Ticket numbers to delete"),
        originator_email: z.string().email().optional().describe("Delete every ticket raised by this address"),
        queue: z.string().optional().describe("With originator_email: only tickets in this queue"),
        dry_run: z.boolean().optional().describe("List the matching tickets, delete nothing"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/delete", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "restore_ticket",
    {
      title: "Restore a deleted ticket",
      description:
        "Undo a delete: the ticket (or task) comes back, into the queue it was in, with the messages or notes deleted " +
        "with it, as they were: they start no automations, SLA timing, satisfaction survey, Axial reply or " +
        "out-of-office reply. Refused (422) when that queue no longer exists. From an Axial agent task's " +
        "token, a restore that would bring back public messages the ticket's customer can read is not carried " +
        "out: a task with a ticket gets a 202 with status awaiting_approval and an approval card for a member of " +
        "staff; a task with no ticket, and a reply task, which only reads, get a 403. Requires tickets:write.",
      inputSchema: { ticket_number: z.string().describe("Number of the deleted ticket") },
    },
    async ({ ticket_number }) => toToolResult(await callV1("tickets/restore", { ticket_number })),
  );

  server.registerTool(
    "merge_tickets",
    {
      title: "Merge two tickets (or two tasks)",
      description:
        "Merge two tickets, or two tasks, as the ticket browser's Merge: the OLDER one survives; the newer one's " +
        "participants and messages or notes (with attachments) are copied into it and the newer one is deleted, " +
        "marked as merged. A ticket and a task are never merged (422, error 'refused'). The copies start no " +
        "automations, SLA timing, satisfaction survey, Axial reply or " +
        "out-of-office reply; a survivor with no first response takes its earliest public staff reply, copies " +
        "included, and a surviving task with no description takes its first note, copied or its own. The result " +
        "names the survivor. From an Axial agent task's token, a merge that would " +
        "add anyone not on the staff to the surviving ticket, or show the other ticket's public messages to its " +
        "customer, is not carried out: a task with a ticket gets a 202 with status awaiting_approval and an " +
        "approval card for a member of staff; a reply task, which only reads, gets a 403. Requires tickets:write " +
        "and managing both queues.",
      inputSchema: {
        ticket_number: z.string().describe("One ticket"),
        other_ticket_number: z.string().describe("The other ticket"),
      },
    },
    async ({ ticket_number, other_ticket_number }) =>
      toToolResult(await callV1("tickets/merge", { ticket_number, other_ticket_number })),
  );

  server.registerTool(
    "link_tickets",
    {
      title: "Link tickets",
      description:
        "Link a ticket or task to one or more others, of either kind (the ticket page's Linked panel) - a real " +
        "relationship, not a link in a message body. Linking an already-linked pair does nothing. Requires " +
        "tickets:write and sight of every one of them (403 naming one the token owner cannot see).",
      inputSchema: {
        ...ticketRef,
        linked_ticket_numbers: z.array(z.string()).min(1).max(100).describe("Tickets to link it to"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/link", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "unlink_tickets",
    {
      title: "Unlink two tickets",
      description:
        "Remove the link between two tickets (or a ticket and a task). Clone links are permanent and can't be " +
        "removed. Requires tickets:write and sight of both ends.",
      inputSchema: { ...ticketRef, linked_ticket_number: z.string().describe("The linked ticket to unlink") },
    },
    async (args) => toToolResult(await callV1("tickets/unlink", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "list_linked_tickets",
    {
      title: "List a ticket's linked tickets",
      description: "The tickets linked to a ticket (also part of get_ticket). Requires tickets:read.",
      inputSchema: { ...ticketRef },
    },
    async (args) => toToolResult(await callV1("tickets/links", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "get_response",
    {
      title: "Get one message or note by id",
      description:
        "Read a single response (a ticket's message or a task's note) by its response_id alone - with its ticket number, flags, audit and " +
        "attachments - when you don't know which ticket it is on. Always says is_email_sourced and mail_auth " +
        "(what the receiving mail server concluded about the From address: pass, fail, or null; api when it was " +
        "posted through the API in the sender's name, so nothing checked the address). include " +
        "original_html: the email as it arrived, before inbound cleaning (null with has_original_html false when " +
        "the stored html already is the original; inline images stay cid: references, listed by cid in the " +
        "attachments); reply_text: the plain text without the quoted history. Requires tickets:read.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id"),
        max_body_chars: z.number().int().min(0).optional().describe("Cut html / plain_text (and the includes) to this many characters"),
        include: z.array(z.enum(["original_html", "reply_text"])).optional(),
      },
    },
    async ({ response_id, max_body_chars, include }) =>
      toToolResult(await callV1("tickets/response", compact({ response_id, max_body_chars, include }))),
  );

  for (const [name, path, verb] of [
    ["move_responses", "tickets/response-move", "Move"],
    ["copy_responses", "tickets/response-copy", "Copy"],
  ] as const) {
    server.registerTool(
      name,
      {
        title: `${verb} messages or notes to another ticket or task`,
        description:
          `${verb} responses onto another entry of the same kind: a ticket's messages onto another ticket, a ` +
          `task's notes onto another task (between a ticket and a task: 422, error 'refused'). Each is re-created ` +
          `there (author, flags, timestamps, attachments)` +
          (verb === "Move" ? " and the original deleted" : "") +
          ". Both record it." +
          (verb === "Move"
            ? " A move never takes a task's description (get_ticket: is_task_description) off its task, nor the " +
              "last message or note off its ticket or task (422)."
            : "") +
          " The copies are not new messages on the target: they start no automations, " +
          "SLA timing, satisfaction survey, Axial reply or out-of-office reply, and a copied staff reply is not the " +
          "target's first response. For repairing a mis-split thread or a botched clone. Requires tickets:write" +
          (verb === "Move" ? " and managing both queues." : " and managing the target's queue.") +
          " From an Axial agent task's token, a public response that would land where someone not on the staff " +
          "could not already read it is not carried out: a task with a ticket gets a 202 with status " +
          "awaiting_approval and an approval card for a member of staff; a reply task, which only reads, gets a " +
          "403. Between two tickets of the same customer it goes straight through.",
        inputSchema: {
          response_ids: z.array(z.number().int()).min(1).max(500).describe("Response ids (messages or notes), in the order to place them"),
          target_ticket_number: z.string().describe("The ticket (or task) to put them on: the same kind as their source"),
        },
      },
      async ({ response_ids, target_ticket_number }) =>
        toToolResult(await callV1(path, { response_ids, target_ticket_number })),
    );
  }

  server.registerTool(
    "split_ticket",
    {
      title: "Split messages or notes off into a new ticket or task",
      description:
        "Move (or, with copy: true, copy) responses of one ticket onto a NEW ticket with the given subject, " +
        "linked to the original as its clone and carrying its originator and participants. The new entry is the " +
        "source's kind: a ticket's messages make a ticket and a task's notes a task. `queue` may be any queue " +
        "but Drafts (Drafts: 422, error 'refused'; a queue that does not exist: 422, errors.queue). A move never takes a task's description off its task, " +
        "nor every message or note off the source, which keeps at least one (422). A new task's description is its " +
        "first copied note. Its messages or notes are " +
        "copies, so they start no automations, satisfaction survey, Axial reply or out-of-office reply, but the new " +
        "ticket gets its SLA policy (a task has none) and its first response is the earliest public staff reply " +
        "split off with it. Requires tickets:write and managing the source queue.",
      inputSchema: {
        response_ids: z.array(z.number().int()).min(1).max(500).describe("Messages or notes to split off (all from one ticket or task)"),
        subject: z.string().max(255).describe("Subject of the new ticket or task"),
        queue: z.string().optional().describe("Queue for the new entry (default: the source's); any queue but Drafts"),
        copy: z.boolean().optional().describe("Copy instead of move"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/split", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "change_originator",
    {
      title: "Change who raised a ticket",
      description:
        "Change a ticket's originator (raised-by) - e.g. one raised under the wrong one of a person's " +
        "addresses. The new address becomes a participant; the old one stays a participant (remove it " +
        "separately if needed). Recorded on the thread. On a task the new originator must be a member of staff " +
        "(only staff join a task; anyone else is refused, 422). From an Axial agent task's token, a new originator who " +
        "is not a member of staff and not already on the ticket is not set (they would get every public reply and " +
        "could open the whole history): a task with a ticket, or one naming the ticket by ticket_number, gets a " +
        "202 with status awaiting_approval and an approval card for a member of staff; a reply task, which only " +
        "reads, gets a 403. Requires tickets:write and managing the queue.",
      inputSchema: { ...ticketRef, originator_email: z.string().email().describe("The new originator") },
    },
    async (args) => toToolResult(await callV1("tickets/originator-update", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete one attachment",
      description:
        "Remove one attachment from a response - a malicious file above all. The stored bytes go too when no " +
        "other response, draft or template uses the same file; the response keeps a line recording the " +
        "name, sha256, who removed it and why. The response itself is untouched. Requires tickets:write and " +
        "managing the queue.",
      inputSchema: {
        ...ticketRef,
        response_attachment_id: z.union([z.string(), z.number()]).describe("ResponseAttachment.id (from get_ticket)"),
        reason: z.string().max(500).optional().describe("Why (kept on the response's record)"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/attachment-delete", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "list_staff",
    {
      title: "List staff (name → email)",
      description:
        "Staff who can be participants or assignees: id, name, email and team keys. Use it to turn a name or " +
        "@handle into the address add_participants / assigned_to_email need - never guess an address. " +
        "search filters by name or email. Requires tickets:read.",
      inputSchema: { search: z.string().optional().describe("Part of a name or email") },
    },
    async ({ search }) => toToolResult(await callV1("tickets/staff", compact({ search }))),
  );

  server.registerTool(
    "list_resolutions",
    {
      title: "List resolution categories",
      description: "The resolution categories `resolved` takes on close_ticket / respond_to_ticket (id, name, selectable). Requires tickets:read.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("tickets/resolutions", {})),
  );

  server.registerTool(
    "get_search_modes",
    {
      title: "Ticket search vocabulary",
      description: "The query_tickets search modes, what each matches, and how criteria and tokens combine. Requires tickets:read.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("tickets/search-modes", {})),
  );

  server.registerTool(
    "get_token_info",
    {
      title: "What this token can do",
      description:
        "This token's abilities, its owner's roles and the instance's plan features, per API family - so a " +
        "403 can be traced to a missing ability, role or plan. Extra abilities (such as " +
        "tickets:customer_impersonation) are reported separately, not folded into read or write. Any token.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("token", {})),
  );
}
