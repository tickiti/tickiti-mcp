// Strict tool arguments, tickiti_call's method / multipart / required-body checks, the
// instance's own endpoint list, and the respond / create / template fields, through the
// built server against a local stand-in for Tickiti.
// Run: node tests/strict-and-generic.mjs (build first: npm run build). Needs no Tickiti.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MANIFEST } from "../dist/generated/manifest.js";

// The instance lists every endpoint but tickets/close, plus one newer than the manifest.
const instanceRoutes = [
  ...MANIFEST.map((e) => e.name).filter((n) => n !== "api.v1.tickets.close"),
  { name: "api.v1.tickets.future_thing", uri: "api/v1/tickets/future-thing", method: "POST" },
];

const seen = [];
let reply = { status: 200, body: {} };
const stub = createServer((req, res) => {
  let text = "";
  req.setEncoding("latin1");
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    const type = req.headers["content-type"] ?? "";
    const row = { method: req.method, url: req.url, type, auth: req.headers.authorization, raw: text };
    if (type.includes("application/json") && text) row.body = JSON.parse(text);
    if (req.url === "/api/v1/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { version: "9.9.9", endpoints: instanceRoutes } }));
      return;
    }
    seen.push(row);
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
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
const client = new Client({ name: "strict-and-generic", version: "0" });
await client.connect(transport);

const dir = mkdtempSync(join(tmpdir(), "tickiti-strict-"));
const logo = join(dir, "logo.png");
writeFileSync(logo, "PNGBYTES");

let passed = 0;
async function ok(name, fn) {
  reply = { status: 200, body: { ok: true } };
  await fn();
  passed++;
  console.log("  ✓ " + name);
}

/** The call's text, whether the SDK returns the refusal as a tool error or throws it. */
async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content?.map((c) => c.text ?? "").join("\n") ?? "" };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e) };
  }
}

try {
  const { tools } = await client.listTools();

  await ok("every tool's schema refuses unlisted properties", () => {
    for (const t of tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);
  });

  await ok("respond_to_ticket with html is refused before anything is sent", async () => {
    const before = seen.length;
    const r = await call("respond_to_ticket", {
      ticket_number: "365176", from_email: "a@example.com", html: "<p>Hi</p>", status: "on-hold", on_hold_until: "2026-12-01",
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /'html'/);
    assert.match(r.text, /The body is `content`/);
    assert.match(r.text, /respond_to_ticket takes: .*content/);
    assert.equal(seen.length, before);
  });

  await ok("tickiti_call with params instead of payload is refused, naming payload", async () => {
    const before = seen.length;
    const r = await call("tickiti_call", { family: "tickets", action: "query", params: { row_limit: 5 } });
    assert.equal(r.isError, true);
    assert.match(r.text, /'params'/);
    assert.match(r.text, /payload/);
    assert.equal(seen.length, before);
  });

  await ok("an unknown key inside a files item is refused too", async () => {
    const before = seen.length;
    const r = await call("respond_to_ticket", {
      ticket_number: "1", from_email: "a@example.com", content: "x", files: [{ path: logo, mime: "image/png" }],
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /mime/);
    assert.equal(seen.length, before);
  });

  await ok("respond_to_ticket and close_ticket send signature and signature_custom", async () => {
    await call("respond_to_ticket", {
      ticket_number: "1", from_email: "a@example.com", content: "<p>x</p>", signature: "custom", signature_custom: "<p>Sam</p>",
    });
    assert.equal(seen.at(-1).url, "/api/v1/tickets/respond");
    assert.equal(seen.at(-1).body.signature, "custom");
    assert.equal(seen.at(-1).body.signature_custom, "<p>Sam</p>");
    const bad = await call("respond_to_ticket", { ticket_number: "1", from_email: "a@example.com", content: "x", signature: "fancy" });
    assert.equal(bad.isError, true);
    // close_ticket is a known route this instance lacks, so it reaches the stub only as a named tool
    await call("close_ticket", { ticket_number: "1", signature: "none" });
    assert.equal(seen.at(-1).url, "/api/v1/tickets/close");
    assert.equal(seen.at(-1).body.signature, "none");
  });

  await ok("create_ticket sends customer_name, company and other_fields at the top level", async () => {
    await call("create_ticket", {
      originator_email_address: "c@example.com", subject: "S", content: "<p>C</p>", is_public: true,
      customer_name: "Casey", company: "Acme", other_fields: [{ label: "Serial", value: "123" }],
    });
    const b = seen.at(-1).body;
    assert.equal(b.customer_name, "Casey");
    assert.equal(b.company, "Acme");
    assert.deepEqual(b.other_fields, [{ label: "Serial", value: "123" }]);
    assert.equal(b.data.customer_name, undefined);
  });

  await ok("create_ticket sends kind at the top level, and refuses a kind Tickiti does not have", async () => {
    await call("create_ticket", {
      originator_email_address: "s@example.com", subject: "T", content: "<p>Do it</p>", is_public: false,
      kind: "task", queue_name: "Tasks",
    });
    const b = seen.at(-1).body;
    assert.equal(seen.at(-1).url, "/api/v1/tickets");
    assert.equal(b.kind, "task");
    assert.equal(b.queue_name, "Tasks");
    assert.equal(b.data.kind, undefined);
    const before = seen.length;
    const bad = await call("create_ticket", {
      originator_email_address: "s@example.com", subject: "T", content: "<p>x</p>", is_public: false, kind: "note",
    });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, before);
  });

  await ok("create_template takes category, subcategory and keywords", async () => {
    await call("create_template", { type: "email", identifier: "t1", category: "A", subcategory: "B", keywords: "k" });
    assert.deepEqual(seen.at(-1).body, { type: "email", identifier: "t1", category: "A", subcategory: "B", keywords: "k" });
  });

  await ok("update_template sends only the fields given, in one call", async () => {
    const before = seen.length;
    await call("update_template", { id: 7, keywords: "x" });
    assert.equal(seen.length, before + 1);
    assert.equal(seen.at(-1).url, "/api/v1/templates/update");
    assert.deepEqual(seen.at(-1).body, { template: { id: 7, keywords: "x" } });
  });

  await ok("tickiti_call faqs is a GET with the payload as its query string", async () => {
    await call("tickiti_call", { family: "faqs", action: "(root)", payload: { lang: "fr" } });
    assert.equal(seen.at(-1).method, "GET");
    assert.equal(seen.at(-1).url, "/api/v1/faqs?lang=fr");
  });

  await ok("tickiti_call with no payload to an endpoint with required fields is refused, naming them", async () => {
    const before = seen.length;
    const r = await call("tickiti_call", { family: "workflow", action: "queues.move" });
    assert.equal(r.isError, true);
    assert.match(r.text, /from_queue_id/);
    assert.match(r.text, /to_queue_id/);
    assert.equal(seen.length, before);
  });

  await ok("tickiti_call uploads a logo as multipart in the endpoint's own field", async () => {
    await call("tickiti_call", { family: "administration", action: "branding.app_logo", file_path: logo });
    const last = seen.at(-1);
    assert.equal(last.url, "/api/v1/administration/branding/app-logo");
    assert.match(last.type, /multipart\/form-data/);
    assert.match(last.raw, /name="logo"; filename="logo.png"/);
    assert.match(last.raw, /PNGBYTES/);
  });

  await ok("an upload endpoint without file_path, and file_path on a JSON endpoint, are refused", async () => {
    const before = seen.length;
    const a = await call("tickiti_call", { family: "administration", action: "branding.app_logo" });
    assert.equal(a.isError, true);
    assert.match(a.text, /file_path/);
    const b = await call("tickiti_call", { family: "workflow", action: "queues.move", payload: { from_queue_id: 1, to_queue_id: 2 }, file_path: logo });
    assert.equal(b.isError, true);
    assert.match(b.text, /takes no file/);
    assert.equal(seen.length, before);
  });

  await ok("a route the instance does not list is refused by tickiti_call with its version", async () => {
    const before = seen.length;
    const r = await call("tickiti_call", { family: "tickets", action: "close", payload: { ticket_number: "1" } });
    assert.equal(r.isError, true);
    assert.match(r.text, /not on this instance \(Tickiti 9\.9\.9\)/);
    assert.equal(seen.length, before);
  });

  await ok("a route the instance lists but the manifest lacks is callable", async () => {
    await call("tickiti_call", { family: "tickets", action: "future_thing", payload: { x: 1 } });
    assert.equal(seen.at(-1).url, "/api/v1/tickets/future-thing");
    assert.deepEqual(seen.at(-1).body, { x: 1 });
  });

  await ok("list_endpoints marks what the instance lacks and gives body fields when filtered", async () => {
    const all = JSON.parse((await call("list_endpoints", { family: "tickets" })).text);
    assert.equal(all.catalogue.source, "instance");
    assert.equal(all.catalogue.version, "9.9.9");
    assert.equal(all.endpoints.find((e) => e.action === "close").on_instance, false);
    assert.equal(all.endpoints.find((e) => e.action === "respond").on_instance, undefined);
    assert.ok(all.instance_only.some((r) => r.name === "api.v1.tickets.future_thing"));

    const users = JSON.parse((await call("list_endpoints", { family: "administration", action: "users.queue_upsert" })).text);
    assert.equal(users.count, 1);
    const q = users.endpoints[0];
    assert.deepEqual(q.params, ["user", "queue"]);
    assert.ok(q.required.includes("can_manage"));
    assert.equal(q.body_fields.can_manage, "required|boolean");

    const logoRow = JSON.parse((await call("list_endpoints", { action: "branding.app_logo" })).text).endpoints[0];
    assert.equal(logoRow.file_field, "logo");
    const faqs = JSON.parse((await call("list_endpoints", { family: "faqs" })).text).endpoints[0];
    assert.equal(faqs.method, "GET");
  });

  await ok("Laravel's route-not-found 404 says the instance lacks the endpoint", async () => {
    reply = { status: 404, body: { message: "The route api/v1/tickets/close could not be found." } };
    const r = await call("close_ticket", { ticket_number: "1" });
    assert.equal(r.isError, true);
    assert.match(r.text, /does not have this endpoint/);
    reply = { status: 404, body: { message: "Ticket not found." } };
    const r2 = await call("get_ticket", { ticket_number: "1" });
    assert.equal(r2.isError, true);
    assert.doesNotMatch(r2.text, /does not have this endpoint/);
  });

  console.log(`\nAll ${passed} tests passed.`);
} finally {
  await client.close();
  stub.close();
  rmSync(dir, { recursive: true, force: true });
}
