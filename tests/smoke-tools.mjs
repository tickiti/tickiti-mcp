// Offline smoke test: spawn the built server, list its tools, and check the
// registration (unique names, the new tools present, the instance argument when more
// than one instance is configured). Needs no Tickiti server.
//
//   npm run build && node tests/smoke-tools.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "create_ticket", "respond_to_ticket", "close_ticket", "edit_response", "delete_response",
  "get_ticket", "list_responses", "query_responses", "export_responses", "download_attachment",
  "delete_tickets", "restore_ticket", "merge_tickets", "link_tickets", "unlink_tickets",
  "list_linked_tickets", "get_response", "move_responses", "copy_responses", "split_ticket",
  "change_originator", "delete_attachment", "list_staff", "list_resolutions", "get_search_modes",
  "get_token_info", "send_email", "search_sent_mail", "render_template", "upload_template_image",
  "get_perspective", "list_perspectives", "list_stock_responses", "create_template", "update_template",
  "list_api_tokens", "create_api_token", "update_api_token", "revoke_api_token", "list_instances",
  "list_endpoints", "tickiti_call",
];

async function tools(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
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
check(!one.tools[0].inputSchema.properties?.instance, "no instance argument with one instance");
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

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
