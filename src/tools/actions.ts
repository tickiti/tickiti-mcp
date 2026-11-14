import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";

/**
 * The plumbing for a tool that covers one resource with an `action` enum (list / create /
 * update / delete ...), so a page of the web UI is one tool and not five.
 *
 * Every action names the endpoint it calls and the arguments it takes. An argument another
 * action of the tool takes is refused by name before anything is sent, as strictRegistration
 * refuses an unknown one: without it a field meant for `update` given to `create` would reach
 * Tickiti, which ignores what it does not read, and the caller would never know.
 */

/** Strip undefined keys so the API call body only carries supplied fields. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** The ticket reference most ticket endpoints take: ticket_number or ticket_id. */
export const ticketRef = {
  ticket_number: z.union([z.string(), z.number()]).optional().describe("The ticket's number (e.g. 365176)"),
  ticket_id: z.number().int().optional().describe("The ticket's internal id, instead of its number"),
};

export interface ActionSpec {
  /** The v1 path, or a function building it from the arguments (path parameters). */
  path: string | ((args: Record<string, unknown>) => string);
  /** The arguments this action sends. */
  fields: string[];
  /** Arguments it needs; "a|b" means one of them. */
  required?: string[];
  /** Send an Idempotency-Key (the endpoint refuses a call without one). */
  idempotent?: boolean;
  /** Arguments used to build the path, not sent in the body. */
  pathFields?: string[];
}

export function errorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${text}` }] };
}

/** Check the arguments against the action and call its endpoint. */
export async function runAction(
  tool: string,
  actions: Record<string, ActionSpec>,
  args: Record<string, unknown>,
) {
  const { action, ...rest } = args;
  const spec = actions[String(action)];
  if (!spec) return errorResult(`${tool}: unknown action '${String(action)}'. Actions: ${Object.keys(actions).join(", ")}.`);
  const given = compact(rest);
  const takes = [...spec.fields, ...(spec.pathFields ?? [])];
  const stray = Object.keys(given).filter((k) => !takes.includes(k));
  if (stray.length) {
    return errorResult(
      `${tool} action '${String(action)}' does not take ${stray.map((k) => `'${k}'`).join(", ")}: nothing was sent. ` +
        `It takes: ${takes.length ? takes.join(", ") : "no arguments"}.`,
    );
  }
  const missing = (spec.required ?? []).filter((r) => !r.split("|").some((k) => given[k] !== undefined));
  if (missing.length) {
    return errorResult(
      `${tool} action '${String(action)}' needs ${missing.map((r) => r.split("|").join(" or ")).join(", ")}: nothing was sent.`,
    );
  }
  const body = Object.fromEntries(Object.entries(given).filter(([k]) => !(spec.pathFields ?? []).includes(k)));
  const path = typeof spec.path === "function" ? spec.path(given) : spec.path;
  return toToolResult(await callV1(path, body, { idempotent: spec.idempotent }));
}

/** The action enum for a tool, from its actions table. */
export function actionEnum(actions: Record<string, ActionSpec>) {
  return z.enum(Object.keys(actions) as [string, ...string[]]);
}
