import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { z } from 'zod';
import type { Config, Repo, Role } from './config.ts';
import { repoPath, resolveModels, resolvePath } from './config.ts';
import * as g from './git.ts';
import { designDropDir, designWaitMessage, FIGMA_TOOLS, findBrief, findDesignFolders, prepareDesign } from './design.ts';
import { computeBaseline, gateFailureDetail, gateReport, gatesOk, runGates, type Baseline, type GateResult } from './gates.ts';
import { GitLab } from './gitlab.ts';
import { buildInputs, ticketMarkdown } from './ingest.ts';
import { isOurComment, Jira } from './jira.ts';
import { AgentError, claudeSessionFile, runAgent, type Access } from './providers.ts';
import * as S from './schemas.ts';
import { buildSprintContext, findBranches, mentionedKeys, relatedText, type TicketBranch } from './sprint.ts';
import { adviceFor } from './sprintplan.ts';
import { isMergedInto, ownSubjects, resolveRef, startOn, startRestack, verifyRestack } from './stack.ts';
import { hasRun, listRuns, loadState, runDir, saveState, scratchDir, totals, type Challenge, type GrillAnswer, type Phase, type RunState } from './state.ts';
import { ensureDir, exec, fill, log, now, PipelineStop, readJson, render, TOOL_ROOT, writeJson, writeText } from './util.ts';

export type StartOptions = {
  key: string;
  profile?: string;
  set?: string[];
  repos?: string[];
  specs: string[];
  contexts: string[];
  ticketFile?: string;
  publish: boolean;
  jira: boolean;
  autoAnswer: boolean;
  replay?: { repo: string; base: string; reference?: string };
  // force the branch base: another ticket's key, or the target branch name for none
  base?: string;
  // extra tickets to treat as connected
  related?: string[];
  // protected files this one run may edit anyway
  allowEdit?: string[];
  // bug tickets: the story it's a bug in (found from Jira links otherwise); fresh = don't reuse that story's conversation
  parent?: string;
  fresh?: boolean;
  // ask the developer every grill decision instead of letting the dev agent choose
  ask?: boolean;
};

// models sometimes echo a schema field name as an xml tag around or after the text
export function stripFieldTags(text: string): string {
  return text.replace(/<\/?[a-z]+(_[a-z]+)+>/g, '').trim();
}

// gate commands without the machine-readable output flags, for agents to run themselves
export function humanCmd(cmd: string): string {
  const drop = [' -o {out}', ' -f json', ' --outputFile={out}', ' --reporter=json', ' --reporter json', ' --reporter-option output={out}', ' --outDir {tmp}/dist'];
  return drop.reduce((c, flag) => c.replaceAll(flag, ''), cmd);
}

type GrillKind = 'grill' | 'challenge';
const ASK_MODE = "The grill is done: the developer answered every open decision, listed under 'Decisions already made'. Don't grill again or re-ask them; build the plan on those answers. Put in `calls` only decisions you still had to make while planning, which should be rare: settle them from the sources and the developer's answers. The developer's decisions are added to the plan for you.";

const canPrompt = () => Boolean(process.stdin.isTTY && process.stderr.isTTY && !process.env.CLOSIO_AGENT_NO_PROMPT);
const letter = (i: number) => String.fromCharCode(97 + i);
const letters = (n: number) => Array.from({ length: n }, (_, i) => letter(i)).join('/');
const recommendedLetter = (c: S.Call) => {
  const i = c.options.findIndex((o) => o.trim().toLowerCase() === c.recommended.trim().toLowerCase());
  return i >= 0 ? letter(i) : c.recommended;
};

// what differs between asking a grill question and asking about a reviewer's challenge to your answer
const ASKING: Record<GrillKind, { title: string; what: (n: number) => string; mark: string; markLabel: string; reason: string; headline: (c: S.Call) => string; hint: (options: number) => string }> = {
  grill: {
    title: 'Grill',
    what: (n) => `${n} grill question(s)`,
    mark: 'recommended',
    markLabel: 'Recommended',
    reason: "Agent's reasoning",
    headline: (c) => c.question.trim(),
    hint: (n) => `Enter = recommended · ${letters(n)} · your own words · auto · auto all`,
  },
  challenge: {
    title: 'Reviewer challenge',
    what: (n) => `${n} reviewer challenge(s) to your decisions`,
    mark: 'your choice',
    markLabel: 'Your choice',
    reason: 'The reviewer says',
    headline: (c) => `You decided: ${c.question.trim()} → ${c.chosen.trim()}`,
    hint: (n) => `Enter = keep yours · ${letters(n)} to switch · your own words`,
  },
};

// the options with the recommended one (or, for a challenge, your current one) marked
function optionLines(c: S.Call, kind: GrillKind, indent: string): string[] {
  const rec = recommendedLetter(c);
  return [
    ...c.options.map((o, i) => `${indent}${letter(i)}) ${o.trim()}${letter(i) === rec ? `   ← ${ASKING[kind].mark}` : ''}`),
    ...(rec.length > 1 ? [`${indent}${ASKING[kind].markLabel}: ${c.recommended.trim()}`] : []),
  ];
}

function grillQuestion(key: string, c: S.Call, n: number, total: number, kind: GrillKind): string {
  return [`${ASKING[kind].title} · ${key} · question ${n} of ${total}`, '', ASKING[kind].headline(c), ...optionLines(c, kind, '  '), `${ASKING[kind].reason}: ${c.why.trim()}`].join('\n');
}

// a letter picks that option, "auto" leaves it to the agent, anything else is your own words
function readGrillAnswer(typed: string, c: S.Call, kind: GrillKind): GrillAnswer | null {
  const t = typed.trim();
  if (!t) return null;
  // on a challenge only keep, switch or your own words make sense; "auto" keeps yours
  if (kind === 'challenge' && /^(keep|auto( all)?)$/i.test(t)) return { chosen: c.chosen, by: 'you' };
  if (/^auto( all)?$/i.test(t)) return { chosen: c.chosen, by: 'agent' };
  const i = /^[a-z]$/i.test(t) ? t.toLowerCase().charCodeAt(0) - 97 : -1;
  if (i >= 0 && i < c.options.length) return { chosen: c.options[i].trim(), by: 'you' };
  return { chosen: t, by: 'you' };
}

// a decision with all its options, as decisions.md and the plan show it
function callLines(c: S.Call, indent = '  ', by?: string): string {
  const options = c.options.map((o, i) => `(${letter(i)}) ${o.trim()}`);
  return [
    `**${c.question.trim()}**`,
    `${indent}- Options: ${options.join('; ') || 'none listed'}`,
    `${indent}- Recommended: ${c.recommended.trim()}`,
    `${indent}- Chose: ${c.chosen.trim()}`,
    `${indent}- Why: ${c.why.trim()}`,
    ...(by ? [`${indent}- Decided by: ${by}`] : []),
  ].join('\n');
}

const prompt = (name: string) => fs.readFileSync(path.join(TOOL_ROOT, 'prompts', `${name}.md`), 'utf8');
const json = (value: unknown) => JSON.stringify(value, null, 2);

// the dev databases set up in .env for bin/agent-sql (names only, never credentials)
function databaseList(): string {
  const keys = [...new Set(Object.keys(process.env).map((k) => k.match(/^DB_RO_URL_(\w+)$/)?.[1] ?? k.match(/^DB_RO_(\w+?)_HOST$/)?.[1]).filter(Boolean) as string[])];
  return keys.length ? keys.map((k) => `\`${k.toLowerCase()}\`${process.env[`DB_RO_${k}_NAME`] ? ` (${process.env[`DB_RO_${k}_NAME`]})` : ''}`).join(', ') : 'none set up yet, so write the queries you would run into the plan\'s risks instead';
}

// QA's agreed marker for "this is a question for the dev": QA-Question:, QA Question -, qa question: …
// leading tags, bold, bullets and quotes are skipped, so "@Name **QA-Question:** …" counts too
const QA_MARK = /^(?:\s|@[\w.'-]+(?:\s+[A-Z][\w.'-]*){0,3}|[*_>#-])*qa[\s_-]*question\s*\**\s*[:\-]/i;
export const isQaQuestion = (text: string) => QA_MARK.test(text);

// after merge, a comment without the marker that still smells like it needs the developer
const mayNeedDev = (text: string, me: string) => /\?|\bbug\b|not working|error|broken|wrong|doesn'?t work/i.test(text) || (me !== '' && text.includes(`@${me}`));

// "Added X" + "so the FE can …" reads as one sentence; anything else becomes a second sentence
const withWhy = (what: string, why: string) => {
  const w = what.trim().replace(/\.$/, '');
  const y = why.trim().replace(/\.$/, '');
  if (!y) return `${w}.`;
  return /^(so|because|since|as|to|which|but)\b/i.test(y) ? `${w}, ${y}.` : `${w}. ${y.replace(/^./, (x) => x.toUpperCase())}.`;
};

export class Run {
  readonly config: Config;
  state: RunState;
  readonly dir: string;
  private jiraClient?: Jira;
  private gitlabClient?: GitLab;
  private feedbackCommitCount = 0;

  constructor(config: Config, state: Run['state']) {
    this.config = config;
    this.state = state;
    this.dir = runDir(config, state.key);
  }

  static create(config: Config, opts: StartOptions): Run {
    const state: Run['state'] = {
      key: opts.key,
      summary: '',
      mode: opts.replay ? 'replay' : 'ticket',
      createdAt: now(),
      updatedAt: now(),
      phase: 'intake',
      publish: opts.publish && !opts.replay,
      jira: opts.jira && !opts.replay && !opts.ticketFile,
      models: resolveModels(config, opts.profile, opts.set),
      repos: {},
      nextChunk: 0,
      questions: { pending: [], answers: [], inbox: [] },
      options: opts,
      allowEdit: opts.allowEdit,
      assumptions: [],
      disagreements: [],
      gateNotes: [],
      ledger: [],
      humanTouches: 0,
      processed: { mrNotes: [], jiraComments: [] },
      replay: opts.replay,
      autoAnswer: opts.autoAnswer,
      baseOverride: opts.base,
      askGrill: Boolean(opts.ask) && !opts.autoAnswer,
    };
    const run = new Run(config, state);
    ensureDir(run.dir);
    run.save();
    return run;
  }

  static load(config: Config, key: string): Run {
    return new Run(config, loadState(config, key));
  }

  save(): void {
    saveState(this.config, this.state);
    this.writeReadme();
  }

  file(...parts: string[]): string {
    return path.join(this.dir, ...this.place(parts));
  }

  // where each kind of file goes in the per-ticket folder
  private place(parts: string[]): string[] {
    const [first, ...rest] = parts;
    const name = rest.at(-1) ?? '';
    if (first === 'inputs') return ['1-input', ...rest];
    if (first === 'plan.md') return ['2-plan', first];
    if (first === 'reviews') return [this.stage(name), name];
    if (first === 'gates') {
      if (rest[0]?.startsWith('baseline-')) return ['.agent', 'baselines', ...rest];
      // a step's results sit with its review; the raw tool output stays hidden
      return rest.length >= 2 ? [this.stage(name), 'tests', ...rest] : ['.agent', 'gates', ...rest];
    }
    if (first === 'deployment.md' || first.startsWith('mr-')) return ['4-mr', first];
    if (['logs', 'chunks', 'steps', 'score', 'plan.json', 'handoff.json'].includes(first)) return ['.agent', first, ...rest];
    return parts;
  }

  // which stage a review or test result belongs to, from its name
  private stage(name: string): string {
    const chunks = this.state.plan?.chunks ?? [];
    const chunk = [...chunks].sort((a, b) => b.id.length - a.id.length).find((c) => name.startsWith(`chunk-${c.id}-`));
    if (chunk) return path.join('3-build', `chunk-${chunks.indexOf(chunk) + 1}-${chunk.id}`);
    if (name.startsWith('plan')) return '2-plan';
    if (/^(feedback|rebase|restack)/.test(name)) return '5-after-mr';
    return path.join('3-build', 'final');
  }

  // the ticket folder's front page: where it stands and what to open first
  private writeReadme(): void {
    const s = this.state;
    const rel = (f: string) => path.relative(this.dir, f);
    const have = (f: string) => fs.existsSync(f);
    const repos = Object.values(s.repos).map((r) => `- ${r.key}: branch \`${r.branch}\`${r.mr ? `, MR ${r.mr.url}` : ''}`);
    const read = [
      [this.file('questions.md'), s.questions.pending.length ? 'waiting on these answers' : 'questions asked so far'],
      [this.file('decisions.md'), 'every call made without asking, and why'],
      [this.file('plan.md'), 'the plan'],
      [this.file('impact.md'), 'what this ticket affects elsewhere'],
      [this.file('handoff-note.md'), 'the note later tickets read'],
      ...Object.keys(s.repos).map((k) => [this.file(`mr-${k}.md`), `MR text for ${k}`]),
      [this.file('deployment.md'), 'deploy notes'],
    ].filter(([f]) => have(f)).map(([f, what]) => `- [${rel(f)}](${rel(f)}): ${what}`);
    writeText(path.join(this.dir, 'README.md'), [
      `# ${s.key}: ${s.summary || 'starting'}`,
      `Stage: **${s.phase}**${s.waitingFor ? ` (waiting for ${s.waitingFor})` : ''}. Updated ${new Date(s.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`,
      repos.length ? `## Code\n\n${repos.join('\n')}\n\nThe ticket's own copies of the repos are in \`code/\`.` : '',
      read.length ? `## Read first\n\n${read.join('\n')}` : '',
      '## Folders\n\n- `1-input/`: the ticket, spec, design, your brief, connected tickets\n- `2-plan/`: the plan and its reviews\n- `3-build/`: one folder per chunk (reviews and test results), then `final/`\n- `4-mr/`: MR text and deploy notes\n- `5-after-mr/`: review feedback and rebases\n- `code/`: the ticket\'s copies of the repos\n- `.agent/`: machine files: state, raw answers, logs',
    ].filter(Boolean).join('\n\n'));
  }

  get jira(): Jira {
    this.jiraClient ??= new Jira(this.config);
    return this.jiraClient;
  }

  // GitLab is optional for lookups (no token or no VPN just means less information)
  private optionalGitlab(): GitLab | undefined {
    try {
      return this.gitlab;
    } catch {
      return undefined;
    }
  }

  get gitlab(): GitLab {
    this.gitlabClient ??= new GitLab(this.config);
    return this.gitlabClient;
  }

  get root(): string {
    return ensureDir(path.join(this.dir, 'code'));
  }

  private repoCfg(key: string): Repo {
    const repo = this.config.repos[key];
    if (!repo) throw new Error(`Unknown repo '${key}'`);
    return repo;
  }

  // ---------------------------------------------------------------- agents

  private writableDirs(): string[] {
    return Object.values(this.state.repos)
      .filter((r) => this.repoCfg(r.key).writable)
      .map((r) => r.worktree);
  }

  private readDirs(): string[] {
    const dirs = [this.file('inputs'), ...(this.state.inputs?.context ?? []), ...(this.state.design?.folders ?? [])];
    for (const [key, repo] of Object.entries(this.config.repos)) {
      if (repo.path && !this.state.repos[key] && fs.existsSync(repoPath(this.config, key))) dirs.push(repoPath(this.config, key));
    }
    return dirs;
  }

  // the team's own notes for a repo, if it has any; our safety rules still win
  // base prompts for the sides not sent yet, then repos whose notes weren't sent
  private unsent(seen: string[]): string[] {
    const repos = Object.keys(this.state.repos);
    const sides = [...new Set(repos.map((k) => (this.repoCfg(k).kind === 'frontend' ? 'side:frontend' : 'side:backend')))];
    return [...sides, ...repos].filter((k) => !seen.includes(k));
  }

  private conventions(keys: string[], role: Role): { text: string; keys: string[] } {
    const parts: string[] = [];
    for (const side of ['frontend', 'backend']) {
      if (!keys.includes(`side:${side}`)) continue;
      parts.push(render(prompt(`${role === 'reviewer' ? 'reviewer' : 'dev'}/${side}`), {
        ...this.sourceVars(),
        jiraHelper: path.join(TOOL_ROOT, 'bin', 'agent-jira'),
        sqlHelper: path.join(TOOL_ROOT, 'bin', 'agent-sql'),
        databases: databaseList(),
        planFile: this.file('plan.md'),
      }).trim());
    }
    for (const key of keys) {
      const repo = this.state.repos[key];
      if (!repo) continue;
      const file = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'].find((f) => fs.existsSync(path.join(repo.worktree, f)));
      if (!file) continue;
      const body = fs.readFileSync(path.join(repo.worktree, file), 'utf8').trim();
      parts.push(`## The team's own notes for repo \`${key}\` (from \`${file}\`)\n\nFollow these for conventions. Where they clash with your rules (never commit or push, never run migrations or DB writes, never touch \`.env\`), your rules win.\n\n${body.length > 15_000 ? body.slice(0, 15_000) + '\n…(cut)' : body}`);
    }
    return { text: parts.join('\n\n'), keys };
  }

  private gitDirs(): string[] {
    const dirs = Object.values(this.state.repos).map((r) => r.worktree);
    for (const [key, repo] of Object.entries(this.config.repos)) {
      if (repo.path && fs.existsSync(repoPath(this.config, key))) dirs.push(repoPath(this.config, key));
    }
    return dirs;
  }

  async call<T>(role: Role, step: string, text: string, schema: z.ZodType<T>, access: Access): Promise<T> {
    const model = this.state.models[role];
    // the dev and the reviewer each keep one session per ticket; the simplifier starts fresh
    const kept = role === 'dev' ? this.state.devSession : role === 'reviewer' ? this.state.reviewerSession : undefined;
    let resume = kept?.provider === model.provider ? kept.id : undefined;
    // a bug ticket's first dev and reviewer calls start from copies of its story's conversations
    const pr = this.state.parentRun;
    const forkFrom = resume || !pr ? undefined : role === 'dev' ? pr.devFork : role === 'reviewer' ? pr.reviewerFork : undefined;
    // each session gets its FE/BE base and each repo's CLAUDE.md once
    const sent = (this.state.conventionsSent ??= {});
    const keyed = role === 'dev' || role === 'reviewer' ? role : null;
    const seen = keyed && resume ? (sent[keyed] ?? []) : [];
    const notes = this.conventions(this.unsent(seen), role);
    if (notes.text) text = `${notes.text}\n\n${text}`;
    // Figma MCP is configured in Claude; codex cannot use it
    const figma = this.state.design?.mcp === 'connected' && model.provider !== 'codex' && ['mcp', 'folder', 'saved'].includes(this.state.design.mode);
    const base = {
      role,
      model,
      cwd: this.root,
      prompt: text,
      access,
      writableDirs: access === 'write' ? this.writableDirs() : [],
      readDirs: this.readDirs(),
      gitDirs: this.gitDirs(),
      // only the dev bot talks to Figma, and saves what it fetches for everyone else
      extraWritable: role === 'dev' && figma ? [this.state.design!.mcpDir] : [],
      mcpTools: role === 'dev' && figma ? FIGMA_TOOLS.map((t) => `mcp__figma__${t}`) : [],
      schema: S.jsonSchema(schema),
      images: role === 'dev' || role === 'reviewer' ? [...(this.state.inputs?.images ?? []), ...(this.state.design?.images ?? [])] : [],
      timeoutMs: this.config.limits.agent_timeout_min * 60_000,
      logDir: this.file('logs', step),
    };
    for (let attempt = 1; ; attempt++) {
      const stepName = attempt === 1 ? step : `${step}-retry${attempt - 1}`;
      try {
        const result = await runAgent({ ...base, step: stepName, resumeSessionId: resume, forkFrom: resume ? undefined : forkFrom });
        const parsed = schema.parse(result.structured);
        this.state.ledger.push({
          at: now(),
          step: stepName,
          role,
          provider: result.provider,
          model: model.model,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
          ok: true,
        });
        if (keyed) sent[keyed] = [...new Set([...(resume ? seen : []), ...notes.keys])];
        if (role === 'dev') this.state.devSession = { provider: result.provider, id: result.sessionId };
        if (role === 'reviewer') this.state.reviewerSession = { provider: result.provider, id: result.sessionId };
        writeJson(this.file('steps', `${stepName}.json`), parsed);
        this.save();
        return parsed;
      } catch (err) {
        const message = (err as Error).message;
        this.state.ledger.push({ at: now(), step: stepName, role, provider: model.provider, model: model.model, durationMs: 0, ok: false, error: message.slice(0, 500) });
        this.save();
        if (attempt >= 2 || !(err instanceof AgentError || err instanceof z.ZodError)) throw err;
        // a lost reviewer session is not worth failing over; the retry starts a fresh reviewer
        if (role === 'reviewer' && resume) {
          const all = this.conventions(this.unsent([]), role);
          base.prompt = this.withFullReviewerRules(all.text ? `${all.text}\n\n${text.replace(notes.text, '').trimStart()}` : text);
          notes.keys = all.keys;
          resume = undefined;
          this.state.reviewerSession = undefined;
        }
        log(`  ${step} failed (${message.slice(0, 200)}), retrying once`);
      }
    }
  }

  // ---------------------------------------------------------------- context

  private repoMap(): string {
    const lines: string[] = [];
    for (const [key, repo] of Object.entries(this.config.repos)) {
      const ticket = this.state.repos[key];
      if (ticket) {
        const cmds = [...repo.gates.focused, ...repo.gates.final].map((gate) => `\`${humanCmd(gate.cmd)}\``);
        const guarded = [...repo.protected, ...(repo.kind.startsWith('backend') ? ['existing files in migrations/ and seeders/ (adding new ones is fine)'] : [])];
        const allowed = this.state.allowEdit?.length ? ` This run may still edit: ${this.state.allowEdit.join(', ')}.` : '';
        lines.push(`- **${key}** (${repo.kind}): ${repo.description}\n  TICKET WORKTREE: \`${ticket.worktree}\`, branch \`${ticket.branch}\` from \`${repo.target_branch}\`. ${repo.writable ? 'Writable.' : 'Read-only.'}${cmds.length ? `\n  Checks you can run here (replace {files} with paths; the orchestrator runs these too): ${[...new Set(cmds)].join(', ')}` : ''}${guarded.length ? `\n  PROTECTED, never edit (edits are undone; if the ticket truly needs one changed, raise it as a gap): ${guarded.map((g) => (g.includes(' ') ? g : `\`${g}\``)).join(', ')}.${allowed}` : ''}`);
      } else if (repo.path && fs.existsSync(repoPath(this.config, key))) {
        const p = repoPath(this.config, key);
        lines.push(`- **${key}** (${repo.kind}): ${repo.description}\n  Main checkout (read-only): \`${p}\`. Its files may be old or on another branch; read the current code from GitLab's copy instead: \`git -C ${p} show origin/${repo.target_branch}:<file>\`, \`git -C ${p} grep <pattern> origin/${repo.target_branch} -- <path>\`, \`git -C ${p} ls-tree -r --name-only origin/${repo.target_branch} -- <dir>\`.`);
      }
    }
    return lines.join('\n');
  }

  // every repo's target branch, fresh from GitLab, so the bot reads today's code in the repos it isn't changing
  private async fetchAll(): Promise<void> {
    const repos = Object.entries(this.config.repos).filter(([key, r]) => r.path && fs.existsSync(repoPath(this.config, key)));
    const results = await Promise.all(repos.map(async ([key, r]) => (await exec('git', ['-C', repoPath(this.config, key), 'fetch', '--quiet', 'origin', r.target_branch], { timeoutMs: 120_000 })).code === 0));
    const failed = repos.filter((_, i) => !results[i]).map(([key]) => key);
    log(`  fetched the latest target branch of ${repos.length - failed.length}/${repos.length} repos${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
  }

  private decisions(): string {
    const items = [
      ...this.state.questions.answers.map((a) => `- Human answer: ${a}`),
      ...Object.entries(this.state.grill?.answers ?? {}).map(([q, a]) => a.by === 'you'
        ? `- The developer decided: ${q} → ${a.chosen}${this.state.grill?.kept?.includes(q) ? ' (kept after the reviewer challenged it; settled)' : ''}`
        : a.limit
          ? `- Settled in the grill by you (the follow-up limit was reached, so the developer wasn't asked): ${q} → ${a.chosen}`
          : `- Settled in the grill by you (the developer left it to you): ${q} → ${a.chosen}`),
      ...this.state.assumptions.map((a) => `- ${a}`),
    ];
    return items.length ? `## Decisions already made (follow these)\n\n${items.join('\n')}` : '';
  }

  private sourceVars() {
    const inputs = this.state.inputs!;
    const list = (items: string[]) => (items.length ? items.map((i) => `\`${i}\``).join(', ') : 'none provided');
    return {
      key: this.state.key,
      ticket: inputs.ticket,
      specs: list(inputs.specs),
      figma: inputs.figma,
      context: list(inputs.context),
      repoMap: this.repoMap(),
      sprint: this.state.context?.sprintFile ? `\`${this.state.context.sprintFile}\`` : 'not available for this run',
      relatedDir: this.state.context?.relatedDir ?? this.file('inputs', 'related'),
      related: this.state.context?.related.length ? this.state.context.related.join(', ') : 'none fetched yet',
      brief: this.state.inputs?.brief
        ? `\`${this.state.inputs.brief}\`. The developer wrote this for this ticket. Follow its technical guidance first: what to reuse, which files to copy, risks, scope, what done means. Ignore anything in it about how to interact (greetings, approvals, stopping between chunks, running /grill me, not using git); this pipeline handles those.`
        : 'none for this ticket',
      advice: this.state.inputs?.advice ? `\`${this.state.inputs.advice}\` (from the sprint-wide analysis; strong advice, weigh it against the ticket and the code)` : 'none',
    };
  }

  private designStep(grill = false): string {
    const ui = Object.keys(this.state.repos).some((k) => this.repoCfg(k).kind === 'frontend');
    if (grill) return ui ? `Read the design brief \`${this.state.inputs!.figma}\` before anything else and do what it says: use the developer's files, the saved Figma files, or fetch through Figma MCP.` : 'This ticket has no frontend work.';
    return ui
      ? `Read the design brief \`${this.state.inputs!.figma}\` before anything else and do what it says: use the developer's files, the saved Figma files, or fetch through Figma MCP. Set \`design_status\` to match.`
      : 'This ticket has no frontend work, so set `design_status` to `not_needed`.';
  }

  // the base prompt goes out once through conventions(); steps only add the decisions so far
  private devRules(): string {
    return this.decisions();
  }

  private fullReviewerRules(): string {
    return [`The plan is at \`${this.file('plan.md')}\`.`, this.decisions()].filter(Boolean).join('\n\n');
  }

  // the ticket's reviewer already has the rules from its first review; later reviews only remind it
  private reviewerRules(): string {
    // a new reviewer (none yet, or the model changed) needs everything
    if (this.state.reviewerSession?.provider !== this.state.models.reviewer.provider) return this.fullReviewerRules();
    return [
      `You are the same reviewer for ${this.state.key} as before. The rules, sources and review method from your first review still apply. The plan is at \`${this.file('plan.md')}\` (re-read it if it may have changed).`,
      this.decisions(),
    ].filter(Boolean).join('\n\n');
  }

  // a review prompt sent to a brand-new reviewer must carry the full rules again
  private withFullReviewerRules(text: string): string {
    const reminder = this.reviewerRules();
    return reminder !== this.fullReviewerRules() && text.startsWith(reminder) ? this.fullReviewerRules() + text.slice(reminder.length) : text;
  }

  private previous(review: S.Review, responses: S.FindingResponse[], answered: string[] = []): string {
    if (!review.findings.length && !answered.length) return '';
    const rows = [...review.findings.map((f) => {
      const r = responses.find((x) => x.finding_id === f.id);
      return `- ${f.id} [${f.severity}${f.required ? ', required' : ''}] ${f.title}\n  Dev Agent: ${r ? `${r.decision.toUpperCase()}: ${r.reasoning}` : 'no response'}`;
    }), ...answered];
    return `## Previous round\n\nYour earlier findings and the Dev Agent's responses are below. For each one, set \`previous_findings\` to resolved, dev_rebuttal_accepted (their evidence convinced you), or still_required. Accept a rebuttal when the evidence holds; do not repeat a finding just to win. New findings are allowed only for problems introduced by the latest changes or that you genuinely missed.\n\n${rows.join('\n')}`;
  }

  private savePlan(plan: S.Plan): S.Plan {
    plan = this.withGrillDecisions(plan);
    this.state.plan = plan;
    // same entries as decisions.md, so the two can't disagree
    const grill = plan.calls.map((c, i) => `${i + 1}. ${callLines(c, '   ', this.decidedBy(c))}`).join('\n\n') || 'None: recon settled everything.';
    const asked = plan.questions.map((q) => `- **For ${q.audience}:** ${q.question} (recommended: ${q.recommendation})`).join('\n');
    writeText(this.file('plan.md'), `${plan.plan_markdown.trim()}\n\n## Decisions taken during the grill phase\n\n${grill}\n${asked ? `\n## Blockers sent to a person\n\n${asked}\n` : ''}`);
    writeJson(this.file('plan.json'), plan);
    this.save();
    return plan;
  }

  private saveReview(name: string, review: S.Review): void {
    const md = [
      `# ${name}: ${review.verdict}`,
      review.summary,
      ...review.findings.map((f) => `## ${f.id} [${f.severity}${f.required ? ', required' : ''}] ${f.title}\n${f.location}\n\n${f.detail}`),
    ].join('\n\n');
    writeText(this.file('reviews', `${name}.md`), md);
  }

  private commitMessage(repoKey: string, summary: string, type?: string): string {
    let format = this.repoCfg(repoKey).commit_format;
    if (type) format = format.replace(/^[a-z]+(?=\()/, type);
    return fill(format, { key: this.state.key, summary: summary.trim().replace(/\.$/, '') });
  }

  // ---------------------------------------------------------------- repos and gates

  private async baselineFor(key: string, cwd: string, sha: string): Promise<Baseline> {
    const cache = path.join(this.dir, '..', '_baselines', `${key}-${sha}.json`);
    if (fs.existsSync(cache)) return readJson<Baseline>(cache);
    log(`  computing test baseline for ${key} at ${sha.slice(0, 8)} (one-off, cached)`);
    const baseline = await computeBaseline(this.repoCfg(key), cwd, this.file('gates', `baseline-${key}`));
    writeJson(cache, baseline);
    return baseline;
  }

  async ensureRepo(key: string): Promise<void> {
    if (this.state.repos[key]) return;
    const repo = this.repoCfg(key);
    const source = repoPath(this.config, key);
    const replay = this.state.replay;
    // lowercase matches the team's own branch names (scrum-524)
    const branch = replay ? `replay/${this.state.key}` : this.state.key.toLowerCase();
    const worktree = path.join(this.root, key);
    log(`preparing ${key} worktree`);
    const { base } = await g.ensureWorktree({
      repoPath: source,
      worktreePath: worktree,
      branch,
      base: replay ? replay.base : `origin/${repo.target_branch}`,
      fetchBranch: replay ? undefined : repo.target_branch,
    });
    await g.linkDependencies(source, worktree, repo.install);
    const baseline = await this.baselineFor(key, worktree, base);
    this.state.repos[key] = { key, worktree, branch, base, baseline, commits: [] };
    this.save();
  }

  // the file part of guard(); also safe mid-rebase, where the commit check would break the rebase
  private async guardFiles(repoKey: string): Promise<void> {
    const repo = this.state.repos[repoKey];
    const secrets = await g.revertSecretEdits(repo.worktree);
    if (secrets.length) log(`  ${repo.key}: reverted edits to ${secrets.join(', ')}`);
    const cfg = this.repoCfg(repo.key);
    const kept = await g.revertProtectedEdits(repo.worktree, cfg.protected, this.state.allowEdit ?? [], cfg.kind.startsWith('backend'));
    if (kept.length) {
      log(`  ${repo.key}: undid edits to protected file(s): ${kept.join(', ')}`);
      this.note(`${repo.key}: the bot tried to edit protected file(s) ${kept.join(', ')}; the edits were undone`);
    }
  }

  private async guard(): Promise<void> {
    for (const repo of Object.values(this.state.repos)) {
      const expected = repo.commits.at(-1)?.sha ?? repo.base;
      if (await g.enforceHead(repo.worktree, expected)) log(`  ${repo.key}: an agent made a commit; undone, changes kept`);
      await this.guardFiles(repo.key);
    }
  }

  private async gates(key: string, kind: 'focused' | 'final', label: string): Promise<GateResult[]> {
    const repo = this.state.repos[key];
    const changed = kind === 'final'
      ? [...new Set([...(await g.filesChangedSince(repo.worktree, repo.base)), ...(await g.changedFiles(repo.worktree))])]
      : await g.changedFiles(repo.worktree);
    log(`  running ${kind} gates in ${key}`);
    const results = await runGates(this.repoCfg(key).gates[kind], repo.worktree, changed, repo.baseline, repo.base, this.file('gates', key), label);
    writeJson(this.file('gates', key, `${label}.result.json`), results);
    return results;
  }

  private async commit(key: string, message: string, chunk: string): Promise<void> {
    const repo = this.state.repos[key];
    const skipHooks = this.repoCfg(key).commit_hooks === 'skip';
    const result = await g.commitChanges(repo.worktree, message, skipHooks);
    if (!result) return;
    const note = `${key}: the repo's pre-commit hook was skipped (commit_hooks: skip); the orchestrator's gates ran instead`;
    if (skipHooks && !this.state.gateNotes.includes(note)) this.state.gateNotes.push(note);
    repo.commits.push({ sha: result.sha, message, chunk });
    log(`  committed ${key} ${result.sha.slice(0, 8)} ${message}`);
    this.save();
  }

  private async reposWithChanges(): Promise<string[]> {
    const keys: string[] = [];
    for (const repo of Object.values(this.state.repos)) {
      if ((await g.changedFiles(repo.worktree)).length) keys.push(repo.key);
    }
    return keys;
  }

  // ---------------------------------------------------------------- human questions

  private async mentions(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [role, person] of Object.entries(this.config.people)) {
      if (!person) continue;
      const id = person.jira_account_id ?? (person.email ? await this.jira.findAccountId(person.email) : undefined);
      if (id) out[role] = id;
    }
    try {
      out.developer = (await this.jira.myself()).accountId;
    } catch {
      // mentioning the developer is optional
    }
    return out;
  }

  // @role becomes a real mention when we know the account, otherwise the person's name
  private named(text: string, ids: Record<string, string>): string {
    return text.replace(/@(pm|tech_lead|developer)\b/g, (match, role: string) =>
      ids[role] ? match : (this.config.people[role as 'pm' | 'tech_lead']?.name ?? (role === 'developer' ? 'developer' : role)),
    );
  }

  private async ask(questions: S.Question[], resumePhase: Phase): Promise<never> {
    if (this.state.autoAnswer) {
      for (const q of questions) {
        this.state.assumptions.push(`Auto-answered ${q.id} (${q.audience}): ${q.question} → ${q.recommendation}`);
        this.decide('question', `${q.question} Went with: ${q.recommendation}`, q.why_unresolvable);
      }
      this.state.gateNotes.push(`${questions.length} question(s) auto-answered with the agent's recommendation`);
      this.save();
      throw new RetryPhase();
    }
    const typed = await this.askInTerminal(questions);
    if (typed) {
      // answered at the terminal: same path as a Jira answer, without the wait
      this.state.questions.pending = questions;
      this.state.questions.inbox.push(...typed);
      this.state.questions.askedAt = now();
      this.state.waitingFor = 'answers';
      this.state.resumePhase = resumePhase;
      this.state.phase = 'awaiting_answers';
      // a human answered, so this isn't the auto-answer loop the retry cap guards against
      this.state.retries = 0;
      this.save();
      throw new RetryPhase();
    }
    const body = [
      `**Agent needs ${questions.length} answer(s) before continuing ${this.state.key}.** Everything else was resolved from the ticket, spec and code.`,
      ...questions.map((q) => `**${q.id}** @${q.audience}: ${q.question}\nWhy it needs a human: ${q.why_unresolvable}\nRecommendation: ${q.recommendation}`),
      `Reply in a comment on this card (for example "${questions[0].id}: go with the recommendation"), or run \`agent answer ${this.state.key} "..."\`. The agent picks it up on the next \`agent run\` or \`agent watch\`.`,
    ].join('\n\n');
    this.state.questions.pending = questions;
    return this.pause('answers', body, resumePhase, `Waiting on ${questions.length} human answer(s).`);
  }

  // someone at the terminal answers right away; anyone else (agent watch, output to a file) gets the Jira comment
  private async askInTerminal(questions: S.Question[]): Promise<string[] | null> {
    if (!canPrompt()) return null;
    log(`the agent needs ${questions.length} answer(s)`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answers: string[] = [];
    try {
      for (const q of questions) {
        process.stderr.write(`\n${q.id} (@${q.audience}): ${q.question}\nWhy it needs a human: ${q.why_unresolvable}\nRecommendation: ${q.recommendation}\n`);
        const a = (await rl.question('Your answer (Enter = take the recommendation, "later" = ask on Jira instead): ')).trim();
        if (/^later$/i.test(a)) return null;
        answers.push(`Developer (terminal): ${q.id}: ${a || `go with the recommendation (${q.recommendation})`}`);
      }
    } finally {
      rl.close();
    }
    return answers;
  }

  // one way to stop and wait for a person: questions.md, run state, a Jira comment, then a clean stop
  private async pause(kind: 'answers' | 'design' | 'dependency' | 'grill', body: string, resumePhase: Phase, summary: string): Promise<never> {
    // grill questions are only asked at the terminal; everything else is written to questions.md
    if (kind !== 'grill') writeText(this.file('questions.md'), body);
    this.state.waitingFor = kind;
    this.state.questions.askedAt = now();
    this.state.resumePhase = resumePhase;
    this.state.phase = 'awaiting_answers';
    this.save();
    // grill questions are for the developer at this laptop, not for Jira
    if (this.state.jira && kind !== 'grill') {
      const ids = await this.mentions();
      const text = kind === 'answers' ? body : body.replace(/^\*\*/, '@developer **');
      this.state.questions.commentId = await this.jira.addComment(this.state.key, this.named(text, ids), ids);
      this.save();
    }
    throw new PipelineStop('waiting', kind === 'grill' ? summary : `${summary} See ${this.file('questions.md')}`);
  }

  // only an explicit go-ahead counts; "files coming tonight" is not one
  private saidExplicitly(answers: string[], pattern: RegExp): boolean {
    return answers.some((a) => pattern.test(a));
  }

  private async collectAnswers(): Promise<string[]> {
    const answers = [...this.state.questions.inbox];
    if (this.state.jira && this.state.questions.askedAt) {
      const since = Date.parse(this.state.questions.askedAt);
      for (const c of await this.jira.comments(this.state.key)) {
        if (Date.parse(c.created) > since && !isOurComment(c.text) && !this.state.processed.jiraComments.includes(c.id)) {
          answers.push(`${c.author}: ${c.text}`);
          this.state.processed.jiraComments.push(c.id);
        }
      }
    }
    return answers;
  }

  // ---------------------------------------------------------------- phases

  async intake(opts: StartOptions): Promise<void> {
    log(`intake ${this.state.key}`);
    let ticketText: string;
    let issue;
    if (opts.ticketFile) {
      ticketText = fs.readFileSync(opts.ticketFile, 'utf8');
    } else {
      issue = await this.jira.getIssue(this.state.key);
      ticketText = ticketMarkdown(issue);
    }
    this.state.summary = issue?.summary ?? ticketText.split('\n')[0].replace(/^#\s*/, '').slice(0, 120);
    this.state.issueType = issue?.type ?? (/type:\s*bug/i.test(ticketText) ? 'Bug' : undefined);
    this.state.reporterId = issue?.reporterId;
    if (!opts.fresh && (opts.parent || /bug/i.test(this.state.issueType ?? ''))) this.findParentRun(opts.parent, issue?.epic, issue?.links ?? [], ticketText);
    const inputs = await buildInputs({ dir: this.file('inputs'), key: this.state.key, ticketText, issue, jira: issue ? this.jira : undefined, specs: opts.specs, contexts: opts.contexts });
    this.state.inputs = { ticket: inputs.ticket, specs: inputs.specs, context: inputs.context, figma: path.join(inputs.dir, 'figma.md'), images: inputs.images };

    // a bug ticket moves only once it's confirmed; a "not a bug" leaves the card as QA left it
    if (this.state.jira && !this.state.parentRun) await this.startOnJira();
    const brief = findBrief(this.config, this.state.key);
    if (brief) {
      this.state.inputs.brief = path.join(inputs.dir, 'brief.md');
      if (path.resolve(brief) !== path.resolve(this.state.inputs.brief)) fs.copyFileSync(brief, this.state.inputs.brief);
      log(`  developer's brief: ${brief}`);
    }
    const sprintName = issue?.sprints.find((x) => x.state === 'active')?.name ?? issue?.sprints.at(-1)?.name;
    const advice = adviceFor(this.config, sprintName, this.state.key);
    if (advice) {
      this.state.inputs.advice = path.join(inputs.dir, 'sprint-advice.md');
      writeText(this.state.inputs.advice, advice.text);
      log(`  sprint plan advice found for ${this.state.key}`);
    }
    if (!this.state.replay) await this.fetchAll();
    log('  reading the sprint and connected tickets');
    this.state.context = await buildSprintContext({
      config: this.config,
      jira: issue ? this.jira : undefined,
      gitlab: this.optionalGitlab(),
      issue,
      key: this.state.key,
      ticketText,
      relatedDir: this.file('inputs', 'related'),
      forcedRelated: [...(opts.related ?? []), ...(advice?.keys ?? []), ...(this.state.parentRun ? [this.state.parentRun.key] : [])],
      ownRuns: listRuns(this.config).filter((r) => r.key !== this.state.key).map((r) => ({ key: r.key, branches: Object.fromEntries(Object.values(r.repos).map((x) => [x.key, x.branch])) })),
    });
    if (this.state.context.sprintFile) log(`  sprint map: ${this.state.context.sprintFile} (${this.state.context.related.length} connected ticket(s) fetched)`);
    const repos = opts.replay ? [opts.replay.repo] : opts.repos?.length ? opts.repos : this.inferRepos(ticketText, issue?.labels ?? []);
    for (const key of repos) await this.ensureRepo(key);
    this.state.phase = 'planning';
    this.save();
  }

  inferRepos(text: string, labels: string[]): string[] {
    const fromLabels = labels.filter((l) => l.startsWith('repo:')).map((l) => l.slice(5)).filter((k) => this.config.repos[k]);
    if (fromLabels.length) return fromLabels;
    const lower = text.toLowerCase();
    const title = lower.split('\n')[0];
    const fe = /\bfrontend\b|\bfe\b/.test(title) || labels.some((l) => /^(fe|frontend)$/i.test(l));
    const be = /\bbackend\b|\bbe\b/.test(title) || labels.some((l) => /^(be|backend)$/i.test(l));
    const out = new Set<string>();
    if (fe || !be) this.config.routing.frontend.forEach((k) => out.add(k));
    if (be) {
      this.config.routing.backend.forEach((k) => out.add(k));
      const services = Object.entries(this.config.repos)
        .filter(([, r]) => r.kind === 'backend-service')
        .map(([k, r]) => [k, r.hints.filter((h) => lower.includes(h.toLowerCase())).length] as const)
        .sort((a, b) => b[1] - a[1]);
      if (services[0]?.[1]) out.add(services[0][0]);
    }
    return [...out].filter((k) => this.config.repos[k]?.path);
  }

  // design material for the plan: developer folder, saved Figma files, or Figma MCP
  private async startOnJira(): Promise<void> {
    await this.jira.transition(this.state.key, this.config.jira.statuses.in_development);
    await this.jira.addComment(this.state.key, `Agent run started for ${this.state.key}.\nRun alias: ${this.state.key}-dev\nModels: ${Object.entries(this.state.models).map(([r, m]) => `${r} ${m.provider}${m.model ? ':' + m.model : ''}`).join(', ')}`);
  }

  // confirm-first for a bug ticket; false = not a real bug, the reporter got a reply and the run is done
  private async confirmBug(): Promise<boolean> {
    const parent = this.state.parentRun!.key;
    log(`  confirming the bug first`);
    const t = await this.call('dev', 'bug-triage', render(prompt('bug-triage'), { rules: this.devRules(), key: this.state.key, parent }), S.BugTriage, 'read');
    let real = t.verdict === 'bug';
    if (!real) {
      // dismissing a QA bug is the costly mistake, so the reviewer checks before anything is posted
      const c = await this.call('reviewer', 'bug-triage-check', render(prompt('bug-triage-check'), {
        rules: this.reviewerRules(), key: this.state.key, parent, verdict: t.verdict.replaceAll('_', ' '), cause: t.cause, reply: t.reply,
      }), S.TriageCheck, 'read');
      if (!c.agree) {
        real = true;
        this.decide('bug', `Treated as a real bug: the reviewer disagreed with "${t.verdict.replaceAll('_', ' ')}"`, c.reason);
      }
    }
    this.state.bugTriage = { verdict: real ? 'bug' : t.verdict, cause: t.cause };
    if (real) {
      if (this.state.jira) await this.startOnJira();
      this.decide('bug', `Confirmed a real bug in ${parent}`, t.cause);
      this.state.assumptions.push(`Bug confirmed in ${parent}: ${t.cause}`);
      log(`  confirmed: ${t.cause}`);
      this.save();
      return true;
    }
    if (this.state.jira) {
      // the reporter always hears back, even if the bot left its reply empty
      const fallback: Record<string, string> = {
        not_a_bug: 'I looked into this and it works the way the ticket describes. Could you check the expected behaviour on the original ticket?',
        data_issue: 'I looked into this and the code looks right; it seems to be the data or setup. Could you try with a different record?',
        needs_info: "I looked into this and couldn't confirm it's a bug yet. Could you share the exact steps or a screenshot?",
      };
      const reply = t.reply.trim() || fallback[t.verdict] || fallback.needs_info;
      const ids: Record<string, string> = this.state.reporterId ? { reporter: this.state.reporterId } : {};
      await this.jira.addComment(this.state.key, `${ids.reporter ? '@reporter ' : ''}${reply}`, ids);
    }
    this.decide('bug', `Not a real bug (${t.verdict.replaceAll('_', ' ')}); replied on the card, no code changed`, t.cause);
    this.state.phase = 'done';
    this.save();
    log(`  not a real bug (${t.verdict.replaceAll('_', ' ')}): ${t.cause}`);
    log(`  replied on ${this.state.key}; nothing to fix, no MR`);
    return false;
  }

  // the story isn't merged yet: ask where the fix goes (its branch, or develop) before planning
  private async askWhereBugGoes(): Promise<void> {
    const parent = this.state.parentRun!.key;
    const q: S.Question = {
      id: 'B1', audience: 'developer', blocking: true,
      question: `${this.state.key} is a bug in ${parent}, which isn't merged yet. Build the fix on ${parent}'s branch, or start from develop?`,
      why_unresolvable: `${parent} is still open, so the fix either stacks on it or may conflict with it`,
      recommendation: `build on ${parent}`,
    };
    // replays and --auto-answer take the recommendation, like every other question
    const typed = this.state.autoAnswer ? [`auto-answered: ${q.recommendation}`] : await this.askInTerminal([q]);
    if (typed) {
      if (/develop|development|fresh/i.test(typed[0]) && !/build on/i.test(typed[0])) this.state.skipDependencies = true;
      else this.state.baseOverride = parent;
      this.decide('human', `Fix goes ${this.state.skipDependencies ? 'from develop' : `on ${parent}'s branch`}`, typed[0], true);
      this.save();
      return;
    }
    this.state.pendingDependency = { repo: '', tickets: [parent], problem: 'bug_base' };
    await this.pause('dependency', [
      `**${this.state.key} is a bug in ${parent}, which isn't merged yet.** Where should the fix go?`,
      `Reply "build on ${parent}" to put it on top of ${parent}'s branch, or "continue from develop" to start from develop. Then run \`agent run ${this.state.key}\`.`,
    ].join('\n\n'), 'planning', `Waiting: ${parent} isn't merged yet.`);
  }

  // a bug ticket in a story this laptop built: start from copies of that story's conversations
  private findParentRun(named: string | undefined, jiraParent: string | undefined, links: string[], text: string): void {
    // order of trust: --parent, the bug's Jira parent (a sub-task of the story), its links, keys mentioned in it
    const candidates = named ? [named] : [...new Set([jiraParent, ...links, ...mentionedKeys(text, this.state.key)].filter((k): k is string => Boolean(k)))];
    const built = candidates.filter((k) => k !== this.state.key && hasRun(this.config, k) && loadState(this.config, k).devSession);
    if (!built.length) {
      log(named ? `  --parent ${named}: no run of it on this laptop, so starting fresh` : '  bug ticket: no story built on this laptop is linked, so starting fresh');
      return;
    }
    const key = built[0];
    const p = loadState(this.config, key);
    const dev = this.state.models.dev, rev = this.state.models.reviewer;
    let devFork = p.devSession!.provider === dev.provider ? p.devSession!.id : undefined;
    // Claude finds conversations by working folder: copy the story's into this run's folder so the bug run works from its own
    if (devFork && dev.provider === 'claude') {
      const from = claudeSessionFile(Run.load(this.config, key).root, devFork);
      if (fs.existsSync(from)) {
        const to = claudeSessionFile(this.root, devFork);
        ensureDir(path.dirname(to));
        if (!fs.existsSync(to)) fs.copyFileSync(from, to);
      } else devFork = undefined;
    }
    this.state.parentRun = {
      key,
      merged: p.phase === 'done' && !p.gateNotes.some((n) => n.startsWith('MR closed without merge')),
      devFork,
      reviewerFork: p.reviewerSession?.provider === rev.provider ? p.reviewerSession.id : undefined,
    };
    const others = built.slice(1);
    log(`  bug in ${key}: starting from ${devFork ? `${key}'s conversations` : 'scratch (its conversation was not found)'}${this.state.parentRun.merged ? '' : ` (${key} isn't merged yet)`}`);
    if (others.length) log(`  also linked and built here: ${others.join(', ')}; use --parent to pick another`);
    this.decide('bug', `Treated as a bug in ${key}`, named ? 'named with --parent' : jiraParent === key ? 'its Jira parent' : 'linked or mentioned in the bug ticket', true);
  }

  private async prepareDesign(): Promise<void> {
    const ticketText = fs.readFileSync(this.state.inputs!.ticket, 'utf8');
    const design = await prepareDesign(this.config, this.state.key, this.file('inputs'), ticketText, Boolean(this.state.designSkipped));
    this.state.design = design;
    log(`  design: ${design.mode}${design.links.length ? ` (${design.links.length} Figma link(s), MCP ${design.mcp})` : ''}`);
    if (design.mode === 'skipped') {
      this.note('UI was built without Figma: it could not be reached and the developer chose to continue');
      this.decide('design', 'Built the UI without the Figma design', 'Figma could not be reached and the developer said to continue without it');
    }
    this.save();
    if (design.mode === 'unavailable') await this.waitForDesign();
  }

  // decisions.md; the handoff picks the MR's "worth a second look" from the non-note entries
  private decide(where: string, decision: string, why: string, note = false, call?: S.Call, by?: 'you' | 'agent'): void {
    const list = (this.state.decisions ??= []);
    if (list.some((d) => d.decision === decision)) return;
    list.push({ at: now(), where, decision, why, note, call, by });
    writeText(this.file('decisions.md'), `# Decisions for ${this.state.key}\n\n${this.decisionLines(false) || '- none'}\n\n## Other notes\n\n${this.decisionLines(true) || '- none'}`);
  }

  private decisionLines(note: boolean): string {
    return (this.state.decisions ?? [])
      .filter((d) => Boolean(d.note) === note)
      .map((d) => (d.call ? `- **[${d.where}]** ${callLines(d.call, '  ', d.by === 'you' ? 'you' : this.decidedBy(d.call))}` : `- **[${d.where}]** ${d.decision}${d.why ? `\n  Why: ${d.why}` : ''}`))
      .join('\n');
  }

  // what a dev would raise with the lead before building; the run keeps going on the stated assumption
  private async postGaps(gaps: S.Gap[]): Promise<void> {
    for (const g of gaps) this.decide('gap', `${g.what} Going ahead assuming: ${g.assumption}`, g.alternative ? `fallback: ${g.alternative}` : 'raised with the lead');
    const already = new Set(this.state.gapsPosted ?? []);
    gaps = gaps.filter((g) => !already.has(g.what.trim()));
    if (!gaps.length || !this.state.jira) return;
    const ids = await this.mentions();
    const line = (g: S.Gap) => `- ${g.what.trim()} Going ahead assuming ${g.assumption.trim().replace(/\.$/, '')}.${g.alternative.trim() ? ` If not, ${g.alternative.trim()}` : ''}`;
    const intro = gaps.length === 1 ? '@tech_lead quick one before I build this:' : '@tech_lead a few things to sort out for this ticket:';
    await this.jira.addComment(this.state.key, this.named(`${intro}\n${gaps.map(line).join('\n')}`, ids), ids);
    // the other ticket gets a short pointer too, so whoever picks it up sees it
    const others = new Map<string, S.Gap[]>();
    for (const g of gaps) {
      const key = g.ticket.trim().toUpperCase();
      if (/^[A-Z][A-Z0-9]+-\d+$/.test(key) && key !== this.state.key) others.set(key, [...(others.get(key) ?? []), g]);
    }
    for (const [key, list] of others) {
      try {
        await this.jira.addComment(key, this.named(`@tech_lead heads up from ${this.state.key}:\n${list.map((g) => `- ${g.what.trim()}`).join('\n')}`, ids), ids);
      } catch (err) {
        log(`  could not comment on ${key}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    this.state.gapsPosted = [...already, ...gaps.map((g) => g.what.trim())];
    this.save();
    log(`  raised ${gaps.length} gap(s) with the lead on Jira`);
  }

  private logCalls(where: string, calls: S.Call[]): void {
    for (const c of calls) this.decide(where, `${c.question} Chose: ${c.chosen}`, c.why, false, c, this.state.grill?.answers[c.question]?.by ?? 'agent');
  }

  private decidedBy(c: S.Call): string {
    const a = this.state.grill?.answers[c.question];
    if (a?.by === 'you') return 'you';
    return a?.limit ? 'the agent (the follow-up limit was reached)' : 'the agent';
  }

  // --ask: recon and the grill come first; the developer answers every open decision, and follow-ups to those
  // answers, before any plan is written
  private async grillPhase(): Promise<void> {
    const grill = (this.state.grill ??= { answers: {} });
    if (!grill.calls) {
      const r = await this.call('dev', 'grill', render(prompt('grill'), { rules: this.devRules(), design: this.designStep(true) }), S.Grill, 'read');
      grill.calls = r.calls;
      grill.round = 0;
      this.save();
    }
    const rounds = this.config.limits.grill_rounds;
    for (;;) {
      const open = grill.calls!.filter((c) => !grill.answers[c.question]);
      if (!open.length) break;
      // the first round is the grill itself; up to `rounds` follow-up rounds come after it
      if (grill.round! > rounds) {
        // out of follow-up rounds: the agent takes its recommendation and says so
        for (const c of open) {
          c.why = `${c.why.trim().replace(/[^.!?]$/, '$&.')} Would have asked you; the follow-up limit (${rounds}) was reached.`;
          grill.answers[c.question] = { chosen: c.chosen, by: 'agent', limit: true };
        }
        break;
      }
      const answers = await this.askDeveloper(open, 'grill');
      Object.assign(grill.answers, answers);
      grill.round! += 1;
      this.state.humanTouches += 1;
      this.save();
      const changed = open.filter((c) => answers[c.question].by === 'you' && answers[c.question].chosen !== c.recommended);
      if (!changed.length) break;
      const r = await this.call('dev', `grill-followup-${grill.round}`, render(prompt('grill-followup'), {
        answers: changed.map((c) => `- ${c.question}\n  You recommended: ${c.recommended}\n  The developer chose: ${answers[c.question].chosen}`).join('\n'),
      }), S.Grill, 'read');
      grill.calls!.push(...r.calls.filter((c) => !grill.calls!.some((x) => x.question === c.question)));
      this.save();
    }
    grill.done = true;
    this.save();
  }

  // the plan always carries every grill decision with its final answer, whatever the dev agent wrote
  private withGrillDecisions(plan: S.Plan): S.Plan {
    const grill = this.state.grill;
    if (!grill?.calls) return plan;
    const asked = grill.calls.map((g) => {
      const own = plan.calls.find((c) => c.question === g.question);
      const a = grill.answers[g.question];
      if (own) return { ...own, chosen: a?.chosen ?? own.chosen };
      if (a?.by === 'you' && a.chosen !== g.recommended) return { ...g, chosen: a.chosen, why: `You chose this. The agent had recommended ${g.recommended} because: ${g.why.trim()}` };
      return { ...g, chosen: a?.chosen ?? g.chosen };
    });
    return { ...plan, calls: [...asked, ...plan.calls.filter((c) => !grill.calls!.some((g) => g.question === c.question))] };
  }

  // after the grill, a new decision nothing can settle is asked of the developer only with --ask; hard blockers for the PM or lead always are
  private askRule(): string {
    return this.state.askGrill
      ? "Raise a question only when neither the sources nor the developer's answers can settle it and it changes what gets built: audience `developer`, `blocking: true`, and say exactly why in `why_unresolvable`. A hard blocker only the PM or tech lead can answer goes to them, as usual."
      : 'Settle it with your recommendation and record it in `calls`; never ask the developer. A hard blocker only the PM or tech lead can answer goes to them, as usual.';
  }

  private async applyDeveloperChoices(plan: S.Plan, lines: string[]): Promise<S.Plan> {
    if (!lines.length) return plan;
    const next = await this.call('dev', `grill-answers-${(this.state.ledger ?? []).length}`, render(prompt('grill-answers'), { answers: lines.join('\n'), askRule: this.askRule() }), S.Plan, 'read');
    return this.savePlan(next);
  }

  // a reviewer finding titled "Developer decision <n>: …" challenges your answer to grill decision n. One you
  // already kept is settled: it goes to nobody.
  private challengesIn(review: S.Review, plan: S.Plan): { challenges: Challenge[]; settled: string[] } {
    const challenges: Challenge[] = [];
    const settled: string[] = [];
    if (!this.state.askGrill) return { challenges, settled };
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const f of review.findings) {
      const m = f.title.match(/^\s*developer decision\s*#?(\d+)?\s*:\s*(.*)$/i);
      if (!m) continue;
      const c = m[1] ? plan.calls[Number(m[1]) - 1] : plan.calls.find((x) => norm(x.question) === norm(m[2]));
      if (!c || this.state.grill?.answers[c.question]?.by !== 'you') continue;
      if (this.state.grill?.kept?.includes(c.question)) settled.push(f.id);
      else challenges.push({ finding: f.id, question: c.question, reason: f.detail.trim() });
    }
    return { challenges, settled };
  }

  // the developer, not the dev agent, settles a challenge to their own decision: keep it, or switch
  private async resolveChallenges(plan: S.Plan): Promise<S.Plan> {
    const grill = this.state.grill!;
    // asked like a grill question, with your current choice standing in for the recommendation
    const items = (grill.challenges ?? []).map((ch) => {
      const current = grill.answers[ch.question].chosen;
      const options = plan.calls.find((c) => c.question === ch.question)?.options ?? [];
      return { question: ch.question, options, recommended: current, chosen: current, why: ch.reason };
    });
    if (!items.length) return plan;
    const answers = await this.askDeveloper(items, 'challenge');
    const switched: string[] = [];
    for (const it of items) {
      const a = answers[it.question];
      if (a.by === 'you' && a.chosen !== it.chosen) {
        grill.answers[it.question] = a;
        switched.push(`- ${it.question}\n  The developer first chose: ${it.chosen}\n  After the reviewer's challenge, they chose: ${a.chosen}`);
      } else {
        grill.kept = [...new Set([...(grill.kept ?? []), it.question])];
        this.decide('plan review', `Kept despite the reviewer: ${it.question} → ${it.chosen}`, it.why);
      }
    }
    grill.challenges = undefined;
    this.state.humanTouches += 1;
    this.save();
    return this.applyDeveloperChoices(plan, switched);
  }

  private async askDeveloper(items: S.Call[], kind: GrillKind): Promise<Record<string, GrillAnswer>> {
    if (canPrompt()) return this.askInTerminalOneByOne(items, kind);
    // nobody at the terminal (agent watch, output to a file): stop until the developer runs it at one
    const what = ASKING[kind].what(items.length);
    return this.pause('grill', '', 'planning', `${what[0].toUpperCase()}${what.slice(1)} waiting for you: run \`agent run ${this.state.key}\` at a terminal to answer them.`);
  }

  // the /grill-me experience: one question at a time
  private async askInTerminalOneByOne(items: S.Call[], kind: GrillKind): Promise<Record<string, GrillAnswer>> {
    log(`${ASKING[kind].what(items.length)} for you`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answers: Record<string, GrillAnswer> = {};
    let restToAgent = false;
    try {
      for (const [i, c] of items.entries()) {
        if (restToAgent) {
          answers[c.question] = { chosen: c.chosen, by: 'agent' };
          continue;
        }
        process.stderr.write(`\n${grillQuestion(this.state.key, c, i + 1, items.length, kind)}\n`);
        const typed = (await rl.question(`Your answer [${ASKING[kind].hint(c.options.length)}]: `)).trim();
        if (kind === 'grill' && /^auto all$/i.test(typed)) restToAgent = true;
        answers[c.question] = readGrillAnswer(typed || recommendedLetter(c), c, kind) ?? { chosen: c.chosen, by: 'agent' };
      }
    } finally {
      rl.close();
    }
    return answers;
  }

  // the dev agent pushed back on reviewer findings; those are decisions too
  private logRejections(where: string, findings: S.Finding[], responses: S.FindingResponse[]): void {
    for (const r of responses) {
      const f = findings.find((x) => x.id === r.finding_id);
      if (f && r.decision === 'reject') this.decide(where, `Kept it as is despite the reviewer: ${f.title}`, r.reasoning);
    }
  }

  private note(text: string): void {
    if (!this.state.gateNotes.includes(text)) this.state.gateNotes.push(text);
  }

  private async waitForDesign(): Promise<never> {
    const folder = ensureDir(designDropDir(this.config, this.state.key));
    // the plan is redone with the design, in the same dev session
    this.state.plan = undefined;
    return this.pause('design', designWaitMessage(this.state.key, folder, this.state.design?.mcp ?? 'missing'), 'planning', `Waiting for design files in ${folder} (or "continue without design").`);
  }

  async planning(): Promise<void> {
    log('planning');
    if (this.state.parentRun && !this.state.bugTriage && !(await this.confirmBug())) return;
    if (this.state.parentRun && !this.state.parentRun.merged && !this.state.baseOverride && !this.state.skipDependencies) await this.askWhereBugGoes();
    if (!this.state.plan) await this.prepareDesign();
    if (this.state.askGrill && !this.state.plan && !this.state.grill?.done) await this.grillPhase();
    let plan = this.state.plan ?? (await this.call('dev', 'plan', render(prompt('plan'), { rules: this.devRules(), design: this.designStep(), grillMode: this.state.askGrill ? ASK_MODE : '' }), S.Plan, 'read'));
    if (plan.design_status === 'unavailable' && this.state.design?.mode === 'mcp') {
      log('  Figma MCP failed during planning');
      if (this.state.design) this.state.design.mode = 'unavailable';
      await this.waitForDesign();
    }
    plan = this.savePlan(plan);
    if (this.state.grill?.challenges?.length) plan = await this.resolveChallenges(plan);
    let previous = '';
    const rounds = this.config.limits.review_rounds;
    for (let round = 1; round <= rounds; round++) {
      const review = await this.call('reviewer', `plan-review-${round}`, render(prompt('review-plan'), { rules: this.reviewerRules(), previous }), S.Review, 'read');
      this.saveReview(`plan-review-${round}`, review);
      for (const qa of review.question_assessments) {
        const q = plan.questions.find((x) => x.id === qa.question_id);
        if (q && !qa.needs_human) {
          this.state.assumptions.push(`${q.id} resolved by reviewer: ${q.question} → ${qa.suggested_resolution}`);
          this.decide('question', `${q.question} Went with: ${qa.suggested_resolution}`, 'resolvable from the code and spec, so no human was asked');
          plan.questions = plan.questions.filter((x) => x.id !== q.id);
        }
      }
      if (review.verdict === 'needs_human' && review.human_question) {
        plan.questions.push({ id: `R${round}`, audience: 'tech_lead', question: review.human_question, why_unresolvable: review.summary, recommendation: 'See the plan review', blocking: true });
        break;
      }
      // challenges to the developer's own decisions go to the developer; the rest go to the dev agent
      const { challenges, settled } = this.challengesIn(review, plan);
      let youChanged = false;
      if (challenges.length) {
        const before = JSON.stringify(plan.calls);
        this.state.grill!.challenges = challenges;
        plan = await this.resolveChallenges(plan);
        youChanged = JSON.stringify(plan.calls) !== before;
      }
      const forDev = { ...review, findings: review.findings.filter((f) => !settled.includes(f.id) && !challenges.some((c) => c.finding === f.id)) };
      // the reviewer's recap: challenges to the developer's decisions were answered by the developer, not the Dev Agent
      const answered = [...challenges.map((c) => c.finding), ...settled].map((id) => {
        const f = review.findings.find((x) => x.id === id)!;
        const q = challenges.find((c) => c.finding === id)?.question;
        return `- ${f.id} ${f.title}\n  The developer: ${q && !this.state.grill?.kept?.includes(q) ? 'switched their decision; check the updated plan' : 'kept their decision; settled'}`;
      });
      const required = forDev.findings.filter((f) => f.required);
      if ((review.verdict === 'approved' || !required.length) && !youChanged) break;
      if (round === rounds) {
        const responses = plan.responses;
        for (const f of required) this.state.disagreements.push({ where: 'plan', finding: f, devReasoning: responses.find((r) => r.finding_id === f.id)?.reasoning ?? '' });
        break;
      }
      // only your own switch changed the plan: the reviewer checks it again
      if (!required.length) {
        previous = this.previous(forDev, [], answered);
        continue;
      }
      plan = await this.call('dev', `plan-revise-${round}`, render(prompt('plan-revise'), { review: json(forDev), askRule: this.askRule() }), S.Plan, 'read');
      this.logRejections('plan review', forDev.findings, plan.responses);
      plan = this.savePlan(plan);
      previous = this.previous(forDev, plan.responses, answered);
    }
    // a replay is scored on one repo; its base commit only exists there
    const replayRepo = this.state.replay?.repo;
    if (replayRepo && plan.repos.some((r) => r.key !== replayRepo)) {
      const dropped = plan.chunks.filter((c) => c.repo !== replayRepo);
      if (dropped.length) this.state.gateNotes.push(`Replay: skipped ${dropped.length} chunk(s) outside ${replayRepo}: ${dropped.map((c) => c.title).join('; ')}`);
      plan.repos = plan.repos.filter((r) => r.key === replayRepo);
      plan.chunks = plan.chunks.filter((c) => c.repo === replayRepo);
    }
    plan = this.savePlan(plan);

    for (const r of plan.repos) {
      if (!this.config.repos[r.key]) throw new PipelineStop('failed', `Plan uses unknown repo '${r.key}'`);
      await this.ensureRepo(r.key);
    }
    for (const chunk of plan.chunks) {
      if (!this.state.repos[chunk.repo]) throw new PipelineStop('failed', `Chunk ${chunk.id} targets repo '${chunk.repo}' that is not in the plan`);
    }
    for (const q of plan.questions.filter((q) => !q.blocking)) {
      this.state.assumptions.push(`${q.id} (${q.audience}, non-blocking): ${q.question} → went with: ${q.recommendation}`);
      this.decide('question', `${q.question} Went with: ${q.recommendation}`, q.why_unresolvable);
    }
    this.logCalls('plan', plan.calls);
    await this.postGaps(plan.gaps ?? []);
    const blocking = plan.questions.filter((q) => q.blocking);
    this.state.phase = 'implementing';
    this.save();
    if (blocking.length) await this.ask(blocking, 'implementing');
  }

  async awaitingAnswers(): Promise<void> {
    if (this.state.waitingFor === 'grill') {
      // back to planning, which asks the open grill questions again (or reads the filled-in file)
      this.state.waitingFor = undefined;
      this.state.phase = 'planning';
      this.save();
      return;
    }
    if (this.state.waitingFor === 'design') {
      const answers = await this.collectAnswers();
      const folders = findDesignFolders(this.config, this.state.key);
      // only an explicit go-ahead skips the design; "files coming tonight" keeps waiting
      const skip = this.saidExplicitly(answers, /(continue|go|proceed|build)\s+without\s+(the\s+)?(design|figma)|skip\s+(the\s+)?(design|figma)/i);
      if (!folders.length && !skip) {
        this.state.questions.inbox = [];
        this.save();
        throw new PipelineStop('waiting', `Still waiting for design files in ${designDropDir(this.config, this.state.key)} (or "continue without design").`);
      }
      this.state.designSkipped = !folders.length;
      log(folders.length ? `design files found in ${folders.join(', ')}` : 'continuing without design');
      this.state.humanTouches += 1;
      this.state.questions.inbox = [];
      this.state.waitingFor = undefined;
      this.state.phase = 'planning';
      this.save();
      return;
    }
    if (this.state.waitingFor === 'dependency') {
      const pending = this.state.pendingDependency!;
      const answers = await this.collectAnswers();
      const chosen = answers.join(' ').match(/build on ([A-Za-z][A-Za-z0-9]+-\d+)/i)?.[1]?.toUpperCase();
      if (this.saidExplicitly(answers, /(continue|go|proceed|build|branch)\s+(from|on)\s+(develop|development|the target)|skip\s+(the\s+)?dependenc/i)) {
        this.state.skipDependencies = true;
      } else if (chosen) {
        this.state.baseOverride = chosen;
      } else if (pending.problem === 'two_parents' || pending.problem === 'bug_base' || !(await this.branchFor(pending.tickets[0], pending.repo))) {
        this.state.questions.inbox = [];
        this.save();
        throw new PipelineStop('waiting', `Still waiting: ${pending.tickets.join(' / ')} (see ${this.file('questions.md')}).`);
      }
      this.state.humanTouches += 1;
      this.state.questions.inbox = [];
      this.state.waitingFor = undefined;
      this.state.pendingDependency = undefined;
      // a bug ticket asks before planning; everything else asks right before building
      this.state.phase = this.state.resumePhase === 'planning' ? 'planning' : 'implementing';
      this.save();
      return;
    }
    const answers = await this.collectAnswers();
    if (!answers.length) throw new PipelineStop('waiting', `Still waiting on answers. See ${this.file('questions.md')}`);
    log(`received ${answers.length} answer(s)`);
    this.state.humanTouches += 1;
    this.state.questions.answers.push(...answers);
    for (const a of answers) this.decide('human', `Followed the answer: ${a}`, 'asked because the sources could not settle it', true);
    this.state.questions.inbox = [];
    if (this.state.plan && this.state.resumePhase === 'implementing' && this.state.nextChunk === 0) {
      const plan = await this.call('dev', `answers-${this.state.ledger.length}`, render(prompt('answers'), { questions: json(this.state.questions.pending), answers: answers.map((a) => `- ${a}`).join('\n') }), S.Plan, 'read');
      this.savePlan(plan);
    }
    this.state.questions.pending = [];
    this.state.phase = this.state.resumePhase ?? 'implementing';
    this.save();
  }

  async implementing(): Promise<void> {
    if (!this.state.depsResolved) await this.resolveDependencies();
    const plan = this.state.plan!;
    for (let i = this.state.nextChunk; i < plan.chunks.length; i++) {
      await this.runChunk(plan.chunks[i]);
      this.state.nextChunk = i + 1;
      this.save();
    }
    this.state.phase = 'finalizing';
    this.save();
  }

  private async runChunk(chunk: S.Chunk): Promise<void> {
    log(`chunk ${chunk.id}: ${chunk.title} (${chunk.repo})`);
    const repo = this.state.repos[chunk.repo];
    const workFile = this.file('chunks', `${chunk.id}-work.json`);
    let work: S.DevWork;
    if ((await g.changedFiles(repo.worktree)).length && fs.existsSync(workFile)) {
      log('  resuming from the existing uncommitted diff');
      work = readJson<S.DevWork>(workFile);
    } else {
      const testsRule = chunk.is_tests_chunk
        ? 'This is the tests chunk. Match the existing suites in this area file for file, cover the behaviour this ticket added or changed, and keep coverage comparable to sibling features rather than exhaustive.'
        : 'This is not the tests chunk. Do not add or edit test files here.';
      work = await this.call('dev', `chunk-${chunk.id}`, render(prompt('chunk'), { chunkId: chunk.id, repo: chunk.repo, worktree: repo.worktree, chunk: json(chunk), answers: '', testsRule }), S.DevWork, 'write');
    }
    writeJson(workFile, work);
    await this.guard();
    // approved earlier but the commit failed (hook, crash): commit without re-reviewing
    const approvedFile = this.file('chunks', `${chunk.id}-approved`);
    if (fs.existsSync(approvedFile) && (await g.changedFiles(repo.worktree)).length) {
      log('  already approved, committing');
      await this.commitChunk(chunk, work);
      return;
    }
    if (!(await g.changedFiles(repo.worktree)).length) {
      this.state.gateNotes.push(`Chunk ${chunk.id} produced no changes (${work.summary.slice(0, 200)})`);
      log('  no changes in this chunk, skipping commit');
      return;
    }

    // gate failures the dev showed are intended behaviour changes, fixed later in the tests chunk;
    // kept across chunks so the dev does not have to justify the same failure again
    this.state.expectedFailures ??= {};
    const carried = (this.state.expectedFailures[chunk.repo] ??= {});
    const expected = new Map<string, string>(chunk.is_tests_chunk ? [] : Object.entries(carried));
    const effective = (results: GateResult[]) =>
      results.map((r) => ({ ...r, failures: chunk.is_tests_chunk ? r.failures : r.failures.filter((f) => !expected.has(f)) })).map((r) => ({ ...r, ok: r.failures.length === 0 }));

    let results = effective(await this.gates(chunk.repo, 'focused', `chunk-${chunk.id}-0`));
    let previous = '';
    const rounds = this.config.limits.review_rounds;
    for (let round = 1; round <= rounds; round++) {
      for (let attempt = 1; !gatesOk(results) && attempt <= this.config.limits.gate_fix_attempts; attempt++) {
        const fix = await this.call('dev', `chunk-${chunk.id}-gatefix-${round}-${attempt}`, render(prompt('chunk-fix'), { chunkId: chunk.id, repo: chunk.repo, gates: `## Gate failures\n\n${gateFailureDetail(results)}`, review: '' }), S.DevWork, 'write');
        work = fix;
        for (const r of fix.responses) if (r.decision === 'reject') expected.set(r.finding_id, r.reasoning);
        await this.guard();
        results = effective(await this.gates(chunk.repo, 'focused', `chunk-${chunk.id}-${round}-${attempt}`));
      }
      await g.prepareDiffForReview(repo.worktree);
      const testsNote = expected.size
        ? `The Dev Agent says these gate failures are intended behaviour changes that the tests chunk will update. Check that each claim holds:\n${[...expected].map(([f, why]) => `- ${f}: ${why}`).join('\n')}`
        : '';
      const review = await this.call('reviewer', `chunk-${chunk.id}-review-${round}`, render(prompt('review-chunk'), {
        rules: this.reviewerRules(), what: `chunk ${chunk.id}, ${chunk.title}`, repo: chunk.repo, worktree: repo.worktree,
        chunk: json(chunk), devReport: json(work), gates: gateReport(results), testsNote, previous,
      }), S.Review, 'read');
      this.saveReview(`chunk-${chunk.id}-review-${round}`, review);
      const required = review.findings.filter((f) => f.required);
      if (review.verdict === 'needs_human' && review.human_question) {
        writeJson(workFile, work);
        await this.ask([{ id: `C${chunk.id}`, audience: 'tech_lead', question: review.human_question, why_unresolvable: review.summary, recommendation: 'See the chunk review', blocking: true }], 'implementing');
      }
      if ((review.verdict === 'approved' || !required.length) && gatesOk(results)) break;
      if (round === rounds) {
        if (!this.state.autoAnswer && required.some((f) => f.severity === 'critical')) {
          writeJson(workFile, work);
          const f = required.find((x) => x.severity === 'critical')!;
          await this.ask([{ id: `C${chunk.id}-${f.id}`, audience: 'tech_lead', question: `Dev and reviewer could not agree on: ${f.title}. ${f.detail}`, why_unresolvable: `Dev Agent's position: ${work.responses.find((r) => r.finding_id === f.id)?.reasoning ?? 'n/a'}`, recommendation: 'Decide which position to follow', blocking: true }], 'implementing');
        }
        for (const f of required) this.state.disagreements.push({ where: `chunk ${chunk.id}`, finding: f, devReasoning: work.responses.find((r) => r.finding_id === f.id)?.reasoning ?? '' });
        if (!gatesOk(results)) this.state.gateNotes.push(`Chunk ${chunk.id} committed with failing focused gates:\n${gateReport(results)}`);
        break;
      }
      work = await this.call('dev', `chunk-${chunk.id}-fix-${round}`, render(prompt('chunk-fix'), {
        chunkId: chunk.id, repo: chunk.repo,
        gates: gatesOk(results) ? 'Gates pass.' : `## Gate failures\n\n${gateFailureDetail(results)}`,
        review: `## Review\n\n\`\`\`json\n${json(review)}\n\`\`\``,
      }), S.DevWork, 'write');
      for (const r of work.responses) if (r.decision === 'reject' && results.some((x) => x.failures.includes(r.finding_id))) expected.set(r.finding_id, r.reasoning);
      this.logRejections(`review of ${chunk.title}`, review.findings, work.responses);
      writeJson(workFile, work);
      await this.guard();
      results = effective(await this.gates(chunk.repo, 'focused', `chunk-${chunk.id}-fix-${round}`));
      previous = this.previous(review, work.responses);
    }
    writeJson(workFile, work);
    this.logCalls(`chunk ${chunk.id}`, work.calls ?? []);
    if (chunk.is_tests_chunk) this.state.expectedFailures[chunk.repo] = {};
    else for (const [f, why] of expected) carried[f] = why;
    this.save();
    writeText(approvedFile, now());
    await this.commitChunk(chunk, work);
  }

  private async commitChunk(chunk: S.Chunk, work: S.DevWork): Promise<void> {
    // conventional type follows what the chunk is: tests, a bug fix, or a feature
    const type = chunk.is_tests_chunk ? 'test' : this.state.issueType?.toLowerCase() === 'bug' ? 'fix' : undefined;
    await this.commit(chunk.repo, this.commitMessage(chunk.repo, work.commit_summary, type), chunk.id);
    // reviews may touch other ticket repos too; keep them with their own repo history
    for (const other of await this.reposWithChanges()) {
      await this.commit(other, this.commitMessage(other, work.commit_summary, type), chunk.id);
    }
    fs.rmSync(this.file('chunks', `${chunk.id}-approved`), { force: true });
  }

  // ---------------------------------------------------------------- stacked branches and alignment

  private ownRuns() {
    return listRuns(this.config)
      .filter((r) => r.key !== this.state.key)
      .map((r) => ({ key: r.key, branches: Object.fromEntries(Object.values(r.repos).map((x) => [x.key, x.branch])) }));
  }

  // where another ticket's code lives in one repo: this tool's own run first, then the remote
  private async branchFor(ticket: string, repoKey: string): Promise<(TicketBranch & { own: boolean }) | null> {
    const own = this.ownRuns().find((r) => r.key === ticket)?.branches[repoKey];
    const found = (await findBranches(this.config, [ticket], this.ownRuns(), this.optionalGitlab())).get(ticket) ?? [];
    const hit = found.find((b) => b.repo === repoKey);
    return hit ? { ...hit, own: hit.branch === own } : null;
  }

  // a ticket that needs another ticket's unmerged code starts on that ticket's latest commit
  private async resolveDependencies(): Promise<void> {
    if (this.state.replay) {
      this.state.depsResolved = true;
      return;
    }
    const plan = this.state.plan!;
    for (const repo of Object.values(this.state.repos)) {
      if (repo.commits.length || repo.parent) continue;
      const target = this.repoCfg(repo.key).target_branch;
      const override = this.state.baseOverride;
      if (this.state.skipDependencies || override?.toLowerCase() === target.toLowerCase()) continue;
      const deps = plan.dependencies.filter((d) => d.repo === repo.key && d.ticket !== this.state.key);
      const tickets = override ? [override] : [...new Set(deps.map((d) => d.ticket))];
      if (!tickets.length) continue;
      const reason = override ? 'chosen by the developer' : deps.map((d) => d.reason).join('; ');
      if (tickets.length > 1) {
        this.state.pendingDependency = { repo: repo.key, tickets, problem: 'two_parents' };
        return this.pause('dependency', [
          `**${this.state.key} needs unmerged code from ${tickets.join(' and ')} in ${repo.key}.** A branch can only be built on one of them. Reason: ${reason}`,
          `Merge one of them first and run \`agent run ${this.state.key}\`, or reply "build on ${tickets[0]}", or reply "continue from ${target}".`,
        ].join('\n\n'), 'implementing', `Waiting: ${tickets.join(' and ')} both unmerged.`);
      }
      const ticket = tickets[0];
      const source = repoPath(this.config, repo.key);
      const branch = await this.branchFor(ticket, repo.key);
      const resolved = branch ? await resolveRef(source, branch.branch, branch.own) : null;
      if (!branch || !resolved) {
        this.state.pendingDependency = { repo: repo.key, tickets: [ticket], problem: 'not_started' };
        return this.pause('dependency', [
          `**${this.state.key} depends on ${ticket} in ${repo.key}, but ${ticket} has no branch yet.** Reason: ${reason}`,
          `Start ${ticket} first (\`agent run ${ticket}\`), and this run continues once its branch exists. Or reply "continue from ${target}" to build without it.`,
        ].join('\n\n'), 'implementing', `Waiting for ${ticket} to be started.`);
      }
      await exec('git', ['-C', source, 'fetch', 'origin', target]);
      if (await isMergedInto(source, resolved.sha, `origin/${target}`)) {
        this.note(`${ticket} is already merged into ${target}, so ${repo.key} branched from ${target}`);
        this.decide('branching', `Branched ${repo.key} from ${target}, not from ${ticket}`, `${ticket} is already merged`, true);
        continue;
      }
      await startOn(repo.worktree, resolved.sha);
      repo.base = resolved.sha;
      repo.baseline = await this.baselineFor(repo.key, repo.worktree, resolved.sha);
      repo.parent = { ticket, repo: repo.key, branch: branch.branch, ref: resolved.ref, sha: resolved.sha, reason, mr: branch.mr };
      this.note(`${repo.key}: built on ${ticket} (\`${branch.branch}\`) because ${reason}`);
      this.decide('branching', `Built ${repo.key} on ${ticket}'s branch`, reason, true);
      log(`  ${repo.key}: depends on ${ticket} → building on ${branch.branch}`);
      this.save();
    }
    this.state.depsResolved = true;
    this.save();
  }

  // moves this ticket's own commits from oldBase onto newBase; conflicts go to the dev bot, then the program verifies
  private async restack(repoKey: string, oldBase: string, newBase: string, onto: string, label: string): Promise<void> {
    const repo = this.state.repos[repoKey];
    const backup = await this.backup(repoKey);
    const expected = await ownSubjects(repo.worktree, oldBase);
    await this.safely(backup, async () => {
      const conflicts = await startRestack(repo.worktree, oldBase, newBase);
      const resolved = await this.resolveConflicts(repoKey, conflicts, onto, `${label}-${repoKey}`);
      const problem = await verifyRestack(repo.worktree, newBase, expected);
      if (problem) throw new PipelineStop('failed', `Moving ${repoKey} onto ${onto} failed the safety check: ${problem}. Nothing was pushed.`);
      if (resolved.files.length) await this.reviewRebase(repoKey, backup, oldBase, onto, resolved, false);
      await this.reportResolution(repoKey, onto, resolved);
    });
    repo.base = newBase;
    const commits = (await g.git(repo.worktree, 'log', '--reverse', '--format=%H %s', `${newBase}..HEAD`)).split('\n').filter(Boolean);
    repo.commits = commits.map((l) => ({ sha: l.slice(0, 40), message: l.slice(41), chunk: 'moved' }));
    repo.baseline = await this.rebaseline(repoKey, newBase);
    this.save();
  }

  // the developer's habit: keep a local copy of the branch before anything rewrites it
  private async backup(repoKey: string): Promise<string> {
    const repo = this.state.repos[repoKey];
    const name = await g.backupBranch(repo.worktree, repo.branch);
    (repo.backups ??= []).push(name);
    this.save();
    log(`  ${repoKey}: saved the branch as ${name} (local only)`);
    return name;
  }

  // any stop mid-rebase says where the untouched copy is and how to go back to it
  private async safely(backup: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      const hint = `The branch as it was before is saved locally as \`${backup}\`. To go back: \`git rebase --abort\` (if one is in progress), then \`git reset --hard ${backup}\` in the worktree.`;
      if (err instanceof PipelineStop) throw new PipelineStop(err.kind, `${err.message}\n${hint}`);
      throw new Error(`${(err as Error).message}\n${hint}`);
    }
  }

  // only real calls reach the reviewer; a rebase with none gets a one-line note when an MR is open
  private async reportResolution(repoKey: string, onto: string, resolved: { files: string[]; decisions: Array<{ file: string; decision: string; why: string }> }): Promise<void> {
    if (!resolved.files.length) return;
    for (const d of resolved.decisions) this.decide(`conflict in ${d.file}`, d.decision, d.why);
    const mr = this.state.repos[repoKey].mr;
    if (!mr) return;
    const head = `Rebased onto the latest \`${onto.replace(/^origin\//, '')}\` and resolved conflicts in ${resolved.files.map((f) => `\`${f}\``).join(', ')}.`;
    const body = resolved.decisions.length
      ? `${head} Calls worth a second look:\n${resolved.decisions.map((d) => `- \`${d.file}\`: ${d.decision} (${d.why})`).join('\n')}`
      : `${head} Nothing needed a judgement call; both sides were kept.`;
    await this.gitlab.comment(mr.projectId, mr.iid, body);
  }

  private async resolveConflicts(repoKey: string, conflicts: string[], onto: string, label: string): Promise<{ files: string[]; decisions: S.Resolve['decisions'] }> {
    const repo = this.state.repos[repoKey];
    const out = { files: [] as string[], decisions: [] as S.Resolve['decisions'] };
    for (let round = 1; conflicts.length; round++) {
      if (round > 20) throw new PipelineStop('failed', `Resolving conflicts in ${repoKey} did not converge`);
      const res = await this.call('dev', `${label}-conflicts-${round}`, render(prompt('resolve-conflicts'), { key: this.state.key, repo: repoKey, target: onto, worktree: repo.worktree, files: conflicts.map((f) => `- ${f}`).join('\n') }), S.Resolve, 'write');
      await this.guardFiles(repoKey);
      const markers = await exec('git', ['-C', repo.worktree, 'grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', '--', ...conflicts]);
      if (markers.stdout.trim()) throw new PipelineStop('failed', `Conflict markers left in ${markers.stdout.trim()} (${res.summary})`);
      out.files.push(...conflicts.filter((f) => !out.files.includes(f)));
      out.decisions.push(...(res.decisions ?? []));
      conflicts = await g.continueRebase(repo.worktree, conflicts);
    }
    return out;
  }

  // "are we still aligned with the connected tickets?" Runs before the MR opens and on `agent align`
  async align(label: string): Promise<boolean> {
    const parents = Object.values(this.state.repos).filter((r) => r.parent);
    const related = this.state.plan?.related_tickets ?? [];
    if (!parents.length && !related.length) return false;
    log('alignment check with connected tickets');
    const relatedDir = this.state.context?.relatedDir ?? this.file('inputs', 'related');
    // sprint-plan may have been re-run since this ticket started
    const advice = adviceFor(this.config, this.state.context?.sprintName, this.state.key);
    if (advice && this.state.inputs) {
      this.state.inputs.advice = this.file('inputs', 'sprint-advice.md');
      writeText(this.state.inputs.advice, advice.text);
    }
    // tickets change after planning; read them fresh
    if (this.state.jira) {
      for (const t of related) {
        try {
          writeText(path.join(relatedDir, `${t.key}.md`), relatedText(this.config, await this.jira.getIssue(t.key)));
        } catch {
          // keep the copy from planning
        }
      }
    }
    const parentNews: string[] = [];
    for (const repo of parents) {
      const p = repo.parent!;
      const source = repoPath(this.config, repo.key);
      const target = this.repoCfg(repo.key).target_branch;
      await exec('git', ['-C', source, 'fetch', 'origin', target]);
      const latest = await resolveRef(source, p.branch, !p.ref.startsWith('origin/'));
      if (await isMergedInto(source, p.sha, `origin/${target}`) && (!latest || (await isMergedInto(source, latest.sha, `origin/${target}`)))) {
        const tip = await g.git(source, 'rev-parse', `origin/${target}`);
        await this.restack(repo.key, p.sha, tip, `origin/${target}`, `align-${label}`);
        parentNews.push(`${p.ticket} was merged into ${target}; ${repo.key} now sits on ${target} with only this ticket's commits.`);
        repo.parent = undefined;
        this.note(`${repo.key}: ${p.ticket} merged, so this branch was moved onto ${target}`);
        continue;
      }
      if (latest && latest.sha !== p.sha) {
        const changes = await g.git(source, 'log', '--format=- %h %s', `${p.sha}..${latest.sha}`);
        const stat = await g.git(source, 'diff', '--stat', p.sha, latest.sha);
        await this.restack(repo.key, p.sha, latest.sha, p.branch, `align-${label}`);
        p.sha = latest.sha;
        parentNews.push(`${p.ticket} (${p.branch}) changed since we built on it. ${repo.key} was moved onto its latest.\nNew commits:\n${changes}\n\n${stat}\nSee them with \`git -C ${source} show <sha>\`.`);
      }
      const comments = await this.parentReviewComments(repo.key);
      if (comments.length) parentNews.push(`New review comments on ${p.ticket}'s MR (check whether each applies to this ticket too):\n${comments.join('\n')}`);
    }
    this.save();
    const n = this.state.ledger.filter((e) => e.step.startsWith('align-')).length + 1;
    const res = await this.call('dev', `align-${label}-${n}`, render(prompt('align'), {
      key: this.state.key,
      related: related.map((t) => `- ${t.key}: ${t.why} (\`${path.join(relatedDir, `${t.key}.md`)}\`)`).join('\n') || '- none listed in the plan',
      parents: parentNews.join('\n\n') || 'No parent branch changes.',
      advice: this.state.inputs?.advice ? `\`${this.state.inputs.advice}\` (re-read just now)` : 'none for this ticket',
      diffs: this.diffList(),
    }), S.Align, 'write');
    await this.guard();
    let changed = parentNews.length > 0;
    for (const key of await this.reposWithChanges()) {
      const results = await this.gates(key, 'focused', `align-${n}`);
      await g.prepareDiffForReview(this.state.repos[key].worktree);
      const review = await this.call('reviewer', `align-${n}-review-${key}`, render(prompt('review-chunk'), {
        rules: this.reviewerRules(), what: 'changes that align this ticket with its connected tickets', repo: key, worktree: this.state.repos[key].worktree,
        chunk: json({ id: `align-${n}`, goal: 'stay consistent with connected tickets', issues: res.issues }), devReport: json(res), gates: gateReport(results), testsNote: '', previous: '',
      }), S.Review, 'read');
      this.saveReview(`align-${n}-review-${key}`, review);
      let summary = res.commit_summary;
      if (review.findings.some((f) => f.required) || !gatesOk(results)) {
        const fix = await this.call('dev', `align-${n}-fix-${key}`, render(prompt('chunk-fix'), { chunkId: `align-${n}`, repo: key, gates: gatesOk(results) ? 'Gates pass.' : gateFailureDetail(results), review: `## Review\n\n\`\`\`json\n${json(review)}\n\`\`\`` }), S.DevWork, 'write');
        await this.guard();
        summary = fix.commit_summary || summary;
      }
      await this.commit(key, this.commitMessage(key, summary, 'fix'), `align-${n}`);
      changed = true;
    }
    this.state.alignment = res.issues;
    for (const a of res.issues) this.decide('alignment', `${a.ticket}: ${a.problem}`, `${a.action.replace('_', ' ')}. ${a.detail}`);
    this.save();
    return changed;
  }

  private async parentReviewComments(repoKey: string): Promise<string[]> {
    const p = this.state.repos[repoKey].parent;
    const iid = Number(p?.mr?.match(/merge_requests\/(\d+)/)?.[1]);
    const gitlab = this.optionalGitlab();
    if (!p || !iid || !gitlab) return [];
    try {
      const projectId = await gitlab.projectId(this.repoCfg(repoKey).remote_path);
      const seen = (this.state.processed.parentNotes ??= []);
      const notes = (await gitlab.notes(projectId, iid)).filter((n) => !n.ours && !seen.includes(n.noteId));
      seen.push(...notes.map((n) => n.noteId));
      return notes.map((n) => `- @${n.author}${n.path ? ` on ${n.path}:${n.line ?? ''}` : ''}: ${n.body}`);
    } catch {
      return [];
    }
  }

  private async finalGates(label: string): Promise<void> {
    for (const repo of Object.values(this.state.repos)) {
      if (!repo.commits.length) continue;
      let results = await this.gates(repo.key, 'final', `${label}-0`);
      for (let attempt = 1; !gatesOk(results) && attempt <= this.config.limits.gate_fix_attempts; attempt++) {
        const fix = await this.call('dev', `${label}-${repo.key}-fix-${attempt}`, render(prompt('fix-final'), { gates: `## Final gate failures in ${repo.key}\n\n${gateFailureDetail(results)}`, review: '' }), S.DevWork, 'write');
        await this.guard();
        results = await this.gates(repo.key, 'final', `${label}-${attempt}`);
        if (gatesOk(results)) await this.commit(repo.key, this.commitMessage(repo.key, fix.commit_summary, 'fix'), label);
      }
      if (!gatesOk(results)) {
        throw new PipelineStop('failed', `Final gates still fail in ${repo.key} after ${this.config.limits.gate_fix_attempts} fix attempts:\n${gateReport(results)}`);
      }
    }
    // everything passes now, so earlier per-chunk failures (usually fixed by the tests chunk) are old news
    this.state.gateNotes = this.state.gateNotes.filter((n) => !/^Chunk \S+ committed with failing focused gates/.test(n));
    this.save();
  }

  private diffList(): string {
    return Object.values(this.state.repos)
      .filter((r) => r.commits.length)
      .map((r) => `- ${r.key}: \`git -C ${r.worktree} diff ${r.base}...HEAD\` (stat: \`git -C ${r.worktree} diff --stat ${r.base}...HEAD\`)`)
      .join('\n');
  }

  private commitList(): string {
    return Object.values(this.state.repos).flatMap((r) => r.commits.map((c) => `- ${r.key} ${c.sha.slice(0, 8)} ${c.message}`)).join('\n') || 'none';
  }

  async finalizing(): Promise<void> {
    log('final verification');
    await this.finalGates('final');
    const finalResults = () => Object.values(this.state.repos).filter((r) => r.commits.length).map((r) => {
      const file = this.file('gates', r.key, 'final-0.result.json');
      return `### ${r.key}\n${fs.existsSync(file) ? gateReport(readJson(file)) : 'n/a'}`;
    }).join('\n');

    let previous = '';
    let changed = false;
    const rounds = this.config.limits.review_rounds;
    for (let round = 1; round <= rounds; round++) {
      // the ticket's own reviewer does the whole-ticket check, with everything it saw so far
      const audit = await this.call('reviewer', `audit-${round}`, render(prompt('audit'), { rules: this.reviewerRules(), diffs: this.diffList(), gates: finalResults(), commits: this.commitList(), previous, done: this.state.plan?.done_checklist.map((d) => `- ${d}`).join('\n') || '- (none in the plan)' }), S.Review, 'read');
      this.saveReview(`audit-${round}`, audit);
      const required = audit.findings.filter((f) => f.required);
      if (audit.verdict === 'needs_human' && audit.human_question) {
        await this.ask([{ id: `A${round}`, audience: 'tech_lead', question: audit.human_question, why_unresolvable: audit.summary, recommendation: 'See the final audit', blocking: true }], 'finalizing');
      }
      if (audit.verdict === 'approved' || !required.length) break;
      const fix = await this.call('dev', `audit-fix-${round}`, render(prompt('fix-final'), { gates: '', review: `## Audit\n\n\`\`\`json\n${json(audit)}\n\`\`\`` }), S.DevWork, 'write');
      this.logRejections('final audit', audit.findings, fix.responses);
      await this.guard();
      for (const key of await this.reposWithChanges()) {
        await this.commit(key, this.commitMessage(key, fix.commit_summary, 'fix'), `audit-${round}`);
        changed = true;
      }
      if (round === rounds) {
        for (const f of required) this.state.disagreements.push({ where: 'final audit', finding: f, devReasoning: fix.responses.find((r) => r.finding_id === f.id)?.reasoning ?? '' });
      }
      previous = this.previous(audit, fix.responses);
    }

    log('simplify pass');
    const suggestions = await this.call('simplifier', 'simplify', render(prompt('simplify'), { key: this.state.key, diffs: this.diffList() }), S.Simplify, 'read');
    if (suggestions.suggestions.length) {
      const applied = await this.call('dev', 'simplify-apply', render(prompt('simplify-apply'), { suggestions: json(suggestions) }), S.DevWork, 'write');
      await this.guard();
      for (const key of await this.reposWithChanges()) {
        const results = await this.gates(key, 'focused', 'simplify');
        await g.prepareDiffForReview(this.state.repos[key].worktree);
        const review = await this.call('reviewer', `simplify-review-${key}`, render(prompt('review-chunk'), {
          rules: this.reviewerRules(), what: 'simplification changes (must not change behaviour)', repo: key, worktree: this.state.repos[key].worktree,
          chunk: json({ id: 'simplify', goal: 'behaviour-preserving cleanup' }), devReport: json(applied), gates: gateReport(results), testsNote: '', previous: '',
        }), S.Review, 'read');
        this.saveReview(`simplify-review-${key}`, review);
        if (review.findings.some((f) => f.required) || !gatesOk(results)) {
          log(`  simplification in ${key} rejected by review or gates; discarding it`);
          await exec('git', ['-C', this.state.repos[key].worktree, 'checkout', '--', '.']);
          await exec('git', ['-C', this.state.repos[key].worktree, 'clean', '-fd', '-e', 'node_modules']);
          continue;
        }
        await this.commit(key, this.commitMessage(key, applied.commit_summary, 'refactor'), 'simplify');
        changed = true;
      }
    }
    if (await this.align('final')) changed = true;
    if (changed) await this.finalGates('final-recheck');

    log('handoff');
    const handoff = await this.call('dev', 'handoff', render(prompt('handoff'), {
      commits: this.commitList(),
      gates: finalResults(),
      decisions: this.decisionLines(false) || 'none',
      disagreements: this.state.disagreements.map((d) => `- ${d.where}: ${d.finding.title} (dev: ${d.devReasoning})`).join('\n') || 'none',
      curlRule: this.state.plan?.needs_qa_curl
        ? 'for every endpoint added or changed, a ready-to-run curl for QA against the shared development environment (use placeholders like <BASE_URL> and <TOKEN>, never real secrets), with the expected response and the key error cases.'
        : 'empty list unless this ticket adds or changes an API.',
    }), S.Handoff, 'read');
    for (const [field, value] of Object.entries(handoff)) {
      if (typeof value === 'string') (handoff as Record<string, unknown>)[field] = stripFieldTags(value);
    }
    writeJson(this.file('handoff.json'), handoff);
    this.state.deploy = await this.deployNotes();
    if (this.state.deploy.length) writeText(this.file('deployment.md'), `# Deploy notes for ${this.state.key}\n\n${this.state.deploy.map((l) => `- ${l}`).join('\n')}`);
    this.state.changes = handoff.changes ?? [];
    if (this.state.changes.length || this.state.plan?.gaps?.length) await this.impact();
    if (handoff.next_tickets_md.trim()) writeText(this.file('handoff-note.md'), `# Handoff from ${this.state.key}: ${this.state.summary}\n\n${handoff.next_tickets_md}`);
    for (const key of Object.keys(this.state.repos)) writeText(this.file(`mr-${key}.md`), this.mrDescription(key, handoff));
    this.state.phase = this.state.publish ? 'publishing' : 'done';
    this.save();
  }

  // who else is affected by this ticket's changes and gaps; a local report, nothing posted
  async impact(): Promise<S.Impact | null> {
    const changes = this.state.changes ?? [];
    const gaps = this.state.plan?.gaps ?? [];
    if (!changes.length && !gaps.length) return null;
    log('  checking the impact on other tickets and the spec');
    const res = await this.call('dev', `impact-${(this.state.ledger ?? []).length}`, render(prompt('impact'), {
      key: this.state.key,
      changes: changes.map((c) => `- (${c.kind}) ${c.what}: ${c.why}`).join('\n') || '- none',
      gaps: gaps.map((g) => `- ${g.ticket || 'this ticket'}: ${g.what} (assumed: ${g.assumption})`).join('\n') || '- none',
    }), S.Impact, 'read');
    this.state.impact = { at: now(), ...res, posted: this.state.impact?.posted };
    const lines = [
      `# Impact of ${this.state.key}`,
      res.summary.trim() || 'Nothing else looks affected.',
      res.affected.length ? `## Other tickets\n${res.affected.map((a) => `- **${a.ticket}**: ${a.note}`).join('\n')}` : '',
      res.missing_work.length ? `## Work no ticket covers yet (draft tickets)\n${res.missing_work.map((m) => `### ${m.title} (${m.repo})\n${m.description}`).join('\n\n')}` : '',
      res.spec.length ? `## Spec updates\n${res.spec.map((x) => `- **${x.section}**: says "${x.now}", should say "${x.should}"`).join('\n')}` : '',
      res.affected.length ? `Post a short note on each affected ticket: \`agent impact ${this.state.key} --post\`` : '',
    ].filter(Boolean);
    writeText(this.file('impact.md'), lines.join('\n\n'));
    this.save();
    log(`  impact: ${res.affected.length} ticket(s), ${res.missing_work.length} uncovered piece(s) of work, ${res.spec.length} spec fix(es). See ${this.file('impact.md')}`);
    return res;
  }

  // what the deploy team must do for the BE repos, read from the diff: env vars, migrations, order. FE never needs it
  async deployNotes(): Promise<string[]> {
    const lines: string[] = [];
    const be = Object.values(this.state.repos).filter((r) => r.commits.length && this.repoCfg(r.key).kind.startsWith('backend'));
    for (const r of be) {
      const range = `${r.base}..HEAD`;
      const exampleDiff = await g.git(r.worktree, 'diff', '-U0', range, '--', '.env.example', '*.env.example').catch(() => '');
      const keysIn = (sign: string) => new Set([...exampleDiff.matchAll(new RegExp(`^\\${sign}\\s*([A-Z][A-Z0-9_]*)=`, 'gm'))].map((m) => m[1]));
      const plus = keysIn('+');
      const minus = keysIn('-');
      const added = [...plus].filter((k) => !minus.has(k));
      const removed = [...minus].filter((k) => !plus.has(k));
      if (added.length) lines.push(`${r.key}: new env var${added.length > 1 ? 's' : ''} ${added.map((k) => `\`${k}\``).join(', ')} (see \`.env.example\`)`);
      if (removed.length) lines.push(`${r.key}: removed from \`.env.example\`: ${removed.map((k) => `\`${k}\``).join(', ')}`);
      // new code reading an env var the example file doesn't list is the classic "works on my machine" deploy break
      const codeDiff = await g.git(r.worktree, 'diff', '-U0', range, '--', '*.js', '*.ts', '*.mjs', '*.cjs', ':!test/**', ':!**/*.spec.*', ':!**/*.test.*').catch(() => '');
      const addedCode = codeDiff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
      const used = new Set([...addedCode.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\))/g)].map((m) => m[1] ?? m[2]));
      const example = await g.git(r.worktree, 'show', 'HEAD:.env.example').catch(() => '');
      const missing = [...used].filter((k) => k !== 'NODE_ENV' && !new RegExp(`^\\s*${k}=`, 'm').test(example));
      if (missing.length) lines.push(`${r.key}: the code now reads ${missing.map((k) => `\`${k}\``).join(', ')}, which \`.env.example\` doesn't have yet`);
      const newFiles = (await g.git(r.worktree, 'diff', '--name-only', '--diff-filter=A', range).catch(() => '')).split('\n').filter(Boolean);
      const migrations = newFiles.filter((f) => /(^|\/)migrations\//.test(f));
      const seeders = newFiles.filter((f) => /(^|\/)seeders\//.test(f));
      if (migrations.length) lines.push(`${r.key}: run migrations (${migrations.length} new: ${migrations.map((f) => `\`${path.basename(f)}\``).join(', ')})`);
      if (seeders.length) lines.push(`${r.key}: run seeders (${seeders.length} new)`);
    }
    // business services first, then the gateway that calls them
    if (be.length > 1) {
      const order = [...be].sort((a, b) => Number(this.repoCfg(a.key).kind === 'backend-gateway') - Number(this.repoCfg(b.key).kind === 'backend-gateway'));
      lines.push(`Deploy ${order.map((r) => r.key).join(' before ')}`);
    }
    return lines;
  }

  // after the developer read the report: one short note on each affected ticket
  async postImpact(): Promise<string[]> {
    const impact = this.state.impact;
    if (!impact?.affected.length) return [];
    const ids = await this.mentions();
    const done = new Set(impact.posted ?? []);
    const now: string[] = [];
    for (const a of impact.affected) {
      const key = a.ticket.trim().toUpperCase();
      if (done.has(key) || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) continue;
      await this.jira.addComment(key, this.named(`Heads up from ${this.state.key}: ${a.note.trim()}`, ids), ids);
      done.add(key);
      now.push(key);
    }
    impact.posted = [...done];
    this.save();
    return now;
  }

  // short and human up top; everything a curious reviewer might want is folded away at the bottom
  mrDescription(repoKey: string, h: S.Handoff, companions: string[] = []): string {
    const t = totals(this.state);
    const repo = this.state.repos[repoKey];
    const gateFile = this.file('gates', repoKey, 'final-0.result.json');
    const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
    // models sometimes write "None. ..." instead of leaving a field empty
    const real = (text: string) => (text.trim() && !/^(none|n\/a|-|nothing)\b/i.test(text.trim()) ? text.trim() : '');
    const changes = this.state.changes ?? h.changes ?? [];
    const impact = this.state.impact;
    const impactLines = impact && (impact.affected.length || impact.missing_work.length || impact.spec.length)
      ? [impact.summary.trim(), ...impact.affected.map((a) => `${a.ticket}: ${a.note}`), ...impact.missing_work.map((m) => `No ticket covers: ${m.title} (${m.repo})`), ...impact.spec.map((x) => `Spec ${x.section} needs updating: ${x.should}`)].filter(Boolean)
      : [];
    const fixes = this.state.parentRun && this.state.bugTriage?.verdict === 'bug' ? `Fixes a bug in ${this.state.parentRun.key}: ${this.state.bugTriage.cause.trim()}` : '';
    const top = [
      fixes,
      h.mr_summary_md.trim(),
      changes.length ? `**Different from the ticket**\n${bullets(changes.map((c) => withWhy(c.what, c.why)))}` : '',
      h.decisions.length ? `**Worth a second look**\n${bullets(h.decisions.map((d) => `${d.decision.trim().replace(/\.$/, '')}: ${d.why.trim()}`))}` : '',
      this.state.disagreements.length
        ? `**Where the reviewer and I disagreed**\n${bullets(this.state.disagreements.map((d) => `${d.finding.title} (${d.where}). Reviewer: ${d.finding.detail.split('\n')[0]}${d.devReasoning.trim() ? ` Me: ${d.devReasoning.trim()}` : ''}`))}`
        : '',
      real(h.risks_md) || impactLines.length ? `**Heads up**\n${[real(h.risks_md), impactLines.length ? bullets(impactLines) : ''].filter(Boolean).join('\n')}` : '',
      h.qa_curls.length || h.manual_checks.length
        ? `**To test**\n${[h.manual_checks.length ? bullets(h.manual_checks.map((c) => `[ ] ${c}`)) : '', ...h.qa_curls.map((c) => `${c.title}\n\`\`\`bash\n${c.curl}\n\`\`\`\nExpected: ${c.expected}`)].filter(Boolean).join('\n\n')}`
        : '',
      this.state.deploy?.length ? `**Deploying**\n${bullets(this.state.deploy)}` : '',
      repo?.parent
        ? `**Depends on ${repo.parent.ticket}**: built on its ${repo.parent.mr ? `MR (${repo.parent.mr})` : `branch \`${repo.parent.branch}\``} because ${repo.parent.reason}. Please review ${repo.parent.ticket} first; until it merges, this MR also shows its changes.`
        : '',
      companions.length ? `**Goes with**\n${bullets(companions)}` : '',
      this.state.jira ? `Jira: ${this.config.jira.base_url}/browse/${this.state.key}` : '',
    ];
    const guide = bullets(h.review_guide.map((g) => `\`${g.file}\`: ${g.what.trim()}`));
    const details = [
      `**Tested:** ${h.testing_md.trim()}`,
      fs.existsSync(gateFile) ? `**Checks run by the pipeline**\n${gateReport(readJson(gateFile))}` : '',
      this.state.plan?.related_tickets.length
        ? `**Connected tickets checked**\n${bullets(this.state.plan.related_tickets.map((r) => `${r.key}: ${r.why}`))}\n\nAlignment before this MR: ${this.state.alignment?.length ? '\n' + bullets(this.state.alignment.map((a) => `${a.ticket} (${a.action.replace('_', ' ')}): ${a.problem}. ${a.detail}`)) : 'consistent.'}`
        : '',
      h.next_tickets_md.trim() ? `**Notes for related tickets**\n${h.next_tickets_md.trim()}` : '',
      this.state.gateNotes.length ? `**Pipeline notes**\n${bullets(this.state.gateNotes)}` : '',
      `Built by closio-agent: ${repo?.commits.length ?? 0} commits, ${t.calls} agent calls, ~$${t.costUsd.toFixed(2)}, ${t.minutes.toFixed(0)} agent-minutes. Models: ${Object.entries(this.state.models).map(([r, m]) => `${r}=${m.provider}:${m.model ?? 'default'}`).join(', ')}. Full decision log: \`runs/${this.state.key}/decisions.md\`.`,
    ].filter(Boolean);
    return [
      ...top.filter(Boolean),
      guide ? `<details><summary>Review guide</summary>\n\n${guide}\n\n</details>` : '',
      `<details><summary>Pipeline details</summary>\n\n${details.join('\n\n')}\n\n</details>`,
    ].filter(Boolean).join('\n\n');
  }

  async publishing(): Promise<void> {
    log('publishing');
    const handoff = readJson<S.Handoff>(this.file('handoff.json'));
    const touched = Object.values(this.state.repos).filter((r) => r.commits.length);
    if (!touched.length) throw new PipelineStop('failed', 'Nothing was committed, so there is nothing to publish');
    for (const repo of touched) {
      const cfg = this.repoCfg(repo.key);
      await g.push(repo.worktree, repo.branch, Boolean(repo.pushedSha));
      repo.pushedSha = await g.head(repo.worktree);
      const mr = await this.gitlab.createOrGetMr({
        remotePath: cfg.remote_path,
        source: repo.branch,
        target: cfg.target_branch,
        title: fill(this.config.gitlab.mr.title_format, { key: this.state.key, summary: this.state.summary }),
        description: this.mrDescription(repo.key, handoff),
        reviewers: this.config.gitlab.mr.reviewers,
      });
      repo.mr = { projectId: mr.projectId, iid: mr.iid, url: mr.webUrl };
      log(`  MR ${repo.key}: ${mr.webUrl}`);
      this.save();
    }
    if (touched.length > 1) {
      for (const repo of touched) {
        const others = touched.filter((r) => r !== repo).map((r) => `${r.key}: ${r.mr!.url}`);
        await this.gitlab.updateDescription(repo.mr!.projectId, repo.mr!.iid, this.mrDescription(repo.key, handoff, others));
      }
    }
    if (this.state.jira) {
      await this.jira.transition(this.state.key, this.config.jira.statuses.code_review);
      const curls = handoff.qa_curls.map((c) => `**${c.title}**\n\`\`\`\n${c.curl}\n\`\`\`\nExpected: ${c.expected}`).join('\n\n');
      const ids = await this.mentions();
      await this.jira.addComment(this.state.key, this.named([
        `**Ready for code review.** ${handoff.jira_summary}`,
        (this.state.changes ?? []).length ? `Different from the ticket:\n${(this.state.changes ?? []).map((c) => `- ${withWhy(c.what, c.why)}`).join('\n')}` : '',
        `MRs:\n${touched.map((r) => `- ${r.key}: ${r.mr!.url}`).join('\n')}`,
        curls ? `**QA curls**\n\n${curls}` : '',
        handoff.manual_checks.length ? `**Manual checks**\n${handoff.manual_checks.map((c) => `- ${c}`).join('\n')}` : '',
        ...touched.filter((r) => r.parent).map((r) => `**Depends on ${r.parent!.ticket}** (${r.key}): please review and merge it first.`),
        ...(this.state.alignment ?? []).filter((a) => a.action === 'needs_human').map((a) => `@tech_lead **Decision needed with ${a.ticket}:** ${a.problem}. ${a.detail}`),
        `Agent session: ${this.state.key}-dev (${this.state.devSession?.provider} ${this.state.devSession?.id}). Continue it with \`agent feedback ${this.state.key} "..."\`, or open it with \`agent session ${this.state.key}\`.`,
      ].filter(Boolean).join('\n\n'), ids), ids);
    }
    this.state.codeReviewAt = now();
    this.state.phase = 'in_review';
    this.save();
  }

  // ---------------------------------------------------------------- after the MR is open

  async sync(): Promise<string> {
    if (this.state.phase !== 'in_review') return `${this.state.key} is ${this.state.phase}`;
    const withMr = Object.values(this.state.repos).filter((r) => r.mr);
    const mrs = await Promise.all(withMr.map(async (r) => ({ repo: r, mr: await this.gitlab.getMr(r.mr!.projectId, r.mr!.iid) })));
    if (mrs.length && mrs.every((m) => m.mr.state === 'merged')) {
      if (this.state.jira) {
        await this.jira.transition(this.state.key, this.config.jira.statuses.ready_for_test);
        const deploy = await this.deployNotes().catch(() => this.state.deploy ?? []);
        await this.jira.addComment(this.state.key, `All MRs merged. Moved to ${this.config.jira.statuses.ready_for_test}.${deploy.length ? `\n\nDeploy notes:\n${deploy.map((l) => `- ${l}`).join('\n')}` : ''}`);
      }
      this.state.phase = 'done';
      this.save();
      return `${this.state.key}: all MRs merged, moved to ${this.config.jira.statuses.ready_for_test}`;
    }
    // closed without merging: the work was abandoned, so stop watching and leave Jira alone
    if (mrs.length && mrs.every((m) => m.mr.state === 'closed' || m.mr.state === 'merged') && mrs.some((m) => m.mr.state === 'closed')) {
      this.state.phase = 'done';
      this.state.gateNotes.push(`MR closed without merge on ${now()}`);
      this.save();
      return `${this.state.key}: MR closed without merge; stopped watching (Jira left as is)`;
    }
    const notes: string[] = [];
    for (const { repo, mr } of mrs) {
      if (mr.state === 'opened' && repo.pushedSha && mr.sha && mr.sha !== repo.pushedSha) {
        notes.push(await this.adoptRemote(repo.key, mr.sha));
      }
    }
    for (const { repo, mr } of mrs) {
      if (mr.state === 'opened' && (mr.hasConflicts || mr.mergeStatus === 'conflict')) {
        await this.rebase(repo.key);
        notes.push(`${repo.key}: rebased onto ${mr.targetBranch || this.repoCfg(repo.key).target_branch}`);
      }
    }
    const items = await this.newFeedback();
    if (items.length) {
      await this.feedback(items);
      notes.push(`handled ${items.length} feedback item(s)`);
    }
    return notes.length ? `${this.state.key}: ${notes.join('; ')}` : `${this.state.key}: no changes`;
  }

  // someone (usually the lead, with GitLab's Rebase button) changed the MR branch; take their version
  private async adoptRemote(key: string, remoteSha: string): Promise<string> {
    const repo = this.state.repos[key];
    const target = await this.targetFor(key);
    if ((await g.head(repo.worktree)) !== repo.pushedSha || (await g.changedFiles(repo.worktree)).length) {
      return `${key}: the MR branch changed on GitLab, but there is unpushed local work; left as is`;
    }
    await g.git(repo.worktree, 'fetch', 'origin', repo.branch, target);
    await this.backup(key);
    await g.git(repo.worktree, 'reset', '-q', '--hard', remoteSha);
    const onTarget = await isMergedInto(repo.worktree, `origin/${target}`, 'HEAD');
    if (repo.parent && (await isMergedInto(repo.worktree, repo.parent.sha, `origin/${target}`))) repo.parent = undefined;
    repo.base = repo.parent?.sha ?? (await g.git(repo.worktree, 'merge-base', 'HEAD', `origin/${target}`));
    const commits = (await g.git(repo.worktree, 'log', '--reverse', '--format=%H %s', `${repo.base}..HEAD`)).split('\n').filter(Boolean);
    repo.commits = commits.map((l) => ({ sha: l.slice(0, 40), message: l.slice(41), chunk: 'remote' }));
    repo.pushedSha = remoteSha;
    repo.baseline = await this.rebaseline(key, repo.base);
    this.save();
    return `${key}: picked up the branch as changed on GitLab${onTarget ? ` (now on latest ${target})` : ''}`;
  }

  private async newFeedback(): Promise<FeedbackItem[]> {
    const items: FeedbackItem[] = [];
    for (const repo of Object.values(this.state.repos)) {
      if (!repo.mr) continue;
      const notes = await this.gitlab.notes(repo.mr.projectId, repo.mr.iid);
      for (const n of notes) {
        if (n.ours || n.resolved || this.state.processed.mrNotes.includes(n.noteId)) continue;
        // a reply in an existing thread only makes sense with the thread before it
        const earlier = notes.filter((x) => x.discussionId === n.discussionId && x.noteId < n.noteId);
        const thread = earlier.length
          ? `\n  Earlier in this thread:\n${earlier.map((x) => `    ${x.ours ? 'You (agent)' : '@' + x.author}: ${x.body.replace(/<sub>.*<\/sub>/s, '').trim()}`).join('\n')}`
          : '';
        items.push({ id: `mr:${n.noteId}`, source: 'mr', repo: repo.key, discussionId: n.discussionId, text: `${repo.key} MR, @${n.author}${n.path ? `, ${n.path}:${n.line ?? ''}` : ''}: ${n.body}${thread}` });
      }
    }
    if (this.state.jira && this.state.codeReviewAt) {
      const since = Date.parse(this.state.codeReviewAt);
      for (const c of await this.jira.comments(this.state.key)) {
        if (Date.parse(c.created) <= since || isOurComment(c.text) || this.state.processed.jiraComments.includes(c.id)) continue;
        // QA questions get a QA-style answer, not a code change
        if (isQaQuestion(c.text)) continue;
        items.push({ id: `jira:${c.id}`, source: 'jira', text: `Jira comment by ${c.author}: ${c.text}` });
      }
    }
    return items;
  }

  // answers QA-Question comments in QA language, while in review or in testing; flags other comments that may need you
  async qaCheck(): Promise<string[]> {
    if (!this.state.jira || !this.state.codeReviewAt || this.state.qaWatchEnded) return [];
    if (!['in_review', 'done'].includes(this.state.phase)) return [];
    const out: string[] = [];
    // a merged card is only watched while QA is testing it
    if (this.state.phase === 'done') {
      const status = await this.jira.status(this.state.key);
      // finished for good: stop; just out of testing for now (e.g. reopened): skip this round, it may come back
      if (status.done) {
        this.state.qaWatchEnded = true;
        this.save();
        return [`${this.state.key}: now ${status.name}; stopped watching for QA questions`];
      }
      if (!this.config.jira.statuses.testing.some((t) => t.toLowerCase() === status.name.toLowerCase())) return [];
    }
    const since = Date.parse(this.state.codeReviewAt);
    const fresh = (await this.jira.comments(this.state.key)).filter((c) => Date.parse(c.created) > since && !isOurComment(c.text) && !this.state.processed.jiraComments.includes(c.id));
    const questions = fresh.filter((c) => isQaQuestion(c.text));
    if (this.state.phase === 'done') {
      const me = await this.jira.myself().then((m) => m.displayName).catch(() => '');
      for (const c of fresh.filter((x) => !isQaQuestion(x.text))) {
        if (mayNeedDev(c.text, me)) out.push(`${this.state.key}: ${c.author} commented, may need you: "${c.text.replace(/\s+/g, ' ').slice(0, 100)}"`);
        this.state.processed.jiraComments.push(c.id);
      }
      this.save();
    }
    if (!questions.length) return out;
    log(`${this.state.key}: answering ${questions.length} QA question(s)`);
    const n = this.state.ledger.filter((e) => e.step.startsWith('qa-')).length + 1;
    // a dev bot with no saved conversation hasn't seen its rules (DB helper, repo map), so it gets them here
    const rules = this.state.devSession ? '' : `${this.devRules()}\n\n`;
    let res: S.QaAnswer = { replies: [] };
    try {
      res = await this.call('dev', `qa-${n}`, rules + render(prompt('qa-answer'), {
        key: this.state.key,
        stage: this.state.phase === 'done' ? 'merged, now being tested' : 'in code review',
        items: questions.map((c) => `- [${c.id}] ${c.author}: ${c.text.replace(QA_MARK, '').replace(/^[\s*]+/, '')}`).join('\n'),
      }), S.QaAnswer, 'read');
    } catch (err) {
      log(`  ${this.state.key}: the QA answer step failed: ${(err as Error).message.split('\n')[0]}`);
    }
    for (const r of res.replies) {
      const c = questions.find((q) => q.id === r.comment_id);
      if (!c || this.state.processed.jiraComments.includes(c.id)) continue;
      // tag the QA who asked, so the reply reaches them
      await this.jira.addComment(this.state.key, c.authorId ? `@qa ${r.reply.trim()}` : r.reply.trim(), c.authorId ? { qa: c.authorId } : {});
      // saved straight away, so a crash right after can't post the same reply twice
      this.state.processed.jiraComments.push(c.id);
      this.save();
      this.decide('qa', `QA asked: ${c.text.slice(0, 120)} → ${r.verdict.replaceAll('_', ' ')}`, r.reply, true);
      out.push(`${this.state.key}: answered ${c.author}'s question (${r.verdict.replaceAll('_', ' ')})${r.verdict === 'bug' ? '; QA found a real bug' : ''}`);
    }
    // one try per question: anything the bot didn't answer goes to you instead of being re-asked every 5 minutes
    for (const c of questions.filter((q) => !this.state.processed.jiraComments.includes(q.id))) {
      this.state.processed.jiraComments.push(c.id);
      out.push(`${this.state.key}: couldn't answer ${c.author}'s question, please reply yourself: "${c.text.replace(/\s+/g, ' ').slice(0, 100)}"`);
    }
    this.save();
    return out;
  }

  async feedback(items: FeedbackItem[]): Promise<void> {
    log(`feedback: ${items.length} item(s)`);
    this.feedbackCommitCount = Object.values(this.state.repos).reduce((sum, r) => sum + r.commits.length, 0);
    const n = this.state.ledger.filter((e) => e.step.startsWith('feedback-')).length + 1;
    const fb = await this.call('dev', `feedback-${n}`, render(prompt('feedback'), {
      key: this.state.key,
      items: items.map((i) => `- [${i.id}] ${i.text}`).join('\n'),
    }), S.Feedback, 'write');
    await this.guard();
    for (const key of await this.reposWithChanges()) {
      const results = await this.gates(key, 'focused', `feedback-${n}`);
      await g.prepareDiffForReview(this.state.repos[key].worktree);
      const review = await this.call('reviewer', `feedback-${n}-review-${key}`, render(prompt('review-chunk'), {
        rules: this.reviewerRules(), what: 'fixes made in response to human review feedback', repo: key, worktree: this.state.repos[key].worktree,
        chunk: json({ id: `feedback-${n}`, goal: 'address the feedback below', feedback: items }), devReport: json(fb), gates: gateReport(results), testsNote: '', previous: '',
      }), S.Review, 'read');
      this.saveReview(`feedback-${n}-review-${key}`, review);
      if (review.findings.some((f) => f.required)) {
        const fix = await this.call('dev', `feedback-${n}-fix-${key}`, render(prompt('chunk-fix'), { chunkId: `feedback-${n}`, repo: key, gates: gatesOk(results) ? 'Gates pass.' : gateFailureDetail(results), review: `## Review\n\n\`\`\`json\n${json(review)}\n\`\`\`` }), S.DevWork, 'write');
        await this.guard();
        fb.commit_summary = fix.commit_summary || fb.commit_summary;
      }
      await this.commit(key, this.commitMessage(key, fb.commit_summary, 'fix'), `feedback-${n}`);
    }
    // a reply-only round changed nothing, so there is nothing to re-verify
    const commitsBefore = this.feedbackCommitCount;
    if (Object.values(this.state.repos).reduce((sum, r) => sum + r.commits.length, 0) > commitsBefore) await this.finalGates(`feedback-${n}-final`);
    for (const repo of Object.values(this.state.repos)) {
      if (repo.mr && repo.pushedSha !== (await g.head(repo.worktree))) {
        await g.push(repo.worktree, repo.branch, true);
        repo.pushedSha = await g.head(repo.worktree);
      }
    }
    const jiraReplies: string[] = [];
    for (const item of fb.items) {
      const source = items.find((i) => i.id === item.source_id);
      if (!source) continue;
      if (source.source === 'mr' && source.repo && source.discussionId && this.config.gitlab.reply_to_mr_comments) {
        const mr = this.state.repos[source.repo].mr!;
        await this.gitlab.reply(mr.projectId, mr.iid, source.discussionId, item.reply);
      }
      // MR questions are answered in the MR thread, where the commenter is; Jira only hears about Jira feedback
      if (source.source !== 'mr') jiraReplies.push(`- ${source.text.slice(0, 120)}…\n  → ${item.reply}`);
      if (source.source === 'mr') this.state.processed.mrNotes.push(Number(source.id.slice(3)));
      else this.state.processed.jiraComments.push(source.id.slice(5));
    }
    if (jiraReplies.length && this.state.jira) await this.jira.addComment(this.state.key, `Feedback handled:\n\n${jiraReplies.join('\n')}`);
    this.state.deploy = await this.deployNotes();
    if (await this.addChanges(fb.changes ?? [])) await this.impact();
    await this.refreshMrText();
    this.state.humanTouches += items.length;
    this.save();
  }

  // review feedback can change behaviour too: tell Jira in one line and keep the MR text current
  private async addChanges(changes: S.Change[]): Promise<boolean> {
    const added = changes.filter((c) => !(this.state.changes ?? []).some((x) => x.what === c.what));
    if (!added.length) return false;
    this.state.changes = [...(this.state.changes ?? []), ...added];
    this.save();
    if (this.state.jira) {
      await this.jira.addComment(this.state.key, `${added.length === 1 ? 'One more change' : 'A few more changes'} after review:\n${added.map((c) => `- ${withWhy(c.what, c.why)}`).join('\n')}`);
    }
    log(`  ${added.length} new change(s) from the ticket; checking what else they affect`);
    return true;
  }

  // keeps the MR text in step after feedback (changes, impact, deploy notes)
  private async refreshMrText(): Promise<void> {
    if (!fs.existsSync(this.file('handoff.json'))) return;
    const h = readJson<S.Handoff>(this.file('handoff.json'));
    const withMr = Object.values(this.state.repos).filter((r) => r.mr);
    for (const repo of withMr) {
      const others = withMr.filter((r) => r !== repo).map((r) => `${r.key}: ${r.mr!.url}`);
      await this.gitlab.updateDescription(repo.mr!.projectId, repo.mr!.iid, this.mrDescription(repo.key, h, others));
    }
  }

  // the yaml picks the target when the MR is created; after that the MR on GitLab is the truth (the lead may retarget it)
  async targetFor(key: string): Promise<string> {
    const configured = this.repoCfg(key).target_branch;
    const mr = this.state.repos[key].mr;
    if (!mr) return configured;
    const live = (await this.gitlab.getMr(mr.projectId, mr.iid)).targetBranch || configured;
    if (live !== configured) log(`  ${key}: the MR targets ${live} on GitLab (config says ${configured}); following GitLab`);
    return live;
  }

  async rebase(key: string): Promise<void> {
    const repo = this.state.repos[key];
    const target = await this.targetFor(key);
    const onto = `origin/${target}`;
    log(`rebasing ${key} onto ${onto}`);
    await g.git(repo.worktree, 'fetch', 'origin', target);
    const backup = await this.backup(key);
    const oldBase = repo.base;
    const expected = await ownSubjects(repo.worktree, oldBase);
    let resolved = { files: [] as string[], decisions: [] as S.Resolve['decisions'] };
    await this.safely(backup, async () => {
      const conflicts = await g.startRebase(repo.worktree, onto);
      resolved = await this.resolveConflicts(key, conflicts, onto, `rebase-${key}`);
      // same "nothing lost" check as a stacked move; expected holds only this ticket's own commits
      const problem = await verifyRestack(repo.worktree, onto, expected);
      if (problem) throw new PipelineStop('failed', `Rebasing ${key} onto ${target} failed the safety check: ${problem}. Nothing was pushed.`);
      repo.base = await g.git(repo.worktree, 'merge-base', 'HEAD', onto);
      const commits = (await g.git(repo.worktree, 'log', '--format=%H %s', `${repo.base}..HEAD`)).split('\n').filter(Boolean).reverse();
      repo.commits = commits.map((line) => ({ sha: line.slice(0, 40), message: line.slice(41), chunk: 'rebased' }));
      repo.baseline = await this.rebaseline(key, repo.base);
      this.save();
      await this.finalGates(`rebase-${key}`);
      if (resolved.files.length) await this.reviewRebase(key, backup, oldBase, onto, resolved, true);
    });
    await this.reportResolution(key, onto, resolved);
    await g.push(repo.worktree, repo.branch, true);
    repo.pushedSha = await g.head(repo.worktree);
    this.save();
  }

  // after conflicts: the reviewer checks nothing broke and every feature is still there; it stops before any push otherwise
  private async reviewRebase(key: string, backup: string, oldBase: string, onto: string, resolved: { files: string[]; decisions: S.Resolve['decisions'] }, gatesRan: boolean): Promise<void> {
    const repo = this.state.repos[key];
    const notes = resolved.decisions.length ? resolved.decisions.map((d) => `- ${d.file}: ${d.decision} (${d.why})`).join('\n') : '- no judgement calls; both sides kept';
    let previous = '';
    const rounds = this.config.limits.review_rounds;
    for (let round = 1; round <= rounds; round++) {
      const label = `rebase-${key}-review-${round}`;
      const review = await this.call('reviewer', label, render(prompt('review-rebase'), {
        rules: this.reviewerRules(), key: this.state.key, repo: key, worktree: repo.worktree, onto, backup, oldBase,
        files: resolved.files.map((f) => `- ${f}`).join('\n'), notes,
        gates: gatesRan ? 'The full tests and build pass after the rebase (run by the orchestrator).' : 'Tests run again before the MR.',
        previous,
      }), S.Review, 'read');
      this.saveReview(label, review);
      const required = review.findings.filter((f) => f.required);
      if (review.verdict === 'approved' || !required.length) return;
      if (round === rounds) throw new PipelineStop('failed', `The reviewer still sees problems after rebasing ${key}: ${required.map((f) => f.title).join('; ')}. Nothing was pushed.`);
      const fix = await this.call('dev', `${label}-fix`, render(prompt('fix-final'), { gates: '', review: `## Review of the rebase\n\n\`\`\`json\n${json(review)}\n\`\`\`` }), S.DevWork, 'write');
      await this.guard();
      if ((await g.changedFiles(repo.worktree)).length) {
        await this.commit(key, this.commitMessage(key, fix.commit_summary, 'fix'), label);
        if (gatesRan) await this.finalGates(`${label}-fix`);
      }
      previous = this.previous(review, fix.responses);
    }
  }

  private async rebaseline(key: string, sha: string): Promise<Baseline> {
    const cache = path.join(this.dir, '..', '_baselines', `${key}-${sha}.json`);
    if (fs.existsSync(cache)) return readJson<Baseline>(cache);
    const tmp = path.join(scratchDir(this.config), 'baseline', `${key}-${sha.slice(0, 8)}`);
    const source = repoPath(this.config, key);
    await g.git(source, 'worktree', 'add', '--detach', tmp, sha);
    try {
      await g.linkDependencies(source, tmp, this.repoCfg(key).install);
      return await this.baselineFor(key, tmp, sha);
    } finally {
      await g.removeWorktree(source, tmp);
    }
  }

  // ---------------------------------------------------------------- driver

  async advance(opts?: StartOptions): Promise<void> {
    for (;;) {
      const phase = this.state.phase;
      try {
        switch (phase) {
          case 'intake':
            await this.intake(opts ?? (this.state.options as StartOptions));
            break;
          case 'planning':
            await this.planning();
            break;
          case 'awaiting_answers':
            await this.awaitingAnswers();
            break;
          case 'implementing':
            await this.implementing();
            break;
          case 'finalizing':
            await this.finalizing();
            break;
          case 'publishing':
            await this.publishing();
            break;
          case 'in_review':
          case 'done':
          case 'failed':
            return;
        }
        this.state.error = undefined;
      } catch (err) {
        if (err instanceof RetryPhase) {
          this.state.retries = (this.state.retries ?? 0) + 1;
          if (this.state.retries > 5) throw new PipelineStop('failed', 'Answering kept leading to new human questions; stopping');
          this.save();
          continue;
        }
        if (err instanceof PipelineStop && err.kind === 'waiting') throw err;
        this.state.error = (err as Error).message;
        this.save();
        throw err;
      }
    }
  }
}

// thrown when auto-answer resolved questions and the phase should simply carry on
class RetryPhase extends Error {}

export type FeedbackItem = { id: string; source: 'mr' | 'jira' | 'manual'; repo?: string; discussionId?: string; text: string };
