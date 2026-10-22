import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderName, Role, RoleModel } from './config.ts';
import { Activity } from './live.ts';
import { ensureDir, exec, log, SAFE_ENV, tail, TOOL_ROOT, writeJson } from './util.ts';

export type Access = 'read' | 'write';

export type AgentCall = {
  role: Role | 'planner';
  step: string;
  model: RoleModel;
  cwd: string;
  prompt: string;
  access: Access;
  // folders the agent may write to (write access only); everything else is read-only
  writableDirs: string[];
  // extra folders the agent should be able to read
  readDirs: string[];
  // repos the bot may inspect with `git -C <dir> <read command>` (Claude matches commands by prefix, so -C needs its own rules)
  gitDirs?: string[];
  // folders writable even in read access (for example where Figma results are saved)
  extraWritable?: string[];
  // MCP tools the agent may call, as mcp__<server>__<tool>
  mcpTools?: string[];
  schema?: object;
  // continue an existing provider session instead of starting a fresh one
  resumeSessionId?: string;
  // start from a copy of another session (a bug ticket starting from its story's conversation); the original is untouched
  forkFrom?: string;
  images?: string[];
  timeoutMs: number;
  logDir: string;
  // set by runAgent: reports what the bot is doing right now
  onActivity?: (action: string) => void;
};

export type AgentResult = {
  text: string;
  structured: unknown;
  sessionId: string;
  provider: ProviderName;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
};

export class AgentError extends Error {}

// read-only shell commands any role may run (no awk: `print > file` writes anywhere)
const READ_BASH = [
  'git status', 'git diff', 'git log', 'git show', 'git blame', 'git grep', 'git ls-files', 'git branch',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed -n', 'sort', 'uniq', 'jq', 'tree', 'pdftotext',
  'cd', 'pwd', 'echo', 'diff', 'file',
];

// read-only git subcommands allowed as `git -C <known repo> …`
const GIT_READ = ['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree'];

// what the dev agent may run on top of that while coding
const WRITE_BASH = [
  'npx vitest', 'npm test', 'npm run test', 'npx mocha', 'npx cross-env NODE_ENV=test', 'npx eslint', 'npx vue-tsc', 'npx tsc',
  'NODE_ENV=test npx mocha', 'NODE_ENV=test APP_LOG_DIR=./.test-logs npx mocha',
  'DOTENV_CONFIG_PATH=.env.example npx mocha', 'DOTENV_CONFIG_PATH=.env.example npx cross-env NODE_ENV=test',
];

// never, whatever the mode
const DENY_BASH = [
  'git push', 'git commit', 'git reset', 'git checkout', 'git switch', 'git rebase', 'git merge', 'git stash',
  'git clean', 'git worktree', 'git branch -D', 'git tag', 'npm run migrate', 'npx sequelize', 'sequelize',
  'npm publish', 'psql', 'rm -rf', 'curl', 'wget',
];

function claudeSettings(call: AgentCall): object {
  const helpers = ['agent-sql', 'agent-jira'].map((h) => path.join(TOOL_ROOT, 'bin', h));
  const bash = [...READ_BASH, ...(call.access === 'write' ? WRITE_BASH : []), ...helpers];
  const allow = ['Read', 'Glob', 'Grep', 'Task', 'Agent', 'TodoWrite', ...bash.map((c) => `Bash(${c}:*)`)];
  for (const dir of call.gitDirs ?? []) for (const sub of GIT_READ) allow.push(`Bash(git -C ${dir} ${sub}:*)`);
  const writable = [...(call.access === 'write' ? call.writableDirs : []), ...(call.extraWritable ?? [])];
  for (const dir of writable) {
    allow.push(`Edit(/${dir}/**)`, `Write(/${dir}/**)`, `MultiEdit(/${dir}/**)`);
  }
  allow.push(...(call.mcpTools ?? []));
  const deny = [
    ...DENY_BASH.map((c) => `Bash(${c}:*)`),
    'Edit(**/.env)', 'Edit(**/.env.*)', 'Write(**/.env)', 'Write(**/.env.*)',
    'WebFetch', 'WebSearch',
  ];
  return { permissions: { defaultMode: 'dontAsk', allow, deny } };
}

// a short, human phrase for what a bot is doing, for the live status line
function shortPath(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel : file.split('/').slice(-2).join('/');
}

function shortCommand(cmd: string): string {
  // codex wraps commands as /bin/zsh -lc "…"; show only what it actually ran
  const inner = cmd.match(/^\/bin\/\w*sh -l?c (["'])([\s\S]*)\1$/)?.[2] ?? cmd;
  const one = inner.replace(/\s+/g, ' ').replace(/^cd [^&;]+(&&|;)\s*/, '').trim();
  return one.length > 70 ? one.slice(0, 67) + '…' : one;
}

function describeClaudeTool(name: string, input: Record<string, any>, root: string): string {
  if (name === 'Read') return `reading ${shortPath(String(input.file_path ?? ''), root)}`;
  if (name === 'Grep') return `searching for "${String(input.pattern ?? '').slice(0, 40)}"`;
  if (name === 'Glob') return `finding files ${input.pattern ?? ''}`;
  if (['Edit', 'Write', 'MultiEdit'].includes(name)) return `editing ${shortPath(String(input.file_path ?? ''), root)}`;
  if (name === 'Bash') return `running ${shortCommand(String(input.command ?? ''))}`;
  if (name === 'Task' || name === 'Agent') return 'asking a sub-agent';
  if (name === 'TodoWrite') return 'planning its next steps';
  if (name.startsWith('mcp__figma__')) return `reading Figma (${name.replace('mcp__figma__', '')})`;
  if (name === 'StructuredOutput') return 'writing its answer';
  return `using ${name}`;
}

// follows a file another process appends JSON lines to, from its current end
function followJsonl(file: string, onEvent: (event: any) => void): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let partial = '';
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      try {
        onEvent(JSON.parse(line));
      } catch {
        // half-written or non-JSON line; skip
      }
    }
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

// Claude keeps each conversation in a file under its working folder's project directory
export function claudeSessionFile(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

async function runClaude(call: AgentCall): Promise<AgentResult> {
  const settingsFile = path.join(call.logDir, `${call.step}.settings.json`);
  writeJson(settingsFile, claudeSettings(call));
  const sessionId = call.resumeSessionId ?? call.forkFrom ?? crypto.randomUUID();
  const args = ['-p', '--output-format', 'json', '--settings', settingsFile, '--permission-mode', 'dontAsk'];
  if (call.forkFrom && !call.resumeSessionId) args.push('--resume', call.forkFrom, '--fork-session');
  else args.push(...(call.resumeSessionId ? ['--resume', sessionId] : ['--session-id', sessionId]));
  if (call.model.model) args.push('--model', call.model.model);
  if (call.model.effort) args.push('--effort', call.model.effort);
  for (const dir of new Set([...call.writableDirs, ...(call.extraWritable ?? []), ...call.readDirs])) args.push('--add-dir', dir);
  if (call.schema) args.push('--json-schema', JSON.stringify(call.schema));

  const started = Date.now();
  // claude appends its conversation to a transcript as it works; follow it for the live line
  const transcript = claudeSessionFile(call.cwd, sessionId);
  const unfollow = followJsonl(transcript, (event) => {
    if (event.type !== 'assistant') return;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use') call.onActivity?.(describeClaudeTool(part.name, part.input ?? {}, call.cwd));
      else if (part.type === 'text' && part.text?.trim()) call.onActivity?.('writing its answer');
    }
  });
  const res = await exec('claude', args, { cwd: call.cwd, input: call.prompt, timeoutMs: call.timeoutMs, env: { ...process.env, ...SAFE_ENV } }).finally(unfollow);
  fs.writeFileSync(path.join(call.logDir, `${call.step}.claude.json`), res.stdout || res.stderr);
  if (res.timedOut) throw new AgentError(`claude timed out on ${call.step}`);

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new AgentError(`claude returned non-JSON on ${call.step} (exit ${res.code}): ${tail(res.stderr || res.stdout, 1500)}`);
  }
  if (parsed.is_error || parsed.subtype !== 'success') {
    throw new AgentError(`claude failed on ${call.step}: ${parsed.subtype} ${tail(String(parsed.result ?? ''), 1500)}`);
  }
  const denials = parsed.permission_denials ?? [];
  if (denials.length) log(`  ${denials.length} tool call(s) blocked by policy on ${call.step} (see ${call.step}.claude.json)`);
  return {
    text: String(parsed.result ?? ''),
    structured: parsed.structured_output,
    sessionId: parsed.session_id ?? sessionId,
    provider: 'claude',
    costUsd: parsed.total_cost_usd,
    inputTokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.cache_read_input_tokens ?? 0) + (parsed.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: parsed.usage?.output_tokens,
    durationMs: Date.now() - started,
  };
}

function tomlArray(items: string[]): string {
  return `[${items.map((i) => JSON.stringify(i)).join(',')}]`;
}

async function runCodex(call: AgentCall): Promise<AgentResult> {
  const lastFile = path.join(call.logDir, `${call.step}.codex-last.txt`);
  const args = call.resumeSessionId ? ['exec', 'resume', call.resumeSessionId] : call.forkFrom ? ['exec', 'fork', call.forkFrom] : ['exec'];
  args.push('--json', '--skip-git-repo-check', '-o', lastFile);
  const sandbox = call.access === 'write' ? 'workspace-write' : 'read-only';
  args.push('-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
  if (call.access === 'write' && call.writableDirs.length) {
    args.push('-c', `sandbox_workspace_write.writable_roots=${tomlArray(call.writableDirs)}`);
  }
  if (call.model.model) args.push('-m', call.model.model);
  if (call.model.effort) args.push('-c', `model_reasoning_effort="${call.model.effort}"`);
  if (call.schema) {
    const schemaFile = path.join(call.logDir, `${call.step}.schema.json`);
    writeJson(schemaFile, call.schema);
    args.push('--output-schema', schemaFile);
  }
  for (const image of call.images ?? []) args.push('-i', image);
  args.push('-');

  const started = Date.now();
  let pending = '';
  const onStdout = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        const item = JSON.parse(line).item;
        if (!item) continue;
        if (item.type === 'command_execution') call.onActivity?.(`running ${shortCommand(String(item.command ?? ''))}`);
        else if (item.type === 'file_change') call.onActivity?.(`editing ${(item.changes ?? []).map((c: any) => shortPath(String(c.path ?? ''), call.cwd)).join(', ')}`);
        else if (item.type === 'reasoning') call.onActivity?.('thinking');
        else if (item.type === 'agent_message') call.onActivity?.('writing its answer');
        else if (item.type === 'mcp_tool_call') call.onActivity?.(`using ${item.tool ?? 'a tool'}`);
      } catch {
        // not an event line
      }
    }
  };
  const res = await exec('codex', args, { cwd: call.cwd, input: call.prompt, timeoutMs: call.timeoutMs, onStdout, env: { ...process.env, ...SAFE_ENV } });
  fs.writeFileSync(path.join(call.logDir, `${call.step}.codex.jsonl`), res.stdout + (res.stderr ? `\n# stderr\n${res.stderr}` : ''));
  if (res.timedOut) throw new AgentError(`codex timed out on ${call.step}`);

  let sessionId = call.resumeSessionId ?? '';
  let inputTokens = 0;
  let outputTokens = 0;
  let failure = '';
  for (const line of res.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'thread.started') sessionId = event.thread_id;
    if (event.type === 'turn.completed') {
      inputTokens += event.usage?.input_tokens ?? 0;
      outputTokens += (event.usage?.output_tokens ?? 0) + (event.usage?.reasoning_output_tokens ?? 0);
    }
    if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? 'unknown';
  }
  const text = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '';
  if (res.code !== 0 || failure || !text) {
    throw new AgentError(`codex failed on ${call.step}: ${failure || tail(res.stderr || res.stdout, 1500)}`);
  }
  let structured: unknown;
  if (call.schema) {
    try {
      structured = JSON.parse(text);
    } catch {
      throw new AgentError(`codex returned invalid JSON on ${call.step}`);
    }
  }
  return { text, structured, sessionId, provider: 'codex', inputTokens, outputTokens, durationMs: Date.now() - started };
}

// scripted provider for tests and dry runs; handlers are registered by step prefix
export type FakeHandler = (call: AgentCall) => unknown | Promise<unknown>;
const fakeHandlers: Array<{ prefix: string; handler: FakeHandler }> = [];

export function registerFake(prefix: string, handler: FakeHandler): void {
  fakeHandlers.unshift({ prefix, handler });
}

export function clearFakes(): void {
  fakeHandlers.length = 0;
}

async function runFake(call: AgentCall): Promise<AgentResult> {
  // longest matching prefix wins, newest first on ties, so 'plan' never answers 'plan-review'
  const match = fakeHandlers
    .filter((h) => call.step.startsWith(h.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) throw new AgentError(`fake provider has no handler for step '${call.step}'`);
  const output = await match.handler(call);
  return {
    text: typeof output === 'string' ? output : JSON.stringify(output),
    structured: typeof output === 'string' ? undefined : output,
    sessionId: call.resumeSessionId ?? `fake-${call.role}`,
    provider: 'fake',
    costUsd: 0,
    durationMs: 0,
  };
}

export async function runAgent(call: AgentCall): Promise<AgentResult> {
  ensureDir(call.logDir);
  fs.writeFileSync(path.join(call.logDir, `${call.step}.prompt.md`), call.prompt);
  const label = `${call.model.provider}${call.model.model ? ':' + call.model.model : ''}`;
  log(`  ${call.role} → ${call.step} (${label}${call.resumeSessionId ? ', resumed' : call.forkFrom ? ', from the story\'s conversation' : ''})`);
  const runner = { claude: runClaude, codex: runCodex, fake: runFake }[call.model.provider];
  const activity = new Activity();
  activity.start();
  let result: AgentResult;
  try {
    result = await runner({ ...call, onActivity: (a) => activity.update(a) });
  } finally {
    activity.stop();
  }
  if (call.schema && (result.structured === undefined || result.structured === null)) {
    throw new AgentError(`${call.step} returned no structured output`);
  }
  return result;
}
