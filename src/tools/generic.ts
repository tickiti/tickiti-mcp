import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1, uploadFileV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { FAMILIES, MANIFEST, actionsFor, buildPath, findRoute, type RouteEntry } from "../manifest.js";
import { PARAM_HINTS } from "../param-hints.js";
import { BODY_FIELDS } from "../generated/body-fields.js";
import { instanceCatalogue } from "../catalogue.js";

/**
 * Completeness layer over the named tools:
 *
 *  - list_endpoints  — discovery. Every endpoint, its action key, abilities, role,
 *    plan gates and path params (from the route table), and its body fields with
 *    their validation rules (read from the controllers when the manifest is built),
 *    then called via tickiti_call.
 *
 *  - tickiti_call    — escape hatch. Forwards an arbitrary payload to any v1
 *    endpoint by family + action, with the endpoint's own method, and a local file
 *    as multipart for the upload endpoints. The token's abilities remain the
 *    security boundary, so this can never exceed what the token already permits.
 */

/** A rule that takes an uploaded file. */
const FILE_RULE = /(^|\|)(file|image)(\||$)/;

/** The form field an endpoint takes its file in, if it takes one. */
function fileFieldOf(name: string): string | undefined {
  const fields = BODY_FIELDS[name]?.fields ?? {};
  return Object.keys(fields).find((f) => !f.includes(".") && FILE_RULE.test(fields[f]));
}

/** Top-level body fields the endpoint's rules require, less path params and the file. */
function requiredOf(entry: RouteEntry): string[] {
  const file = fileFieldOf(entry.name);
  return (BODY_FIELDS[entry.name]?.required ?? []).filter(
    (f) => !f.includes(".") && f !== file && !entry.params.includes(f),
  );
}

/** A multipart form value: scalars as text, booleans as 1/0, anything else as JSON. */
function formValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function registerGenericTools(server: McpServer): void {
  server.registerTool(
    "list_endpoints",
    {
      title: "List Tickiti API endpoints",
      description:
        "Discover available Tickiti v1 endpoints. Optionally filter by family " +
        `(one of: ${FAMILIES.join(", ")}) and/or action (e.g. 'users.' or 'users.queue_upsert'). Returns each ` +
        "endpoint's action key, required abilities, role, plan gates and path params; method when it is not POST; " +
        "file_field for an upload; required body fields; and body (a note on the shape, where one is kept). With a " +
        "family or action filter, body_fields gives every body field with its validation rules (Laravel's, from the " +
        "controller: '?' is a field read without a rule). Where the instance lists its own endpoints, one it lacks " +
        "is marked on_instance: false. Use these with tickiti_call.",
      inputSchema: {
        family: z.string().optional().describe(`Filter to one family: ${FAMILIES.join(", ")}`),
        action: z
          .string()
          .optional()
          .describe("Filter to actions starting with this, e.g. 'users.' or 'watchlists.add_tickets'"),
      },
    },
    async ({ family, action }) => {
      const catalogue = await instanceCatalogue();
      const detailed = Boolean(family || action);
      const rows = MANIFEST.filter((e) => (!family || e.family === family) && (!action || e.action.startsWith(action))).map(
        (e) => {
          const required = requiredOf(e);
          return {
            family: e.family,
            action: e.action,
            method: e.method !== "POST" ? e.method : undefined,
            uri: e.uri,
            abilities: e.abilities,
            role: e.role,
            sysadmin: e.sysadmin || undefined,
            plans: e.plans.length ? e.plans : undefined,
            params: e.params.length ? e.params : undefined,
            file_field: fileFieldOf(e.name),
            required: required.length ? required : undefined,
            body: PARAM_HINTS[e.name],
            body_fields: detailed ? BODY_FIELDS[e.name]?.fields : undefined,
            idempotent: e.idempotent || undefined,
            on_instance: catalogue.routes && !catalogue.routes.has(e.name) ? false : undefined,
          };
        },
      );

      // Routes the instance has that this server's list does not (it runs a newer build).
      const known = new Set(MANIFEST.map((e) => e.name));
      const instanceOnly = catalogue.routes
        ? [...catalogue.routes.values()]
            .filter((r) => !known.has(r.name))
            .filter((r) => !family || r.name.startsWith(`api.v1.${family}.`))
            .map((r) => ({ name: r.name, uri: r.uri, method: r.method }))
        : [];

      const out = {
        count: rows.length,
        catalogue: { source: catalogue.source, version: catalogue.version, note: catalogue.note },
        endpoints: rows,
        instance_only: instanceOnly.length ? instanceOnly : undefined,
        hint: detailed ? undefined : "Filter by family or action to see each endpoint's body_fields.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "tickiti_call",
    {
      title: "Call any Tickiti v1 endpoint",
      description:
        "Advanced escape hatch: invoke any Tickiti v1 endpoint not covered by a " +
        "dedicated tool. Use list_endpoints first to find the family + action and its body fields. " +
        "The request body is `payload` (not params or body: an argument this tool does not list is refused); " +
        "for endpoints with path params (e.g. user, queue) include those keys in payload too. A call with no " +
        "payload to an endpoint whose fields are required is refused, naming them. The endpoint's own method is " +
        "used (GET faqs sends payload as the query string). For an upload endpoint (list_endpoints shows its " +
        "file_field: branding logos, diagnostics upload, attachment and image uploads), give file_path, a local " +
        "file the server reads and sends as multipart with payload's fields beside it.",
      inputSchema: {
        family: z.string().describe(`One of: ${FAMILIES.join(", ")}`),
        action: z.string().describe("Action key from list_endpoints, e.g. 'queues.index'"),
        payload: z.record(z.any()).optional().describe("JSON request body (and any path-param values)"),
        file_path: z
          .string()
          .optional()
          .describe("A local file to upload, for an endpoint that takes one (sent as multipart; the bytes never pass through the model)"),
        file_field: z
          .string()
          .optional()
          .describe("The form field for file_path; defaults to the endpoint's own (list_endpoints file_field), else 'file'"),
      },
    },
    async ({ family, action, payload, file_path, file_field }) => {
      const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

      const catalogue = await instanceCatalogue();
      const routeName = `api.v1.${family}.${action}`;
      let entry = findRoute(family, action);
      if (!entry) {
        // An endpoint newer than this server's list, which the instance reports with its uri.
        const live = catalogue.routes?.get(routeName);
        if (live?.uri) {
          entry = {
            name: routeName, family, action, method: live.method ?? "POST", uri: live.uri,
            abilities: [], role: null, sysadmin: false, plans: [],
            params: [...live.uri.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
            idempotent: false, write: true,
          };
        } else {
          const known = actionsFor(family);
          return fail(
            known.length
              ? `Unknown action '${action}' for family '${family}'. Valid actions: ${known.join(", ")}`
              : `Unknown family '${family}'. Valid families: ${FAMILIES.join(", ")}`,
          );
        }
      } else if (catalogue.routes && !catalogue.routes.has(entry.name)) {
        return fail(
          `${family} ${action} is not on this instance` +
            (catalogue.version ? ` (Tickiti ${catalogue.version})` : "") +
            ": it runs an older build than this server's endpoint list. Nothing was sent.",
        );
      }

      const route: RouteEntry = entry;
      const body = (payload ?? {}) as Record<string, unknown>;
      const { path, missing } = buildPath(route, body);
      if (missing.length) {
        return fail(`Missing required path param(s): ${missing.join(", ")}. Include them in payload.`);
      }

      // A call with nothing in it to an endpoint that needs fields: say which, rather than
      // let a body sent under the wrong name read as an empty request (tickets/query then
      // returns every ticket, a remove reports its fields missing).
      const required = requiredOf(route);
      const sent = Object.keys(body).filter((k) => !route.params.includes(k));
      if (!sent.length && required.length) {
        return fail(
          `${family} ${action} needs a body: ${required.join(", ")}` +
            ` (all fields: ${Object.keys(BODY_FIELDS[route.name]?.fields ?? {}).join(", ")}). ` +
            "Give them in `payload`. Nothing was sent.",
        );
      }

      const ownFileField = fileFieldOf(route.name);
      const takesFile = Boolean(ownFileField) || /multipart/.test(PARAM_HINTS[route.name] ?? "");
      if (file_path === undefined) {
        if (ownFileField && (BODY_FIELDS[route.name]?.required ?? []).includes(ownFileField)) {
          return fail(`${family} ${action} uploads a file: give file_path (sent as '${ownFileField}'). Nothing was sent.`);
        }
        return toToolResult(await callV1(path, body, { idempotent: route.idempotent, method: route.method }));
      }
      if (!takesFile) {
        return fail(`${family} ${action} takes no file, so file_path does not apply. Nothing was sent.`);
      }

      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null && !route.params.includes(k)) fields[k] = formValue(v);
      }
      return toToolResult(await uploadFileV1(file_path, undefined, path, fields, file_field ?? ownFileField ?? "file"));
    },
  );
}
