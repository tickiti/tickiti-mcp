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
      description: "Undo a delete: the ticket comes back with the responses deleted with it. Requires tickets:write.",
      inputSchema: { ticket_number: z.string().describe("Number of the deleted ticket") },
    },
    async ({ ticket_number }) => toToolResult(await callV1("tickets/restore", { ticket_number })),
  );

  server.registerTool(
    "merge_tickets",
    {
      title: "Merge two tickets",
      description:
        "Merge two tickets, as the ticket browser's Merge: the OLDER ticket survives; the newer one's " +
        "participants and responses (with attachments) are copied into it and the newer ticket is deleted, " +
        "marked as merged. The result names the survivor. Requires tickets:write and managing both queues.",
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
        "Link a ticket to one or more others (the ticket page's Linked panel) - a real relationship, not a " +
        "link in a response body. Linking an already-linked pair does nothing. Requires tickets:write and " +
        "sight of every ticket.",
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
      description: "Remove the link between two tickets. Clone links are permanent and can't be removed. Requires tickets:write.",
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
      title: "Get one response by id",
      description:
        "Read a single response by its response_id alone - with its ticket number, flags, audit and " +
        "attachments - when you don't know which ticket it is on. Requires tickets:read.",
      inputSchema: {
        response_id: z.union([z.string(), z.number()]).describe("Response.id"),
        max_body_chars: z.number().int().min(0).optional().describe("Cut html / plain_text to this many characters"),
      },
    },
    async ({ response_id, max_body_chars }) =>
      toToolResult(await callV1("tickets/response", compact({ response_id, max_body_chars }))),
  );

  for (const [name, path, verb] of [
    ["move_responses", "tickets/response-move", "Move"],
    ["copy_responses", "tickets/response-copy", "Copy"],
  ] as const) {
    server.registerTool(
      name,
      {
        title: `${verb} responses to another ticket`,
        description:
          `${verb} responses onto another ticket: each is re-created there (author, flags, timestamps, ` +
          `attachments)` +
          (verb === "Move" ? " and the original deleted" : "") +
          ". Both tickets record it. For repairing a mis-split thread or a botched clone. Requires tickets:write" +
          (verb === "Move" ? " and managing both queues." : " and managing the target's queue."),
        inputSchema: {
          response_ids: z.array(z.number().int()).min(1).max(500).describe("Response ids, in the order to place them"),
          target_ticket_number: z.string().describe("The ticket to put them on"),
        },
      },
      async ({ response_ids, target_ticket_number }) =>
        toToolResult(await callV1(path, { response_ids, target_ticket_number })),
    );
  }

  server.registerTool(
    "split_ticket",
    {
      title: "Split responses off into a new ticket",
      description:
        "Move (or, with copy: true, copy) responses of one ticket onto a NEW ticket with the given subject, " +
        "linked to the original as its clone and carrying its originator and participants. Requires " +
        "tickets:write and managing the source queue.",
      inputSchema: {
        response_ids: z.array(z.number().int()).min(1).max(500).describe("Responses to split off (all from one ticket)"),
        subject: z.string().max(255).describe("Subject of the new ticket"),
        queue: z.string().optional().describe("Queue for the new ticket (default: the source's)"),
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
        "separately if needed). Recorded on the thread. Requires tickets:write and managing the queue.",
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
        "403 can be traced to a missing ability, role or plan. Any token.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("token", {})),
  );
}
