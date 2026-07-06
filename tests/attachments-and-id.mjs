// Integration test for ticket_id lookup + out-of-line file attachments.
//
// Exercises the new API/MCP surface end-to-end against a live instance:
//   - uploadOutOfLineFiles (multipart upload helper)
//   - create_ticket with a downloadable file attachment
//   - tickets/show + tickets/responses + tickets/respond + tickets/attachment
//     all addressed by ticket_id (internal DB id) instead of ticket_number
//   - respond_to_ticket carrying a file attachment, then downloading it back
//
// Requires a running instance and a tickets:read+write token:
//   TICKITI_API_BASE=http://127.0.0.1:9191 \
//   TICKITI_API_TOKEN=... \
//   ORIGINATOR=customer@example.com FROM_EMAIL=system@tickiti.com QUEUE=Inbox \
//   node tests/attachments-and-id.mjs
// (build first: npm run build — this imports the compiled dist.)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callV1, uploadFileV1 } from "../dist/client.js";
import { uploadOutOfLineFiles } from "../dist/attachments.js";

if (!process.env.TICKITI_API_BASE || !process.env.TICKITI_API_TOKEN) {
  console.log("skip: set TICKITI_API_BASE and TICKITI_API_TOKEN to run this integration test");
  process.exit(0);
}

const ORIGINATOR = process.env.ORIGINATOR ?? "attach-test@example.com";
const FROM_EMAIL = process.env.FROM_EMAIL ?? "system@tickiti.com";
const QUEUE = process.env.QUEUE ?? "Inbox";

const dir = mkdtempSync(join(tmpdir(), "tickiti-attach-"));
const pdfPath = join(dir, "diagnosis.txt");
const csvPath = join(dir, "notes.csv");
const PDF_CONTENT = "Diagnosis: everything looks fine.\n";
const CSV_CONTENT = "col_a,col_b\n1,2\n3,4\n";
writeFileSync(pdfPath, PDF_CONTENT);
writeFileSync(csvPath, CSV_CONTENT);

let passed = 0;
function step(name) {
  passed++;
  console.log("  ✓ " + name);
}
function must(r, ctx) {
  assert.ok(r.ok, `${ctx} failed: ${r.summary} :: ${JSON.stringify(r.body)}`);
  return r.body;
}

try {
  // 1. Multipart upload helper returns a usable sha256 reference.
  const refs = await uploadOutOfLineFiles([{ path: pdfPath, name: "diagnosis.txt" }]);
  assert.equal(refs.length, 1);
  assert.match(refs[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(refs[0].name, "diagnosis.txt");
  assert.equal(refs[0].file_size, Buffer.byteLength(PDF_CONTENT));
  step("uploadOutOfLineFiles returns { sha256, name, file_size }");

  // 2. create_ticket with the uploaded file as a downloadable attachment.
  const created = must(
    await callV1(
      "tickets",
      {
        originator_email_address: ORIGINATOR,
        queue_name: QUEUE,
        data: { queue_name: QUEUE, subject: "Attachment + id test", content: "<p>Please see the attached diagnosis.</p>" },
        attachments: refs,
      },
      { idempotent: true },
    ),
    "create_ticket",
  );
  const ticketNumber = String(created.data.ticket_number);
  assert.ok(ticketNumber, "no ticket_number returned");
  step(`create_ticket with a file attachment -> #${ticketNumber}`);

  // 3. Resolve the internal id via show-by-number, and confirm the create
  //    attachment landed on the first response (non-inline).
  const byNumber = must(await callV1("tickets/show", { ticket_number: ticketNumber }), "show by number");
  const ticketId = Number(byNumber.data.ticket.id);
  assert.ok(Number.isInteger(ticketId) && ticketId > 0, "ticket.id not an int");
  const createAtt = byNumber.data.responses.flatMap((r) => r.attachments).find((a) => a.name === "diagnosis.txt");
  assert.ok(createAtt, "create_ticket attachment not found on the thread");
  assert.equal(createAtt.is_inline, false);
  step(`create attachment stored non-inline; resolved ticket_id=${ticketId}`);

  // 4. get_ticket BY ID returns the same ticket.
  const byId = must(await callV1("tickets/show", { ticket_id: ticketId }), "show by id");
  assert.equal(String(byId.data.ticket.number), ticketNumber);
  step("tickets/show by ticket_id matches show by ticket_number");

  // 5. list_responses BY ID.
  const respById = must(await callV1("tickets/responses", { ticket_id: ticketId }), "responses by id");
  assert.ok(Array.isArray(respById.data.responses));
  step("tickets/responses by ticket_id");

  // 6. Ambiguity + missing-reference guards.
  const both = await callV1("tickets/show", { ticket_number: ticketNumber, ticket_id: ticketId });
  assert.equal(both.status, 422, "supplying both should 422");
  const neither = await callV1("tickets/show", {});
  assert.equal(neither.status, 422, "supplying neither should 422");
  step("show rejects both-refs and no-ref with 422");

  // 7. respond_to_ticket BY ID, carrying a downloadable file attachment.
  const csvRefs = await uploadOutOfLineFiles([{ path: csvPath, name: "notes.csv" }]);
  const responded = must(
    await callV1(
      "tickets/respond",
      {
        ticket_id: ticketId,
        from_email: FROM_EMAIL,
        is_internal: true,
        content: "<p>Attaching the notes.</p>",
        attachments: csvRefs,
      },
      { idempotent: true },
    ),
    "respond by id with attachment",
  );
  const responseId = String(responded.data.response_id);
  step(`respond_to_ticket by ticket_id with a file -> response ${responseId}`);

  // 8. Find the new response's attachment id.
  const after = must(await callV1("tickets/show", { ticket_id: ticketId }), "show after respond");
  const newResp = after.data.responses.find((r) => String(r.id) === responseId);
  assert.ok(newResp, "new response not found");
  const csvAtt = newResp.attachments.find((a) => a.name === "notes.csv");
  assert.ok(csvAtt, "respond attachment not found");
  assert.equal(csvAtt.is_inline, false);
  step("respond attachment present on the created response (non-inline)");

  // 9. get_attachment BY ID returns the exact bytes we uploaded.
  const dl = must(
    await callV1("tickets/attachment", { ticket_id: ticketId, response_attachment_id: csvAtt.id, intent: "review_ok" }),
    "attachment download by id",
  );
  const got = Buffer.from(dl.data.content_base64, "base64").toString("utf8");
  assert.equal(got, CSV_CONTENT, "downloaded bytes differ from uploaded");
  step("get_attachment by ticket_id round-trips the exact bytes");

  console.log(`\nattachments-and-id: ${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
