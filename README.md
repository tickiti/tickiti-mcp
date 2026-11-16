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
| `create_ticket` | `tickets:write` | Open a ticket (subject+content, template, or intervention), with assignee, priority, status and participants, and a contact form's `customer_name`, `company` and `other_fields`; `is_public` is required; `kind: 'task'` opens a task instead (in any queue but Drafts; with no queue, the default queue for new tasks); `customer_message` opens an intervention's ticket with the customer's own words (with `use_passed_originator_as_responder`) |
| `respond_to_ticket` | `tickets:write` | Post a response; change status, hold, assignee, priority, queue, subject, participants; `send_full_email` for the whole reply by email; `signature` / `signature_custom` |
| `close_ticket` | `tickets:write` | Close, optionally with a final reply (and its signature) and a resolution |
| `edit_response` | `tickets:write` | Change a response in place (whole body, find/replace, visibility) with no notification — or publish an internal note and notify |
| `delete_response` | `tickets:write` | Soft-delete a response |
| `add_participants` / `remove_participants` | `tickets:write` | Change participants |
| `delete_tickets` / `restore_ticket` | `tickets:write` | Delete tickets (by number, or everything from one sender) and undo it |
| `merge_tickets` | `tickets:write` | Merge two tickets (the older survives) |
| `link_tickets` / `unlink_tickets` / `list_linked_tickets` | `tickets:write` / `read` | The Linked panel |
| `move_responses` / `copy_responses` / `split_ticket` | `tickets:write` | Repair a thread: move or copy responses, or split them off into a new linked ticket |
| `change_originator` | `tickets:write` | Change who raised a ticket |
| `delete_attachment` | `tickets:write` | Remove one attachment (a malicious file, say), keeping a record of it |
| `get_ticket` / `list_responses` | `tickets:read` | A ticket's thread, participants, links and waiting interventions; `fields` / `max_body_chars` keep long email threads small |
| `get_response` | `tickets:read` | One response by id, with `mail_auth`; `include` the email as it arrived (`original_html`) or the reply without its quoted history (`reply_text`) |
| `query_tickets` | `tickets:read` | Search tickets |
| `query_responses` / `export_responses` | `tickets:read` | Responses across tickets; counts and group-by tallies; NDJSON export to disk |
| `get_attachment` / `download_attachment` | `tickets:read` | Attachment bytes (download streams any size to a file) |
| `list_queues` / `list_teams` / `list_staff` / `list_resolutions` / `get_search_modes` | `tickets:read` | Queue names and settings, team keys, staff addresses, resolution categories, the search vocabulary |
| `update_tickets` | `tickets:write` | The ticket browser's Save over up to 100 tickets (status, hold, queue, assignee, priority, resolution, start/due dates), each judged on its own under the queue/assignee rule; `dry_run`; refusals listed per ticket |
| `ticket_checklist` | `tickets:read` / `write` | A ticket's checklist: get, add (text, items or a template), tick / edit, reorder, delete |
| `ticket_reminders` | `tickets:read` / `write` | A ticket's reminders: list, add (one-off or repeating), delete (the owner's, or an admin of at least their rank) |
| `pin_response` / `restore_response` | `tickets:write` | Pin or unpin a response; undo a response's deletion (an admin or a manager of the ticket's queue) |
| `ticket_tags` | `tickets:read` / `write` | @tag staff on a response (notifies them), list a ticket's tags, acknowledge your own |
| `my_ticket_state` | `tickets:read` / `write` | The token owner's own bump, read / unread and private note on tickets |
| `get_share_link` | `tickets:write` | A ticket's permanent share link (created on first request) |
| `scheduled_replies` | `tickets:read` / `write` | The owner's replies held with Send later: list, cancel, send now, reschedule |
| `list_reviews` / `resolve_review` | `tickets:read` / `write` | Inbound emails held for review (sender not a participant, duplicate, already has a ticket): keep or merge |

**Settings, templates, mail, administration**

| Tool | Ability | Purpose |
|---|---|---|
| `list_perspectives` / `get_perspective` | `settings:read` | Saved views, with conditions and sort orders |
| `list_watchlists` | `settings:read` | Watchlists, filtered by id, name, owner or shared, with their tickets |
| `manage_watchlist` | `settings:write` | Create, change or delete a watch list; add, remove or reorder its tickets (on a private list, only its owner) |
| `out_of_office` / `my_signature` | `settings:read` / `write` | The token owner's own out-of-office periods and email signature |
| `list_stock_responses` / `get_stock_response` | `settings:read` | Stock responses (search, bodies) |
| `create_stock_response` / `update_stock_response` / `delete_stock_response` | `settings:write` | Edit stock responses |
| `get_template` / `search_templates` / `render_template` | `templates:read` | Templates and FAQs; render one against data without sending |
| `create_template` / `update_template` | `templates:write` | Edit templates, with category, subcategory and keywords (updates send, and change, only the fields given) |
| `upload_template_image` | `templates:write` / `settings:write` | Upload an image for a template or stock response |
| `template_translation` | `templates:read` / `write` | A template's translation into one language: get, save, delete |
| `send_email` / `search_sent_mail` | `mail:write` / `mail:read` | Send mail; search what was sent |
| `download_sent_mail` | `mail:read` (superuser) | A sent message exactly as sent, saved as an .eml file |
| `mail_attachment_rules` | `mail:read` / `write` | Inbound attachments by extension: always allowed, hard blocked, or held for review |
| `user_account` | `administration:write` | A user's email address change (request, resend, cancel) and WhatsApp (start, status, quiet hours, remove) |
| `list_api_tokens` / `create_api_token` / `update_api_token` / `revoke_api_token` | `administration:*` | API keys (a token only grants abilities it holds) |
| `list_workflow` | `workflow:read` | Resolution categories, interventions, escalations |
| `move_queue_tickets` | `workflow:write` | Move every ticket in one queue to another through the ticket engine (history, perspectives, open views); repeat while `more`, passing `next_after_id` as `after_id` |
| `automations` | `workflow:read` / `write` | Automation rules: list (with the editor's vocabulary), create, update, enable, reorder, delete, dry-run test (`write`), recent runs |
| `sla_policies` | `workflow:read` / `write` | SLA policies: list, create, update, reorder, delete |
| `recurring_tasks` | `workflow:read` / `write` | Recurring tasks: list, create, update, run now, delete |
| `checklist_templates` / `holidays` / `interventions` | `workflow:read` / `write` | Checklist templates; business-hours holidays; intervention definitions (update merges; `axial_note` is what Axial is told while one waits) |
| `run_report` | `reports:read` | Analytics reports, the SLA and satisfaction reports, Axial usage and Axial ratings |
| `confirm_alert` | `supervisor:write` (superuser) | Confirm a latched health alert |
| `get_token_info` | any | What this token can do: abilities, owner roles, plan |
| `list_instances` | — | The Tickiti instances configured (see below) |
| `list_endpoints` | — | Every API endpoint: abilities, role, plan, path params, required body fields, an upload's file field; filtered by family or action, every body field with its validation rules. Marks endpoints the instance lacks, where it lists its own |
| `tickiti_call` | per endpoint | Call any `/api/v1` endpoint by family and action, with its own method (GET `faqs`), and a local file as multipart for the uploads (branding logos, diagnostics) |

**Axial**

| Tool | Ability | Purpose |
|---|---|---|
| `get_axial_chat` / `list_axial_runs` | `axial-chat:read` | A ticket's Axial panel and runs |
| `send_axial_message` / `check_axial_wait` / `answer_axial_card` / `rerun_axial` | `axial-chat:write` / `approve` / `manage` | Talk to Axial on a ticket, answer its cards, rerun it |
| `axial_panel_action` | `axial-chat:write` / `approve` / `manage` | The panel's other buttons: approve or reject an action, a shared note's card, update the suggested response, respond again, add a note, cancel a queued request, give a task, investigate in depth, stop a task, choose the skill, turn back on, approve translations (also `settings:write` or `templates:write`), apply or discard a skill change |
| `axial_conversations` | `axial-chat:read` / `write` | The token owner's own conversations with Axial outside any ticket |
| `axial_settings` | `administration:read` / `write` (admin on a hosted site, sysadmin on a standalone install; the skill store is a sysadmin's) | The Axial settings pages, the skill store, Axial's attachment rules |
| `list_axial_skills` / `get_axial_skill` / ... | `skills:read` / `write` | Axial's skills |

A tool that covers a resource takes an `action` (`list`, `create`, `update`, `delete` ...). An
argument that belongs to another action of the tool is refused by name, as an unknown one is,
and so is a call missing what its action needs; nothing is sent.

For anything beyond the named tools (mail, templates, workflow writes, administration,
supervisor), the assistant uses `list_endpoints` to discover the action, then `tickiti_call`
to run it — covering all of the v1 API.

### Arguments are checked

Every tool refuses an argument it does not list, before anything is sent, with an error that
names the argument and the ones the tool takes. A reply sent as `html` instead of `content`,
or a `tickiti_call` body sent as `params` instead of `payload`, used to be dropped without a
word, so the call went out without it and looked as if it had worked. The free-form fields
(`payload`, `data`, `filters`, `search_object`) are not checked key by key; Tickiti validates
what is in them. `tickiti_call` with no `payload` to an endpoint whose fields are required is
refused, naming them.

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

Optional:

| Variable | Purpose |
|---|---|
| `TICKITI_MCP_FILE_ROOTS` | The directories, separated as `PATH` is (`;` on Windows, `:` elsewhere), that a tool may read a local file from: `content_path`, inline and out-of-line attachments, and `upload_template_image`. Links are resolved first, so one cannot lead outside a root. A path outside every root, or missing, gets the same error. Unset, a tool reads any file the process can. Set it for a process whose tool arguments can be steered by what it reads, such as an Axial agent task. It does not limit where `export_responses` and `download_attachment` write. |

### More than one instance

To reach several Tickiti installs from one server (production and staging, say), add
`TICKITI_INSTANCES`: JSON, or the path of a JSON file, mapping a name to `{ "base", "token" }`.
The `TICKITI_API_BASE` / `TICKITI_API_TOKEN` pair stays the default instance, named by
`TICKITI_INSTANCE_NAME` (default `default`).

```bash
TICKITI_INSTANCE_NAME=production
TICKITI_INSTANCES='{"staging": {"base": "https://staging.example.com", "token": "…"}}'
```

Every tool takes an optional `instance` argument naming one of them (the first is the default);
`list_instances` shows the names. A server with one instance takes it too, but only naming that
one: a call that names it is accepted, and one that names any other instance is refused before
anything is sent.

A `TICKITI_INSTANCES` that cannot be read is refused at start with its length (and the path, when
it is a `.json` file's), never its text, so a mistyped value does not put its tokens in a log.

To keep the tokens out of any config file, have the launcher build `TICKITI_INSTANCES` in its own
environment from wherever the tokens are kept and then start the server, so the JSON only ever
exists in that process. On Windows, with the tokens in Credential Manager:

```powershell
# $tokens: name -> token, read from Credential Manager by the launcher (not shown)
$env:TICKITI_INSTANCES = @{
  staging = @{ base = 'https://staging.example.com'; token = $tokens['staging'] }
} | ConvertTo-Json -Compress
& node /absolute/path/to/tickiti-mcp/dist/server.js
```

### Older instances

The endpoint list is built from the Tickiti this release was made from, but an instance can run
another build (a hosted tenant can lag a version). A call to an endpoint the instance does not
have gets Laravel's "The route ... could not be found", and the server says that this is what it
means. If the instance lists its own endpoints in `v1/token` (`data.endpoints`: route names, or
`{name, uri, method}`; and `data.version`), `list_endpoints` marks the ones it lacks
(`on_instance: false`) and lists the ones only it has, and `tickiti_call` refuses the first with
the instance's version and can call the second. Tickiti does not report that list yet.

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
| `src/tools/ticket-planning.ts` | Bulk update, checklist, reminders, pins, restore, tags, own state, share link, Send later, reviews |
| `src/tools/workflow.ts` | Queue moves, automations, SLA, recurring tasks, checklist templates, holidays, interventions, mail attachment rules |
| `src/tools/axial-panel.ts` | Axial panel actions, Axial conversations, Axial settings |
| `src/tools/account.ts` | Out of office, signature, user accounts, watch lists, translations, alerts, sent mail as .eml |
| `src/tools/actions.ts` | One tool per resource with an `action`: each action's endpoint, its arguments and the ones it needs |
| `src/tools/settings-writes.ts` | Stock responses and templates |
| `src/tools/admin.ts` | Mail, template rendering and images, perspectives, API keys, instances |
| `src/tools/reads.ts` | Named read tools (settings / workflow / reports) |
| `src/tools/generic.ts` | `list_endpoints` + `tickiti_call` |
| `src/param-hints.ts` | Hand-kept notes on a body's shape and meaning, shown by `list_endpoints` as `body` |
| `src/generated/body-fields.ts` | Auto-generated body fields and validation rules per endpoint (do not edit) |
| `src/catalogue.ts` | The instance's own endpoint list, where it gives one |
| `src/server.ts` | Entry point: registers tools, connects the stdio transport |
| `scripts/build-manifest.mjs` | Regenerates the manifest from the Tickiti route table, and the body fields |
| `scripts/body-fields.php` | Reads each endpoint's body fields from the controllers' validation (run by the above) |

## Maintainers

`src/generated/manifest.ts` is generated from Tickiti's own route table
(`php artisan route:list --json`), so abilities, roles, plan gates and path params are never
hand-maintained. Regenerate against a Tickiti checkout after the API changes:

```bash
TICKITI_DIR=/path/to/tickiti npm run manifest
```

The same run writes `src/generated/body-fields.ts`: `scripts/body-fields.php` follows each route's
action into the controller that validates it (through the v1 passthru controllers) and reads the
`validate()` / `Validator::make()` rules and the `$request->input()` reads. It needs `php` and the
Tickiti checkout's `vendor/`. `--body-fields-only` rewrites that file and leaves the manifest.
It reads the methods' source and calls none of them, but it does load the checkout's autoloader
(Composer's `files` autoloads run), its classes and their constants, so point `TICKITI_DIR` only at
a checkout you trust.

There is an end-to-end sweep over every endpoint in `tests/all-paths.mjs`
(`npm run test:paths`, needs a base URL and a full-ability token against a scratch instance),
and an offline check of the tool registration in `tests/smoke-tools.mjs`
(`npm run build && node tests/smoke-tools.mjs`). The other offline tests run the built server
against a local stand-in for Tickiti, or its helpers directly: `strict-and-generic`, `new-endpoint-tools`,
`reply-attachments`, `axial-skill-questions`, `file-roots` and `inline-images`
(`node tests/<name>.mjs`).

Several tools call endpoints added to Tickiti in October 2026 and later. Against an older install
they get Laravel's route-not-found 404, which the server explains (see Older instances).

## License

[MIT](LICENSE) © Oxenic
