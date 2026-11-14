import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, sep } from "node:path";

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
 * JSON, or a path to a JSON file - mapping a name to { base, token }. Every tool
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

  // The value holds tokens, so no error below ever quotes it, or a parser's or the file
  // system's message (both echo the text they choke on): a mistyped value (quoted, a BOM,
  // an unquoted token) printed to stderr ends up in the client's MCP logs.
  const raw = (process.env.TICKITI_INSTANCES ?? "").replace(/^\uFEFF/, "").trim();
  if (raw) {
    let text = raw;
    if (!raw.startsWith("{")) {
      // Named in the error only when it is plainly a JSON file's path: a token pasted here
      // (Sanctum's "12|..." or any other) must not be echoed as if it were one.
      const looksLikePath = /\.json$/i.test(raw) && !/[{}"'|]/.test(raw);
      try {
        text = readFileSync(raw, "utf8").replace(/^\uFEFF/, "");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        throw new Error(
          looksLikePath
            ? `TICKITI_INSTANCES: cannot read the file ${raw}${code ? ` (${code})` : ""}.`
            : `TICKITI_INSTANCES (${raw.length} characters) is neither JSON starting with '{' nor a readable file path; its text is not shown because it may hold tokens.`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `TICKITI_INSTANCES ${text === raw ? `(${raw.length} characters)` : "file"} is not valid JSON; its text is not shown because it may hold tokens.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error('TICKITI_INSTANCES must be a JSON object mapping a name to { "base", "token" }.');
    }
    for (const [name, v] of Object.entries(parsed as Record<string, { base?: string; token?: string }>)) {
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

/** The name of the instance calls are going to now (for per-instance caches). */
export function currentInstanceName(): string {
  return current()?.name ?? "";
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

/**
 * TICKITI_MCP_FILE_ROOTS: the directories (separated as PATH is) a tool may read a local file
 * from, for a process whose tool arguments can be steered by what it reads, such as an agent
 * task. Unset, a tool reads whatever the process can, as a staff member's own session always has.
 */
const FILE_ROOTS = (process.env.TICKITI_MCP_FILE_ROOTS ?? "")
  .split(delimiter)
  .map((r) => r.trim())
  .filter(Boolean);

/**
 * The path to read for a path a tool was given. With roots set, links are resolved first so one
 * cannot lead out of a root, and the resolved path is what gets read. Missing and outside give
 * the same error, so a refused path says nothing about what exists there.
 */
export function readablePath(filePath: string): string {
  if (!FILE_ROOTS.length) return filePath;

  let real: string | undefined;
  try {
    real = realpathSync.native(filePath);
  } catch {
    /* refused below */
  }
  if (real !== undefined) {
    for (const root of FILE_ROOTS) {
      let realRoot: string;
      try {
        realRoot = realpathSync.native(root);
      } catch {
        continue;
      }
      const rel = relative(realRoot, real);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return real;
    }
  }
  throw new Error("not a file under TICKITI_MCP_FILE_ROOTS");
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
  /** HTTP method. Every v1 endpoint is POST but one (GET faqs); a GET sends the body as a query string. */
  method?: string;
  /** Give up after this many milliseconds (default TICKITI_API_TIMEOUT_MS, 30 s). */
  timeoutMs?: number;
}

/** A body as a query string, for a GET: scalars as they are, arrays as key[]=, objects as JSON. */
function queryString(body: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, typeof x === "object" ? JSON.stringify(x) : String(x));
    else q.append(k, typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Call /api/v1/{path}: a JSON body by POST, which every v1 endpoint takes but GET faqs,
 * or a query string by GET when opts.method says so.
 */
export async function callV1(
  path: string,
  body: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<ApiResult> {
  const { base, token } = current();
  const method = (opts.method ?? "POST").toUpperCase();
  const get = method === "GET" || method === "HEAD";
  const url = `${base}/api/v1/${path.replace(/^\/+/, "")}${get ? queryString(body) : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (!get) headers["Content-Type"] = "application/json";
  if (opts.idempotent) headers["Idempotency-Key"] = randomUUID();

  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: get ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `request timed out after ${timeout}ms`
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
 * Upload one local file to POST /api/v1/{path} (multipart): by default
 * tickets/attachment-upload, for out-of-line (non-inline) attachments. That endpoint
 * is content-addressed by sha256, so a re-upload of identical bytes is a no-op and no
 * idempotency key is needed. Reads the file off disk here — the model never handles
 * bytes. `fileField` is the form field the file goes in ('file' unless the endpoint
 * names another, as the branding logos' 'logo' does); `fields` are sent beside it.
 */
export async function uploadFileV1(
  filePath: string,
  name?: string,
  path = "tickets/attachment-upload",
  fields: Record<string, string> = {},
  fileField = "file",
): Promise<ApiResult> {
  const { base, token } = current();
  const url = `${base}/api/v1/${path}`;

  let bytes: Buffer;
  try {
    bytes = readFileSync(readablePath(filePath));
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
  form.append(fileField, new Blob([new Uint8Array(bytes)]), fileName);
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

  // Laravel's own 404 for a route it does not have, as against a record not found: the
  // instance runs an older (or newer) Tickiti than the endpoint list this server was built
  // from - a hosted tenant can lag a version. Say so rather than leave a bare "Not found".
  if (status === 404 && /The route .+ could not be found/i.test(detail)) {
    detail +=
      " This Tickiti instance does not have this endpoint: it runs a different build from the one this " +
      "server's endpoint list came from, so the call needs that instance updated (or the web UI meanwhile).";
  }

  return detail ? `${hint} ${detail}`.trim() : hint;
}
