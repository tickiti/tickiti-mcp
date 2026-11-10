// Unit test for TICKITI_MCP_FILE_ROOTS. Run: node tests/file-roots.mjs
// (build first: npm run build — this imports the compiled dist.) Needs no Tickiti server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tickiti-roots-"));
const root = join(dir, "task");
const other = join(dir, "task2"); // shares root's prefix, and is outside it
const secret = join(other, "secret.png");
const inside = join(root, "shot.png");
const link = join(root, "out");
mkdirSync(root);
mkdirSync(other);
writeFileSync(inside, "inside");
writeFileSync(secret, "secret");
symlinkSync(other, link, "junction");

// Read once at import, so set before it.
process.env.TICKITI_API_BASE = "http://127.0.0.1:9";
process.env.TICKITI_API_TOKEN = "x";
process.env.TICKITI_MCP_FILE_ROOTS = [join(dir, "absent"), root].join(delimiter);
const { readablePath, uploadFileV1 } = await import("../dist/client.js");
const { inlineImagesIntoContent, readContentFile } = await import("../dist/attachments.js");

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log("  ✓ " + name);
}
const refused = /not a file under TICKITI_MCP_FILE_ROOTS/;

try {
  await ok("a file under a root is read", () => assert.equal(readContentFile(inside), "inside"));

  await ok("a root that does not exist is skipped", () => assert.ok(readablePath(inside)));

  await ok("content_path outside the roots is refused", () =>
    assert.throws(() => readContentFile(secret), refused));

  await ok("a directory sharing a root's prefix is outside it", () =>
    assert.throws(() => readablePath(join(other, "secret.png")), refused));

  await ok("climbing out with .. is refused", () =>
    assert.throws(() => readablePath(join(root, "..", "task2", "secret.png")), refused));

  await ok("a link inside a root cannot lead out", () =>
    assert.throws(() => readablePath(join(link, "secret.png")), refused));

  await ok("the root itself is not a file", () => assert.throws(() => readablePath(root), refused));

  await ok("a missing file gets the same refusal", () =>
    assert.throws(() => readablePath(join(other, "absent.png")), refused));

  await ok("inline image outside the roots is refused", () =>
    assert.throws(() => inlineImagesIntoContent("", [{ path: secret }]), refused));

  await ok("inline image under a root is embedded", () =>
    assert.match(inlineImagesIntoContent("", [{ path: inside }]), /data:image\/png;base64,/));

  await ok("upload outside the roots stops before the network", async () => {
    const r = await uploadFileV1(secret);
    assert.equal(r.ok, false);
    assert.match(r.summary, refused);
  });

  await ok("upload under a root goes on to the network", async () => {
    const r = await uploadFileV1(inside);
    assert.match(r.summary, /Failed to reach/);
  });

  console.log(`\nAll ${passed} tests passed.`);
} finally {
  // The junction first, so removing the folder cannot follow it.
  rmdirSync(link);
  rmSync(dir, { recursive: true, force: true });
}
