import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { actionEnum, runAction, ticketRef, type ActionSpec } from "./actions.js";

/**
 * The rest of Axial: the ticket panel's buttons besides chat, cards and rerun (axial-chat.ts),
 * a staff member's own conversations with Axial out of any ticket, and the Axial menu's
 * settings pages.
 *
 * Panel actions go through the panel's own controller as the token's owner, with the owner's
 * Axial access on the ticket, and are refused while someone else is working with Axial on it.
 * What they write is recorded as made through the API with the token's name. An agent task (a
 * task, Investigate in depth, a conversation message) works as the owner with every ability
 * they have, so it is started only with a token that already holds them all.
 */

export function registerAxialPanelTools(server: McpServer): void {
  const t = ["ticket_number", "ticket_id"];
  const T = "ticket_number|ticket_id";
  const panel: Record<string, ActionSpec> = {
    approve_action: { path: "axial/chat/approval", fields: [...t, "call_id", "decision", "reason"], required: [T, "call_id", "decision"] },
    shared_note: {
      path: "axial/chat/shared-note",
      fields: [...t, "note_id", "decision", "title", "body", "applies_when", "reason"],
      required: [T, "note_id", "decision"],
    },
    redraft: { path: "axial/chat/redraft", fields: t, required: [T] },
    respond_again: { path: "axial/chat/respond-again", fields: t, required: [T] },
    add_note: { path: "axial/chat/note", fields: [...t, "response_id"], required: [T, "response_id"] },
    cancel_queued: { path: "axial/chat/queue/cancel", fields: [...t, "id"], required: [T, "id"] },
    agent_task: { path: "axial/chat/agent-task", fields: [...t, "instruction"], required: [T, "instruction"] },
    investigate: { path: "axial/chat/agent-task/deep", fields: t, required: [T] },
    stop_task: { path: "axial/chat/agent-task/stop", fields: [...t, "task_id"], required: [T, "task_id"] },
    set_skill: { path: "axial/chat/skill", fields: [...t, "skill_key", "op"], required: [T, "skill_key"] },
    turn_on: { path: "axial/chat/turn-on", fields: t, required: [T] },
    approve_translations: { path: "axial/chat/translations/approve", fields: [...t, "run_id"], required: [T, "run_id"] },
    skill_proposal: { path: "axial/chat/skill-proposal", fields: [...t, "proposal_id", "decision"], required: [T, "proposal_id", "decision"] },
  };
  server.registerTool(
    "axial_panel_action",
    {
      title: "Act on a ticket's Axial panel",
      description:
        "The Axial panel's buttons (read the panel first with get_axial_chat, which gives the ids). " +
        "approve_action: approve or reject a proposed write action (call_id, decision approve|reject); approving runs " +
        "it as the owner, who must have the right it asks for; never from an agent task's own token. shared_note: a " +
        "shared note's card (note_id, decision send|publish|reject|discard; publish and reject need Manage access to " +
        "Axial). Both need axial-chat:approve. " +
        "redraft: 'Update suggested response' over the whole conversation. respond_again: another suggested response " +
        "to the same customer message after a reply was sent. add_note: put one of the ticket's internal notes " +
        "(response_id) into Axial's conversation. cancel_queued: take back one of the owner's own requests waiting its " +
        "turn (id from the chat's queued[]). agent_task: 'Give Axial a task' (instruction). investigate: 'Investigate " +
        "in depth', the skill's deep route. stop_task: stop an agent task (task_id). These need axial-chat:write; " +
        "agent_task and investigate also a token holding every ability the task would carry. " +
        "set_skill: choose the ticket's skill (skill_key, op add|primary|remove); it holds until changed. turn_on: Axial " +
        "takes the customer's messages again after a staff reply turned it off. approve_translations: a run's " +
        "stock-response translations become the approved ones (run_id); it changes stock responses, so it also needs " +
        "settings:write or templates:write. skill_proposal: apply or discard a skill " +
        "change Axial drafted (proposal_id, decision apply|discard; apply also needs skills:write and an owner who may " +
        "edit skills). These need axial-chat:manage. All need the AI-assistant plan and a staff owner.",
      inputSchema: {
        action: actionEnum(panel),
        ...ticketRef,
        call_id: z.number().int().optional().describe("approve_action: the approval's call id"),
        decision: z
          .enum(["approve", "reject", "send", "publish", "discard", "apply"])
          .optional()
          .describe("approve_action: approve|reject; shared_note: send|publish|reject|discard; skill_proposal: apply|discard"),
        reason: z.string().max(2000).optional().describe("approve_action / shared_note: why, when rejecting"),
        note_id: z.number().int().optional().describe("shared_note: the note"),
        title: z.string().optional().describe("shared_note: the note's title, edited before publishing"),
        body: z.string().optional().describe("shared_note: the note's text, edited before publishing"),
        applies_when: z.string().optional().describe("shared_note: when the note applies"),
        response_id: z.number().int().optional().describe("add_note: the internal note"),
        id: z.string().max(64).optional().describe("cancel_queued: the queued request's id"),
        instruction: z.string().max(20000).optional().describe("agent_task: what Axial is to do"),
        task_id: z.number().int().optional().describe("stop_task: the agent task"),
        skill_key: z.string().optional().describe("set_skill: the skill (list_axial_skills)"),
        op: z.enum(["add", "primary", "remove"]).optional().describe("set_skill: default add"),
        run_id: z.number().int().optional().describe("approve_translations: the run"),
        proposal_id: z.number().int().optional().describe("skill_proposal: the proposal"),
      },
    },
    async (args) => runAction("axial_panel_action", panel, args as Record<string, unknown>),
  );

  const conversations: Record<string, ActionSpec> = {
    list: { path: "axial/conversations", fields: [] },
    show: { path: "axial/conversations/show", fields: ["conversation_id"], required: ["conversation_id"] },
    create: { path: "axial/conversations/create", fields: ["message"], required: ["message"] },
    message: { path: "axial/conversations/message", fields: ["conversation_id", "message"], required: ["conversation_id", "message"] },
    stop: { path: "axial/conversations/stop", fields: ["conversation_id", "task_id"], required: ["conversation_id", "task_id"] },
    update: { path: "axial/conversations/update", fields: ["conversation_id", "title", "delete"], required: ["conversation_id", "title|delete"] },
  };
  server.registerTool(
    "axial_conversations",
    {
      title: "My conversations with Axial outside any ticket",
      description:
        "The token owner's OWN conversations with Axial out of any ticket (anyone else's is a 404). list: newest " +
        "first. show: one, with its messages. create: start one with a message. message: continue one. Each message " +
        "is an agent task on the agent host working as the owner, so create and message need a token holding every " +
        "ability the task would carry, an owner who may give Axial agent tasks, and an agent host. stop: stop the " +
        "task answering (task_id). update: rename (title) or delete (delete: true; not while Axial is answering). " +
        "Any axial-chat: ability reads; axial-chat:write changes. Needs the AI-assistant plan and a staff owner.",
      inputSchema: {
        action: actionEnum(conversations),
        conversation_id: z.number().int().min(1).optional(),
        message: z.string().max(20000).optional(),
        task_id: z.number().int().optional().describe("stop: the task answering"),
        title: z.string().optional().describe("update: the new title"),
        delete: z.literal(true).optional().describe("update: delete the conversation"),
      },
    },
    async (args) => runAction("axial_conversations", conversations, args as Record<string, unknown>),
  );

  const settings: Record<string, ActionSpec> = {
    get: { path: "axial/settings", fields: [] },
    update: { path: "axial/settings/update", fields: [] },
    skill_store: { path: "axial/skill-store", fields: [] },
    skill_store_update: {
      path: "axial/skill-store/update",
      fields: ["store", "repo_url", "branch", "username", "secret"],
      required: ["store"],
    },
    skill_store_sync: { path: "axial/skill-store/sync", fields: [] },
    attachment_rules: { path: "axial/attachment-rules", fields: [] },
    attachment_rule_save: {
      path: "axial/attachment-rules/save",
      fields: ["id", "extension", "mode", "max_bytes", "note", "enabled"],
      required: ["extension|id", "mode"],
    },
    attachment_rule_delete: { path: "axial/attachment-rules/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "axial_settings",
    {
      title: "Axial settings, skill store and attachment rules",
      description:
        "The Axial menu's settings pages. get: every setting with what a blank one falls back to. update: `settings` " +
        "holds any of the keys get lists (not axial_visible_to), axial_open_tools (a list), axial_enabled, the " +
        "house rules every customer reply follows (axial_house_rules: Markdown text; axial_first_lookups: tool names a " +
        "reply runs first; axial_house_rules_base_commit: get's house_rules.commit, so a change made in the skill store " +
        "since is refused; saved to the skill store as house-rules.md when skills are kept in git) and the sign-off " +
        "(ai_signature); what is not sent is kept; all or nothing. ai_persona and ai_business_context are kept for the " +
        "older engine only and are now part of the house rules. " +
        "axial_reply_auto_send (true|false, off by default): with it on, a reply task's draft answering a customer's " +
        "message is sent to the customer at once from the system account unless it needs a person: the model says " +
        "so, a question card or an approval is waiting, a prepared action has not finished, failed or was declined, " +
        "the draft is empty or names a link no tool returned, or the task stopped early; a draft overtaken on the " +
        "ticket is held too. A redraft or revision staff asked for is never sent, nor anything on a development copy " +
        "or in a replay, and Tickiti's server-wide stop holds every draft (get's auto_send_stopped says when it is " +
        "on). axial_auto_send and axial_auto_send_threshold are DEPRECATED: the older engine's own (off|shadow|on " +
        "with a confidence threshold), kept for that engine only and listed in get's deprecated_settings. " +
        "axial_inbound_queues: the queue ids Axial answers a customer's incoming message in (empty: none); a queue " +
        "is answered only when listed, so a new queue is not answered until it is added here or with axial_answers " +
        "on the queue (workflow/queues/create or update). axial_inbound_exclude_queues is DEPRECATED, kept as an " +
        "alias: read, it is every queue not answered; set, Axial answers every existing queue but those (a queue " +
        "added later is still not answered). Send one of the two, not both. get's notices say when Axial is on and " +
        "answering no queue. " +
        "skill_store: where the skills are kept (never the password). skill_store_update: store database|git; turning " +
        "git on checks the repository, then syncs, and a repository with skills in it REPLACES the skills here; a " +
        "blank secret keeps the saved one. skill_store_sync: catch up with the repository now. attachment_rules: what " +
        "Axial does with each attachment type; attachment_rule_save: no id creates (one rule per extension), mode " +
        "auto|preprocess|ignore; attachment_rule_delete. The AI connection and who is shown Axial stay browser-only. " +
        "Requires the AI-assistant plan, administration:read (reads) or administration:write, and an owner who is an " +
        "admin on a hosted customer site, or a sysadmin on a standalone install and on Tickiti's own support site. " +
        "The skill store (skill_store, skill_store_update, skill_store_sync), axial_open_tools and the models and " +
        "limits settings need a sysadmin owner, so on a hosted site Tickiti runs them and an admin's token cannot " +
        "change them.",
      inputSchema: {
        action: actionEnum(settings),
        settings: z.record(z.any()).optional().describe("update: the settings to change, by key"),
        store: z.enum(["database", "git"]).optional(),
        repo_url: z.string().max(500).nullable().optional().describe("skill_store_update: https:// repository URL"),
        branch: z.string().max(100).nullable().optional(),
        username: z.string().max(200).nullable().optional(),
        secret: z.string().max(500).nullable().optional().describe("skill_store_update: blank keeps the saved one"),
        id: z.number().int().optional().describe("attachment_rule_save / _delete: the rule"),
        extension: z.string().optional(),
        mode: z.enum(["auto", "preprocess", "ignore"]).optional(),
        max_bytes: z.number().int().min(1).nullable().optional(),
        note: z.string().max(255).nullable().optional(),
        enabled: z.boolean().optional(),
      },
    },
    async (args) => {
      const { settings: values, ...rest } = args as Record<string, unknown>;
      if (rest.action === "update") {
        if (!values || typeof values !== "object" || !Object.keys(values).length) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "Error: axial_settings update needs `settings` (the keys to change): nothing was sent." }],
          };
        }
        const stray = Object.keys(rest).filter((k) => k !== "action" && rest[k] !== undefined);
        if (stray.length) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Error: axial_settings update takes only \`settings\`; put ${stray.join(", ")} inside it. Nothing was sent.` }],
          };
        }
        const spec = { ...settings, update: { ...settings.update, fields: Object.keys(values) } };
        return runAction("axial_settings", spec, { action: "update", ...(values as Record<string, unknown>) });
      }
      if (values !== undefined) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error: axial_settings action '${String(rest.action)}' does not take 'settings': nothing was sent.` }],
        };
      }
      return runAction("axial_settings", settings, rest);
    },
  );
}
