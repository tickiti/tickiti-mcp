/**
 * Request-body parameters for endpoints reached through tickiti_call, shown by
 * list_endpoints as `body`. The manifest is generated from Laravel's route table, which
 * knows path params but not body fields, so a caller had nothing to check a parameter
 * name against (sent_mail.search wants `q`; `search` returned nothing and read as "no
 * matches").
 *
 * Every field name and rule now comes from src/generated/body-fields.ts (`body_fields`),
 * read from the controllers' own validation. These hand-kept lines are for what rules
 * cannot say: which of several shapes to send, what a field means, what an endpoint does
 * that its name does not. Add one when an endpoint's body is not obvious from its rules.
 */
export const PARAM_HINTS: Record<string, string> = {
  "api.v1.faqs": "GET, no body; lang? (query string, the FAQ language for a customer's token; a staff token gets the staff language)",
  "api.v1.administration.branding.app_logo": "multipart: the image as `logo` (tickiti_call file_path; png/jpg/svg/webp, 500 KB)",
  "api.v1.administration.branding.email_logo": "multipart: the image as `logo` (tickiti_call file_path; png, 500 KB)",
  "api.v1.administration.diagnostics.upload": "multipart: the zip as `file` (tickiti_call file_path)",
  "api.v1.tickets.attachment_upload": "multipart: `file` (tickiti_call file_path); returns {sha256, name, file_size} to reference in attachments[] on create/respond",
  "api.v1.administration.users.index": "q? (filter), staff_only? (default true), user_id? / queue_id? (the selected user and queue, as on the Users page)",
  "api.v1.administration.users.update": "path user; is_staff, is_admin, tonic_notifications (all three, every time), can_crm?, is_api_user?, is_sysadmin? (taken only from a sysadmin token owner, so never on a hosted customer site, which has admins only), two_factor_required?, axial_access?. is_admin implies is_staff; is_sysadmin implies both. On a hosted site only the account owner (user 1) changes the account owner's roles, and the last admin cannot be demoted",
  "api.v1.administration.users.queue_upsert": "path user + queue; can_view, can_manage, can_delete, treat_as_inbox, receive_inbox_errors - all five booleans, every time. Manage needs view (Contribute), Delete needs Manage. Staff users only. Manage on a queue is what lets someone move tickets into or out of it and assign within it",
  "api.v1.administration.users.queue_detach": "path user + queue; no body - removes every right that user has on that queue",
  "api.v1.administration.teams.create": "name, user_ids[] (member user ids; must be present, may be empty)",
  "api.v1.administration.teams.update": "team_id, name, user_ids[] - the whole membership, replacing it",
  "api.v1.administration.teams.delete": "team_id",
  "api.v1.settings.perspectives.create": "name, shared (true: every member of staff sees it; false: the owner only), then description?, show_in_crm?, display_mode? (card|list), conditions[]? {field,operator (=|!=|like),value}, orders[]? {field,ascending}, user_id?, impersonate_user_id?",
  "api.v1.settings.perspectives.delete": "perspective_id",
  "api.v1.settings.hashtags.delete": "tag - deletes every hashtag row with that tag (hashtags.index lists them)",
  "api.v1.settings.watchlists.add_tickets": "watchlist_id, ticket_numbers[] and/or ticket_ids[] (at least one ticket, up to 500); a private list only by its owner, and only tickets they can see",
  "api.v1.settings.watchlists.remove_tickets": "watchlist_id, ticket_numbers[] and/or ticket_ids[] (a deleted ticket, or one out of sight, can still be taken off); a private list only by its owner",
  "api.v1.settings.watchlists.reorder": "watchlist_id, ticket_numbers[] and/or ticket_ids[] - the list's tickets in their new order; a private list only by its owner (not an admin), and only tickets they can see",
  "api.v1.workflow.business_hours.update": "mode (always_on|simple|per_day), simple_start/simple_end (minutes from midnight, 0-1440), mon_enabled..sun_enabled, per_day_ranges[]? {start,end} - the whole setting each time",
  "api.v1.workflow.escalations.create": "minutes, action (notify|email), email ('assigned' or exactly a member of staff's address; any other, the system's own included, is refused 422), repeat_minutes?",
  "api.v1.workflow.escalations.update": "id, then minutes, action (notify|email), email ('assigned' or exactly a member of staff's address, else 422), repeat_minutes? - all the required fields each time",
  "api.v1.workflow.queues.move": "from_queue_id, to_queue_id - one raw UPDATE of every ticket's queue (deleted ones go too) that skips the ticket engine: no history rows, and perspectives and open views are not refreshed. Tickets and tasks move alike; neither queue may be Drafts (422, my_error). Use queues.move_tickets (the move_queue_tickets tool) instead",
  "api.v1.workflow.queues.move_tickets": "from_queue or from_queue_id, to_queue or to_queue_id, limit? (1-500, default 500), after_id?, dry_run? - moves through the ticket engine (history, perspectives and open views follow), oldest first; tickets and tasks move alike, and neither queue may be Drafts (422); skipped tickets stay in the queue, so repeat while the reply's `more` is true, passing its next_after_id as after_id (not while `remaining` > 0). Prefer this to queues.move",
  "api.v1.tickets.create": "originator_email_address, then subject+content, template_identifier+data or intervention+data+uid; kind? ('ticket' default | 'task', fixed for life: any queue but Drafts holds either; a task naming no queue starts in the default queue for new tasks (System settings; workflow/queues gives default_task_queue_id), needs is_public false, and refuses intervention/uid, customer_name, company, other_fields, data.status on-hold, a non-staff originator or participants and posting in someone else's name); customer_message? (intervention only, with use_passed_originator_as_responder true and an originator who is not the token owner: the customer's own message, posted first and public in their name); the reply carries kind; sender_confirmed? (in a customer's name only; needs tickets:sender_confirmed, beside tickets:customer_impersonation: the integration's own form confirmed the address); when System settings asks contact-form senders for an emailed code, a message in a customer's name is otherwise held and the reply says awaiting_sender_confirmation (true), sender_code_sent, and no secure_id until it is confirmed",
  "api.v1.tickets.close": "ticket_number OR ticket_id; from_email? (defaults to the token owner, whatever `required` says: close fills it in before respond's rules run), content?, is_internal?, resolved?, queue? (any queue but Drafts, for a ticket or a task alike), subject?, signature?",
  "api.v1.tickets.response_delete": "response_id - refused (422) for a task's description and for the last message or note on its ticket or task",
  "api.v1.tickets.response_update": "response_id, then content OR replace[] {find, replace, all?}, and/or is_internal (false is refused on a task: its notes are never public), notify? - a task's description cannot be emptied",
  "api.v1.tickets.response_pin": "response_id, pinned - a task's description is always pinned (unpinning it is refused 422)",
  "api.v1.tickets.alert": "source (the reporting system; its alerts share one ticket), problem_key (stable name of the problem; a repeat while the ticket is open adds nothing), title, content (HTML, the internal note), severity? (critical|normal), latched?, originator_email_address? (a staff account to write as). Only where the instance has a System alerts team: a hosted customer site has none, so its tokens cannot hold alerts:write",
  "api.v1.mail.mailboxes.update": "mailbox_id, then the whole mailbox (its required fields every time); pop_disposition_queue, when given, must be an existing queue, not Drafts (mail opens tickets); passwords and secrets go through mailboxes.set_password",
  "api.v1.mail.send": "to_address, subject+content OR template_identifier+data, cc[]?, mailbox?, validate_address? (Idempotency-Key sent for you)",
  "api.v1.mail.sent_mail.list": "range_days? (1-30, default 1), limit? (1-300)",
  "api.v1.mail.sent_mail.search": "q (matches subject and to_address; `search` also accepted), limit? (1-500)",
  "api.v1.mail.sent_mail.show": "id",
  "api.v1.templates.show": "template_id",
  "api.v1.templates.search": "search, mode?, type?",
  "api.v1.templates.create": "type, identifier (not for faq), subject?, content?, description?, legend?, category? and subcategory? (kept only for type stock-response; stored empty for any other type), keywords?, is_enabled?, ordinal?",
  "api.v1.templates.update": "template: { id, ...only the fields to change } - omitted fields keep their values",
  "api.v1.templates.delete": "template_id (from Axial, an email, notification, intervention or FAQ template is refused 403: an administrator deletes those)",
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
  "api.v1.workflow.queues.create": "name, outgoing_mailbox_id, then track_resolutions?, is_parked?, release_queue_id?, axial_answers? (true: Axial answers customers' incoming messages in the new queue; left out or false it does not, as a new queue starts unanswered). axial_answers is taken only from a token owner who sets up Axial (an admin on a hosted customer site, a sysadmin elsewhere): anyone else sending it is refused (403) and nothing is made",
  "api.v1.workflow.queues.update": "queue_id, then only what changes: name? (a built-in queue keeps its name), track_resolutions?, is_parked?, release_queue_id?, outgoing_mailbox_id?, axial_answers? (whether Axial answers customers' incoming messages in this queue; left out it stays as it is; refused (403) from a token owner who does not set up Axial). Deleting a queue stops Axial answering it. A queue has no type: any queue but Drafts holds tickets and tasks. A parked queue needs a release queue that is another queue, not Drafts and not itself parked. The default queue for new tasks is chosen in System settings, not here (queues.index gives default_task_queue_id), and that queue cannot be deleted while it is the default",
  "api.v1.tickets.query": "search_object { search_perspective?, criteria: [{mode, tokens[], match?}] }, perspective_id?, row_limit? (top level, default 100)",
  "api.v1.tickets.responses_query": "filters (created_from/to, is_internal, staff_response, queue[], queue_id[], ticket_number[], response_id[], created_by_email, has_attachments, is_empty), fields[]?, metadata_only?, count_only?, group_by?, limit?, cursor?",
  "api.v1.administration.api_tokens.create": "name, owner ('system' | staff or API user id), abilities[] (only ones this token holds; tickets:customer_impersonation needs tickets:write and a System/API-user owner), allowed_ip?",
  "api.v1.administration.api_tokens.update": "id, abilities[]? (not on a has_legacy key), allowed_ip? (null clears it, but not on a has_legacy key), name?",
};
