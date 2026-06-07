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
