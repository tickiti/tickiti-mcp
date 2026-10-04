# tickiti-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes the
**Tickiti** helpdesk API to AI assistants such as Claude. It is a thin shim over the
**Tickiti Public API v1** (`/api/v1/...`): each MCP tool forwards to a v1 endpoint, adding
your bearer token and — for writes — an idempotency key. The token's abilities are the
security boundary: the server only relays calls, it never widens them, so a read-only token
gives a read-only assistant.

📖 Full documentation: <https://www.tickiti.com/docs/topic/mcp_server/>

## Tools

The ticket tools have full, validated inputs; the rest of the API is reachable through two
general tools, so the whole surface is available without a separate tool per endpoint.

**Tickets**

| Tool | Ability | Purpose |
|---|---|---|
| `create_ticket` | `tickets:write` | Open a ticket (subject+content, template, or intervention), with assignee, priority, status and participants; `is_public` is required |
| `respond_to_ticket` | `tickets:write` | Post a response; change status, hold, assignee, priority, queue, subject, participants; `send_full_email` for the whole reply by email |
| `close_ticket` | `tickets:write` | Close, optionally with a final reply and a resolution |
| `edit_response` | `tickets:write` | Change a response in place (whole body, find/replace, visibility) with no notification — or publish an internal note and notify |
| `delete_response` | `tickets:write` | Soft-delete a response |
| `add_participants` / `remove_participants` | `tickets:write` | Change participants |
| `delete_tickets` / `restore_ticket` | `tickets:write` | Delete tickets (by number, or everything from one sender) and undo it |
| `merge_tickets` | `tickets:write` | Merge two tickets (the older survives) |
| `link_tickets` / `unlink_tickets` / `list_linked_tickets` | `tickets:write` / `read` | The Linked panel |
| `move_responses` / `copy_responses` / `split_ticket` | `tickets:write` | Repair a thread: move or copy responses, or split them off into a new linked ticket |
| `change_originator` | `tickets:write` | Change who raised a ticket |
| `delete_attachment` | `tickets:write` | Remove one attachment (a malicious file, say), keeping a record of it |
| `get_ticket` / `list_responses` | `tickets:read` | A ticket's thread, participants and links; `fields` / `max_body_chars` keep long email threads small |
| `get_response` | `tickets:read` | One response by id |
| `query_tickets` | `tickets:read` | Search tickets |
| `query_responses` / `export_responses` | `tickets:read` | Responses across tickets; counts and group-by tallies; NDJSON export to disk |
| `get_attachment` / `download_attachment` | `tickets:read` | Attachment bytes (download streams any size to a file) |
| `list_queues` / `list_teams` / `list_staff` / `list_resolutions` / `get_search_modes` | `tickets:read` | Queue names and settings, team keys, staff addresses, resolution categories, the search vocabulary |

**Settings, templates, mail, administration**

| Tool | Ability | Purpose |
|---|---|---|
| `list_perspectives` / `get_perspective` | `settings:read` | Saved views, with conditions and sort orders |
| `list_watchlists` | `settings:read` | Watchlists |
| `list_stock_responses` / `get_stock_response` | `settings:read` | Stock responses (search, bodies) |
| `create_stock_response` / `update_stock_response` / `delete_stock_response` | `settings:write` | Edit stock responses |
| `get_template` / `search_templates` / `render_template` | `templates:read` | Templates and FAQs; render one against data without sending |
| `create_template` / `update_template` | `templates:write` | Edit templates (updates change only the fields given) |
| `upload_template_image` | `templates:write` / `settings:write` | Upload an image for a template or stock response |
| `send_email` / `search_sent_mail` | `mail:write` / `mail:read` | Send mail; search what was sent |
| `list_api_tokens` / `create_api_token` / `update_api_token` / `revoke_api_token` | `administration:*` | API keys (a token only grants abilities it holds) |
| `list_workflow` | `workflow:read` | Resolution categories, interventions, escalations |
| `run_report` | `reports:read` | Analytics reports |
| `get_token_info` | any | What this token can do: abilities, owner roles, plan |
| `list_instances` | — | The Tickiti instances configured (see below) |
| `list_endpoints` | — | Every API endpoint, with abilities, path and body parameters |
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

### More than one instance

To reach several Tickiti installs from one server (production and staging, say), add
`TICKITI_INSTANCES`: JSON, or the path of a JSON file, mapping a name to `{ "base", "token" }`.
The `TICKITI_API_BASE` / `TICKITI_API_TOKEN` pair stays the default instance, named by
`TICKITI_INSTANCE_NAME` (default `default`).

```bash
TICKITI_INSTANCE_NAME=production
TICKITI_INSTANCES='{"staging": {"base": "https://staging.example.com", "token": "…"}}'
```

Every tool then takes an optional `instance` argument; `list_instances` shows the names.

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

The ticket-writing tools send an idempotency key with every call, so a retried request
never creates a duplicate ticket or response.

Long bodies can be given as `content_path` (a local file) instead of `content`, and files and
images always go by path: the server reads them, so their bytes never pass through the model.

## How it works

| File | Role |
|---|---|
| `src/client.ts` | Request core: base URL, bearer auth, idempotency, error normalisation |
| `src/result.ts` | Maps an API result into the MCP tool-result envelope |
| `src/manifest.ts` | Helpers over the generated route manifest (lookup, path building) |
| `src/generated/manifest.ts` | Auto-generated route table (do not edit) |
| `src/tools/tickets.ts` | Ticket writes — verified input schemas |
| `src/tools/ticket-reads.ts` | Ticket, response and attachment reads |
| `src/tools/ticket-operations.ts` | Delete, merge, link, move, originator, attachment delete, lookups |
| `src/tools/settings-writes.ts` | Stock responses and templates |
| `src/tools/admin.ts` | Mail, template rendering and images, perspectives, API keys, instances |
| `src/tools/reads.ts` | Named read tools (settings / workflow / reports) |
| `src/tools/generic.ts` | `list_endpoints` + `tickiti_call` |
| `src/param-hints.ts` | Body parameters `list_endpoints` shows for endpoints without a dedicated tool |
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
(`npm run test:paths`, needs a base URL and a full-ability token against a scratch instance),
and an offline check of the tool registration in `tests/smoke-tools.mjs`
(`npm run build && node tests/smoke-tools.mjs`).

Several tools call endpoints added to Tickiti in October 2026. Against an older install they
return 404; `list_endpoints` describes the newest API.

## License

[MIT](LICENSE) © Oxenic
