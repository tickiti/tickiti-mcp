import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { callV1 } from "../client.js";
import { toToolResult, toAttachmentResult } from "../result.js";

/**
 * Tickets family — read side. Backs onto the tickets:read endpoints added to
 * the Public API v1:
 *   POST /api/v1/tickets/show              (tickets:read) — get_ticket
 *   POST /api/v1/tickets/responses         (tickets:read) — list_responses
 *   POST /api/v1/tickets/responses/query   (tickets:read) — query_responses / export_responses
 *   POST /api/v1/tickets/attachment        (tickets:read) — get_attachment
 *
 * These complement query_tickets (which only lists summary rows): they read a
 * ticket's full thread (public + internal staff notes), bulk-query responses
 * across tickets by date/queue/flags, and download attachment bytes — so an
 * assistant can read-then-respond without leaving the sanctioned API channel.
 */

/** Shared filter shape for the cross-ticket responses query. */
const responseFilterShape = {
  created_from: z
    .string()
    .optional()
    .describe("Responses created on/after — 'YYYY-MM-DD' (>=00:00:00 UTC) or full 'YYYY-MM-DD HH:MM:SS'"),
  created_to: z
    .string()
    .optional()
    .describe("Responses created on/before — 'YYYY-MM-DD' (<=23:59:59 UTC) or full datetime"),
  is_internal: z.boolean().optional().describe("Tri-state: omit for either"),
  staff_response: z.boolean().optional().describe("Tri-state: omit for either"),
  queue: z.array(z.string()).optional().describe("Restrict by queue name(s)"),
  queue_id: z.array(z.number().int()).optional().describe("Restrict by queue id(s)"),
  ticket_number: z.array(z.string()).optional().describe("Restrict to specific ticket number(s)"),
  response_id: z.array(z.number().int()).optional().describe("Restrict to specific response id(s)"),
  created_by_email: z.string().optional().describe("Restrict to one author"),
  has_attachments: z.boolean().optional().describe("Tri-state: only responses with (true) / without (false) attachments"),
  is_empty: z.boolean().optional().describe("Tri-state: only responses with no message body (true) / with one (false)"),
  include_deleted: z.boolean().optional().describe("Include soft-deleted responses (default false)"),
  fields: z
    .array(
      z.enum([
        "html", "plain_text", "attachments", "is_internal", "is_pinned", "staff_response",
        "created_by_email", "created_at", "updated_at", "is_email_sourced", "audit", "is_audit_only",
      ]),
    )
    .optional()
    .describe(
      "Only the three body fields: return all metadata plus those. Any metadata name: return exactly the " +
        "fields named (response_id and ticket_number always come). Default: everything.",
    ),
  metadata_only: z.boolean().optional().describe("Drop html, plain_text and attachments."),
};

/** Shared projection for the two per-ticket thread reads. */
const threadShape = {
  fields: z
    .array(z.enum(["html", "plain_text", "attachments"]))
    .optional()
    .describe("Which heavy response fields to return (default all). Metadata, audit and body_chars always come."),
  max_body_chars: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Cut each html / plain_text to this many characters (marked *_truncated). Email threads can be 100-400 KB."),
};

/** Strip undefined keys so the API call body only carries supplied filters. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerTicketReadTools(server: McpServer): void {
  server.registerTool(
    "get_ticket",
    {
      title: "Get a ticket with its full thread",
      description:
        "Fetch one ticket with its header and full response thread " +
        "(public + internal staff notes) plus attachment metadata, its participants (with " +
        "names and staff flags), the raised-by name, the queue name and its linked tickets. " +
        "Email-sourced threads can be very large: pass fields and/or max_body_chars to keep the " +
        "result small (e.g. fields: ['plain_text'], max_body_chars: 2000). Identify it by " +
        "ticket_number OR ticket_id (internal DB id) — supply exactly one. Requires tickets:read.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number (the 6-digit human reference); supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id); supply this OR ticket_number"),
        ...threadShape,
      },
    },
    async ({ ticket_number, ticket_id, fields, max_body_chars }) =>
      toToolResult(await callV1("tickets/show", compact({ ticket_number, ticket_id, fields, max_body_chars }))),
  );

  server.registerTool(
    "list_responses",
    {
      title: "List a ticket's responses",
      description:
        "List the responses on a ticket (bodies, public/internal flag, author and " +
        "attachment metadata). fields / max_body_chars keep a long email thread small. Identify " +
        "it by ticket_number OR ticket_id (internal DB id) — supply exactly one. Requires tickets:read.",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket.number (the 6-digit human reference); supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id); supply this OR ticket_number"),
        ...threadShape,
      },
    },
    async ({ ticket_number, ticket_id, fields, max_body_chars }) =>
      toToolResult(await callV1("tickets/responses", compact({ ticket_number, ticket_id, fields, max_body_chars }))),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Download a response attachment",
      description:
        "Download one response attachment's bytes (returned as an embedded resource). " +
        "The attachment must belong to the given ticket. Requires tickets:read. " +
        "Hard-blocked types are refused; review-gated types need confirm=true.",
      inputSchema: {
        ticket_number: z
          .string()
          .optional()
          .describe("Ticket the attachment belongs to (authorisation scope); supply this OR ticket_id"),
        ticket_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Ticket.id (internal DB id); supply this OR ticket_number"),
        response_attachment_id: z
          .union([z.string(), z.number()])
          .describe("ResponseAttachment.id (from get_ticket / list_responses)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to accept a 'review'-gated attachment type"),
      },
    },
    async ({ ticket_number, ticket_id, response_attachment_id, confirm }) => {
      const body: Record<string, unknown> = compact({ ticket_number, ticket_id, response_attachment_id });
      if (confirm) body.intent = "review_ok";
      return toAttachmentResult(await callV1("tickets/attachment", body));
    },
  );

  server.registerTool(
    "download_attachment",
    {
      title: "Download a response attachment to a local file",
      description:
        "Save a response attachment to a local file path, streaming it in byte-range chunks " +
        "so it works for files ABOVE the 25 MiB single-shot get_attachment cap (videos, large " +
        "diagnostics, …). The bytes are written to disk and never pass through the model's " +
        "context — the right tool for big attachments. Returns a manifest { path, bytes, mime }. " +
        "Requires tickets:read. 'path' is a path on the machine running the MCP (an existing " +
        "file is overwritten; missing folders are created).",
      inputSchema: {
        ticket_number: z.string().optional().describe("Ticket the attachment belongs to; supply this OR ticket_id"),
        ticket_id: z.union([z.string(), z.number()]).optional().describe("Ticket.id (internal DB id)"),
        response_attachment_id: z.union([z.string(), z.number()]).describe("ResponseAttachment.id"),
        path: z.string().describe("Absolute local output path (overwritten if present)"),
        confirm: z.boolean().optional().describe("Set true to accept a 'review'-gated attachment type"),
        chunk_bytes: z
          .number()
          .int()
          .min(1)
          .max(25 * 1024 * 1024)
          .optional()
          .describe("Bytes per range request (default 8 MiB; each must be ≤ 25 MiB)"),
      },
    },
    async ({ ticket_number, ticket_id, response_attachment_id, path, confirm, chunk_bytes }) => {
      const CAP = 25 * 1024 * 1024;
      const chunk = Math.min(chunk_bytes ?? 8 * 1024 * 1024, CAP);
      const intent: Record<string, unknown> = confirm ? { intent: "review_ok" } : {};

      // The output folder is created rather than failing with ENOENT (#931019).
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (e) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error: cannot create the folder for ${path} — ${e instanceof Error ? e.message : String(e)}` }],
        };
      }
      const out = createWriteStream(path, { flags: "w" });
      // Lifecycle as a promise that NEVER rejects (resolves Error|null) and that we
      // ALWAYS await before returning — so a stream 'error' can never become a
      // detached unhandled rejection that takes the whole stdio server down.
      const closed = new Promise<Error | null>((resolve) => {
        out.on("error", (e) => resolve(e instanceof Error ? e : new Error(String(e))));
        out.on("close", () => resolve(null)); // 'close' fires after end() AND after destroy()
      });
      const fail = (text: string) => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      try {
        // Probe with a single UN-ranged read — identical to get_attachment, so it
        // works even against a server that has not deployed the offset/length
        // variant. Anything at/under the 25 MiB single-shot cap is written here and
        // never touches the ranged path.
        const first = await callV1(
          "tickets/attachment",
          compact({ ticket_number, ticket_id, response_attachment_id, ...intent }),
        );
        const firstBody = first.body as
          | { error?: string; data?: Record<string, unknown> }
          | null
          | undefined;

        // A server refuses an UN-ranged read of an oversize file with HTTP 413
        // { error: "attachment_too_large", data: { file_size, ranged: true } } —
        // it returns NO first page. Detect that and page with explicit ranges
        // from offset 0 rather than surfacing the 413. (get_attachment stays
        // single-shot/capped; only download_attachment recovers.)
        const tooBig =
          !first.ok &&
          typeof firstBody === "object" &&
          firstBody?.error === "attachment_too_large" &&
          Boolean(firstBody?.data?.ranged);

        if (!tooBig && (!first.ok || !first.body || typeof first.body !== "object")) {
          out.destroy();
          await closed;
          return toToolResult(first); // surface 403/404/422/… verbatim
        }

        let mime = "application/octet-stream";
        let total = 0;
        let offset = 0;
        let needRanged = false;

        if (tooBig) {
          // The probe delivered no bytes; the whole file comes via ranged reads.
          total = Number(firstBody?.data?.file_size ?? 0);
          if (typeof firstBody?.data?.mime_type === "string") {
            mime = String(firstBody.data.mime_type);
          }
          needRanged = true;
        } else {
          const d0 = (first.body as { data?: Record<string, unknown> }).data ?? {};
          mime = String(d0.mime_type ?? "application/octet-stream");
          total = Number(d0.file_size ?? 0);
          const b0 = typeof d0.content_base64 === "string" ? d0.content_base64 : "";
          if (!b0) {
            out.destroy();
            await closed;
            return toToolResult(first); // no bytes in the payload — show what we got
          }
          const buf0 = Buffer.from(b0, "base64");
          out.write(buf0);
          offset = buf0.length;
          // Page only when the single shot didn't already deliver everything.
          needRanged = total > offset && !d0.eof;
        }

        // Shared ranged-paging loop (used both by the too-big-from-0 path and the
        // exceeded-one-shot path). Explicit offset/length reads to eof/total.
        if (needRanged) {
          for (;;) {
            const r = await callV1(
              "tickets/attachment",
              compact({ ticket_number, ticket_id, response_attachment_id, offset, length: chunk, ...intent }),
            );
            if (!r.ok || !r.body || typeof r.body !== "object") {
              out.destroy();
              await closed;
              return toToolResult(r);
            }
            const d = (r.body as { data?: Record<string, unknown> }).data ?? {};
            if (typeof d.mime_type === "string") mime = String(d.mime_type);
            if (!total) total = Number(d.file_size ?? 0);
            const b = typeof d.content_base64 === "string" ? d.content_base64 : "";
            const buf = Buffer.from(b, "base64");
            if (buf.length === 0) break; // server didn't honour the range — stop, don't spin
            out.write(buf);
            offset += buf.length; // strictly increasing => guaranteed to terminate
            if (Boolean(d.eof) || (total > 0 && offset >= total)) break;
          }
        }

        out.end();
        const err = await closed;
        if (err) return fail(`Error: failed writing ${path} — ${err.message}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, path, bytes: offset, file_size: total, mime }, null, 2),
            },
          ],
        };
      } catch (e) {
        out.destroy();
        await closed;
        return fail(`Error: download_attachment failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "query_responses",
    {
      title: "Query responses across tickets",
      description:
        "Bulk-query responses across every queue-authorised ticket, filtered by " +
        "created_at window / queue / internal+staff flags / author / specific tickets or " +
        "response ids / has-attachments / empty-body. count_only: true returns just the number " +
        "of matches; group_by returns tallies (by ticket_number, created_by_email, queue, " +
        "is_internal, staff_response or day) - no rows. Keyset-paginated: pass back " +
        "data.next_cursor to get the next page. Requires tickets:read. For a full dump to disk, " +
        "use export_responses instead.",
      inputSchema: {
        ...responseFilterShape,
        count_only: z.boolean().optional().describe("Return only the number of matching responses."),
        group_by: z
          .enum(["ticket_number", "created_by_email", "queue", "is_internal", "staff_response", "day"])
          .optional()
          .describe("Return match counts grouped by this column."),
        limit: z.number().int().min(1).max(1000).optional().describe("Page size (default 200, max 1000)"),
        cursor: z
          .object({ created_at: z.string(), id: z.number().int() })
          .optional()
          .describe("Keyset cursor from a prior page's data.next_cursor"),
      },
    },
    async (args) => toToolResult(await callV1("tickets/responses/query", compact({ ...args }))),
  );

  server.registerTool(
    "export_responses",
    {
      title: "Export responses to an NDJSON file",
      description:
        "Dump every response matching the filters to a local NDJSON file (one JSON " +
        "object per line), paging through the result server-side. Returns only a " +
        "manifest { path, count, pages } — the bodies are written to disk and never " +
        "pass through the model's context, so this is the right tool for large " +
        "exports. Requires tickets:read. The MCP server runs locally, so 'path' is a " +
        "path on this machine; an existing file is overwritten.",
      inputSchema: {
        path: z.string().describe("Absolute local path for the output .ndjson file (overwritten if present)"),
        ...responseFilterShape,
        page_size: z.number().int().min(1).max(1000).optional().describe("Rows per API page (default 500)"),
        max_records: z.number().int().min(1).optional().describe("Optional safety cap on total rows written"),
      },
    },
    async ({ path, page_size, max_records, ...filters }) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (e) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Error: cannot create the folder for ${path} — ${e instanceof Error ? e.message : String(e)}` }],
        };
      }
      const out = createWriteStream(path, { encoding: "utf8", flags: "w" });
      // Non-rejecting lifecycle (resolves Error|null), always awaited before return —
      // same detached-rejection hazard as download_attachment; keep it from crashing
      // the whole server.
      const closed = new Promise<Error | null>((resolve) => {
        out.on("error", (e) => resolve(e instanceof Error ? e : new Error(String(e))));
        out.on("close", () => resolve(null));
      });
      const fail = (text: string) => ({
        isError: true as const,
        content: [{ type: "text" as const, text }],
      });

      let cursor: { created_at: string; id: number } | undefined;
      let count = 0;
      let pages = 0;
      const pageSize = page_size ?? 500;

      try {
        for (;;) {
          const body: Record<string, unknown> = compact({ ...filters });
          body.limit = pageSize;
          if (cursor) body.cursor = cursor;

          const r = await callV1("tickets/responses/query", body);
          if (!r.ok) {
            out.destroy();
            await closed;
            return toToolResult(r); // surface the API error verbatim
          }

          const data = (r.body as { data?: { responses?: unknown[]; next_cursor?: { created_at: string; id: number } | null } }).data;
          const rows = data?.responses ?? [];
          for (const row of rows) {
            if (max_records && count >= max_records) break;
            out.write(JSON.stringify(row) + "\n");
            count++;
          }
          pages++;

          const next = data?.next_cursor ?? null;
          if (!next || (max_records && count >= max_records)) break;
          cursor = next;
        }
      } catch (e) {
        out.destroy();
        await closed;
        return fail(`Error: export_responses failed — ${e instanceof Error ? e.message : String(e)}`);
      }

      out.end();
      const err = await closed;
      if (err) return fail(`Error: failed writing ${path} — ${err.message}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, path, count, pages, format: "ndjson" }, null, 2),
          },
        ],
      };
    },
  );
}
