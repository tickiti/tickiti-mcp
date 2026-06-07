import { MANIFEST, type RouteEntry } from "./generated/manifest.js";

export type { RouteEntry };
export { MANIFEST };

export const FAMILIES: string[] = [...new Set(MANIFEST.map((e) => e.family))].sort();

/** Resolve a route by family + action (the route-name-derived key). */
export function findRoute(family: string, action: string): RouteEntry | undefined {
  return MANIFEST.find((e) => e.family === family && e.action === action);
}

/** Valid actions for a family, for error messages and discovery. */
export function actionsFor(family: string): string[] {
  return MANIFEST.filter((e) => e.family === family)
    .map((e) => e.action)
    .sort();
}

/**
 * Substitute {param} placeholders in a route uri from the payload, returning the
 * concrete path plus the param keys consumed. Missing params are left in place
 * so the caller surfaces a clear "missing path param" rather than a silent 404.
 */
export function buildPath(
  entry: RouteEntry,
  payload: Record<string, unknown>,
): { path: string; missing: string[] } {
  const missing: string[] = [];
  const path = entry.uri.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = payload[key];
    if (v === undefined || v === null || v === "") {
      missing.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(String(v));
  });
  return { path, missing };
}
