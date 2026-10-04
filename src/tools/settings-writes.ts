import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * Settings/templates WRITE + body-read tools.
 *
 * The v1 API already exposes full CRUD for stock responses (settings family,
 * settings:write) and templates/FAQs (templates family, templates:write) — but
 * the handlers read specific body shapes the generic list tools never send:
 *   - show / delete take a top-level `template_id`
 *   - update (template_save) takes a NESTED `template: { id, ... }` object
 * so these dedicated tools exist to send the right shape. Reading a stock
 * response's BODY (content) is via get_stock_response (the list_* index returns
 * metadata only). See docs & the tickiti-api skill's "Known MCP issues".
 */

/** Strip undefined keys so the body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerSettingsWriteTools(server: McpServer): void {
  // ── Stock responses (settings family) ──────────────────────────────────

  server.registerTool(
    "get_stock_response",
    {
      title: "Get a stock response (with its body)",
      description:
        "Fetch one stock (canned) response including its content/body — list_stock_responses " +
        "returns metadata only. Pass the template_id from list_stock_responses. Requires settings:read.",
      inputSchema: {
        template_id: z.union([z.string(), z.number()]).describe("Template.id of the stock response"),
      },
    },
    async ({ template_id }) =>
      toToolResult(await callV1("settings/stock-responses/show", { template_id })),
  );

  server.registerTool(
    "create_stock_response",
    {
      title: "Create a stock response",
      description:
        "Create a new stock (canned) response. category is required; identifier is the topic " +
        "title the composer picker shows. content is Quill HTML (images: upload_template_image, or " +
        "data: URIs). is_enabled: false creates it hidden from the composer until it is ready. " +
        "Requires settings:write.",
      inputSchema: {
        identifier: z.string().max(255).describe("Topic / title shown in the picker"),
        category: z.string().max(255).describe("Grouping category (required for stock responses)"),
        subcategory: z.string().max(255).optional(),
        subject: z.string().max(255).optional().describe("Default subject when inserted"),
        keywords: z.string().max(255).optional().describe("Search terms (comma- or newline-separated)"),
        content: z.string().optional().describe("Body (Quill HTML)"),
        is_enabled: z.boolean().optional().describe("Show in the composer picker (default true)"),
        notes: z.string().optional().describe("Internal staff notes"),
        ai_relevance: z.enum(["as_is", "compose", "reference", "exclude"]).optional().describe("Admin-only"),
      },
    },
    async (args) =>
      toToolResult(await callV1("settings/stock-responses/create", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "update_stock_response",
    {
      title: "Update a stock response",
      description:
        "Edit an existing stock response by id. Only the fields you pass are changed. content " +
        "is Quill HTML. ai_relevance (as_is|compose|reference|exclude) governs the AI assistant and is " +
        "admin-only. Fields are limited to 255 characters (content excepted). Requires settings:write.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Template.id of the stock response"),
        identifier: z.string().optional().describe("Topic / title"),
        category: z.string().optional(),
        subcategory: z.string().optional(),
        subject: z.string().optional(),
        keywords: z.string().optional(),
        content: z.string().optional().describe("Body (Quill HTML)"),
        is_enabled: z.boolean().optional().describe("Show in the composer picker"),
        notes: z.string().optional().describe("Internal staff notes"),
        ai_relevance: z.enum(["as_is", "compose", "reference", "exclude"]).optional().describe("Admin-only"),
      },
    },
    async ({ id, ...fields }) =>
      toToolResult(await callV1("settings/stock-responses/update", { template: compact({ id, ...fields }) }, { idempotent: true })),
  );

  server.registerTool(
    "delete_stock_response",
    {
      title: "Delete a stock response",
      description: "Delete a stock response by id. Requires settings:write.",
      inputSchema: {
        template_id: z.union([z.string(), z.number()]).describe("Template.id of the stock response"),
      },
    },
    async ({ template_id }) =>
      toToolResult(await callV1("settings/stock-responses/delete", { template_id }, { idempotent: true })),
  );

  // ── Templates / FAQs (templates family — admin) ─────────────────────────

  server.registerTool(
    "get_template",
    {
      title: "Get a template / FAQ (with its body)",
      description:
        "Fetch one template or FAQ including its content/body by id. Requires templates:read.",
      inputSchema: {
        template_id: z.union([z.string(), z.number()]).describe("Template.id"),
      },
    },
    async ({ template_id }) => toToolResult(await callV1("templates/show", { template_id })),
  );

  server.registerTool(
    "update_template",
    {
      title: "Update a template / FAQ",
      description:
        "Edit an email/notification template or FAQ by id (the body is nested under `template` " +
        "server-side; this tool wraps it for you). Only the fields you pass are changed: the tool " +
        "reads the template first and sends content / subject / is_enabled back unchanged when you " +
        "leave them out (older Tickiti builds blanked omitted fields). content is Quill HTML; inline " +
        "data: images are extracted to attachments. Text fields other than content are limited to " +
        "255 characters. FAQ identifiers are immutable. Requires templates:write.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Template.id"),
        identifier: z.string().max(255).optional().describe("Template identifier (ignored for FAQs)"),
        subject: z.string().max(255).optional(),
        content: z.string().optional().describe("Body (Quill HTML)"),
        is_enabled: z.boolean().optional(),
        legend: z.string().max(255).optional(),
        description: z.string().max(255).optional(),
        ordinal: z.number().int().optional().describe("FAQ ordering"),
      },
    },
    async ({ id, ...fields }) => {
      const sent: Record<string, unknown> = compact({ id, ...fields });
      // Read-modify-write for the three fields older servers reset when omitted, so a
      // one-field update can never blank a live template body (#420800).
      if (sent.content === undefined || sent.is_enabled === undefined || sent.subject === undefined) {
        const cur = await callV1("templates/show", { template_id: id });
        const t = (cur.body as { template?: Record<string, unknown> } | null)?.template;
        if (!cur.ok || !t) return toToolResult(cur);
        if (sent.content === undefined) sent.content = t.content;
        if (sent.is_enabled === undefined) sent.is_enabled = Boolean(t.is_enabled);
        if (sent.subject === undefined) sent.subject = t.subject;
      }
      return toToolResult(await callV1("templates/update", { template: sent }, { idempotent: true }));
    },
  );

  server.registerTool(
    "create_template",
    {
      title: "Create a template / FAQ",
      description:
        "Create an email/notification template or FAQ. Every field is stored (subject, content, " +
        "description, ...); is_enabled: false creates it as a disabled draft. Requires templates:write.",
      inputSchema: {
        type: z.string().describe("e.g. 'email', 'notification', 'faq'"),
        identifier: z.string().max(255).optional().describe("Required except for FAQs"),
        subject: z.string().max(255).optional(),
        content: z.string().optional().describe("Body (Quill HTML)"),
        description: z.string().max(255).optional(),
        legend: z.string().max(255).optional(),
        is_enabled: z.boolean().optional().describe("Default true"),
        ordinal: z.number().int().optional().describe("FAQ ordering"),
      },
    },
    async (args) => toToolResult(await callV1("templates/create", compact({ ...(args as Record<string, unknown>) }), { idempotent: true })),
  );

  server.registerTool(
    "search_templates",
    {
      title: "Search templates / FAQs / stock responses by content",
      description:
        "Full-text search across templates by identifier/subject/content/keywords (the body " +
        "IS searched — answers 'which template mentions X?'). `mode` scopes which types appear; " +
        "`type` narrows further (e.g. 'stock-response', 'faq', 'email'). Requires templates:read.",
      inputSchema: {
        search: z.string().describe("Search string (supports \"quoted phrases\")"),
        mode: z.string().optional().describe("Scope, e.g. 'templates' (default)"),
        type: z.string().optional().describe("Narrow to one template type, e.g. 'stock-response', 'faq', 'email'"),
      },
    },
    async (args) => toToolResult(await callV1("templates/search", compact({ ...(args as Record<string, unknown>) }))),
  );
}
