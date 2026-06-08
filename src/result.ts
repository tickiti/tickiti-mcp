import type { ApiResult } from "./client.js";

/**
 * Shape an ApiResult into the MCP tool-result envelope. On failure we set
 * isError and lead with the human summary so the model sees *why* it failed;
 * the raw body follows for any structured detail.
 */
export function toToolResult(r: ApiResult) {
  const payload =
    typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);

  if (!r.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${r.summary}\n\n${payload}` }],
    };
  }

  return {
    content: [{ type: "text" as const, text: payload }],
  };
}

/**
 * Like toToolResult, but for the attachment-download endpoint, whose `data`
 * carries the file bytes base64-encoded. On success, return a human summary
 * line PLUS an MCP embedded resource (BlobResourceContents) so a client can
 * save or render the file. On failure — including the blocked / review-required
 * / too-large 4xx envelopes — fall back to the normal error result.
 */
export function toAttachmentResult(r: ApiResult) {
  if (!r.ok || !r.body || typeof r.body !== "object") {
    return toToolResult(r);
  }

  const data = (r.body as { data?: Record<string, unknown> }).data;
  const blob = data?.content_base64;
  if (typeof blob !== "string") {
    // No bytes in the payload — surface whatever we got as text.
    return toToolResult(r);
  }

  const name = String(data?.name ?? "attachment");
  const mime = String(data?.mime_type ?? "application/octet-stream");
  const size = data?.file_size ?? "?";
  const sha = data?.sha256 ?? "";
  const id = String(data?.id ?? "");

  return {
    content: [
      {
        type: "text" as const,
        text: `Attachment "${name}" (${size} bytes, ${mime}) sha256=${sha}`,
      },
      {
        type: "resource" as const,
        resource: {
          uri: `tickiti://attachment/${id}`,
          mimeType: mime,
          blob,
        },
      },
    ],
  };
}
