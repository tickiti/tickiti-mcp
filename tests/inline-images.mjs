// Unit test for the inline-image helper. Run: node tests/inline-images.mjs
// (build first: npm run build — this imports the compiled dist.)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineImagesIntoContent } from "../dist/attachments.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const dir = mkdtempSync(join(tmpdir(), "tickiti-inline-"));
const png = join(dir, "shot.png");
writeFileSync(png, Buffer.from(PNG_B64, "base64"));
const expectedImg = `<img src="data:image/png;base64,${PNG_B64}">`;

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

try {
  ok("placeholder is substituted in place", () => {
    const out = inlineImagesIntoContent("<p>before {{attach:shot.png}} after</p>", [{ path: png }]);
    assert.equal(out, `<p>before ${expectedImg} after</p>`);
  });

  ok("custom placeholder via name", () => {
    const out = inlineImagesIntoContent("<p>{{attach:pic}}</p>", [{ path: png, name: "pic" }]);
    assert.equal(out, `<p>${expectedImg}</p>`);
  });

  ok("explicit placeholder string", () => {
    const out = inlineImagesIntoContent("<p>[IMG]</p>", [{ path: png, placeholder: "[IMG]" }]);
    assert.equal(out, `<p>${expectedImg}</p>`);
  });

  ok("appends when no placeholder present", () => {
    const out = inlineImagesIntoContent("<p>body</p>", [{ path: png }]);
    assert.equal(out, `<p>body</p><p>${expectedImg}</p>`);
  });

  ok("empty content yields just the image paragraph", () => {
    const out = inlineImagesIntoContent("", [{ path: png }]);
    assert.equal(out, `<p>${expectedImg}</p>`);
  });

  ok("unsupported extension throws", () => {
    const txt = join(dir, "note.txt");
    writeFileSync(txt, "hello");
    assert.throws(() => inlineImagesIntoContent("x", [{ path: txt }]), /Unsupported inline image type/);
  });

  ok("missing file throws", () => {
    assert.throws(() => inlineImagesIntoContent("x", [{ path: join(dir, "nope.png") }]), /Cannot read attachment file/);
  });

  console.log(`\ninline-images: ${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
