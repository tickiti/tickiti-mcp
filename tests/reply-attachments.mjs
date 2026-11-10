// The reply-task attachment tools, through the built server against a local stand-in for
// Tickiti. Run: node tests/reply-attachments.mjs (build first: npm run build). Needs no Tickiti.
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
    TICKITI_API_TOKEN: "task-token",
    TICKITI_INSTANCES: "",
  },
});
const client = new Client({ name: "reply-attachments", version: "0" });
await client.connect(transport);

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log("  ✓ " + name);
}
const call = (name, args = {}) => client.callTool({ name, arguments: args });

try {
  const { tools } = await client.listTools();

  await ok("all four are listed, read-only, and say whom they serve", () => {
    for (const name of ["attachment_files", "attachment_read", "attachment_search", "attachment_frames"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} listed`);
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.match(t.description, /Only for a reply task/);
    }
  });

  await ok("attachment_read requires archive_id and path", () => {
    const t = tools.find((x) => x.name === "attachment_read");
    assert.deepEqual([...t.inputSchema.required].sort(), ["archive_id", "path"]);
  });

  await ok("attachment_files posts to the agent-task route with the task's token", async () => {
    reply = { status: 200, body: { archives: [] } };
    const r = await call("attachment_files");
    const last = seen.at(-1);
    assert.equal(last.url, "/api/v1/axial/agent-task/attachment");
    assert.equal(last.auth, "Bearer task-token");
    assert.deepEqual(last.body, { tool: "attachment_files" });
    assert.deepEqual(JSON.parse(r.content[0].text), { archives: [] });
  });

  await ok("attachment_search passes its arguments through", async () => {
    await call("attachment_search", { archive_id: "a1", pattern: "x|y", regex: true });
    assert.deepEqual(seen.at(-1).body, { tool: "attachment_search", archive_id: "a1", pattern: "x|y", regex: true });
  });

  await ok("a refusal from Tickiti comes back as an error", async () => {
    reply = { status: 403, body: { message: "This is for a reply task." } };
    const r = await call("attachment_files");
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /This is for a reply task/);
  });

  await ok("attachment_frames gives images, each video's note after its frames", async () => {
    reply = {
      status: 200,
      body: {
        videos: [
          { frames: ["AAAA", "BBBB"], note: "first video" },
          { frames: ["CCCC"], note: "second video" },
        ],
        not_opened_note: "one could not be opened",
      },
    };
    const r = await call("attachment_frames");
    assert.deepEqual(r.content.map((c) => c.type), ["image", "image", "text", "image", "text", "text"]);
    assert.equal(r.content[0].data, "AAAA");
    assert.equal(r.content[0].mimeType, "image/jpeg");
    assert.equal(r.content[2].text, "first video");
    assert.equal(r.content[5].text, "one could not be opened");
  });

  await ok("attachment_frames with no videos returns what Tickiti said", async () => {
    reply = { status: 200, body: { videos: [], note: "no videos" } };
    const r = await call("attachment_frames");
    assert.equal(r.content.length, 1);
    assert.match(r.content[0].text, /no videos/);
  });

  console.log(`\nAll ${passed} tests passed.`);
} finally {
  await client.close();
  stub.close();
}
