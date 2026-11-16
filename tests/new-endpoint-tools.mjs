// The typed tools over the v1 endpoints added with 0.3.0 (bulk update, checklist, reminders,
// pins, tags, the owner's own state, Send later, reviews, automations, SLA, recurring tasks,
// checklist templates, holidays, interventions, attachment rules, the Axial panel, Axial
// conversations and settings, reports, out of office, signature, user accounts, watch lists,
// translations, alerts, sent mail as .eml): each action reaches an endpoint in the manifest
// with only its own fields, a field of another action or a missing one is refused before
// anything is sent, and the two endpoints that need an Idempotency-Key get one.
// Run: node tests/new-endpoint-tools.mjs (build first: npm run build). Needs no Tickiti.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MANIFEST } from "../dist/generated/manifest.js";

const seen = [];
let reply = () => ({ status: 200, body: { ok: true, data: {} } });
const stub = createServer((req, res) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    const row = { url: req.url, body: text ? JSON.parse(text) : undefined, idem: req.headers["idempotency-key"] };
    if (req.url === "/api/v1/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: {} }));
      return;
    }
    seen.push(row);
    const r = reply(row);
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
  env: {
    ...process.env,
    TICKITI_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    TICKITI_API_TOKEN: "test-token",
    TICKITI_INSTANCES: "",
    TICKITI_MCP_FILE_ROOTS: "",
  },
});
const client = new Client({ name: "new-endpoint-tools", version: "0" });
await client.connect(transport);
const dir = mkdtempSync(join(tmpdir(), "tickiti-new-"));

let passed = 0;
async function ok(name, fn) {
  reply = () => ({ status: 200, body: { ok: true, data: {} } });
  await fn();
  passed++;
  console.log("  ✓ " + name);
}

async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content?.map((c) => c.text ?? "").join("\n") ?? "" };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e) };
  }
}

const uris = new Set(MANIFEST.map((e) => "/api/v1/" + e.uri));
const uriMatches = (url) =>
  [...uris].some((u) => new RegExp("^" + u.replace(/\{\w+\}/g, "[^/]+") + "$").test(url.replace(/\?.*$/, "")));

// [tool, arguments, path called, body sent]
const CASES = [
  ["update_tickets", { ticket_numbers: ["101", "102"], status: "on-hold", on_hold_until: "2026-12-01", dry_run: true },
    "tickets/update-many", { ticket_numbers: ["101", "102"], status: "on-hold", on_hold_until: "2026-12-01", dry_run: true }],
  ["ticket_checklist", { action: "get", ticket_number: "101" }, "tickets/checklist", { ticket_number: "101" }],
  ["ticket_checklist", { action: "add", ticket_number: "101", items: ["a", "b"] }, "tickets/checklist/add", { ticket_number: "101", items: ["a", "b"] }],
  ["ticket_checklist", { action: "update", ticket_number: "101", item_id: 4, is_done: true }, "tickets/checklist/update", { ticket_number: "101", item_id: 4, is_done: true }],
  ["ticket_checklist", { action: "reorder", ticket_id: 9, ids: [2, 1] }, "tickets/checklist/reorder", { ticket_id: 9, ids: [2, 1] }],
  ["ticket_checklist", { action: "delete", ticket_number: "101", all: true }, "tickets/checklist/delete", { ticket_number: "101", all: true }],
  ["ticket_reminders", { action: "list", ticket_number: "101" }, "tickets/reminders", { ticket_number: "101" }],
  ["ticket_reminders", { action: "add", ticket_number: "101", next_at: "2026-12-01T09:00", repeat_every: 1, repeat_unit: "week" },
    "tickets/reminders/add", { ticket_number: "101", next_at: "2026-12-01T09:00", repeat_every: 1, repeat_unit: "week" }],
  ["ticket_reminders", { action: "delete", ticket_number: "101", reminder_id: 3 }, "tickets/reminders/delete", { ticket_number: "101", reminder_id: 3 }],
  ["pin_response", { response_id: 5, pinned: false }, "tickets/response-pin", { response_id: 5, pinned: false }],
  ["restore_response", { response_id: 5 }, "tickets/response-restore", { response_id: 5 }],
  ["ticket_tags", { action: "list", ticket_number: "101", mine: true }, "tickets/tags", { ticket_number: "101", mine: true }],
  ["ticket_tags", { action: "acknowledge", response_tag_id: 7 }, "tickets/tag-ack", { response_tag_id: 7 }],
  ["my_ticket_state", { action: "get", ticket_numbers: ["101"] }, "tickets/user-state", { ticket_numbers: ["101"] }],
  ["my_ticket_state", { action: "update", ticket_numbers: ["101"], note: null }, "tickets/user-state/update", { ticket_numbers: ["101"], note: null }],
  ["get_share_link", { ticket_number: "101", response_id: 5 }, "tickets/external-link", { ticket_number: "101", response_id: 5 }],
  ["scheduled_replies", { action: "list" }, "tickets/scheduled", {}],
  ["scheduled_replies", { action: "cancel", ticket_number: "101" }, "tickets/scheduled/cancel", { ticket_number: "101" }],
  ["scheduled_replies", { action: "send_now", ticket_number: "101" }, "tickets/scheduled/send-now", { ticket_number: "101" }],
  ["scheduled_replies", { action: "reschedule", ticket_number: "101", send_at: "2026-12-01T09:00:00Z" },
    "tickets/scheduled/reschedule", { ticket_number: "101", send_at: "2026-12-01T09:00:00Z" }],
  ["list_reviews", { reason: "duplicate", limit: 5 }, "tickets/reviews", { reason: "duplicate", limit: 5 }],
  ["resolve_review", { review_id: 2, decision: "keep" }, "tickets/review-resolve", { review_id: 2, decision: "keep" }],
  ["move_queue_tickets", { from_queue: "A", to_queue: "B", dry_run: true }, "workflow/queues/move-tickets", { from_queue: "A", to_queue: "B", dry_run: true }],
  ["move_queue_tickets", { from_queue_id: 3, to_queue_id: 4, limit: 50, after_id: 1200 }, "workflow/queues/move-tickets",
    { from_queue_id: 3, to_queue_id: 4, limit: 50, after_id: 1200 }],
  ["automations", { action: "list", with_options: true }, "workflow/automations", { with_options: true }],
  ["automations", { action: "create", name: "R", event: "ticket.created", actions: [{ type: "set_priority", priority: "30" }] },
    "workflow/automations/create", { name: "R", event: "ticket.created", actions: [{ type: "set_priority", priority: "30" }] }],
  ["automations", { action: "update", id: 1, conditions: [{ field: "subject", operator: "contains", value: "x" }] },
    "workflow/automations/update", { id: 1, conditions: [{ field: "subject", operator: "contains", value: "x" }] }],
  ["automations", { action: "toggle", id: 1, is_enabled: false }, "workflow/automations/toggle", { id: 1, is_enabled: false }],
  ["automations", { action: "reorder", ids: [2, 1] }, "workflow/automations/reorder", { ids: [2, 1] }],
  ["automations", { action: "delete", id: 1 }, "workflow/automations/delete", { id: 1 }],
  ["automations", { action: "test", id: 1, ticket_number: "101" }, "workflow/automations/test", { id: 1, ticket_number: "101" }],
  ["automations", { action: "runs", id: 1 }, "workflow/automations/runs", { id: 1 }],
  ["sla_policies", { action: "list" }, "workflow/sla-policies", {}],
  ["sla_policies", { action: "create", name: "P", first_response_minutes: 60 }, "workflow/sla-policies/create", { name: "P", first_response_minutes: 60 }],
  ["sla_policies", { action: "update", id: 1, is_enabled: false }, "workflow/sla-policies/update", { id: 1, is_enabled: false }],
  ["sla_policies", { action: "reorder", ids: [1] }, "workflow/sla-policies/reorder", { ids: [1] }],
  ["sla_policies", { action: "delete", id: 1, confirm: true }, "workflow/sla-policies/delete", { id: 1, confirm: true }],
  ["recurring_tasks", { action: "list" }, "workflow/recurring-tasks", {}],
  ["recurring_tasks", { action: "update", id: 1, is_enabled: false }, "workflow/recurring-tasks/update", { id: 1, is_enabled: false }],
  ["recurring_tasks", { action: "delete", id: 1 }, "workflow/recurring-tasks/delete", { id: 1 }],
  ["checklist_templates", { action: "list" }, "workflow/checklist-templates", {}],
  ["checklist_templates", { action: "create", name: "T", items: ["a"] }, "workflow/checklist-templates/create", { name: "T", items: ["a"] }],
  ["checklist_templates", { action: "update", id: 1, name: "U" }, "workflow/checklist-templates/update", { id: 1, name: "U" }],
  ["checklist_templates", { action: "reorder", ids: [1] }, "workflow/checklist-templates/reorder", { ids: [1] }],
  ["checklist_templates", { action: "delete", id: 1 }, "workflow/checklist-templates/delete", { id: 1 }],
  ["holidays", { action: "list" }, "workflow/holidays", {}],
  ["holidays", { action: "create", date: "2026-12-25", name: "Xmas", recurring: true }, "workflow/holidays/create", { date: "2026-12-25", name: "Xmas", recurring: true }],
  ["holidays", { action: "delete", id: 1 }, "workflow/holidays/delete", { id: 1 }],
  ["interventions", { action: "list" }, "workflow/interventions", {}],
  ["interventions", { action: "update", intervention_id: 1, assign_to_email: null }, "workflow/interventions/update", { intervention_id: 1, assign_to_email: null }],
  ["interventions", { action: "update", intervention_id: 1, axial_note: "Waiting on sales" }, "workflow/interventions/update", { intervention_id: 1, axial_note: "Waiting on sales" }],
  ["interventions", {
    action: "create", name: "quote_request", title: "Quote", axial_note: "Waiting on sales", queue_name: "Sales",
    create_urgent: false, notify_inbox_managers: true, remote_enabled: false, remote_timeout_seconds: 30,
  }, "workflow/interventions/create", {
    name: "quote_request", title: "Quote", axial_note: "Waiting on sales", queue_name: "Sales",
    create_urgent: false, notify_inbox_managers: true, remote_enabled: false, remote_timeout_seconds: 30,
  }],
  ["interventions", { action: "delete", intervention_id: 1 }, "workflow/interventions/delete", { intervention_id: 1 }],
  ["mail_attachment_rules", { action: "list", q: "zip" }, "mail/attachment-rules", { q: "zip" }],
  ["mail_attachment_rules", { action: "create", extension: "zip", rule: "always_allowed" }, "mail/attachment-rules/create", { extension: "zip", rule: "always_allowed" }],
  ["mail_attachment_rules", { action: "update", id: 1, note: "n" }, "mail/attachment-rules/update", { id: 1, note: "n" }],
  ["mail_attachment_rules", { action: "delete", id: 1 }, "mail/attachment-rules/delete", { id: 1 }],
  ["axial_panel_action", { action: "approve_action", ticket_number: "101", call_id: 3, decision: "reject", reason: "no" },
    "axial/chat/approval", { ticket_number: "101", call_id: 3, decision: "reject", reason: "no" }],
  ["axial_panel_action", { action: "shared_note", ticket_number: "101", note_id: 2, decision: "discard" }, "axial/chat/shared-note", { ticket_number: "101", note_id: 2, decision: "discard" }],
  ["axial_panel_action", { action: "redraft", ticket_number: "101" }, "axial/chat/redraft", { ticket_number: "101" }],
  ["axial_panel_action", { action: "respond_again", ticket_number: "101" }, "axial/chat/respond-again", { ticket_number: "101" }],
  ["axial_panel_action", { action: "add_note", ticket_number: "101", response_id: 5 }, "axial/chat/note", { ticket_number: "101", response_id: 5 }],
  ["axial_panel_action", { action: "cancel_queued", ticket_number: "101", id: "q1" }, "axial/chat/queue/cancel", { ticket_number: "101", id: "q1" }],
  ["axial_panel_action", { action: "agent_task", ticket_number: "101", instruction: "x" }, "axial/chat/agent-task", { ticket_number: "101", instruction: "x" }],
  ["axial_panel_action", { action: "investigate", ticket_number: "101" }, "axial/chat/agent-task/deep", { ticket_number: "101" }],
  ["axial_panel_action", { action: "stop_task", ticket_number: "101", task_id: 4 }, "axial/chat/agent-task/stop", { ticket_number: "101", task_id: 4 }],
  ["axial_panel_action", { action: "set_skill", ticket_number: "101", skill_key: "k", op: "primary" }, "axial/chat/skill", { ticket_number: "101", skill_key: "k", op: "primary" }],
  ["axial_panel_action", { action: "turn_on", ticket_number: "101" }, "axial/chat/turn-on", { ticket_number: "101" }],
  ["axial_panel_action", { action: "approve_translations", ticket_number: "101", run_id: 8 }, "axial/chat/translations/approve", { ticket_number: "101", run_id: 8 }],
  ["axial_panel_action", { action: "skill_proposal", ticket_number: "101", proposal_id: 1, decision: "discard" }, "axial/chat/skill-proposal", { ticket_number: "101", proposal_id: 1, decision: "discard" }],
  ["axial_conversations", { action: "list" }, "axial/conversations", {}],
  ["axial_conversations", { action: "show", conversation_id: 1 }, "axial/conversations/show", { conversation_id: 1 }],
  ["axial_conversations", { action: "create", message: "hi" }, "axial/conversations/create", { message: "hi" }],
  ["axial_conversations", { action: "message", conversation_id: 1, message: "hi" }, "axial/conversations/message", { conversation_id: 1, message: "hi" }],
  ["axial_conversations", { action: "stop", conversation_id: 1, task_id: 2 }, "axial/conversations/stop", { conversation_id: 1, task_id: 2 }],
  ["axial_conversations", { action: "update", conversation_id: 1, title: "T" }, "axial/conversations/update", { conversation_id: 1, title: "T" }],
  ["axial_settings", { action: "get" }, "axial/settings", {}],
  ["axial_settings", { action: "update", settings: { axial_enabled: true, ai_persona: "p" } }, "axial/settings/update", { axial_enabled: true, ai_persona: "p" }],
  ["axial_settings", { action: "skill_store" }, "axial/skill-store", {}],
  ["axial_settings", { action: "skill_store_update", store: "database" }, "axial/skill-store/update", { store: "database" }],
  ["axial_settings", { action: "skill_store_sync" }, "axial/skill-store/sync", {}],
  ["axial_settings", { action: "attachment_rules" }, "axial/attachment-rules", {}],
  ["axial_settings", { action: "attachment_rule_save", extension: "pdf", mode: "auto" }, "axial/attachment-rules/save", { extension: "pdf", mode: "auto" }],
  ["axial_settings", { action: "attachment_rule_delete", id: 1 }, "axial/attachment-rules/delete", { id: 1 }],
  ["run_report", { report: "sla", filters: { date_from: "2026-11-01", date_to: "2026-11-13", group_by: "day" } },
    "reports/sla", { date_from: "2026-11-01", date_to: "2026-11-13", group_by: "day" }],
  ["run_report", { report: "satisfaction" }, "reports/satisfaction", {}],
  ["run_report", { report: "axial-usage" }, "axial/usage", {}],
  ["run_report", { report: "axial-reports", filters: { period: "month" } }, "axial/reports", { period: "month" }],
  ["out_of_office", { action: "list" }, "settings/availability", {}],
  ["out_of_office", { action: "create", all_day: true, start_date: "2026-12-24", end_date: "2026-12-26" },
    "settings/availability/create", { all_day: true, start_date: "2026-12-24", end_date: "2026-12-26" }],
  ["out_of_office", { action: "update", id: 1, staff_message: "away" }, "settings/availability/update", { id: 1, staff_message: "away" }],
  ["out_of_office", { action: "delete", id: 1 }, "settings/availability/delete", { id: 1 }],
  ["my_signature", { action: "get" }, "settings/signature", {}],
  ["my_signature", { action: "update", signature: null }, "settings/signature/update", { signature: null }],
  ["user_account", { action: "email_change", user_id: 15, email: "new@example.com" }, "administration/users/15/email", { email: "new@example.com" }],
  ["user_account", { action: "email_resend", user_id: 15 }, "administration/users/15/email/resend", {}],
  ["user_account", { action: "email_cancel", user_id: 15 }, "administration/users/15/email/cancel", {}],
  ["user_account", { action: "whatsapp_start", user_id: 15, number: "+447700900123" }, "administration/users/15/whatsapp/start", { number: "+447700900123" }],
  ["user_account", { action: "whatsapp_status", user_id: 15 }, "administration/users/15/whatsapp/status", {}],
  ["user_account", { action: "whatsapp_quiet", user_id: 15, dnd_enabled: false, dnd_when_away: true },
    "administration/users/15/whatsapp/quiet", { dnd_enabled: false, dnd_when_away: true }],
  ["user_account", { action: "whatsapp_remove", user_id: 15 }, "administration/users/15/whatsapp/remove", {}],
  ["list_watchlists", { owner: "me", with_tickets: true }, "settings/watchlists", { owner: "me", with_tickets: true }],
  ["manage_watchlist", { action: "create", name: "W", icon: "star", shared: false }, "settings/watchlists/create", { name: "W", icon: "star", shared: false }],
  ["manage_watchlist", { action: "update", watchlist_id: 1, name: "W", icon: "star", shared: true },
    "settings/watchlists/update", { watchlist_id: 1, name: "W", icon: "star", shared: true }],
  ["manage_watchlist", { action: "delete", watchlist_id: 1, force: true }, "settings/watchlists/delete", { watchlist_id: 1, force: true }],
  ["manage_watchlist", { action: "add_tickets", watchlist_id: 1, ticket_numbers: ["101"] }, "settings/watchlists/add-tickets", { watchlist_id: 1, ticket_numbers: ["101"] }],
  ["manage_watchlist", { action: "remove_tickets", watchlist_id: 1, ticket_ids: [9] }, "settings/watchlists/remove-tickets", { watchlist_id: 1, ticket_ids: [9] }],
  ["manage_watchlist", { action: "reorder", watchlist_id: 1, ticket_numbers: ["102", "101"] }, "settings/watchlists/reorder", { watchlist_id: 1, ticket_numbers: ["102", "101"] }],
  ["template_translation", { action: "get", template_id: 3, locale: "de" }, "templates/localisation", { template_id: 3, locale: "de" }],
  ["template_translation", { action: "update", template_id: 3, locale: "de", content: "<p>Hallo</p>" },
    "templates/localisation/update", { template_id: 3, locale: "de", content: "<p>Hallo</p>" }],
  ["template_translation", { action: "delete", template_id: 3, locale: "de" }, "templates/localisation/delete", { template_id: 3, locale: "de" }],
  ["confirm_alert", { id: 4 }, "supervisor/health/alerts/confirm", { id: 4 }],
  ["get_response", { response_id: 5, include: ["original_html", "reply_text"] }, "tickets/response", { response_id: 5, include: ["original_html", "reply_text"] }],
];

try {
  await ok("each action calls its own endpoint, one in the manifest, with only its fields", async () => {
    for (const [tool, args, path, body] of CASES) {
      const before = seen.length;
      const r = await call(tool, args);
      assert.equal(r.isError, false, `${tool} ${JSON.stringify(args)}: ${r.text}`);
      assert.equal(seen.length, before + 1, `${tool} ${args.action ?? ""} made one call`);
      const row = seen[seen.length - 1];
      assert.equal(row.url, `/api/v1/${path}`, `${tool} ${args.action ?? ""}`);
      assert.ok(uriMatches(row.url), `${row.url} is in the manifest`);
      assert.deepEqual(row.body, body, `${tool} ${args.action ?? ""} body`);
      assert.equal(row.idem, undefined, `${tool} ${args.action ?? ""} sends no Idempotency-Key`);
    }
  });

  await ok("tag and run_now send an Idempotency-Key, as their endpoints require", async () => {
    await call("ticket_tags", { action: "tag", response_id: 5, emails: ["a@example.com"], comment: "look" });
    let row = seen[seen.length - 1];
    assert.equal(row.url, "/api/v1/tickets/tag");
    assert.deepEqual(row.body, { response_id: 5, emails: ["a@example.com"], comment: "look" });
    assert.ok(row.idem);
    await call("recurring_tasks", { action: "run_now", id: 2 });
    row = seen[seen.length - 1];
    assert.equal(row.url, "/api/v1/workflow/recurring-tasks/run-now");
    assert.ok(row.idem);
  });

  await ok("a field another action takes is refused by name, and nothing is sent", async () => {
    const before = seen.length;
    const r = await call("ticket_checklist", { action: "get", ticket_number: "101", text: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /action 'get' does not take 'text'/);
    const r2 = await call("axial_settings", { action: "get", settings: { a: 1 } });
    assert.equal(r2.isError, true);
    const r3 = await call("axial_settings", { action: "update", settings: { a: 1 }, store: "git" });
    assert.equal(r3.isError, true);
    assert.equal(seen.length, before);
  });

  await ok("a missing argument is refused, naming the alternatives", async () => {
    const before = seen.length;
    let r = await call("ticket_checklist", { action: "add", ticket_number: "101" });
    assert.match(r.text, /needs text or items or template_id/);
    r = await call("ticket_reminders", { action: "list" });
    assert.match(r.text, /needs ticket_number or ticket_id/);
    r = await call("user_account", { action: "whatsapp_status" });
    assert.match(r.text, /needs user_id/);
    r = await call("my_signature", { action: "update" });
    assert.equal(r.isError, true);
    assert.equal(seen.length, before);
  });

  await ok("unknown arguments and wrong enums are refused by the schema", async () => {
    const before = seen.length;
    let r = await call("update_tickets", { ticket_numbers: ["1"], status: "pending" });
    assert.equal(r.isError, true);
    r = await call("pin_response", { response_id: 1, pinned: true, html: "x" });
    assert.match(r.text, /'html'/);
    r = await call("update_tickets", { ticket_numbers: Array.from({ length: 101 }, (_, i) => String(i)), status: "open" });
    assert.equal(r.isError, true);
    assert.equal(seen.length, before);
  });

  await ok("update_tickets sends a numeric resolved as text, which Tickiti validates as a string", async () => {
    let r = await call("update_tickets", { ticket_numbers: ["101"], status: "closed", resolved: 3 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(seen[seen.length - 1].body, { ticket_numbers: ["101"], status: "closed", resolved: "3" });
    r = await call("update_tickets", { ticket_numbers: ["101"], status: "closed", resolved: "Fixed" });
    assert.equal(r.isError, false, r.text);
    assert.equal(seen[seen.length - 1].body.resolved, "Fixed");
  });

  await ok("with one instance, `instance` naming it is accepted and another name refused", async () => {
    let r = await call("get_share_link", { ticket_number: "101", instance: "default" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(seen[seen.length - 1].body, { ticket_number: "101" });
    const before = seen.length;
    r = await call("get_share_link", { ticket_number: "101", instance: "staging" });
    assert.equal(r.isError, true);
    assert.equal(seen.length, before);
  });

  await ok("the interventions tool names the plan its routes are gated on", async () => {
    const { tools } = await client.listTools();
    const plans = [...new Set(MANIFEST.filter((e) => e.uri.startsWith("workflow/interventions")).flatMap((e) => e.plans))];
    assert.ok(plans.length > 0, "the manifest gates interventions on a plan");
    const d = tools.find((t) => t.name === "interventions").description;
    for (const p of plans) assert.ok(d.includes(p), `interventions names ${p}`);
  });

  await ok("a refusal from Tickiti comes back as an error with its body", async () => {
    reply = () => ({ status: 403, body: { ok: false, error: "forbidden" } });
    const r = await call("automations", { action: "list" });
    assert.equal(r.isError, true);
    assert.match(r.text, /forbidden/);
  });

  await ok("download_sent_mail writes every range to the file", async () => {
    const parts = ["From: a\r\n", "\r\nbody"];
    reply = (row) => {
      const i = row.body.offset === 0 ? 0 : 1;
      return {
        status: 200,
        body: { ok: true, data: { id: 3, filename: "m.eml", content_base64: Buffer.from(parts[i]).toString("base64"), eof: i === 1 } },
      };
    };
    const path = join(dir, "sub", "m.eml");
    const r = await call("download_sent_mail", { id: 3, path, chunk_bytes: 9 });
    assert.equal(r.isError, false, r.text);
    assert.equal(readFileSync(path, "utf8"), parts.join(""));
    assert.equal(JSON.parse(r.text).bytes, parts.join("").length);
    assert.deepEqual(seen.slice(-2).map((s) => s.body.offset), [0, 9]);
  });

  console.log(`\nAll ${passed} tests passed.`);
} finally {
  await client.close();
  stub.close();
  rmSync(dir, { recursive: true, force: true });
}
