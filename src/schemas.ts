import { z } from 'zod';

// every field is required (nullable where optional) so the same schema works for
// claude --json-schema and codex --output-schema strict mode
export function jsonSchema(schema: z.ZodType): object {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

const Response = z.object({
  finding_id: z.string(),
  decision: z.enum(['accept', 'reject']),
  reasoning: z.string(),
});
export type FindingResponse = z.infer<typeof Response>;

export const Question = z.object({
  id: z.string(),
  audience: z.enum(['pm', 'tech_lead', 'developer']),
  question: z.string(),
  why_unresolvable: z.string(),
  recommendation: z.string(),
  blocking: z.boolean(),
});
export type Question = z.infer<typeof Question>;

export const Call = z.object({
  choice: z.string(),
  went_with: z.string(),
  why: z.string(),
});
export type Call = z.infer<typeof Call>;

// something this ticket needs from another ticket or the spec that isn't there, or a clash between them
export const Gap = z.object({
  ticket: z.string(),
  what: z.string(),
  assumption: z.string(),
  alternative: z.string(),
});
export type Gap = z.infer<typeof Gap>;

// a significant way the built work differs from the ticket or spec; internal choices never count
export const Change = z.object({
  kind: z.enum(['ticket', 'spec', 'added', 'removed', 'contract']),
  what: z.string(),
  why: z.string(),
});
export type Change = z.infer<typeof Change>;

export const Chunk = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string(),
  goal: z.string(),
  expected_files: z.array(z.string()),
  is_tests_chunk: z.boolean(),
  done_when: z.array(z.string()),
});
export type Chunk = z.infer<typeof Chunk>;

export const Plan = z.object({
  summary: z.string(),
  repos: z.array(z.object({ key: z.string(), role_in_ticket: z.string() })),
  facts: z.array(z.object({ claim: z.string(), source: z.string() })),
  // choices no source settled, or where I went against the ticket, spec or design; the MR asks for a second look at these
  calls: z.array(Call),
  // needed from other tickets or the spec but missing there, or clashing; the lead is tagged on Jira
  gaps: z.array(Gap),
  questions: z.array(Question),
  chunks: z.array(Chunk),
  risks: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  needs_qa_curl: z.boolean(),
  // tickets the dev bot read because they affect this one, and why
  related_tickets: z.array(z.object({ key: z.string(), why: z.string() })),
  // the developer's usual questions, answered up front
  reuses: z.array(z.object({ what: z.string(), from: z.string() })),
  analogues: z.array(z.object({ path: z.string(), why: z.string() })),
  upcoming: z.array(z.object({ ticket: z.string(), needs: z.string() })),
  done_checklist: z.array(z.string()),
  // unmerged tickets whose code this one must be built on, per repo
  dependencies: z.array(z.object({ repo: z.string(), ticket: z.string(), reason: z.string() })),
  // where the UI design came from; "unavailable" when Figma could not be reached
  design_status: z.enum(['figma_mcp', 'saved', 'developer_folder', 'not_needed', 'unavailable']),
  plan_markdown: z.string(),
  responses: z.array(Response),
});
export type Plan = z.infer<typeof Plan>;

export const Finding = z.object({
  id: z.string(),
  severity: Severity,
  title: z.string(),
  detail: z.string(),
  location: z.string(),
  required: z.boolean(),
});
export type Finding = z.infer<typeof Finding>;

export const Review = z.object({
  verdict: z.enum(['approved', 'changes_required', 'needs_human']),
  summary: z.string(),
  findings: z.array(Finding),
  previous_findings: z.array(
    z.object({
      finding_id: z.string(),
      status: z.enum(['resolved', 'dev_rebuttal_accepted', 'still_required']),
      note: z.string(),
    }),
  ),
  question_assessments: z.array(
    z.object({ question_id: z.string(), needs_human: z.boolean(), suggested_resolution: z.string() }),
  ),
  human_question: z.string().nullable(),
});
export type Review = z.infer<typeof Review>;

export const DevWork = z.object({
  summary: z.string(),
  files_changed: z.array(z.string()),
  verification: z.string(),
  plan_deviations: z.string(),
  // new calls made while coding, same bar as the plan's
  calls: z.array(Call),
  commit_summary: z.string(),
  responses: z.array(Response),
});
export type DevWork = z.infer<typeof DevWork>;

export const Simplify = z.object({
  suggestions: z.array(
    z.object({ id: z.string(), location: z.string(), change: z.string(), rationale: z.string(), risk: z.string() }),
  ),
});
export type Simplify = z.infer<typeof Simplify>;

export const Handoff = z.object({
  mr_summary_md: z.string(),
  // the calls worth a second look, condensed from the run's decision log
  decisions: z.array(z.object({ decision: z.string(), why: z.string() })),
  testing_md: z.string(),
  risks_md: z.string(),
  review_guide: z.array(z.object({ file: z.string(), what: z.string() })),
  // usually empty: only what makes the ticket or spec wrong now
  changes: z.array(Change),
  qa_curls: z.array(z.object({ title: z.string(), curl: z.string(), expected: z.string() })),
  manual_checks: z.array(z.string()),
  jira_summary: z.string(),
  // for tickets that come later: what was built to reuse, decisions, gotchas, what is left
  next_tickets_md: z.string(),
});
export type Handoff = z.infer<typeof Handoff>;

export const Feedback = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      source_id: z.string(),
      action: z.enum(['fix', 'reply_only', 'needs_human']),
      reply: z.string(),
    }),
  ),
  files_changed: z.array(z.string()),
  // new significant differences from the ticket or spec caused by this feedback; usually empty
  changes: z.array(Change),
  commit_summary: z.string(),
});
export type Feedback = z.infer<typeof Feedback>;

export const Resolve = z.object({
  summary: z.string(),
  files_resolved: z.array(z.string()),
  // only real calls: picked one side's behaviour, changed or dropped something; not "kept both"
  decisions: z.array(z.object({ file: z.string(), decision: z.string(), why: z.string() })),
});
export type Resolve = z.infer<typeof Resolve>;

export const Align = z.object({
  summary: z.string(),
  checked: z.array(z.object({ ticket: z.string(), aligned: z.boolean(), note: z.string() })),
  issues: z.array(
    z.object({
      ticket: z.string(),
      problem: z.string(),
      action: z.enum(['fixed', 'noted', 'needs_human']),
      detail: z.string(),
    }),
  ),
  files_changed: z.array(z.string()),
  commit_summary: z.string(),
});
export type Align = z.infer<typeof Align>;

export const SprintPlan = z.object({
  summary: z.string(),
  start_order: z.array(z.object({ ticket: z.string(), why: z.string() })),
  dependencies: z.array(z.object({ ticket: z.string(), depends_on: z.string(), repo: z.string(), reason: z.string() })),
  fe_be_pairs: z.array(z.object({ fe: z.string(), be: z.string(), contract: z.string() })),
  collisions: z.array(z.object({ tickets: z.array(z.string()), area: z.string(), advice: z.string() })),
  build_for_reuse: z.array(z.object({ ticket: z.string(), for_tickets: z.array(z.string()), what: z.string() })),
  ticket_issues: z.array(z.object({ ticket: z.string(), problem: z.string(), suggestion: z.string() })),
});
export type SprintPlan = z.infer<typeof SprintPlan>;

// what the planner must answer: one ticket key per side, and a repo from our config
const TicketKey = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export function sprintPlanFor(repos: [string, ...string[]]) {
  return SprintPlan.extend({
    dependencies: z.array(z.object({ ticket: TicketKey, depends_on: TicketKey, repo: z.enum(repos), reason: z.string() })),
  });
}

export const Impact = z.object({
  // one or two plain sentences; empty when nothing else is affected
  summary: z.string(),
  affected: z.array(z.object({ ticket: z.string(), note: z.string() })),
  missing_work: z.array(z.object({ title: z.string(), repo: z.string(), description: z.string() })),
  spec: z.array(z.object({ section: z.string(), now: z.string(), should: z.string() })),
});
export type Impact = z.infer<typeof Impact>;

export const QaAnswer = z.object({
  replies: z.array(
    z.object({
      comment_id: z.string(),
      verdict: z.enum(['question', 'not_a_bug', 'data_issue', 'bug', 'unclear']),
      reply: z.string(),
    }),
  ),
});
export type QaAnswer = z.infer<typeof QaAnswer>;

// a bug ticket's confirm-first step
export const BugTriage = z.object({
  verdict: z.enum(['bug', 'not_a_bug', 'data_issue', 'needs_info']),
  cause: z.string(),
  reply: z.string(),
});
export type BugTriage = z.infer<typeof BugTriage>;

export const TriageCheck = z.object({
  agree: z.boolean(),
  reason: z.string(),
});
export type TriageCheck = z.infer<typeof TriageCheck>;
