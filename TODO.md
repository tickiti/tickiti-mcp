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

## Still open (low priority)

- `tests/all-paths.mjs` does not yet exercise the endpoints added in 0.2.0.

_Original note (2026-06-10): logged while searching for stock responses referencing
`monitorsetupmetrics.sort` — SR 336 "Touch/Monitor association - Full". The list tools
couldn't surface it; now `search_templates` can._
