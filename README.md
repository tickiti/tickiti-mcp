# tickiti-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes the
**Tickiti** helpdesk API to AI assistants such as Claude. It is a thin shim over the
**Tickiti Public API v1** (`/api/v1/...`): each MCP tool forwards to a v1 endpoint, adding
your bearer token and — for writes — an idempotency key. The token's abilities are the
security boundary: the server only relays calls, it never widens them, so a read-only token
gives a read-only assistant.

📖 Full documentation: <https://docs.tickiti.com/topic/mcp_server/>

## Tools

The ticket tools have full, validated inputs; the rest of the API is reachable through two
general tools, so the whole surface is available without a separate tool per endpoint.

| Tool | Ability | Purpose |
|---|---|---|
| `create_ticket` | `tickets:write` | Open a ticket (subject+content, template, or intervention) |
| `respond_to_ticket` | `tickets:write` | Post a response to an existing ticket |
| `query_tickets` | `tickets:read` | List tickets for a perspective |
| `list_perspectives` | `settings:read` | List saved perspectives |
| `list_watchlists` | `settings:read` | List watchlists |
| `list_stock_responses` | `settings:read` | List stock responses |
| `list_queues` | `workflow:read` | List ticket queues |
| `list_workflow` | `workflow:read` | List resolution categories, interventions or escalations |
| `run_report` | `reports:read` | Run an analytics report |
| `list_endpoints` | — | Discover every available API endpoint, with abilities and parameters |
| `tickiti_call` | per endpoint | Call any `/api/v1` endpoint by family and action |

For anything beyond the named tools (mail, templates, workflow writes, administration,
supervisor), the assistant uses `list_endpoints` to discover the action, then `tickiti_call`
to run it — covering all of the v1 API.

## Requirements

- **Node.js** 20 or newer
- A **Tickiti API token**, minted from **Administration → API keys**, scoped to the
  abilities you want the assistant to have
- An **MCP-capable client** — e.g. Claude Code or the Claude desktop app

## Install

```bash
git clone https://github.com/tickiti/tickiti-mcp.git
cd tickiti-mcp
npm install
npm run build
```

The built server is `dist/server.js`.

## Configure

The server reads two environment variables (it fails fast on startup if either is missing):

| Variable | Purpose |
|---|---|
| `TICKITI_API_BASE` | Your Tickiti install's public address, no trailing slash — e.g. `https://support.example.com`. The server appends `/api/v1/…`. |
| `TICKITI_API_TOKEN` | The bearer token. Its abilities determine what the assistant can do. |

## Use with Claude Code

```bash
claude mcp add tickiti \
  --env TICKITI_API_BASE=https://support.example.com \
  --env TICKITI_API_TOKEN=YOUR_TICKITI_API_TOKEN \
  -- node /absolute/path/to/tickiti-mcp/dist/server.js
```

Confirm with `claude mcp list` (or `/mcp` in a session). Remove with `claude mcp remove tickiti`.

Other MCP clients configure servers in their own settings file, but the shape is the same:
run `node /absolute/path/to/tickiti-mcp/dist/server.js` as a **stdio** server with
`TICKITI_API_BASE` and `TICKITI_API_TOKEN` set in its environment.

## Permissions & security

The server adds no permissions of its own. Every call runs as the staff user the token
belongs to, gated by the token's abilities — exactly as a direct API call would be. To limit
what an assistant can do, mint a narrowly-scoped token:

- A read-only token (e.g. `tickets:read`, `reports:read`) gives an assistant that can look
  but not change anything.
- Grant write abilities only for the families the assistant needs to act on.
- If a call is refused, the server reports the reason (missing ability, role or plan).

The two ticket-writing tools send an idempotency key with every call, so a retried request
never creates a duplicate ticket or response.

## How it works

| File | Role |
|---|---|
| `src/client.ts` | Request core: base URL, bearer auth, idempotency, error normalisation |
| `src/result.ts` | Maps an API result into the MCP tool-result envelope |
| `src/manifest.ts` | Helpers over the generated route manifest (lookup, path building) |
| `src/generated/manifest.ts` | Auto-generated route table (do not edit) |
| `src/tools/tickets.ts` | Tickets family — verified input schemas |
| `src/tools/reads.ts` | Named read tools (settings / workflow / reports) |
| `src/tools/generic.ts` | `list_endpoints` + `tickiti_call` |
| `src/server.ts` | Entry point: registers tools, connects the stdio transport |
| `scripts/build-manifest.mjs` | Regenerates the manifest from the Tickiti route table |

## Maintainers

`src/generated/manifest.ts` is generated from Tickiti's own route table
(`php artisan route:list --json`), so abilities, roles, plan gates and path params are never
hand-maintained. Regenerate against a Tickiti checkout after the API changes:

```bash
TICKITI_DIR=/path/to/tickiti npm run manifest
```

There is an end-to-end sweep over every endpoint in `tests/all-paths.mjs`
(`npm run test:paths`, needs a base URL and a full-ability token against a scratch instance).

## License

© Oxenic. All rights reserved. (A licence will be added here.)
