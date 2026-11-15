import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { resolveContent } from "../attachments.js";
import { actionEnum, errorResult, runAction, type ActionSpec } from "./actions.js";

/**
 * People and their settings: the token owner's own out-of-office and signature, an admin's
 * changes to a user's email address and WhatsApp, watch lists, template translations, and two
 * operator tools (confirming a health alert, a sent mail as .eml).
 */

export function registerAccountTools(server: McpServer): void {
  // ── The token owner's own settings ──────────────────────────────────────

  const periodFields = ["all_day", "start_date", "end_date", "starts_at", "ends_at", "staff_message", "customer_message"];
  const ooo: Record<string, ActionSpec> = {
    list: { path: "settings/availability", fields: [] },
    create: { path: "settings/availability/create", fields: periodFields, required: ["all_day"] },
    update: { path: "settings/availability/update", fields: ["id", ...periodFields], required: ["id"] },
    delete: { path: "settings/availability/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "out_of_office",
    {
      title: "My out-of-office periods",
      description:
        "The token owner's OWN availability (out of office), never anyone else's. list: newest first, with the " +
        "workspace time zone they are in. create: all_day with start_date + end_date (YYYY-MM-DD, whole days in the " +
        "workspace time zone), or all_day false with starts_at + ends_at (ISO 8601); staff_message shows to " +
        "colleagues, customer_message to customers. update: only the fields sent change. delete. An Axial agent " +
        "task's token is refused a create or update that leaves a customer_message on the period (it goes to every " +
        "customer who writes while it lasts); the owner sets that in Settings. Requires a staff owner and " +
        "settings:read (list) or settings:write.",
      inputSchema: {
        action: actionEnum(ooo),
        id: z.number().int().optional(),
        all_day: z.boolean().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD, with all_day"),
        end_date: z.string().optional().describe("YYYY-MM-DD, with all_day"),
        starts_at: z.string().optional().describe("ISO 8601, without all_day"),
        ends_at: z.string().optional().describe("ISO 8601, without all_day"),
        staff_message: z.string().max(2000).nullable().optional(),
        customer_message: z.string().max(2000).nullable().optional(),
      },
    },
    async (args) => runAction("out_of_office", ooo, args as Record<string, unknown>),
  );

  const signature: Record<string, ActionSpec> = {
    get: { path: "settings/signature", fields: [] },
    update: { path: "settings/signature/update", fields: ["signature"], required: [] },
  };
  server.registerTool(
    "my_signature",
    {
      title: "My email signature",
      description:
        "The token owner's OWN signature, as the reply editor has it. get: the workspace policy, whether a personal " +
        "signature is allowed, the system text resolved for the owner, their own text, which one a reply starts with, " +
        "and the placeholders. update: signature (up to 1000 characters; null or '' clears it); saved even when " +
        "personal signatures are off, when it is used only on a reply that chooses it. An Axial agent task's token " +
        "is refused update (the signature goes on the owner's replies to customers). Requires a staff owner and " +
        "settings:read (get) or settings:write.",
      inputSchema: {
        action: actionEnum(signature),
        signature: z.string().max(1000).nullable().optional(),
      },
    },
    async (args) => {
      const a = args as Record<string, unknown>;
      // signature: null clears it, so it is sent as given rather than compacted away.
      if (a.action === "update") {
        if (!("signature" in a) || a.signature === undefined) return errorResult("my_signature update needs `signature` (null clears it): nothing was sent.");
        return toToolResult(await callV1("settings/signature/update", { signature: a.signature }));
      }
      return runAction("my_signature", signature, a);
    },
  );

  // ── A user's account (admin) ────────────────────────────────────────────

  const u = (a: Record<string, unknown>) => `administration/users/${encodeURIComponent(String(a.user_id))}`;
  const account: Record<string, ActionSpec> = {
    email_change: { path: (a) => `${u(a)}/email`, pathFields: ["user_id"], fields: ["email"], required: ["user_id", "email"] },
    email_resend: { path: (a) => `${u(a)}/email/resend`, pathFields: ["user_id"], fields: [], required: ["user_id"] },
    email_cancel: { path: (a) => `${u(a)}/email/cancel`, pathFields: ["user_id"], fields: [], required: ["user_id"] },
    whatsapp_start: { path: (a) => `${u(a)}/whatsapp/start`, pathFields: ["user_id"], fields: ["number"], required: ["user_id", "number"] },
    whatsapp_status: { path: (a) => `${u(a)}/whatsapp/status`, pathFields: ["user_id"], fields: [], required: ["user_id"] },
    whatsapp_quiet: {
      path: (a) => `${u(a)}/whatsapp/quiet`,
      pathFields: ["user_id"],
      fields: ["dnd_enabled", "dnd_start", "dnd_end", "dnd_when_away", "dnd_send_held", "dnd_alerts_through", "timezone"],
      required: ["user_id", "dnd_enabled", "dnd_when_away"],
    },
    whatsapp_remove: { path: (a) => `${u(a)}/whatsapp/remove`, pathFields: ["user_id"], fields: [], required: ["user_id"] },
  };
  server.registerTool(
    "user_account",
    {
      title: "Change a user's email address or WhatsApp (admin)",
      description:
        "Administration > Users & queues, besides details and queue rights. email_change: a link to confirm goes to " +
        "the new address and only a click on it changes anything; email_resend sends it again with a new expiry; " +
        "email_cancel stops it working. whatsapp_start: sends a code to the number (international format), which the " +
        "user types on their own profile within a day (staff only). whatsapp_status: the number's state and the " +
        "code's delivery. whatsapp_quiet: Do Not Disturb. whatsapp_remove: nothing more is sent to the number. An " +
        "admin never acts on a sysadmin's or superuser's account (only a sysadmin does), nor on the system account, " +
        "nor on their own (that is their profile). Deleting a user and the two-factor reset are not available. " +
        "Requires an admin owner and administration:write (whatsapp_status: administration:read).",
      inputSchema: {
        action: actionEnum(account),
        user_id: z.union([z.number().int(), z.string()]).optional().describe("The user's id (list_staff)"),
        email: z.string().email().optional().describe("email_change: the new address"),
        number: z.string().max(32).optional().describe("whatsapp_start: e.g. +447700900123"),
        dnd_enabled: z.boolean().optional(),
        dnd_start: z.string().max(5).nullable().optional().describe("HH:MM"),
        dnd_end: z.string().max(5).nullable().optional().describe("HH:MM"),
        dnd_when_away: z.boolean().optional().describe("Quiet while out of office"),
        dnd_send_held: z.boolean().optional().describe("Send what was held when the quiet time ends"),
        dnd_alerts_through: z.boolean().optional().describe("Let Alerts through"),
        timezone: z.string().max(64).nullable().optional(),
      },
    },
    async (args) => runAction("user_account", account, args as Record<string, unknown>),
  );

  // ── Watch lists ─────────────────────────────────────────────────────────

  const listFields = ["name", "icon", "description", "shared", "display_mode", "show_in_my_perspectives", "user_id"];
  const tickets = ["watchlist_id", "ticket_numbers", "ticket_ids"];
  const watchlists: Record<string, ActionSpec> = {
    create: { path: "settings/watchlists/create", fields: [...listFields, "ticket_ids"], required: ["name", "icon", "shared"] },
    update: { path: "settings/watchlists/update", fields: ["watchlist_id", ...listFields], required: ["watchlist_id", "name", "icon"] },
    delete: { path: "settings/watchlists/delete", fields: ["watchlist_id", "force"], required: ["watchlist_id"] },
    add_tickets: {
      path: "settings/watchlists/add-tickets",
      fields: [...tickets, "show_in_my_perspectives"],
      required: ["watchlist_id", "ticket_numbers|ticket_ids"],
    },
    remove_tickets: { path: "settings/watchlists/remove-tickets", fields: tickets, required: ["watchlist_id", "ticket_numbers|ticket_ids"] },
    reorder: { path: "settings/watchlists/reorder", fields: tickets, required: ["watchlist_id", "ticket_numbers|ticket_ids"] },
  };
  server.registerTool(
    "manage_watchlist",
    {
      title: "Create, change or delete a watch list, or add, remove or reorder its tickets",
      description:
        "Watch lists (list_watchlists reads them). create (name, icon and shared; only an admin makes a shared list, or " +
        "a private one for someone else with user_id) / update (needs name and icon, as the page does) / " +
        "delete (force when it has tickets). add_tickets: tickets already on it stay where they are, new ones go to " +
        "its end. remove_tickets. reorder: the list's tickets in their new order. Tickets by ticket_numbers or " +
        "ticket_ids. A private list's tickets are added, removed and reordered only by its owner (not by an admin), " +
        "and added or reordered only with tickets they can see; remove_tickets also takes a ticket since deleted or " +
        "no longer in their sight. A shared list is open to every member of staff; the Axial notes list is kept by " +
        "the system. Requires a staff owner and settings:write.",
      inputSchema: {
        action: actionEnum(watchlists),
        watchlist_id: z.number().int().optional(),
        name: z.string().max(255).optional(),
        icon: z.string().max(50).optional().describe("The list's icon name, as list_watchlists shows"),
        description: z.string().max(255).nullable().optional(),
        shared: z.boolean().optional().describe("create (required) / update: shared with every member of staff"),
        display_mode: z.enum(["card", "list"]).optional(),
        show_in_my_perspectives: z.boolean().optional(),
        user_id: z.number().int().optional().describe("The owner (an admin making a list for someone)"),
        ticket_numbers: z.array(z.string()).min(1).max(500).optional(),
        ticket_ids: z.array(z.number().int()).min(1).max(500).optional(),
        force: z.boolean().optional().describe("delete: even with tickets on it"),
      },
    },
    async (args) => runAction("manage_watchlist", watchlists, args as Record<string, unknown>),
  );

  // ── Template translations ───────────────────────────────────────────────

  server.registerTool(
    "template_translation",
    {
      title: "Read, save or delete a template's translation",
      description:
        "A template's variant in one language (FAQs, emails, notifications; the editor's language tabs; stock " +
        "responses have none). get: exists, stale (the English changed since), subject, legend, content and the " +
        "English; with no variant yet the English is given as the starting point. update: creates or changes the " +
        "variant; fields left out keep their values (a new one needs content, and a subject unless it is a " +
        "notification); stamped against the current English. delete: the English is untouched. From Axial (an " +
        "agent task's token, or a call Axial makes itself), update and delete are refused with a 403: a " +
        "translation is what those customers are sent, with nobody approving each one, so say what you would " +
        "change, for an administrator to do. Requires an admin owner and templates:read (get) or templates:write.",
      inputSchema: {
        action: z.enum(["get", "update", "delete"]),
        template_id: z.number().int(),
        locale: z.string().max(16).describe("A supported language other than English, e.g. 'de'"),
        subject: z.string().optional(),
        content: z.string().optional().describe("update: the HTML"),
        content_path: z.string().optional().describe("update: a local file holding the HTML, instead of content"),
        legend: z.string().optional(),
      },
    },
    async (args) => {
      const { action, content, content_path, ...rest } = args as Record<string, unknown>;
      const spec: Record<string, ActionSpec> = {
        get: { path: "templates/localisation", fields: ["template_id", "locale"] },
        update: { path: "templates/localisation/update", fields: ["template_id", "locale", "subject", "content", "legend"] },
        delete: { path: "templates/localisation/delete", fields: ["template_id", "locale"] },
      };
      return runAction("template_translation", spec, { action, ...rest, content: resolveContent(content, content_path) });
    },
  );

  // ── Operator tools ──────────────────────────────────────────────────────

  server.registerTool(
    "confirm_alert",
    {
      title: "Confirm a latched health alert",
      description:
        "Mark a latched health alert as looked at, so /health may turn green again (the Health page's Confirm). id " +
        "comes from the supervisor health/manage `alerts` (tickiti_call supervisor health.manage). An id that is not " +
        "an unconfirmed latched alert is a 404. Returns the alerts still waiting. Requires a superuser owner and " +
        "supervisor:write.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => toToolResult(await callV1("supervisor/health/alerts/confirm", { id })),
  );

  server.registerTool(
    "download_sent_mail",
    {
      title: "Save a sent email as an .eml file",
      description:
        "Save a message from the sent-mail archive exactly as it was sent (RFC 822, headers and every part) to a " +
        "local .eml file, in byte ranges; the bytes never pass through the model. id comes from search_sent_mail. " +
        "Returns { path, bytes, filename }. Requires a superuser owner (as the page's Download) and mail:read.",
      inputSchema: {
        id: z.number().int().describe("The sent mail's id"),
        path: z.string().describe("Absolute local output path (overwritten; missing folders are created)"),
        chunk_bytes: z.number().int().min(1).max(25 * 1024 * 1024).optional().describe("Bytes per request (default 8 MiB)"),
      },
    },
    async ({ id, path, chunk_bytes }) => {
      const length = chunk_bytes ?? 8 * 1024 * 1024;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.alloc(0));
      } catch (e) {
        return errorResult(`cannot write ${path} — ${e instanceof Error ? e.message : String(e)}`);
      }
      let offset = 0;
      let filename = "";
      for (let i = 0; i < 10000; i++) {
        const r = await callV1("mail/sent-mail/eml", { id, offset, length });
        if (!r.ok) return toToolResult(r);
        const d = ((r.body as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
        filename = String(d.filename ?? filename);
        const buf = Buffer.from(typeof d.content_base64 === "string" ? d.content_base64 : "", "base64");
        appendFileSync(path, buf);
        offset += buf.length;
        if (d.eof || buf.length === 0) break;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ path, bytes: offset, filename }, null, 2) }] };
    },
  );
}
