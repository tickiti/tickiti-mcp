import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV1 } from "../client.js";
import { toToolResult } from "../result.js";
import { MANIFEST } from "../manifest.js";
import { actionEnum, compact, runAction, ticketRef, type ActionSpec } from "./actions.js";

/**
 * The Workflow menu's pages: moving a queue's tickets, automations, SLA policies, recurring
 * tasks, checklist templates, holidays and interventions, and the mail attachment rules.
 *
 * All of them are admin pages: the workflow family needs an admin token owner and
 * workflow:read / workflow:write, and some need the plan's feature (has_automations,
 * has_sla, has_escalations, has_interventions), returning 403 without it. Saves go through the pages' own
 * controllers, so what the page refuses the API refuses with the page's message. The
 * update actions merge: what a call leaves out keeps its stored value, and a list sent
 * (conditions, actions, items, fields) replaces the whole list.
 */

/** A condition row, as the automation and SLA editors have them. */
const condition = z
  .object({
    field: z.string(),
    operator: z.string(),
    value: z.any().optional(),
  })
  .strict();

export function registerWorkflowTools(server: McpServer): void {
  // ── Queues ──────────────────────────────────────────────────────────────

  server.registerTool(
    "move_queue_tickets",
    {
      title: "Move every ticket from one queue to another",
      description:
        "Move every ticket in a queue to another through the ticket engine (as the Workflow page's 'move all " +
        "tickets'): each ticket gets a history row authored by the admin, and cached perspectives and open views " +
        "refresh. Acts with the admin's authority: no per-queue rights needed and reply locks ignored. A ticket the " +
        "admin has an unsent draft on, one with no response at all, and one the engine refuses are skipped, listed " +
        "and left in the queue. Up to `limit` (default and max 500) a call, oldest first: repeat while the reply's " +
        "`more` is true, passing its `next_after_id` as after_id (not while `remaining` is above 0: skipped tickets " +
        "stay, so that never ends). dry_run counts without moving. Requires workflow:write and an admin owner. (Use " +
        "update_tickets to move chosen tickets under the queue/assignee rule.)",
      inputSchema: {
        from_queue: z.string().optional().describe("Queue name (or from_queue_id)"),
        from_queue_id: z.number().int().optional(),
        to_queue: z.string().optional().describe("Queue name (or to_queue_id); must differ"),
        to_queue_id: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        after_id: z.number().int().min(0).optional().describe("The last call's next_after_id, to carry on after it"),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => toToolResult(await callV1("workflow/queues/move-tickets", compact(args as Record<string, unknown>))),
  );

  // ── Automations ─────────────────────────────────────────────────────────

  const ruleFields = ["name", "description", "is_enabled", "event", "trigger_options", "conditions", "actions", "stop_after"];
  const automations: Record<string, ActionSpec> = {
    list: { path: "workflow/automations", fields: ["with_options"] },
    create: { path: "workflow/automations/create", fields: ruleFields, required: ["name", "event", "actions"] },
    update: { path: "workflow/automations/update", fields: ["id", ...ruleFields], required: ["id"] },
    toggle: { path: "workflow/automations/toggle", fields: ["id", "is_enabled"], required: ["id", "is_enabled"] },
    reorder: { path: "workflow/automations/reorder", fields: ["ids"], required: ["ids"] },
    delete: { path: "workflow/automations/delete", fields: ["id"], required: ["id"] },
    test: {
      path: "workflow/automations/test",
      fields: ["ticket_number", "ticket_id", "id", "event", "conditions", "actions"],
      required: ["ticket_number|ticket_id", "id|event"],
    },
    runs: { path: "workflow/automations/runs", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "automations",
    {
      title: "Automation rules: list, create, update, enable, reorder, delete, test, runs",
      description:
        "Workflow > Automations. list: the rules in run order with their runs and failures over 30 days " +
        "(with_options adds the editor's vocabulary: events, condition fields, operators, action types and the " +
        "queues, staff, teams, watchlists, stock responses and checklist templates they take; read it before writing " +
        "a rule). create: placed last. update: only the fields sent change; conditions/actions replace the whole list; " +
        "clears the rule's failure streak. toggle: is_enabled. reorder: every rule id once, first to run first. " +
        "delete: the rule and its run history. test: a dry run against a ticket the owner can see, of a saved rule " +
        "(id), an unsaved one (event + conditions + actions) or a saved one with parts replaced; changes nothing. " +
        "runs: a rule's latest 25 runs. An add_participant action takes a member of staff's exact address only; " +
        "a reply action must name an existing stock response. From Axial, a rule that replies to customers cannot " +
        "be turned on or saved enabled (saving it disabled is fine), and while another enabled rule replies to " +
        "customers, enabled rules cannot be toggled, deleted, reordered or have their event, trigger_options, " +
        "conditions, actions or stop_after changed (name and description still can, and disabled rules that stay " +
        "disabled are unaffected); a person makes those changes. Requires an admin owner, the " +
        "has_automations plan, and workflow:read (list, runs) or workflow:write (the rest, test included).",
      inputSchema: {
        action: actionEnum(automations),
        id: z.number().int().optional().describe("The rule"),
        with_options: z.boolean().optional().describe("list: add the editor's vocabulary"),
        name: z.string().max(100).optional(),
        description: z.string().max(255).nullable().optional(),
        is_enabled: z.boolean().optional(),
        event: z.string().optional().describe("e.g. ticket.created, customer.replied, ticket.idle, sla.breached"),
        trigger_options: z
          .object({
            minutes: z.number().int().min(1).max(525600).optional(),
            waiting_on: z.enum(["us", "customer", "anyone"]).optional(),
            business_hours: z.boolean().optional(),
          })
          .strict()
          .nullable()
          .optional()
          .describe("ticket.idle only"),
        conditions: z.array(condition).max(30).optional().describe("[{field, operator, value}], all must match"),
        actions: z
          .array(z.object({ type: z.string() }).passthrough())
          .max(20)
          .optional()
          .describe("[{type, ...its parameters}] (with_options lists the types and their parameters)"),
        stop_after: z.boolean().optional().describe("Stop later rules running when this one matched"),
        ids: z.array(z.number().int()).min(1).optional().describe("reorder: every rule id, first to run first"),
        ...ticketRef,
      },
    },
    async (args) => runAction("automations", automations, args as Record<string, unknown>),
  );

  // ── SLA policies ────────────────────────────────────────────────────────

  const slaFields = ["name", "description", "is_enabled", "conditions", "first_response_minutes", "resolution_minutes", "business_hours"];
  const sla: Record<string, ActionSpec> = {
    list: { path: "workflow/sla-policies", fields: ["with_options"] },
    create: { path: "workflow/sla-policies/create", fields: slaFields, required: ["name", "first_response_minutes|resolution_minutes"] },
    update: { path: "workflow/sla-policies/update", fields: ["id", ...slaFields], required: ["id"] },
    reorder: { path: "workflow/sla-policies/reorder", fields: ["ids"], required: ["ids"] },
    delete: { path: "workflow/sla-policies/delete", fields: ["id", "confirm"], required: ["id"] },
  };
  server.registerTool(
    "sla_policies",
    {
      title: "SLA policies: list, create, update, reorder, delete",
      description:
        "Workflow > SLA. list: the policies in order with their open and breached tickets and the workspace time " +
        "zone (with_options adds the condition vocabulary: queue, priority, assignee, subject, from, hashtag). create: " +
        "placed last, with at least one target in minutes; the first policy also adds two SLA automations. update: " +
        "only the fields sent change. reorder: every policy id; the first that matches a ticket applies. delete: a " +
        "policy open tickets use needs confirm: true. Requires an admin owner, the has_sla plan, and workflow:read " +
        "(list) or workflow:write.",
      inputSchema: {
        action: actionEnum(sla),
        id: z.number().int().optional(),
        with_options: z.boolean().optional(),
        name: z.string().max(100).optional(),
        description: z.string().max(255).nullable().optional(),
        is_enabled: z.boolean().optional(),
        conditions: z.array(condition).max(20).optional(),
        first_response_minutes: z.number().int().min(1).max(525600).nullable().optional(),
        resolution_minutes: z.number().int().min(1).max(525600).nullable().optional(),
        business_hours: z.boolean().optional().describe("Count only business hours (default true)"),
        ids: z.array(z.number().int()).min(1).optional(),
        confirm: z.boolean().optional().describe("delete: when open tickets use the policy"),
      },
    },
    async (args) => runAction("sla_policies", sla, args as Record<string, unknown>),
  );

  // ── Recurring tasks ─────────────────────────────────────────────────────

  const taskFields = [
    "subject", "queue_id", "assigned_to_email", "priority", "next_at", "repeat_every", "repeat_unit", "repeat_until",
    "timezone", "due_days", "notes", "checklist_template_id", "skip_if_open", "is_enabled",
  ];
  const recurring: Record<string, ActionSpec> = {
    list: { path: "workflow/recurring-tasks", fields: ["with_options"] },
    create: {
      path: "workflow/recurring-tasks/create",
      fields: taskFields,
      required: ["subject", "queue_id", "assigned_to_email", "priority", "next_at", "repeat_every", "repeat_unit"],
    },
    update: { path: "workflow/recurring-tasks/update", fields: ["id", ...taskFields], required: ["id"] },
    run_now: { path: "workflow/recurring-tasks/run-now", fields: ["id"], required: ["id"], idempotent: true },
    delete: { path: "workflow/recurring-tasks/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "recurring_tasks",
    {
      title: "Recurring tasks: list, create, update, run now, delete",
      description:
        "Workflow > Recurring tasks: a task ticket raised on a schedule. list (with_options adds the queues, staff, " +
        "teams and checklist templates to choose from). create / update (only the fields sent change). run_now: " +
        "raise the task now (a real task ticket, notified as any other) without moving its schedule. delete. " +
        "Requires an admin owner and workflow:read (list) or workflow:write.",
      inputSchema: {
        action: actionEnum(recurring),
        id: z.number().int().optional(),
        with_options: z.boolean().optional(),
        subject: z.string().max(255).optional(),
        queue_id: z.number().int().optional(),
        assigned_to_email: z.string().max(255).optional().describe("A staff email or 'team:<id>'"),
        priority: z.enum(["10", "20", "30", "40"]).optional().describe("10 Low, 20 Normal, 30 High, 40 Urgent"),
        next_at: z.string().optional().describe("The next occurrence, a date-time"),
        repeat_every: z.number().int().min(1).max(365).optional(),
        repeat_unit: z.enum(["day", "week", "month"]).optional(),
        repeat_until: z.string().nullable().optional().describe("YYYY-MM-DD"),
        timezone: z.string().nullable().optional().describe("IANA name"),
        due_days: z.number().int().min(0).max(3650).nullable().optional().describe("Due date this many days after it is raised"),
        notes: z.string().max(5000).nullable().optional().describe("The task ticket's first message"),
        checklist_template_id: z.number().int().nullable().optional(),
        skip_if_open: z.boolean().optional().describe("Skip an occurrence while the last one is still open"),
        is_enabled: z.boolean().optional(),
      },
    },
    async (args) => runAction("recurring_tasks", recurring, args as Record<string, unknown>),
  );

  // ── Checklist templates ─────────────────────────────────────────────────

  const templates: Record<string, ActionSpec> = {
    list: { path: "workflow/checklist-templates", fields: [] },
    create: { path: "workflow/checklist-templates/create", fields: ["name", "description", "items"], required: ["name", "items"] },
    update: { path: "workflow/checklist-templates/update", fields: ["id", "name", "description", "items"], required: ["id"] },
    reorder: { path: "workflow/checklist-templates/reorder", fields: ["ids"], required: ["ids"] },
    delete: { path: "workflow/checklist-templates/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "checklist_templates",
    {
      title: "Checklist templates: list, create, update, reorder, delete",
      description:
        "Workflow > Checklists: named lists of items that ticket_checklist add (template_id), automations and " +
        "recurring tasks put on a ticket. update: only the fields sent change; items replaces the whole list. delete " +
        "is refused while an automation or recurring task adds the template. Requires an admin owner and " +
        "workflow:read (list) or workflow:write.",
      inputSchema: {
        action: actionEnum(templates),
        id: z.number().int().optional(),
        name: z.string().max(100).optional(),
        description: z.string().max(255).nullable().optional(),
        items: z.array(z.string().max(500)).min(1).max(100).optional(),
        ids: z.array(z.number().int()).min(1).optional().describe("reorder: every template id in the new order"),
      },
    },
    async (args) => runAction("checklist_templates", templates, args as Record<string, unknown>),
  );

  // ── Holidays ────────────────────────────────────────────────────────────

  const holidays: Record<string, ActionSpec> = {
    list: { path: "workflow/holidays", fields: [] },
    create: { path: "workflow/holidays/create", fields: ["date", "name", "recurring"], required: ["date", "name"] },
    delete: { path: "workflow/holidays/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "holidays",
    {
      title: "Business-hours holidays: list, add, delete",
      description:
        "The days business hours skip (SLA and idle timers, escalations). create: a date and a name; recurring " +
        "repeats it every year on that day. Each call returns every holiday. Requires an admin owner, the " +
        "has_escalations plan, and workflow:read (list) or workflow:write.",
      inputSchema: {
        action: actionEnum(holidays),
        id: z.number().int().optional().describe("delete: the holiday"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().max(100).optional(),
        recurring: z.boolean().optional(),
      },
    },
    async (args) => runAction("holidays", holidays, args as Record<string, unknown>),
  );

  // ── Interventions ───────────────────────────────────────────────────────

  const interventionFields = [
    "title", "queue_name", "completion_queue_name", "assign_to_email", "create_urgent", "notify_inbox_managers",
    "fma_users", "fields", "remote_enabled", "remote_name", "remote_epilog_url", "remote_bearer_token",
    "remote_timeout_seconds",
  ];
  const interventions: Record<string, ActionSpec> = {
    list: { path: "workflow/interventions", fields: [] },
    create: {
      path: "workflow/interventions/create",
      fields: ["name", ...interventionFields],
      required: ["name", "title", "queue_name", "create_urgent", "notify_inbox_managers", "remote_enabled", "remote_timeout_seconds"],
    },
    update: { path: "workflow/interventions/update", fields: ["intervention_id", ...interventionFields], required: ["intervention_id"] },
    delete: { path: "workflow/interventions/delete", fields: ["intervention_id"], required: ["intervention_id"] },
  };
  // The plan the routes are gated on, as the manifest records it (has_interventions), so the
  // description cannot drift from the route table.
  const plans = [...new Set(MANIFEST.filter((e) => e.uri.startsWith("workflow/interventions")).flatMap((e) => e.plans))];
  const interventionPlans = plans.length ? `the ${plans.join(" and ")} plan` : "a plan with interventions";
  server.registerTool(
    "interventions",
    {
      title: "Intervention definitions: list, create, update, delete",
      description:
        "Workflow > Interventions: the forms a system or person raises as a ticket. update merges: send only what " +
        "changes; null or [] clears a field; `fields`, when sent, replaces the form's whole field list (keep each " +
        "field's id to keep it). (A remote's bearer token is generated with tickiti_call workflow " +
        `interventions.generate_token.) Requires an admin owner, ${interventionPlans}, and workflow:read (list) or ` +
        "workflow:write; without the plan every action is a 403.",
      inputSchema: {
        action: actionEnum(interventions),
        intervention_id: z.number().int().optional(),
        name: z.string().max(255).optional().describe("create: the identifier, letters, digits and _ only; cannot change"),
        title: z.string().max(255).optional(),
        queue_name: z.string().max(255).optional().describe("Queue the ticket is raised in"),
        completion_queue_name: z.string().max(255).nullable().optional(),
        assign_to_email: z.string().max(255).nullable().optional(),
        create_urgent: z.boolean().optional(),
        notify_inbox_managers: z.boolean().optional(),
        fma_users: z.array(z.string().max(255)).nullable().optional(),
        fields: z.array(z.record(z.any())).nullable().optional().describe("The form's fields (list shows their shape)"),
        remote_enabled: z.boolean().optional(),
        remote_name: z.string().max(255).nullable().optional(),
        remote_epilog_url: z.string().max(2000).nullable().optional(),
        remote_bearer_token: z.string().max(10000).nullable().optional(),
        remote_timeout_seconds: z.number().int().min(1).max(120).optional(),
      },
    },
    async (args) => runAction("interventions", interventions, args as Record<string, unknown>),
  );

  // ── Mail attachment rules ───────────────────────────────────────────────

  const attachmentRules: Record<string, ActionSpec> = {
    list: { path: "mail/attachment-rules", fields: ["q"] },
    create: {
      path: "mail/attachment-rules/create",
      fields: ["extension", "response_attachment_id", "rule", "note"],
      required: ["extension|response_attachment_id", "rule"],
    },
    update: { path: "mail/attachment-rules/update", fields: ["id", "rule", "note"], required: ["id"] },
    delete: { path: "mail/attachment-rules/delete", fields: ["id"], required: ["id"] },
  };
  server.registerTool(
    "mail_attachment_rules",
    {
      title: "Inbound attachment rules by extension: list, create, update, delete",
      description:
        "Settings > Mail > Attachments: an extension is always allowed, hard blocked, or (no rule) held for review. " +
        "create: by extension, or response_attachment_id for the extension of an attachment on a ticket (the ticket " +
        "page's 'allow this extension'); an extension with a rule has it replaced. update: rule and/or note; the " +
        "extension cannot change. delete: the extension goes back to being held for review. A security setting: " +
        "every change is logged with who made it. Requires an admin owner and mail:read (list) or mail:write.",
      inputSchema: {
        action: actionEnum(attachmentRules),
        id: z.number().int().optional(),
        q: z.string().optional().describe("list: filter by extension"),
        extension: z.string().max(255).optional().describe("e.g. 'zip'"),
        response_attachment_id: z.number().int().optional(),
        rule: z.enum(["always_allowed", "hard_blocked"]).optional(),
        note: z.string().max(2000).nullable().optional(),
      },
    },
    async (args) => runAction("mail_attachment_rules", attachmentRules, args as Record<string, unknown>),
  );
}
