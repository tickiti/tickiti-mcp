import { randomUUID } from "node:crypto";

/**
 * The single chokepoint every tool calls through. Owns:
 *  - base URL + bearer auth (token abilities are the real security boundary)
 *  - idempotency-key injection for write calls
 *  - error normalisation, so a tool always gets a predictable shape back
 *
 * Config is read once at startup so a missing token fails fast and loud
 * rather than on the first tool call.
 */

const BASE = (process.env.TICKITI_API_BASE ?? "").replace(/\/+$/, "");
const TOKEN = process.env.TICKITI_API_TOKEN ?? "";
const TIMEOUT_MS = Number(process.env.TICKITI_API_TIMEOUT_MS ?? 30000);

export function assertConfig(): void {
  const missing: string[] = [];
  if (!BASE) missing.push("TICKITI_API_BASE");
  if (!TOKEN) missing.push("TICKITI_API_TOKEN");
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
        `Copy .env.example and fill them in.`,
    );
  }
}

export interface ApiResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON; otherwise the raw text. */
  body: unknown;
  /** A short human-readable summary, useful for surfacing 401/403/422 to the model. */
  summary: string;
}

export interface CallOptions {
  /** When true, mint and send an Idempotency-Key header (create/respond writes). */
  idempotent?: boolean;
}

/**
 * POST a JSON body to /api/v1/{path}. Every v1 endpoint is POST, so this is the
 * only verb the shim needs.
 */
export async function callV1(
  path: string,
  body: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<ApiResult> {
  const url = `${BASE}/api/v1/${path.replace(/^\/+/, "")}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };
  if (opts.idempotent) headers["Idempotency-Key"] = randomUUID();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `request timed out after ${TIMEOUT_MS}ms`
        : `network error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, status: 0, body: null, summary: `Failed to reach ${url} — ${reason}` };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = text;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* leave parsed as raw text */
    }
  }

  return {
    ok: res.ok,
    status: res.status,
    body: parsed,
    summary: res.ok ? `${res.status} OK` : summariseError(res.status, parsed),
  };
}

/** Turn the common Tickiti/Laravel failure shapes into one readable line. */
function summariseError(status: number, body: unknown): string {
  const hint =
    status === 401
      ? "Unauthenticated — check TICKITI_API_TOKEN."
      : status === 403
        ? "Forbidden — the token lacks the required ability/role/plan for this endpoint."
        : status === 422
          ? "Validation failed."
          : status === 404
            ? "Not found."
            : `HTTP ${status}.`;

  let detail = "";
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") detail = b.message;
    if (b.errors && typeof b.errors === "object") {
      detail += " " + JSON.stringify(b.errors);
    }
  } else if (typeof body === "string" && body.trim()) {
    detail = body.slice(0, 300);
  }

  return detail ? `${hint} ${detail}`.trim() : hint;
}
