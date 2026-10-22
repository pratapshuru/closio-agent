import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aroundLiveLine } from './live.ts';

export const TOOL_ROOT = path.resolve(import.meta.dirname, '..');

// tag on everything we post, so sync never treats our own comments as human feedback
export const MARKER = '[closio-agent]';

// every Postgres connection made by tests or bots is read-only: reads work, writes fail
export const SAFE_ENV = { PGOPTIONS: '-c default_transaction_read_only=on' };

// set by the CLI: tries to bring the network back (the VPN) after a failed GitLab call, fetch or push
export const network: { recover?: () => Promise<boolean> } = {};

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export type ExecOptions = {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shell?: boolean;
  // called with each stdout chunk as it arrives
  onStdout?: (chunk: string) => void;
};

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => {
      stdout += d;
      opts.onStdout?.(String(d));
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.end(opts.input ?? '');
  });
}

export async function execOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await exec(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}): ${(res.stderr || res.stdout).trim().slice(-2000)}`);
  }
  return res.stdout;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
}

export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Prompt variable {{${key}}} is not set`);
    return String(value);
  });
}

export function fill(format: string, vars: Record<string, string>): string {
  return format.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

export function tail(text: string, chars = 4000): string {
  return text.length > chars ? '…' + text.slice(-chars) : text;
}

export function now(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  aroundLiveLine(() => process.stderr.write(`[${time}] ${message}\n`));
}

export class PipelineStop extends Error {
  // a clean, expected stop: waiting on a human, or a limit reached
  readonly kind: 'waiting' | 'failed';
  constructor(kind: 'waiting' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}
