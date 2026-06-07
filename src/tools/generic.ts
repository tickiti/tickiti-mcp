import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { FAMILIES, MANIFEST, actionsFor, buildPath, findRoute } from "../manifest.js";

/**
 * Completeness layer over the named tools:
 *
 *  - list_endpoints  — discovery. The family controllers are pure passthru to
 *    the UI controllers, so we don't ship per-write field schemas; this lets the
 *    model (and the user) see every endpoint, its action key, abilities, role,
 *    plan gates and path params, then call it via tickiti_call.
 *
 *  - tickiti_call    — escape hatch. Forwards an arbitrary payload to any v1
 *    endpoint by family + action. The token's abilities remain the security
 *    boundary, so this can never exceed what the token already permits.
 */
export function registerGenericTools(server: McpServer): void {
  server.registerTool(
    "list_endpoints",
    {
      title: "List Tickiti API endpoints",
      description:
        "Discover available Tickiti v1 endpoints. Optionally filter by family " +
        `(one of: ${FAMILIES.join(", ")}). Returns each endpoint's action key, ` +
        "required abilities, role, plan gates and path params — use these with tickiti_call.",
      inputSchema: {
        family: z.string().optional().describe(`Filter to one family: ${FAMILIES.join(", ")}`),
      },
    },
    async ({ family }) => {
      const rows = MANIFEST.filter((e) => !family || e.family === family).map((e) => ({
        family: e.family,
        action: e.action,
        uri: e.uri,
        abilities: e.abilities,
        role: e.role,
        sysadmin: e.sysadmin || undefined,
        plans: e.plans.length ? e.plans : undefined,
        params: e.params.length ? e.params : undefined,
        idempotent: e.idempotent || undefined,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, endpoints: rows }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "tickiti_call",
    {
      title: "Call any Tickiti v1 endpoint",
      description:
        "Advanced escape hatch: invoke any Tickiti v1 endpoint not covered by a " +
        "dedicated tool. Use list_endpoints first to find the family + action. " +
        "payload becomes the JSON request body; for endpoints with path params " +
        "(e.g. user, queue) include those keys in payload too.",
      inputSchema: {
        family: z.string().describe(`One of: ${FAMILIES.join(", ")}`),
        action: z.string().describe("Action key from list_endpoints, e.g. 'queues.index'"),
        payload: z.record(z.any()).optional().describe("JSON request body (and any path-param values)"),
      },
    },
    async ({ family, action, payload }) => {
      const entry = findRoute(family, action);
      if (!entry) {
        const known = actionsFor(family);
        const msg = known.length
          ? `Unknown action '${action}' for family '${family}'. Valid actions: ${known.join(", ")}`
          : `Unknown family '${family}'. Valid families: ${FAMILIES.join(", ")}`;
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }

      const body = (payload ?? {}) as Record<string, unknown>;
      const { path, missing } = buildPath(entry, body);
      if (missing.length) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Missing required path param(s): ${missing.join(", ")}. Include them in payload.`,
            },
          ],
        };
      }

      return toToolResult(await callV1(path, body, { idempotent: entry.idempotent }));
    },
  );
}
