// The Axial skill question tools, through the built server against a local stand-in for
// Tickiti. Run: node tests/axial-skill-questions.mjs (build first: npm run build). Needs no Tickiti.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const seen = [];
let reply = { status: 200, body: {} };
const stub = createServer((req, res) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
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
    TICKITI_API_TOKEN: "admin-token",
    TICKITI_INSTANCES: "",
  },
});
const client = new Client({ name: "axial-skill-questions", version: "0" });
await client.connect(transport);

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log("  ✓ " + name);
}
const call = (name, args = {}) => client.callTool({ name, arguments: args });

const question = {
  name: "which_device",
  question: "Which device is {customer} using?",
  options: [
    { label: "The one on the ticket", selected: true },
    { label: "Another", input: "Which one?", then: ["which_os"] },
    { label: "Send the download", action: { name: "send_download", params: { os: "{os}" } }, unless: "no_download" },
  ],
  enabled: true,
  ordinal: 2,
};

try {
  const { tools } = await client.listTools();

  await ok("both are listed and need skill plus question or name", () => {
    const up = tools.find((t) => t.name === "upsert_axial_skill_question");
    const del = tools.find((t) => t.name === "delete_axial_skill_question");
    assert.ok(up && del);
    assert.deepEqual([...up.inputSchema.required].sort(), ["question", "skill"]);
    assert.deepEqual([...del.inputSchema.required].sort(), ["name", "skill"]);
    assert.match(up.description, /skills:write/);
  });

  await ok("upsert posts {skill, question} to the questions route, unchanged", async () => {
    reply = { status: 200, body: { skill: { key: "updd.diagnostic", questions: [question] } } };
    const r = await call("upsert_axial_skill_question", { skill: "updd.diagnostic", question });
    const last = seen.at(-1);
    assert.equal(last.url, "/api/v1/axial/skills/questions/upsert");
    assert.equal(last.auth, "Bearer admin-token");
    assert.deepEqual(last.body, { skill: "updd.diagnostic", question });
    assert.equal(JSON.parse(r.content[0].text).skill.questions[0].name, "which_device");
  });

  await ok("upsert of a change sends only the fields given", async () => {
    await call("upsert_axial_skill_question", { skill: 12, question: { name: "which_device", enabled: false } });
    assert.deepEqual(seen.at(-1).body, { skill: 12, question: { name: "which_device", enabled: false } });
  });

  await ok("delete posts {skill, name} to the questions route", async () => {
    await call("delete_axial_skill_question", { skill: "updd.diagnostic", name: "which_device" });
    const last = seen.at(-1);
    assert.equal(last.url, "/api/v1/axial/skills/questions/delete");
    assert.deepEqual(last.body, { skill: "updd.diagnostic", name: "which_device" });
  });

  await ok("a refusal from Tickiti comes back as an error", async () => {
    reply = { status: 404, body: { message: "That skill has no question named nope." } };
    const r = await call("delete_axial_skill_question", { skill: "updd.diagnostic", name: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no question named nope/);
  });

  console.log(`\nAll ${passed} tests passed.`);
} finally {
  await client.close();
  stub.close();
}
