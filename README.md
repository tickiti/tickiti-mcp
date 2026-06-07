# tickiti-mcp

An [MCP](https://modelcontextprotocol.io) server that acts as a thin shim over the
**Tickiti Public API v1** (`/api/v1/...`). Each MCP tool forwards to a v1 endpoint,
adding the bearer token and (for writes) an idempotency key. The token's Sanctum
abilities are the real security boundary — the shim only relays calls, it never
widens them.

## Status

Full surface in place (pending a live smoke-test against a running instance):

- **tickets** — rich, verified schemas: `create_ticket`, `respond_to_ticket`, `query_tickets`
- **settings / workflow / reports** — named read tools: `list_perspectives`, `list_watchlists`,
  `list_stock_responses`, `list_queues`, `list_workflow`, `run_report`
- **completeness** — `list_endpoints` (discovery) + `tickiti_call` (escape hatch) cover all
  104 v1 endpoints, including every write, without shipping guessed field schemas

The family controllers are pure passthru to the UI controllers, so write field
shapes aren't transcribed here — `tickiti_call` forwards an arbitrary payload and
the token's abilities remain the security boundary.

## Manifest

`src/generated/manifest.ts` is generated from Laravel's own route table
(`php artisan route:list --json`), so abilities / role / plan gates / path params
are never hand-maintained. Regenerate after changing `routes/api.php`:

```bash
TICKITI_DIR=e:/devl/tickiti npm run manifest
```

## Setup

```bash
npm install
cp .env.example .env   # then fill in TICKITI_API_BASE + TICKITI_API_TOKEN
npm run build
```

Mint the token in **Administration → API keys** with the abilities you want the
shim to use (e.g. `tickets:write`). A read-only token transparently makes the
whole shim read-only.

## Run with Claude Code

```bash
claude mcp add tickiti --env TICKITI_API_BASE=http://localhost:9191 \
  --env TICKITI_API_TOKEN=<token> \
  -- node e:/devl/tickiti-mcp/dist/server.js
```

For local development you can point it at `tsx` instead of the built file:

```bash
claude mcp add tickiti --env ... -- npx tsx e:/devl/tickiti-mcp/src/server.ts
```

## Layout

| File | Role |
|---|---|
| `src/client.ts` | Request core: base URL, bearer auth, idempotency, error normalisation |
| `src/result.ts` | Maps an API result into the MCP tool-result envelope |
| `src/manifest.ts` | Helpers over the generated route manifest (lookup, path building) |
| `src/generated/manifest.ts` | Auto-generated route table (do not edit) |
| `src/tools/tickets.ts` | Tickets family — verified schemas |
| `src/tools/reads.ts` | Named read tools (settings / workflow / reports) |
| `src/tools/generic.ts` | `list_endpoints` + `tickiti_call` |
| `src/server.ts` | Entry point: registers tools, connects stdio transport |
| `scripts/build-manifest.mjs` | Regenerates the manifest from `php artisan route:list` |
