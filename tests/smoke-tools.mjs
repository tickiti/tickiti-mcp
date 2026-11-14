// Offline smoke test: spawn the built server, list its tools, and check the
// registration (unique names, the new tools present, the instance argument naming the
// configured instances, one or more). Needs no Tickiti server.
//
//   npm run build && node tests/smoke-tools.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

const SERVER = "dist/server.js";

const EXPECTED = [
  "create_ticket", "respond_to_ticket", "close_ticket", "edit_response", "delete_response",
  "get_ticket", "list_responses", "query_responses", "export_responses", "download_attachment",
  "delete_tickets", "restore_ticket", "merge_tickets", "link_tickets", "unlink_tickets",
  "list_linked_tickets", "get_response", "move_responses", "copy_responses", "split_ticket",
  "change_originator", "delete_attachment", "list_staff", "list_resolutions", "get_search_modes",
  "get_token_info", "send_email", "search_sent_mail", "render_template", "upload_template_image",
  "get_perspective", "list_perspectives", "list_stock_responses", "create_template", "update_template",
  "list_api_tokens", "create_api_token", "update_api_token", "revoke_api_token", "list_instances",
  "list_endpoints", "tickiti_call", "upsert_axial_skill_question", "delete_axial_skill_question",
  "update_tickets", "ticket_checklist", "ticket_reminders", "pin_response", "restore_response", "ticket_tags",
  "my_ticket_state", "get_share_link", "scheduled_replies", "list_reviews", "resolve_review",
  "move_queue_tickets", "automations", "sla_policies", "recurring_tasks", "checklist_templates", "holidays",
  "interventions", "mail_attachment_rules", "axial_panel_action", "axial_conversations", "axial_settings",
  "out_of_office", "my_signature", "user_account", "manage_watchlist", "template_translation",
  "confirm_alert", "download_sent_mail",
];

async function tools(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const endpoints = await client.callTool({ name: "list_endpoints", arguments: { family: "mail" } });
  const instances = await client.callTool({ name: "list_instances", arguments: {} });
  await client.close();
  return { tools, endpoints, instances };
}

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failed++; };

const one = await tools({ TICKITI_API_BASE: "http://127.0.0.1:9", TICKITI_API_TOKEN: "x", TICKITI_INSTANCES: "" });
const names = one.tools.map((t) => t.name);
check(new Set(names).size === names.length, `tool names unique (${names.length} tools)`);
for (const n of EXPECTED) check(names.includes(n), `tool ${n} registered`);
check(
  one.tools.every((t) => JSON.stringify(t.inputSchema.properties?.instance?.enum) === '["default"]'),
  "every tool takes instance, naming the only instance, with one instance",
);
const create = one.tools.find((t) => t.name === "create_ticket");
check((create.inputSchema.required ?? []).includes("is_public"), "create_ticket requires is_public");
check(JSON.parse(one.endpoints.content[0].text).endpoints.some((e) => e.action === "sent_mail.search" && /\bq\b/.test(e.body ?? "")), "list_endpoints shows body hints");

const two = await tools({
  TICKITI_API_BASE: "http://127.0.0.1:9", TICKITI_API_TOKEN: "x", TICKITI_INSTANCE_NAME: "production",
  TICKITI_INSTANCES: JSON.stringify({ staging: { base: "http://127.0.0.1:8", token: "y" } }),
});
check(two.tools.every((t) => t.inputSchema.properties?.instance), "every tool takes instance with two instances");
check(JSON.parse(two.instances.content[0].text).instances.map((i) => i.name).join(",") === "production,staging", "list_instances names both");
check(!two.instances.content[0].text.includes('"y"'), "list_instances shows no token");

// A mistyped TICKITI_INSTANCES (quoted as cmd.exe keeps it, or a bare token) stops the server
// without its text, which holds the tokens, reaching stderr (the client's MCP log).
for (const [what, value] of [
  ["quoted", `'{"staging":{"base":"http://127.0.0.1:8","token":"SECRET-tok-123"}}'`],
  ["not JSON", `{"staging":{"base":"http://127.0.0.1:8","token":SECRET-tok-123}}`],
  ["bare token", "12|SECRET-tok-123"],
]) {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, TICKITI_API_BASE: "http://127.0.0.1:9", TICKITI_API_TOKEN: "x", TICKITI_INSTANCES: value },
    input: "",
    encoding: "utf8",
    timeout: 20000,
  });
  check(r.status !== 0 && /TICKITI_INSTANCES/.test(r.stderr), `a ${what} TICKITI_INSTANCES stops the server, naming the variable`);
  check(!r.stderr.includes("SECRET-tok") && !r.stdout.includes("SECRET-tok"), `a ${what} TICKITI_INSTANCES never echoes its token`);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
