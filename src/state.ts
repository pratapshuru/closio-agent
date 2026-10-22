import fs from 'node:fs';
import path from 'node:path';
import type { Config, Role, RoleModel } from './config.ts';
import { resolvePath } from './config.ts';
import type { Design } from './design.ts';
import type { SprintContext } from './sprint.ts';
import type { Parent } from './stack.ts';
import type { Baseline } from './gates.ts';
import type { Finding, Plan, Question } from './schemas.ts';
import { ensureDir, now, readJson, writeJson } from './util.ts';

export type Phase =
  | 'intake'
  | 'planning'
  | 'awaiting_answers'
  | 'implementing'
  | 'finalizing'
  | 'publishing'
  | 'in_review'
  | 'done'
  | 'failed';

export type RepoState = {
  key: string;
  worktree: string;
  branch: string;
  // commit the ticket branch started from
  base: string;
  baseline: Baseline;
  commits: Array<{ sha: string; message: string; chunk: string }>;
  mr?: { projectId: number; iid: number; url: string };
  pushedSha?: string;
  // set when this branch is built on another ticket's unmerged branch
  parent?: Parent;
  // local branches saved before each rebase or move (`agent clean` removes them)
  backups?: string[];
};

export type LedgerEntry = {
  at: string;
  step: string;
  role: Role;
  provider: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  ok: boolean;
  error?: string;
};

export type Disagreement = { where: string; finding: Finding; devReasoning: string };

export type RunState = {
  key: string;
  summary: string;
  issueType?: string;
  mode: 'ticket' | 'replay';
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  publish: boolean;
  jira: boolean;
  models: Record<Role, RoleModel>;
  repos: Record<string, RepoState>;
  devSession?: { provider: string; id: string };
  // one reviewer for the whole ticket, so it builds up context like the dev does
  reviewerSession?: { provider: string; id: string };
  plan?: Plan;
  nextChunk: number;
  questions: { pending: Question[]; askedAt?: string; commentId?: string; answers: string[]; inbox: string[] };
  resumePhase?: Phase;
  options?: unknown;
  autoAnswer?: boolean;
  inputs?: { ticket: string; specs: string[]; context: string[]; figma: string; images: string[]; brief?: string; advice?: string };
  retries?: number;
  design?: Design;
  designSkipped?: boolean;
  // what an awaiting_answers pause is waiting for
  waitingFor?: 'answers' | 'design' | 'dependency';
  context?: SprintContext;
  depsResolved?: boolean;
  // a dependency that could not be built on yet (parent not started, or two parents in one repo)
  pendingDependency?: { repo: string; tickets: string[]; problem: 'not_started' | 'two_parents' | 'bug_base' };
  skipDependencies?: boolean;
  // a parent ticket chosen with --base or by a human reply ("build on SCRUM-560"), or the target branch for none
  baseOverride?: string;
  alignment?: Array<{ ticket: string; problem: string; action: string; detail: string }>;
  // every call made without asking a human, logged as it happens (runs/<KEY>/decisions.md)
  // note: true for routine entries (branching, answers a human gave) that never reach the MR
  decisions?: Array<{ at: string; where: string; decision: string; why: string; note?: boolean }>;
  // significant differences from the ticket or spec (handoff, then feedback rounds)
  changes?: Array<{ kind: string; what: string; why: string }>;
  // protected files this run may edit (from --allow-edit)
  allowEdit?: string[];
  // repos whose own CLAUDE.md/AGENTS.md each kept session has already been given
  conventionsSent?: { dev?: string[]; reviewer?: string[] };
  // BE deploy notes from the diff (env vars, migrations, order)
  deploy?: string[];
  // gaps already posted on Jira at planning, so a re-run doesn't post them twice
  gapsPosted?: string[];
  impact?: { at: string; summary: string; affected: Array<{ ticket: string; note: string }>; missing_work: Array<{ title: string; repo: string; description: string }>; spec: Array<{ section: string; now: string; should: string }>; posted?: string[] };
  // gate failures the dev showed are intended, waiting for that repo's tests chunk
  expectedFailures?: Record<string, Record<string, string>>;
  assumptions: string[];
  disagreements: Disagreement[];
  gateNotes: string[];
  ledger: LedgerEntry[];
  humanTouches: number;
  processed: { mrNotes: number[]; jiraComments: string[]; parentNotes?: number[] };
  codeReviewAt?: string;
  // a bug ticket's parent story, built on this laptop: its conversations are copied, never resumed
  parentRun?: { key: string; merged: boolean; devFork?: string; reviewerFork?: string };
  // the confirm-first verdict for a bug ticket
  bugTriage?: { verdict: string; cause: string };
  // who raised the ticket (Jira account id), tagged in replies
  reporterId?: string;
  // set once a merged card is Done, so watch stops checking it for QA questions
  qaWatchEnded?: boolean;
  replay?: { repo: string; base: string; reference?: string };
  error?: string;
};

export function runsDir(config: Config): string {
  return ensureDir(resolvePath(config.workspace.runs_dir));
}

export function worktreesDir(config: Config): string {
  return ensureDir(resolvePath(config.workspace.worktrees_dir));
}

export function runDir(config: Config, key: string): string {
  return path.join(runsDir(config), key);
}

export function stateFile(config: Config, key: string): string {
  return path.join(runDir(config, key), 'state.json');
}

export function hasRun(config: Config, key: string): boolean {
  return fs.existsSync(stateFile(config, key));
}

export function loadState(config: Config, key: string): RunState {
  if (!hasRun(config, key)) throw new Error(`No run for ${key}. Start one with: agent run ${key}`);
  return readJson<RunState>(stateFile(config, key));
}

export function saveState(config: Config, state: RunState): void {
  state.updatedAt = now();
  writeJson(stateFile(config, state.key), state);
}

export function listRuns(config: Config): RunState[] {
  return fs
    .readdirSync(runsDir(config), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runsDir(config), d.name, 'state.json')))
    .map((d) => readJson<RunState>(path.join(runsDir(config), d.name, 'state.json')));
}

export function totals(state: RunState): { costUsd: number; minutes: number; calls: number } {
  return {
    costUsd: state.ledger.reduce((s, e) => s + (e.costUsd ?? 0), 0),
    minutes: state.ledger.reduce((s, e) => s + e.durationMs, 0) / 60_000,
    calls: state.ledger.length,
  };
}
