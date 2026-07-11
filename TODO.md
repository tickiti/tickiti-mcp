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

## Still open (low priority)

- **`stock-responses` index returns metadata only** and ignores a `search` filter. Body
  reads go through `get_stock_response`, and content search through `search_templates`, so
  this is a nice-to-have: a server-side `search` / `include_content` option on
  `TemplateController::stock_responses` (select `content`, honour a keyword filter) would
  let `list_stock_responses` search+return bodies directly.

_Original note (2026-06-10): logged while searching for stock responses referencing
`monitorsetupmetrics.sort` — SR 336 "Touch/Monitor association - Full". The list tools
couldn't surface it; now `search_templates` can._
