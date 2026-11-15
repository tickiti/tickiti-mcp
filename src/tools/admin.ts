import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1, instanceList, uploadFileV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { resolveContent } from "../attachments.js";

/**
 * Mail, templates, perspectives, API keys and instances - the parts of the API
 * that were reachable only through tickiti_call with guessed payloads, or not at all.
 */

/** Strip undefined keys so the API call body only carries supplied fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerAdminTools(server: McpServer): void {
  // ── Mail ────────────────────────────────────────────────────────────────

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send an email from a tenant mailbox: either subject + content (HTML), or an email template " +
        "(template_identifier + data, the template's tokens). Not tied to a ticket. Requires mail:write " +
        "(and an admin token owner).",
      inputSchema: {
        to_address: z.string().describe("Recipient"),
        cc: z.array(z.string().email()).optional(),
        subject: z.string().optional().describe("With content"),
        content: z.string().optional().describe("HTML body, with subject"),
        content_path: z.string().optional().describe("Local file holding the HTML body, instead of content"),
        template_identifier: z.string().optional().describe("An email template's identifier, with data"),
        data: z.record(z.any()).optional().describe("Token values for the template"),
        mailbox: z.string().optional().describe("Sending mailbox name (default: the tenant's)"),
        validate_address: z.boolean().optional().describe("Refuse a malformed to_address now rather than failing later"),
      },
    },
    async (args) => {
      const { content, content_path, ...rest } = args as Record<string, unknown>;
      return toToolResult(
        await callV1("mail/send", compact({ ...rest, content: resolveContent(content, content_path) }), { idempotent: true }),
      );
    },
  );

  server.registerTool(
    "search_sent_mail",
    {
      title: "Search sent mail",
      description:
        "Search the sent-mail archive by subject or recipient address (q). Empty results mean no match. " +
        "Requires mail:read.",
      inputSchema: {
        q: z.string().describe("Text in the subject or the to-address"),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ q, limit }) => toToolResult(await callV1("mail/sent-mail/search", compact({ q, limit }))),
  );

  // ── Templates ───────────────────────────────────────────────────────────

  server.registerTool(
    "render_template",
    {
      title: "Render a template (dry run)",
      description:
        "Render a template against data and return the subject and HTML it would send - nothing is sent. " +
        "Check a template's output before using it. Requires templates:read.",
      inputSchema: {
        template_identifier: z.string(),
        data: z.record(z.any()).describe("Token values"),
        type: z.string().optional().describe("Template type (default 'email')"),
      },
    },
    async (args) => toToolResult(await callV1("templates/render", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "upload_template_image",
    {
      title: "Upload an image for a template or stock response",
      description:
        "Upload a local image file for a template, FAQ or stock response and get back its cid reference and " +
        "an <img> tag to place in the content (then update_template / update_stock_response). The bytes " +
        "never pass through the model. Stock responses need settings:write; other templates templates:write. " +
        "From Axial (an agent task's token, or a call Axial makes itself), an image for an email, notification, " +
        "intervention or FAQ template is refused with a 403: those go to customers with nobody approving each one.",
      inputSchema: {
        template_id: z.union([z.string(), z.number()]).describe("Template.id (or stock response id)"),
        path: z.string().describe("Local image file"),
        stock_response: z.boolean().optional().describe("True for a stock response (settings family)"),
      },
    },
    async ({ template_id, path, stock_response }) =>
      toToolResult(
        await uploadFileV1(
          path,
          undefined,
          stock_response ? "settings/stock-responses/image-upload" : "templates/image-upload",
          { template_id: String(template_id) },
        ),
      ),
  );

  // ── Perspectives ────────────────────────────────────────────────────────

  server.registerTool(
    "get_perspective",
    {
      title: "Get a perspective with its conditions and sort order",
      description:
        "Read one perspective (saved view) by id or name, with its conditions and sort orders. Requires settings:read.",
      inputSchema: {
        perspective_id: z.number().int().optional(),
        name: z.string().optional().describe("Perspective name (yours or shared)"),
      },
    },
    async (args) => toToolResult(await callV1("settings/perspectives/show", compact({ ...(args as Record<string, unknown>) }))),
  );

  // ── API keys ────────────────────────────────────────────────────────────

  server.registerTool(
    "list_api_tokens",
    {
      title: "List API keys",
      description:
        "The tenant's Tickiti API keys (no secrets): owner, abilities, IP allow-list, last use. Older Tickiti keys " +
        "holding legacy abilities are listed too: `abilities` shows only their registry abilities and has_legacy " +
        "is true (the legacy ones are not named). Keys of other applications sharing the database, and Axial's " +
        "own internal keys, are not listed. Requires administration:read.",
      inputSchema: {},
    },
    async () => toToolResult(await callV1("administration/api-tokens", {})),
  );

  server.registerTool(
    "create_api_token",
    {
      title: "Create an API key",
      description:
        "Mint an API key. A token can only grant abilities it holds itself (list_api_tokens shows which), so " +
        "this can rotate or narrow access, never widen it - wider keys are made in Administration → API keys. " +
        "tickets:customer_impersonation (open tickets and post responses as the customer, for an integration " +
        "such as a website contact form) is granted by an admin, only on a key owned by System or an API user, " +
        "and only with tickets:write in the same abilities (it does not imply tickets:read); the key holds it " +
        "only while its owner is still System or an API user. " +
        "Returns the plain-text token once. Requires administration:write.",
      inputSchema: {
        name: z.string().max(255).describe("Description of the key"),
        owner: z.string().describe("'system' or a staff or API user id"),
        abilities: z
          .array(z.string())
          .min(1)
          .describe(
            "e.g. ['tickets:read','tickets:write'], or ['tickets:write','tickets:customer_impersonation'] for a " +
              "contact-form integration (System/API-user owner only)",
          ),
        allowed_ip: z.string().optional().describe("Only accept the key from this IP"),
      },
    },
    async (args) => toToolResult(await callV1("administration/api-tokens/create", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "update_api_token",
    {
      title: "Change an API key",
      description:
        "Change a key's abilities (only to ones this token holds), IP allow-list (null clears it) or name. " +
        "tickets:customer_impersonation follows create_api_token's rules (System/API-user owner, with " +
        "tickets:write). A key with legacy abilities (has_legacy in list_api_tokens) can have its IP allow-list " +
        "set or changed (never cleared: 422, errors.allowed_ip) and its name changed, but not its abilities: " +
        "make a new key instead. Requires administration:write.",
      inputSchema: {
        id: z.union([z.string(), z.number()]),
        abilities: z.array(z.string()).min(1).optional(),
        allowed_ip: z.string().nullable().optional(),
        name: z.string().max(255).optional(),
      },
    },
    async (args) => toToolResult(await callV1("administration/api-tokens/update", compact({ ...(args as Record<string, unknown>) }))),
  );

  server.registerTool(
    "revoke_api_token",
    {
      title: "Revoke an API key",
      description:
        "Delete an API key; anything using it stops working at once. Any key list_api_tokens shows can be " +
        "revoked, legacy ones included; a key it doesn't show answers 'Token not found.'. Requires administration:write.",
      inputSchema: { id: z.union([z.string(), z.number()]) },
    },
    async ({ id }) => toToolResult(await callV1("administration/api-tokens/revoke", { id })),
  );

  // ── Instances ───────────────────────────────────────────────────────────

  server.registerTool(
    "list_instances",
    {
      title: "List configured Tickiti instances",
      description:
        "The Tickiti instances this server is configured for (name and address, no tokens). Every tool takes an " +
        "optional `instance` naming one of them; the first is the default.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ instances: instanceList() }, null, 2) }],
    }),
  );
}
