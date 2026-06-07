// All-paths integration sweep against a SCRATCH Tickiti instance.
// Exercises every v1 endpoint read+write as a dependency-ordered lifecycle:
// create a resource, use it (update/move/reorder/etc.), then delete it.
//
//   TICKITI_API_BASE=... TICKITI_API_TOKEN=<full-ability token> node tests/all-paths.mjs
//
// Field names / enums were taken from the controllers' own validation rules.
import { callV1 } from "../dist/client.js";
import { buildPath } from "../dist/manifest.js";
import { MANIFEST } from "../dist/generated/manifest.js";

const PW = process.env.MCP_TEST_PASSWORD ?? "McpTest!2026"; // gary's scratch password
const byName = Object.fromEntries(MANIFEST.map((e) => [e.name, e]));
const hit = new Set();
const rows = [];

function record(name, kind, status, ok, note, expected = false) {
  rows.push({ name, kind, status, ok, note, expected });
  const tag = ok ? "PASS" : expected ? "SKIP" : "FAIL";
  console.log(`${tag.padEnd(4)} ${kind} ${String(status).padStart(3)}  ${name.replace("api.v1.", "").padEnd(44)} ${note}`);
}

const isBad = (b) => b && typeof b === "object" && (b.my_error || b.amf_error || b.error || b.ok === false);

// Call an endpoint by manifest name. expected=true marks env/feature limits (not shim faults).
async function call(name, payload = {}, { expected = false } = {}) {
  const e = byName[name];
  if (!e) throw new Error(`unknown endpoint ${name}`);
  hit.add(name);
  const { path, missing } = buildPath(e, payload);
  if (missing.length) {
    record(name, e.write ? "W" : "R", "-", false, `missing path param: ${missing.join(",")}`, expected);
    return null;
  }
  const r = await callV1(path, payload, { idempotent: e.idempotent });
  const ok = r.ok && !isBad(r.body);
  const note = ok ? str(r.body, 70) : r.ok ? `logical: ${str(r.body, 90)}` : r.summary;
  record(name, e.write ? "W" : "R", r.status, ok, note, expected);
  return r.body;
}

const str = (b, n) => {
  const s = typeof b === "string" ? b : JSON.stringify(b);
  return s.length > n ? s.slice(0, n) + "…" : s;
};
const arr = (body, key) => (key ? body?.[key] : body) ?? [];
const findId = (body, key, matchKey, val) => {
  const item = arr(body, key).find((x) => String(x[matchKey]) === String(val));
  return item?.id;
};
const DATES = { date_from: "2026-01-01", date_to: "2026-12-31" };

// ----------------------------------------------------------------------------
// TICKETS
await call("api.v1.tickets.query", { search_object: { search_perspective: "All" } });
await call("api.v1.tickets.create", {
  originator_email_address: "mcp-test@example.com",
  data: { subject: "[MCP] all-paths test", content: "<p>scratch test ticket</p>" },
});
await call("api.v1.tickets.respond", {
  ticket_number: "709383",
  from_email: "mcp-test@example.com",
  content: "<p>scratch reply</p>",
});
await call("api.v1.idempotency_key.create");

// ----------------------------------------------------------------------------
// SETTINGS — perspectives
await call("api.v1.settings.perspectives.index");
{
  const created = await call("api.v1.settings.perspectives.create", { name: "MCP Perspective", shared: false });
  const id = created?.perspective_id;
  await call("api.v1.settings.perspectives.update", { perspective_id: id, name: "MCP Perspective 2", show_in_crm: false, shared: false });
  await call("api.v1.settings.perspectives.delete", { perspective_id: id });
}

// SETTINGS — watchlists
await call("api.v1.settings.watchlists.create", { name: "MCP Watchlist", icon: "star", shared: false });
{
  const idx = await call("api.v1.settings.watchlists.index");
  const id = findId(idx, "watchlists", "name", "MCP Watchlist");
  await call("api.v1.settings.watchlists.add_tickets", { watchlist_id: id, ticket_ids: [13] });
  await call("api.v1.settings.watchlists.reorder", { watchlist_id: id, ticket_ids: [13] });
  await call("api.v1.settings.watchlists.remove_tickets", { watchlist_id: id, ticket_ids: [13] });
  await call("api.v1.settings.watchlists.update", { watchlist_id: id, name: "MCP Watchlist 2", icon: "flag" });
  await call("api.v1.settings.watchlists.delete", { watchlist_id: id });
}

// SETTINGS — hashtags
await call("api.v1.settings.hashtags.index");
await call("api.v1.settings.hashtags.delete", { tag: "mcp-nonexistent-tag" });

// SETTINGS — stock responses
await call("api.v1.settings.stock_responses.index");
{
  const created = await call("api.v1.settings.stock_responses.create", {});
  const id = created?.template?.id ?? created?.id;
  await call("api.v1.settings.stock_responses.show", { template_id: id });
  await call("api.v1.settings.stock_responses.update", { template: { id, title: "MCP Stock", category: "MCP", subcategory: "test", content: "<p>x</p>" } });
  await call("api.v1.settings.stock_responses.delete", { template_id: id });
}

// ----------------------------------------------------------------------------
// MAIL — mailboxes
const mbox = {
  name: "MCP Box", address: "mcpbox@example.com", mailbox_type: "imap",
  pop_enable: false, pop_encryption: "none", pop_validate_cert: false,
  max_consecutive_errors: 5, secondary_report_threshold: 3,
  outgoing_mailbox_type: "none", smtp_enable: false, smtp_security: "none",
};
await call("api.v1.mail.mailboxes.create", mbox);
{
  const idx = await call("api.v1.mail.mailboxes.index");
  const id = findId(idx, "mailboxes", "address", "mcpbox@example.com");
  await call("api.v1.mail.mailboxes.set_password", { mailbox_id: id, field: "smtp_password", value: "secret" });
  await call("api.v1.mail.mailboxes.update", { mailbox_id: id, ...mbox, name: "MCP Box 2" });
  await call("api.v1.mail.mailboxes.delete", { mailbox_id: id });
}

// MAIL — ignored subjects
await call("api.v1.mail.subjects.create", { subject: "(mcp test subject)" });
{
  const idx = await call("api.v1.mail.subjects.index");
  const id = findId(idx, null, "subject", "(mcp test subject)");
  await call("api.v1.mail.subjects.delete", { id });
}

// MAIL — excluded emails
await call("api.v1.mail.excluded.create", { email: "mcp-excluded@example.com" });
{
  const idx = await call("api.v1.mail.excluded.index");
  const id = findId(idx, null, "email", "mcp-excluded@example.com");
  await call("api.v1.mail.excluded.delete", { id });
}

// MAIL — sent mail (read-only; instance has none → show is unexercisable)
await call("api.v1.mail.sent_mail.list");
await call("api.v1.mail.sent_mail.search", { q: "" });
await call("api.v1.mail.sent_mail.show", { id: 1 }, { expected: true });

// ----------------------------------------------------------------------------
// TEMPLATES
await call("api.v1.templates.index");
await call("api.v1.templates.faqs");
await call("api.v1.templates.search", { q: "" });
await call("api.v1.templates.create", { type: "email", identifier: "mcp-tmpl-1", category: "", subcategory: "" });
{
  const idx = await call("api.v1.templates.index");
  const id = findId(idx, null, "identifier", "mcp-tmpl-1");
  await call("api.v1.templates.show", { template_id: id });
  await call("api.v1.templates.update", { template: { id, type: "email", identifier: "mcp-tmpl-1", subject: "MCP", content: "<p>x</p>" } });
  await call("api.v1.templates.delete", { template_id: id });
}

// ----------------------------------------------------------------------------
// WORKFLOW — queues
await call("api.v1.workflow.queues.index");
await call("api.v1.workflow.queues.create", { name: "MCP Queue", outgoing_mailbox_id: 2 });
{
  const idx = await call("api.v1.workflow.queues.index");
  const id = findId(idx, "queues", "name", "MCP Queue");
  await call("api.v1.workflow.queues.update", { queue_id: id, name: "MCP Queue 2", outgoing_mailbox_id: 2 });
  await call("api.v1.workflow.queues.move", { from_queue_id: id, to_queue_id: 1 });
  await call("api.v1.workflow.queues.delete", { queue_id: id });
}

// WORKFLOW — resolution categories
await call("api.v1.workflow.resolutions.create", { name: "MCP Resolution", colour: "#abcdef" });
{
  const idx = await call("api.v1.workflow.resolutions.index");
  const id = findId(idx, null, "name", "MCP Resolution");
  await call("api.v1.workflow.resolutions.update", { id, name: "MCP Resolution 2", colour: "#123456" });
  await call("api.v1.workflow.resolutions.reorder", { ids: arr(idx, null).map((x) => x.id) });
  await call("api.v1.workflow.resolutions.delete", { id });
}

// WORKFLOW — interventions
await call("api.v1.workflow.interventions.index");
const interv = { name: "mcp_intervention", title: "MCP Intervention", queue_name: "Inbox", notify_inbox_managers: false, create_urgent: false, remote_timeout_seconds: 30, remote_enabled: false };
await call("api.v1.workflow.interventions.create", interv);
{
  const idx = await call("api.v1.workflow.interventions.index");
  const id = findId(idx, "interventions", "name", "mcp_intervention");
  await call("api.v1.workflow.interventions.update", { intervention_id: id, ...interv, title: "MCP Intervention 2" });
  await call("api.v1.workflow.interventions.generate_token", { intervention_id: id, remote_name: "mcp-remote" });
  await call("api.v1.workflow.interventions.delete", { intervention_id: id });
}

// WORKFLOW — escalations + business hours
await call("api.v1.workflow.escalations.index");
await call("api.v1.workflow.escalations.create", { minutes: 60, action: "notify", email: "esc@example.com" });
{
  const idx = await call("api.v1.workflow.escalations.index");
  const id = findId(idx, "escalations", "minutes", 60);
  await call("api.v1.workflow.escalations.update", { id, minutes: 120, action: "email", email: "esc@example.com" });
  await call("api.v1.workflow.escalations.delete", { id });
}
await call("api.v1.workflow.business_hours.update", {
  mode: "simple", mon_enabled: true, tue_enabled: true, wed_enabled: true, thu_enabled: true,
  fri_enabled: true, sat_enabled: false, sun_enabled: false, simple_start: 540, simple_end: 1020,
});

// ----------------------------------------------------------------------------
// REPORTS (read-only)
await call("api.v1.reports.meta");
await call("api.v1.reports.resolutions", { ...DATES });
await call("api.v1.reports.volumes", { ...DATES, group_by: "day" });
await call("api.v1.reports.response_times", { ...DATES, group_by: "day" });
await call("api.v1.reports.agent_activity", { ...DATES });

// ----------------------------------------------------------------------------
// SUPERVISOR
await call("api.v1.supervisor.jobs.index");
await call("api.v1.supervisor.jobs.retry", { job_ids: [999999] });
await call("api.v1.supervisor.jobs.delete", { job_ids: [999999] });
await call("api.v1.supervisor.health.status");
await call("api.v1.supervisor.health.manage");
await call("api.v1.supervisor.health.disk_store", { root_path: "C:/", min_free_space: 1, warn_free_space: 2 });
{
  const mng = await call("api.v1.supervisor.health.manage");
  const diskId = findId(mng, "disks", "root_path", "C:/") ?? arr(mng, "disks").at(-1)?.id;
  await call("api.v1.supervisor.health.disk_delete", { id: diskId });
  await call("api.v1.supervisor.health.exception_store", { pattern: "mcp-test-*", description: "mcp" });
  const mng2 = await call("api.v1.supervisor.health.manage");
  const excId = findId(mng2, "exceptions", "pattern", "mcp-test-*") ?? arr(mng2, "exceptions").at(-1)?.id;
  await call("api.v1.supervisor.health.exception_delete", { id: excId });
}
await call("api.v1.supervisor.super_tasks.fetch");
await call("api.v1.supervisor.diagnostics");

// ----------------------------------------------------------------------------
// ADMINISTRATION
await call("api.v1.administration.system.index");
await call("api.v1.administration.system.update", {});
await call("api.v1.administration.branding.index");
await call("api.v1.administration.branding.update", {});
await call("api.v1.administration.branding.reset_app_logo");
await call("api.v1.administration.branding.reset_email_logo");
await call("api.v1.administration.branding.app_logo", {}, { expected: true });   // multipart file upload
await call("api.v1.administration.branding.email_logo", {}, { expected: true }); // multipart file upload
await call("api.v1.administration.custom_domain.status");
await call("api.v1.administration.custom_domain.update", { current_password: PW, domain: "mcp-test-domain.example.com" });
await call("api.v1.administration.ai.index");
await call("api.v1.administration.ai.update", {
  current_password: PW, ai_enabled: true, ai_auto_draft_inbound: true, ai_suggest_after_staff_reply: true,
  ai_auto_send: false, ai_auto_send_threshold: 90, ai_model: "", ai_persona: "", ai_business_context: "",
  ai_signature: "", ai_auto_signature: "", ai_api_key: "", ai_api_key_clear: false,
});
await call("api.v1.administration.users.index");
await call("api.v1.administration.users.create", { name: "MCP User", email: "mcpuser@example.com", is_staff: true, is_admin: false, tonic_notifications: false });
{
  const idx = await call("api.v1.administration.users.index");
  const id = findId(idx, "users", "email", "mcpuser@example.com");
  await call("api.v1.administration.users.update", { user: id, is_staff: true, is_admin: false, tonic_notifications: false });
  await call("api.v1.administration.users.queue_upsert", { user: id, queue: 1, can_view: true, can_manage: false, can_delete: false, treat_as_inbox: false, receive_inbox_errors: false });
  await call("api.v1.administration.users.queue_detach", { user: id, queue: 1 });
}
await call("api.v1.administration.licence.index");
await call("api.v1.administration.storage.retention", { sent_mail_retention_days: 365 });
await call("api.v1.administration.storage.delete_orphaned");
await call("api.v1.administration.storage.delete_closed", { older_than_days: 99999 });
await call("api.v1.administration.diagnostics.index", {}, { expected: true });  // build: diagnostics disabled
await call("api.v1.administration.diagnostics.fetch", {}, { expected: true });
await call("api.v1.administration.diagnostics.update", {}, { expected: true });
await call("api.v1.administration.diagnostics.upload", {}, { expected: true });

// ----------------------------------------------------------------------------
// SUMMARY + coverage
const pass = rows.filter((r) => r.ok).length;
const skip = rows.filter((r) => !r.ok && r.expected).length;
const fail = rows.filter((r) => !r.ok && !r.expected).length;
const missed = MANIFEST.filter((e) => !hit.has(e.name)).map((e) => e.name.replace("api.v1.", ""));

console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} expected-skip  (of ${rows.length} calls, ${hit.size}/${MANIFEST.length} endpoints) ===`);
if (fail) {
  console.log("\nUnexpected failures:");
  for (const r of rows.filter((x) => !x.ok && !x.expected)) console.log(`  ${r.kind} ${r.status}  ${r.name.replace("api.v1.", "")}  — ${r.note}`);
}
if (skip) {
  console.log("\nExpected skips (env/feature/upload, not shim faults):");
  for (const r of rows.filter((x) => !x.ok && x.expected)) console.log(`  ${r.kind} ${r.status}  ${r.name.replace("api.v1.", "")}  — ${r.note}`);
}
if (missed.length) console.log(`\nNOT covered (${missed.length}): ${missed.join(", ")}`);
