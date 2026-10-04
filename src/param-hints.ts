/**
 * Request-body parameters for endpoints reached through tickiti_call, shown by
 * list_endpoints. The manifest is generated from Laravel's route table, which knows
 * path params but not body fields, so a caller had nothing to check a parameter name
 * against (sent_mail.search wants `q`; `search` returned nothing and read as "no
 * matches"). Hand-kept: add an entry when an endpoint's body is not obvious.
 */
export const PARAM_HINTS: Record<string, string> = {
  "api.v1.mail.send": "to_address, subject+content OR template_identifier+data, cc[]?, mailbox?, validate_address? (Idempotency-Key sent for you)",
  "api.v1.mail.sent_mail.list": "range_days? (1-30, default 1), limit? (1-300)",
  "api.v1.mail.sent_mail.search": "q (matches subject and to_address; `search` also accepted), limit? (1-500)",
  "api.v1.mail.sent_mail.show": "id",
  "api.v1.templates.show": "template_id",
  "api.v1.templates.search": "search, mode?, type?",
  "api.v1.templates.create": "type, identifier (not for faq), subject?, content?, description?, legend?, keywords?, is_enabled?, ordinal?",
  "api.v1.templates.update": "template: { id, ...only the fields to change } - omitted fields keep their values",
  "api.v1.templates.delete": "template_id",
  "api.v1.templates.render": "template_identifier, data{}, type? (default email) - renders, sends nothing",
  "api.v1.templates.image_upload": "multipart: template_id, file",
  "api.v1.settings.perspectives.index": "scope? ('mine' default | 'all' incl. built-ins, with conditions + orders)",
  "api.v1.settings.perspectives.show": "perspective_id OR name",
  "api.v1.settings.perspectives.update": "perspective_id, then only what changes: name?, description?, shared?, show_in_crm?, display_mode?, conditions[]? {field,operator,value}, orders[]? {field,ascending}",
  "api.v1.settings.stock_responses.index": "search?, include_content?",
  "api.v1.settings.stock_responses.show": "template_id",
  "api.v1.settings.stock_responses.create": "identifier, category, subcategory?, subject?, keywords?, content?, is_enabled?, notes?, ai_relevance?",
  "api.v1.settings.stock_responses.update": "template: { id, ...only the fields to change }",
  "api.v1.settings.stock_responses.image_upload": "multipart: template_id, file",
  "api.v1.workflow.queues.update": "queue_id, then only what changes: name?, track_resolutions?, is_parked?, release_queue_id?, outgoing_mailbox_id?, content_type?",
  "api.v1.tickets.query": "search_object { search_perspective?, criteria: [{mode, tokens[], match?}] }, perspective_id?, row_limit? (top level, default 100)",
  "api.v1.tickets.responses_query": "filters (created_from/to, is_internal, staff_response, queue[], queue_id[], ticket_number[], response_id[], created_by_email, has_attachments, is_empty), fields[]?, metadata_only?, count_only?, group_by?, limit?, cursor?",
  "api.v1.administration.api_tokens.create": "name, owner ('system' | staff user id), abilities[] (only ones this token holds), allowed_ip?",
  "api.v1.administration.api_tokens.update": "id, abilities[]?, allowed_ip?, name?",
};
