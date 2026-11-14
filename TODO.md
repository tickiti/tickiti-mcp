# tickiti-mcp — TODO

## Resolved 2026-07-11 (gap-closure pass)

The canned-content read/search gap below is largely closed:

- **Stock-response body read** — `get_stock_response(template_id)` returns the full
  content. (The earlier "show doesn't work" symptom was the wrong id key — the API's
  `settings/stock-responses/show` reads a top-level `template_id`, which this tool sends.)
- **Content/body search** — `search_templates(search, mode?, type?)` hits
  `templates/search`, which matches identifier/subject/**content**/keywords across the
  `templates` table (stock responses, FAQs, email templates — filter with `type`). So
  "which stock response / FAQ / template mentions X?" (e.g. `monitorsetupmetrics.sort`)
  is answerable through the API, no DB grep.
- **Stock-response create/edit/delete** — `create_stock_response`,
  `update_stock_response`, `delete_stock_response`.
- **Template edit** — `update_template` (wraps the nested `template:{id,...}` shape the
  API's `templates/update` expects), `get_template`.

## Resolved 2026-10-04 (0.2.0)

- **`stock-responses` index** now takes `search` and `include_content`
  (`list_stock_responses`).
- Everything in the tickiti-api skill's "Known MCP issues" list that had a code fix: see the
  0.2.0 commit for the tool-by-tool list.

## Resolved 2026-11-13 (mcp-vs-api review)

- **Unknown arguments are refused, not stripped.** `server.ts` registers every tool's input as a
  strict zod object (and the nested item objects of `attachments`, `files`, `replace`,
  `other_fields` and `answers` are strict too), so `respond_to_ticket {html}` and
  `tickiti_call {params}` get an error naming the key and the accepted ones, and nothing is
  sent. `tickiti_call` with no `payload` to an endpoint with required fields is refused, naming
  them. (The Axial skill shapes stay `.passthrough()` on purpose: they pass the extra keys on
  to Tickiti, which validates them, rather than dropping them.)
- **`signature` / `signature_custom`** on `respond_to_ticket` and `close_ticket`.
- **`create_ticket`** takes `customer_name`, `company`, `other_fields[{label,value}]`;
  **`create_template`** and **`update_template`** take `category`, `subcategory`, `keywords`.
  `update_template` no longer reads the template and sends content / subject / is_enabled
  back: it sends only the fields given, which Tickiti's template_save patches.
- **`tickiti_call`** uses the endpoint's own method (GET `faqs`, payload as the query string) and
  uploads a local `file_path` as multipart in the endpoint's own field (`logo` for the branding
  logos, `file` for diagnostics and the attachment/image uploads).
- **Body fields for every endpoint**: `scripts/body-fields.php`, run by `build-manifest.mjs`,
  reads each route's validation rules out of the controllers into `src/generated/body-fields.ts`
  (142 endpoints at the time of writing); `list_endpoints` shows `required`, `file_field` and,
  filtered by family or action, `body_fields`. `param-hints.ts` keeps notes on meaning for the
  administration users / queue rights / teams, perspectives, watchlists, business hours,
  escalations, queues.move, tickets.alert, mailboxes and the uploads.
- **Older instances**: Laravel's route-not-found 404 is explained as "this instance does not
  have this endpoint". `src/catalogue.ts` reads the instance's own endpoint list and version
  from `v1/token` when it gives them, for `list_endpoints` (`on_instance: false`,
  `instance_only`) and `tickiti_call` (refused with the version; newer routes callable).
- Doc drift: `query_tickets` pointed at `get_search_items` (it is `get_search_modes`);
  `server.ts` said 104 endpoints.

## Resolved 2026-11-13 (0.3.0: the new v1 endpoints)

- The manifest is regenerated from the Tickiti working tree (280 endpoints, 228 with body fields),
  and `tickets.tag` and `workflow.recurring_tasks.run_now` are marked as needing an
  Idempotency-Key, as their controllers refuse a call without one.
- Typed tools for the new endpoints, one per resource with an `action` where a page has several
  (`src/tools/actions.ts` refuses another action's argument by name): `update_tickets`,
  `ticket_checklist`, `ticket_reminders`, `pin_response`, `restore_response`, `ticket_tags`,
  `my_ticket_state`, `get_share_link`, `scheduled_replies`, `list_reviews`, `resolve_review`,
  `move_queue_tickets`, `automations`, `sla_policies`, `recurring_tasks`, `checklist_templates`,
  `holidays`, `interventions`, `mail_attachment_rules`, `axial_panel_action`,
  `axial_conversations`, `axial_settings`, `out_of_office`, `my_signature`, `user_account`,
  `manage_watchlist`, `template_translation`, `confirm_alert`, `download_sent_mail`; and
  `get_response` (`include`), `list_watchlists` (filters) and `run_report` (sla, satisfaction,
  axial-usage, axial-reports) take the new fields. Offline: `tests/new-endpoint-tools.mjs`.

## Still open (low priority)

- `tests/all-paths.mjs` does not yet exercise the endpoints added in 0.2.0 or 0.3.0.
- `interventions` leaves out `generate_token` (it mints a bearer token for a remote and returns
  it); it stays reachable through `tickiti_call`.
- Tickiti's `v1/token` does not list the instance's routes or version yet (the review's
  proposed API change), so `catalogue.ts` falls back to the compiled list everywhere today.
- The tickiti-api skill's `launch.ps1` (outside this repo) starts one instance; it does not
  build `TICKITI_INSTANCES` from the instance registry and Credential Manager, so the
  `instance` argument is not seen in practice. The README shows the launcher side.
- The manifest and body fields are generated from the Tickiti working tree of 2026-11-13, whose
  new API controllers are not committed yet; regenerate once they land on Tickiti main.
- `body-fields.php` reads code, so a rule built far from the call (a helper's return value, a
  FormRequest that needs the container) shows as '?' or not at all; `body` notes cover the
  ones that matter.

_Original note (2026-06-10): logged while searching for stock responses referencing
`monitorsetupmetrics.sort` — SR 336 "Touch/Monitor association - Full". The list tools
couldn't surface it; now `search_templates` can._
