import { callV1, currentInstanceName } from "./client.js";

/**
 * Which v1 endpoints the instance being called actually has.
 *
 * The manifest (src/generated/manifest.ts) is built from Tickiti main, but an instance
 * can run another build: a hosted tenant can lag main by a version, and
 * support.tickiti.com once had no tickets/close at all. Where the instance says which
 * routes it has, list_endpoints marks the ones it lacks and tickiti_call refuses them
 * with that reason instead of a bare 404.
 *
 * The list is read from v1/token (get_token_info), once per instance per process, from
 * `data.endpoints` (or `data.routes`): route names such as "api.v1.tickets.close", or
 * objects with a `name` (and optionally `uri` and `method`). A build may give its version
 * as `data.version` (or `data.build`). Tickiti does not report either yet; until it does,
 * the catalogue is the compiled one and a missing route still shows up as Laravel's
 * "The route ... could not be found", which callV1 explains.
 */

export interface InstanceRoute {
  name: string;
  uri?: string;
  method?: string;
}

export interface Catalogue {
  /** "instance": the instance listed its routes; "compiled": it did not, or could not be asked. */
  source: "instance" | "compiled";
  /** The instance's build or version, when it says. */
  version?: string;
  /** Route names the instance has, by name (source "instance" only). */
  routes?: Map<string, InstanceRoute>;
  /** Why the catalogue is the compiled one. */
  note?: string;
}

/** A failed read is retried after this long; a good one is kept for the process. */
const RETRY_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Catalogue> }>();

function normalise(name: string): string {
  return name.startsWith("api.v1.") ? name : `api.v1.${name}`;
}

function readRoutes(list: unknown): Map<string, InstanceRoute> | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  const routes = new Map<string, InstanceRoute>();
  for (const r of list) {
    if (typeof r === "string") routes.set(normalise(r), { name: normalise(r) });
    else if (r && typeof r === "object" && typeof (r as InstanceRoute).name === "string") {
      const e = r as InstanceRoute;
      const name = normalise(e.name);
      routes.set(name, { name, uri: e.uri?.replace(/^\/?api\/v1\//, ""), method: e.method?.split("|")[0] });
    }
  }
  return routes.size ? routes : undefined;
}

async function load(): Promise<Catalogue> {
  const r = await callV1("token", {}, { timeoutMs: 5000 });
  if (!r.ok || !r.body || typeof r.body !== "object") {
    throw new Error(r.summary);
  }
  const data = ((r.body as { data?: unknown }).data ?? r.body) as Record<string, unknown>;
  const v = data.version ?? data.build;
  const version = typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  const routes = readRoutes(data.endpoints ?? data.routes);
  return routes
    ? { source: "instance", version, routes }
    : {
        source: "compiled",
        version,
        note: "This instance does not list its own endpoints, so these are the endpoints of the Tickiti build this server was made from.",
      };
}

/** The catalogue for the instance calls are going to now. Never throws. */
export async function instanceCatalogue(): Promise<Catalogue> {
  const key = currentInstanceName();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < RETRY_MS) return hit.value;
  if (hit) {
    const prev = await hit.value;
    if (prev.source === "instance" || !prev.note?.startsWith("Could not")) return prev;
  }

  const value = load().catch(
    (e): Catalogue => ({
      source: "compiled",
      note: `Could not ask the instance for its endpoints (${e instanceof Error ? e.message : String(e)}); these are the compiled ones.`,
    }),
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}
