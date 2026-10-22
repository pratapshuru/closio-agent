import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Config } from '../src/config.ts';
import type { AgentCall } from '../src/providers.ts';

export function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// a throwaway repo with one commit and a tool dir for runs
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closio-agent-test-'));
  const repo = path.join(root, 'svc');
  fs.mkdirSync(repo);
  sh(repo, 'git init -q -b develop && git config user.email t@t && git config user.name t');
  fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  sh(repo, 'git add -A && git commit -qm init');
  const base = sh(repo, 'git rev-parse HEAD');
  return { root, repo, base };
}

// a throwaway "server" (bare origin) with develop and an unmerged parent ticket branch scrum-560,
// plus the developer's clone that the tool works from
export function sandboxWithRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closio-agent-stack-'));
  const origin = path.join(root, 'origin.git');
  sh(root, `git init -q --bare -b develop ${origin}`);
  const seed = path.join(root, 'seed');
  sh(root, `git clone -q ${origin} seed`);
  sh(seed, 'git config user.email t@t && git config user.name t && git checkout -q -b develop');
  fs.writeFileSync(path.join(seed, 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  sh(seed, 'git add -A && git commit -qm init && git push -q origin develop');
  sh(seed, 'git checkout -q -b scrum-560');
  fs.writeFileSync(path.join(seed, 'shared.js'), 'module.exports = "form";\n');
  sh(seed, 'git add -A && git commit -qm "add shared form" && git push -q origin scrum-560 && git checkout -q develop');
  sh(root, `git clone -q ${origin} svc`);
  const repo = path.join(root, 'svc');
  sh(repo, 'git config user.email t@t && git config user.name t');
  return { root, repo, seed, origin };
}

export function testConfig(root: string, repo: string): Config {
  return {
    jira: { base_url: 'https://example.invalid', project: 'SCRUM', statuses: { in_development: 'In Development', code_review: 'Code Review', ready_for_test: 'Ready For Test', blocked: 'Blocked', testing: ['Ready For Test'] } },
    gitlab: { base_url: 'https://example.invalid', mr: { title_format: '{key} - {summary}', draft: false, remove_source_branch: true, reviewers: [] }, reply_to_mr_comments: true },
    people: {},
    repos: {
      svc: {
        kind: 'backend-service',
        description: 'test service',
        path: repo,
        remote_path: 'x/svc',
        target_branch: 'develop',
        writable: true,
        commit_format: 'feat({key}): {summary}',
        install: 'none',
        commit_hooks: 'run',
        hints: [],
        protected: [],
        // fails while a file called "broken" exists
        gates: {
          focused: [{ cmd: 'test ! -f broken', parser: 'exit-code', scope: 'all', timeout_min: 1 }],
          final: [{ cmd: 'test ! -f broken', parser: 'exit-code', scope: 'all', timeout_min: 1 }],
        },
      },
    },
    routing: { frontend: [], backend: ['svc'] },
    models: {
      default_profile: 'fake',
      profiles: { fake: { dev: { provider: 'fake' }, reviewer: { provider: 'fake' }, simplifier: { provider: 'fake' } } },
    },
    limits: { review_rounds: 3, gate_fix_attempts: 2, agent_timeout_min: 1, feedback_rounds: 2, grill_rounds: 3 },
    design: { legacy_folders: false, legacy_number_projects: ['SCRUM'] },
    workspace: { runs_dir: path.join(root, 'runs'), sprints_dir: path.join(root, 'sprints') },
  };
}

export const plan = (overrides: Record<string, unknown> = {}) => ({
  summary: 'test plan',
  repos: [{ key: 'svc', role_in_ticket: 'everything' }],
  facts: [],
  calls: [],
  gaps: [],
  questions: [],
  chunks: [
    { id: 'c1', repo: 'svc', title: 'add feature', goal: 'add feature.js', expected_files: ['feature.js'], is_tests_chunk: false, done_when: [] },
  ],
  risks: [],
  out_of_scope: [],
  needs_qa_curl: false,
  related_tickets: [],
  reuses: [],
  analogues: [],
  upcoming: [],
  done_checklist: [],
  dependencies: [],
  design_status: 'not_needed',
  plan_markdown: '# Plan',
  responses: [],
  ...overrides,
});

export const approved = { verdict: 'approved', summary: 'ok', findings: [], previous_findings: [], question_assessments: [], human_question: null };

export const work = (summary = 'add feature', responses: unknown[] = []) => ({
  summary,
  files_changed: ['feature.js'],
  verification: 'none',
  plan_deviations: '',
  calls: [],
  commit_summary: summary,
  responses,
});

export const handoff = {
  mr_summary_md: 'summary',
  decisions: [{ decision: 'Reused the existing helper', why: 'it already does this' }],
  testing_md: 'tests',
  risks_md: 'none',
  review_guide: [{ file: 'a.ts', what: 'guide' }],
  changes: [],
  qa_curls: [],
  manual_checks: [],
  jira_summary: 'done',
  next_tickets_md: 'Built feature.js; reuse it.',
};

export function wt(call: AgentCall): string {
  return call.writableDirs[0];
}
