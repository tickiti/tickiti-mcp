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
