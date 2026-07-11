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
        "title the composer picker shows. content is Quill HTML (inline images may be embedded " +
        "as data: URIs). Requires settings:write.",
      inputSchema: {
        identifier: z.string().describe("Topic / title shown in the picker"),
        category: z.string().describe("Grouping category (required for stock responses)"),
        subcategory: z.string().optional(),
        subject: z.string().optional().describe("Default subject when inserted"),
        keywords: z.string().optional().describe("Search terms (comma- or newline-separated)"),
        content: z.string().optional().describe("Body (Quill HTML)"),
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
        "is Quill HTML. ai_relevance (as_is|reference|exclude) governs the AI assistant and is " +
        "admin-only. Requires settings:write.",
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
        ai_relevance: z.enum(["as_is", "reference", "exclude"]).optional().describe("Admin-only"),
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
        "server-side; this tool wraps it for you). Only the fields you pass are changed. " +
        "content is Quill HTML; inline data: images are extracted to attachments. FAQ " +
        "identifiers are immutable. Requires templates:write.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Template.id"),
        identifier: z.string().optional().describe("Template identifier (ignored for FAQs)"),
        subject: z.string().optional(),
        content: z.string().optional().describe("Body (Quill HTML)"),
        is_enabled: z.boolean().optional(),
        legend: z.string().optional(),
        description: z.string().optional(),
        ordinal: z.number().int().optional().describe("FAQ ordering"),
      },
    },
    async ({ id, ...fields }) =>
      toToolResult(await callV1("templates/update", { template: compact({ id, ...fields }) }, { idempotent: true })),
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
