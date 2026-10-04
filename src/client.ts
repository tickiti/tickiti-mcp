import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * The single chokepoint every tool calls through. Owns:
 *  - base URL + bearer auth (token abilities are the real security boundary)
 *  - idempotency-key injection for write calls
 *  - error normalisation, so a tool always gets a predictable shape back
 *  - which Tickiti instance a call goes to
 *
 * Config is read once at startup so a missing token fails fast and loud
 * rather than on the first tool call.
 *
 * Instances: TICKITI_API_BASE + TICKITI_API_TOKEN name the default one (called
 * TICKITI_INSTANCE_NAME, or "default"). More can be added with TICKITI_INSTANCES -
 * JSON, or a path to a JSON file - mapping a name to { base, token }. Every tool then
 * takes an optional `instance`, so production and staging can be used in one session
 * without reconnecting the server (the server used to be bound to one instance at
 * spawn time).
 */

export interface Instance {
  name: string;
  base: string;
  token: string;
}

const TIMEOUT_MS = Number(process.env.TICKITI_API_TIMEOUT_MS ?? 30000);

function loadInstances(): Instance[] {
  const out: Instance[] = [];
  const base = (process.env.TICKITI_API_BASE ?? "").replace(/\/+$/, "");
  const token = process.env.TICKITI_API_TOKEN ?? "";
  if (base || token) {
    out.push({ name: process.env.TICKITI_INSTANCE_NAME || "default", base, token });
  }

  const raw = (process.env.TICKITI_INSTANCES ?? "").trim();
  if (raw) {
    let text = raw;
    if (!raw.startsWith("{")) {
      try {
        text = readFileSync(raw, "utf8");
      } catch (e) {
        throw new Error(`TICKITI_INSTANCES: cannot read ${raw}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let parsed: Record<string, { base?: string; token?: string }>;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`TICKITI_INSTANCES is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [name, v] of Object.entries(parsed)) {
      if (out.some((i) => i.name === name)) continue;
      out.push({ name, base: String(v?.base ?? "").replace(/\/+$/, ""), token: String(v?.token ?? "") });
    }
  }
  return out;
}

const INSTANCES = loadInstances();
const context = new AsyncLocalStorage<string>();

/** Names of the configured instances (no tokens). */
export function instanceList(): { name: string; base: string; default: boolean }[] {
  return INSTANCES.map((i, n) => ({ name: i.name, base: i.base, default: n === 0 }));
}

export function hasMultipleInstances(): boolean {
  return INSTANCES.length > 1;
}

/** Run fn with every call inside it going to the named instance (undefined = default). */
export function withInstance<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (name !== undefined && !INSTANCES.some((i) => i.name === name)) {
    const known = INSTANCES.map((i) => i.name).join(", ");
    return Promise.reject(new Error(`Unknown instance '${name}'. Configured: ${known}.`));
  }
  return name === undefined ? fn() : context.run(name, fn);
}

function current(): Instance {
  const name = context.getStore();
  return (name !== undefined ? INSTANCES.find((i) => i.name === name) : undefined) ?? INSTANCES[0];
}

export function assertConfig(): void {
  if (!INSTANCES.length) {
    throw new Error(
      "Missing required env var(s): TICKITI_API_BASE, TICKITI_API_TOKEN (or TICKITI_INSTANCES). " +
        "Copy .env.example and fill them in.",
    );
  }
  for (const i of INSTANCES) {
    const missing: string[] = [];
    if (!i.base) missing.push("base");
    if (!i.token) missing.push("token");
    if (missing.length) {
      throw new Error(`Instance '${i.name}' is missing its ${missing.join(" and ")}.`);
    }
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
  const { base, token } = current();
  const url = `${base}/api/v1/${path.replace(/^\/+/, "")}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
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

/**
 * Upload one local file to POST /api/v1/tickets/attachment-upload (multipart),
 * for out-of-line (non-inline) attachments. The endpoint is content-addressed
 * by sha256, so a re-upload of identical bytes is a no-op and no idempotency
 * key is needed. Reads the file off disk here — the model never handles bytes.
 * Returns the parsed { sha256, name, file_size } on success.
 */
export async function uploadFileV1(
  filePath: string,
  name?: string,
  path = "tickets/attachment-upload",
  fields: Record<string, string> = {},
): Promise<ApiResult> {
  const { base, token } = current();
  const url = `${base}/api/v1/${path}`;

  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      summary: `Cannot read attachment file ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const fileName = name ?? basename(filePath);
  const form = new FormData();
  // Wrap in a fresh Uint8Array so the Blob part is ArrayBuffer-backed (a raw
  // Node Buffer's ArrayBufferLike doesn't satisfy the BlobPart DOM type).
  form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // No Content-Type — fetch sets the multipart boundary itself.
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      body: form,
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
          : status === 413
            ? "Too large."
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
