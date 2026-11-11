import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * A ticket's Axial chat — what the ticket page's Axial panel shows and does, as the token's owner.
 *
 * Wraps /api/v1/axial/chat/*. Abilities: axial-chat:read (or any axial: ability) to read,
 * axial-chat:write to send a message or Check now, axial-chat:approve to answer a question card (which
 * runs the card's actions — a build, a CRM change — as the owner), axial-chat:manage to rerun. The
 * owner's own Axial access on the ticket applies as in the panel. A message or card answer is
 * recorded as made through the API with the token's name, and is refused while someone else is
 * working with Axial on the ticket.
 */

/** Strip undefined keys so the body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const ticketRef = {
  ticket_number: z.union([z.string(), z.number()]).optional().describe("The ticket's number (e.g. 365176)"),
  ticket_id: z.number().int().optional().describe("The ticket's internal id, instead of its number"),
};

export function registerAxialChatTools(server: McpServer): void {
  server.registerTool(
    "get_axial_chat",
    {
      title: "Read a ticket's Axial chat",
      description:
        "Read the Axial panel of a ticket as staff see it: the conversation with Axial (who asked what, Axial's " +
        "answers, which suggested-response version appeared and why, replies sent, waits for long-running work with " +
        "their run or task id), the latest suggested response with its note to staff, needs-a-person reason, " +
        "confidence and the stock responses it cites, every question card (open ones with their options; answered " +
        "ones with who answered, what, and how each action went), approvals waiting, agent tasks, requests queued, " +
        "and who is working with Axial on the ticket. Customers' messages are not repeated: read them with " +
        "get_ticket. Pass `since` (the last_turn of an earlier read) for only what is new. Requires axial-chat:read.",
      inputSchema: {
        ...ticketRef,
        since: z.number().int().optional().describe("Only turns after this one (last_turn from an earlier read)"),
        include: z
          .array(z.enum(["tools", "drafts"]))
          .optional()
          .describe("tools: Axial's lookups, their results and its own notes; drafts: every suggested-response version, not just the latest"),
      },
    },
    async ({ ticket_number, ticket_id, since, include }) =>
      toToolResult(await callV1("axial/chat", compact({ ticket_number, ticket_id, since, include }))),
  );

  server.registerTool(
    "list_axial_runs",
    {
      title: "List a ticket's Axial runs",
      description:
        "Each time Axial worked on a ticket, newest first: the message it answered (a ticket response id, or what a " +
        "member of staff asked), status, mode, skill, engine, the models used, tokens, cost, confidence, whether it " +
        "needs a person, any error, and how long it took. Requires axial-chat:read.",
      inputSchema: {
        ...ticketRef,
        limit: z.number().int().min(1).max(200).optional().describe("How many runs (default 50)"),
      },
    },
    async ({ ticket_number, ticket_id, limit }) =>
      toToolResult(await callV1("axial/chat/runs", compact({ ticket_number, ticket_id, limit }))),
  );

  server.registerTool(
    "send_axial_message",
    {
      title: "Send a message to Axial on a ticket",
      description:
        "Write to Axial in a ticket's chat, as typing in the panel's box does: a question or an instruction to Axial, " +
        "which answers in the chat and may revise its suggested response. Nothing reaches the customer. If Axial is " +
        "busy on the ticket the message waits its turn (queued_position says where); it is refused while someone " +
        "else is working with Axial there. Answers arrive later: read them with get_axial_chat, passing the " +
        "last_turn returned here as `since`. Requires axial-chat:write.",
      inputSchema: {
        ...ticketRef,
        message: z.string().min(1).describe("What to say to Axial"),
      },
    },
    async ({ ticket_number, ticket_id, message }) =>
      toToolResult(await callV1("axial/chat/message", compact({ ticket_number, ticket_id, message }))),
  );

  server.registerTool(
    "check_axial_wait",
    {
      title: "Check now on Axial's long-running work",
      description:
        "The wait box's Check now: ask whether the long-running work Axial is waiting for (a driver build, a legacy " +
        "release) has finished. Give the run_id or task_id from the turn's long_wait in get_axial_chat. The answer " +
        "appears in the chat shortly. Requires axial-chat:write.",
      inputSchema: {
        ...ticketRef,
        run_id: z.number().int().optional().describe("The waiting run's id"),
        task_id: z.number().int().optional().describe("The waiting agent task's id"),
      },
    },
    async ({ ticket_number, ticket_id, run_id, task_id }) =>
      toToolResult(await callV1("axial/chat/check-wait", compact({ ticket_number, ticket_id, run_id, task_id }))),
  );

  server.registerTool(
    "answer_axial_card",
    {
      title: "Answer an Axial question card",
      description:
        "Answer a question card Axial raised on a ticket, as pressing its options in the panel does. Answering IS the " +
        "approval: an option's actions run at once as the token's owner (a driver build, a release, a CRM change), " +
        "then Axial writes the reply again. Give one option for every question shown, by the ids get_axial_chat " +
        "lists, with text where an option takes input. decision 'dismiss' says staff will deal with it themselves. " +
        "Only on a member of staff's instruction. Requires axial-chat:approve.",
      inputSchema: {
        ...ticketRef,
        card_id: z.number().int().describe("The card's id"),
        decision: z.enum(["answer", "dismiss"]).optional().describe("answer (the default) or dismiss"),
        answers: z
          .record(z.object({ option: z.string(), text: z.string().optional() }))
          .optional()
          .describe('By question id: { "<question id>": { "option": "<option id>", "text": "..." } }'),
        note: z.string().optional().describe("A note for Axial with the answer"),
      },
    },
    async ({ ticket_number, ticket_id, card_id, decision, answers, note }) =>
      toToolResult(
        await callV1(
          "axial/chat/card",
          compact({ ticket_number, ticket_id, card_id, decision: decision ?? "answer", answers, note }),
        ),
      ),
  );

  server.registerTool(
    "rerun_axial",
    {
      title: "Rerun Axial on a ticket",
      description:
        "The panel's Rerun: clear what Axial did about the latest customer message and work it again. Refused once a " +
        "reply has been sent for that message, and while Axial is working. Needs Manage access to Axial. Requires " +
        "axial-chat:manage.",
      inputSchema: { ...ticketRef },
    },
    async ({ ticket_number, ticket_id }) =>
      toToolResult(await callV1("axial/chat/rerun", compact({ ticket_number, ticket_id }))),
  );

  server.registerTool(
    "list_axial_gaps",
    {
      title: "List Axial's gaps",
      description:
        "The gap log (Axial > Gaps): what Axial was asked to do and could not, logged from staff conversations with " +
        "Axial. Each gap with its status, whose it is (tenant: the installation's own tools; axial: Axial itself), " +
        "what was asked and missing, how often it has been seen, and its history, in which entries by staff without " +
        "Manage access are marked as recommendations. By default only gaps still to be dealt with (recommended, open, " +
        "planned). Needs Manage access to Axial. Requires any axial-chat: ability.",
      inputSchema: {
        status: z
          .enum(["active", "all", "recommended", "open", "planned", "done", "wont_do", "merged"])
          .optional()
          .describe("active (the default): still to be dealt with; all; or one status"),
        owner: z.enum(["tenant", "axial"]).optional().describe("Only the installation's own gaps, or only Axial's"),
        gap_id: z.number().int().optional().describe("Just this gap, whatever its status"),
      },
    },
    async ({ status, owner, gap_id }) => toToolResult(await callV1("axial/gaps", compact({ status, owner, gap_id }))),
  );

  server.registerTool(
    "update_axial_gap",
    {
      title: "Change an Axial gap",
      description:
        "A manager's change to a gap on the gap log: its status (open, planned, done, wont_do) with a note saying why, " +
        "its title, kind or owner, or merge it into another gap (merge_into; its history stays with it). Each change " +
        "is recorded in the gap's history with who made it. Needs Manage access to Axial. Requires axial-chat:manage.",
      inputSchema: {
        gap_id: z.number().int().describe("The gap to change"),
        status: z.enum(["open", "planned", "done", "wont_do"]).optional(),
        status_note: z.string().max(2000).optional().describe("Why it has this status: what was done, or why not"),
        title: z.string().min(5).max(200).optional(),
        kind: z.enum(["tool", "data", "permission", "skill"]).optional(),
        owner: z.enum(["tenant", "axial"]).optional(),
        merge_into: z.number().int().optional().describe("Fold this gap into that one instead of changing it"),
      },
    },
    async ({ gap_id, status, status_note, title, kind, owner, merge_into }) =>
      toToolResult(
        await callV1("axial/gaps/update", compact({ gap_id, status, status_note, title, kind, owner, merge_into })),
      ),
  );
}
