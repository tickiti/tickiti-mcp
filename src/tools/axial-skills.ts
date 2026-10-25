import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * Axial skills — read and edit the skills Tickiti's Axial assistant drafts from.
 *
 * Wraps /api/v1/axial/skills/*. Needs a token with skills:read / skills:write
 * whose owner is a system administrator on a plan with the AI assistant — the
 * same gate as Administration → Axial skills.
 *
 * A skill is addressed by `skill`: its key (e.g. updd.diagnostic) or its id. An
 * action is addressed by name within its skill. Updates change only the fields
 * passed. Instructions are Markdown.
 */

/** Strip undefined keys so the body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const skillRef = z.union([z.string(), z.number()]).describe("Skill key (e.g. updd.diagnostic) or id");

const composition = z
  .enum(["vetted", "guided", "open"])
  .describe(
    "vetted: product claims only from approved responses; guided: composes freely, cites approved content; open: no citation expected",
  );

const skillFields = {
  title: z.string().optional(),
  description: z.string().optional().describe("Routing hint: what queries this skill is for"),
  triggers: z.string().optional().describe("Keywords / example phrases for the router"),
  instructions: z.string().optional().describe("The skill body (Markdown)"),
  composition: composition.optional(),
  citation_set: z
    .array(z.string())
    .optional()
    .describe("Identifiers of approved responses (stock responses with AI relevance as_is/compose) the skill may cite"),
  enabled: z.boolean().optional(),
  ordinal: z.number().int().optional(),
  parent_key: z.string().nullable().optional().describe("Key of a parent skill, or null"),
};

const actionShape = z
  .object({
    name: z.string().describe("Lower-case identifier; the tool name the model calls"),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional().describe("JSON Schema object for the tool input"),
    handler_type: z.enum(["local", "remote"]).optional(),
    handler_ref: z.string().optional().describe("local: a handler from get_axial_skill_options; remote: the agent's action id"),
    permission: z.enum(["staff", "participant", "system"]).optional(),
    requires_confirmation: z.boolean().optional(),
    enabled: z.boolean().optional(),
    ordinal: z.number().int().optional(),
    timeout_ms: z.number().int().optional().describe("Remote actions only"),
    prefetch: z.boolean().optional().describe("Run before the model's first turn"),
    prefetch_params: z.record(z.unknown()).optional(),
  })
  .passthrough();

export function registerAxialSkillTools(server: McpServer): void {
  server.registerTool(
    "list_axial_skills",
    {
      title: "List Axial skills",
      description:
        "List Axial's skills: key, title, description, composition, enabled, reserved, action count. " +
        "Instructions are not included — use get_axial_skill. Requires skills:read.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("axial/skills", {})),
  );

  server.registerTool(
    "get_axial_skill",
    {
      title: "Get an Axial skill",
      description: "Fetch one Axial skill in full: fields, instructions (Markdown) and actions. Requires skills:read.",
      inputSchema: { skill: skillRef },
    },
    async ({ skill }) => toToolResult(await callV1("axial/skills/show", { skill })),
  );

  server.registerTool(
    "get_axial_skill_options",
    {
      title: "Axial skill options",
      description:
        "What a skill and an action can be set to: local handlers, permissions, compositions, and the field names. Requires skills:read.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("axial/skills/options", {})),
  );

  server.registerTool(
    "create_axial_skill",
    {
      title: "Create an Axial skill",
      description:
        "Create a skill, optionally with its actions, in one transaction. key, title, description and " +
        "instructions are required. Requires skills:write.",
      inputSchema: {
        key: z.string().describe("Lower-case, dots and underscores, e.g. billing.refund_request"),
        ...skillFields,
        actions: z.array(actionShape).optional().describe("Actions to create with the skill"),
      },
    },
    async (args) =>
      toToolResult(await callV1("axial/skills/create", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "update_axial_skill",
    {
      title: "Update an Axial skill",
      description:
        "Change a skill's fields. Only the fields you pass change; instructions are replaced whole. " +
        "The reserved skill (axial.core) cannot be renamed. Requires skills:write.",
      inputSchema: {
        skill: skillRef,
        key: z.string().optional().describe("New key (rename)"),
        ...skillFields,
      },
    },
    async (args) =>
      toToolResult(await callV1("axial/skills/update", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "delete_axial_skill",
    {
      title: "Delete an Axial skill",
      description: "Delete a skill and its actions. The reserved skill cannot be deleted. Requires skills:write.",
      inputSchema: { skill: skillRef },
    },
    async ({ skill }) => toToolResult(await callV1("axial/skills/delete", { skill })),
  );

  server.registerTool(
    "upsert_axial_skill_action",
    {
      title: "Add or change an Axial skill action",
      description:
        "Add an action to a skill, or change the action with that name (only the fields passed change). " +
        "A new action needs description, handler_type, handler_ref and permission. Returns the whole skill. " +
        "Requires skills:write.",
      inputSchema: { skill: skillRef, action: actionShape },
    },
    async ({ skill, action }) => toToolResult(await callV1("axial/skills/actions/upsert", { skill, action })),
  );

  server.registerTool(
    "delete_axial_skill_action",
    {
      title: "Delete an Axial skill action",
      description: "Remove an action from a skill by name. Returns the whole skill. Requires skills:write.",
      inputSchema: { skill: skillRef, name: z.string() },
    },
    async ({ skill, name }) => toToolResult(await callV1("axial/skills/actions/delete", { skill, name })),
  );
}

/**
 * Axial's suggested response on a ticket. For an Axial agent task (the enclave staff
 * conversation): its own token is the only one this works with, and the revision is made
 * by Axial's own engine as the staff member the task works for (#430587).
 */
export function registerAxialSuggestionTools(server: McpServer): void {
  server.registerTool(
    "revise_suggestion",
    {
      title: "Revise Axial's suggested response",
      description:
        "Ask Axial to change its suggested response to the customer on the ticket this agent task is about, " +
        "as staff would in the Axial panel. Axial writes the new version itself, under its own rules (approved " +
        "stock responses, guards), and it appears in the panel as a new version. Use it whenever the staff member " +
        "asks for the draft, reply or suggestion to change; never write the customer reply yourself instead. " +
        "Only an Axial agent task's own token can call it; it is refused while Axial is already working on the ticket.",
      inputSchema: {
        change: z.string().describe("The change wanted, in the staff member's terms (e.g. 'say there is no OEM licence option for this monitor')"),
        summary: z.string().optional().describe("A few words for the version's label"),
      },
    },
    async ({ change, summary }) =>
      toToolResult(await callV1("axial/agent-task/revise-suggestion", compact({ change, summary }))),
  );

  server.registerTool(
    "get_suggestion",
    {
      title: "Read Axial's suggested response",
      description:
        "Read Axial's suggested response to the customer on the ticket this agent task is about: the latest version " +
        "(or one by number), as plain text and HTML, with its one-off sign-off if it has one and whether it was sent. " +
        "Embedded images come back as [embedded image]; sending the version sends them. " +
        "Only an Axial agent task's own token can call it.",
      inputSchema: {
        version: z.number().int().optional().describe("A version number as the panel shows it (v3 = 3); the latest when left out"),
      },
    },
    async ({ version }) => toToolResult(await callV1("axial/agent-task/suggestion", compact({ version }))),
  );

  server.registerTool(
    "set_suggestion_signature",
    {
      title: "Sign off Axial's suggested response",
      description:
        "Give the latest version of Axial's suggested response a one-off sign-off, used instead of the usual one when it " +
        "is inserted into the reply editor or sent - for that version only. Use it when the staff member asks for the reply " +
        "to be signed off differently. Pass the whole sign-off as it should appear, one line per line (e.g. \"Regards,\nClaude\"); " +
        "pass an empty signature to remove it. Only an Axial agent task's own token can call it.",
      inputSchema: {
        signature: z.string().describe("The sign-off, line by line; empty to go back to the usual one"),
      },
    },
    async ({ signature }) => toToolResult(await callV1("axial/agent-task/suggestion-signature", { signature })),
  );

  server.registerTool(
    "send_suggestion",
    {
      title: "Send Axial's suggested response",
      description:
        "Send Axial's suggested response to the customer as a public response, exactly as written and with its one-off " +
        "sign-off if it has one, optionally closing the ticket with a resolution. It is held as an approval card on the " +
        "ticket: nothing reaches the customer until a member of staff approves it. With private: true it is posted at once " +
        "as a private response (an internal note, staff-only, no approval card), its one-off sign-off written in. Use it when " +
        "the staff member asks for the draft or suggestion to be sent or posted. Only an Axial agent task's own token can call it.",
      inputSchema: {
        version: z.number().int().optional().describe("The version to send; the latest when left out"),
        private: z.boolean().optional().describe("Post it as a private response (internal note) instead of to the customer"),
        signature: z
          .string()
          .optional()
          .describe("A one-off sign-off to set on the version first (e.g. \"Regards,\\nClaude\"), when they asked for one with the send"),
        close: z.boolean().optional().describe("Close the ticket with the response"),
        resolved: z.string().optional().describe("Resolution category (id or name) when closing"),
      },
    },
    async ({ version, private: isPrivate, signature, close, resolved }) =>
      toToolResult(
        await callV1("axial/agent-task/send-suggestion", compact({ version, private: isPrivate, signature, close, resolved })),
      ),
  );
}
