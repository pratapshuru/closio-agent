import fs from 'node:fs';
import path from 'node:path';
import type { Gate, Repo } from './config.ts';
import { ensureDir, exec, SAFE_ENV, tail } from './util.ts';

export type GateResult = {
  cmd: string;
  ok: boolean;
  skipped: boolean;
  failures: string[];
  // failures that already existed before this ticket's changes
  preexisting: string[];
  output: string;
};

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function rel(cwd: string, file: string): string {
  return path.isAbsolute(file) ? path.relative(cwd, file) : file;
}

function parseVitest(cwd: string, raw: string): string[] {
  const data = JSON.parse(raw);
  const failures: string[] = [];
  for (const suite of data.testResults ?? []) {
    const file = rel(cwd, suite.name);
    const failed = (suite.assertionResults ?? []).filter((a: any) => a.status === 'failed');
    for (const a of failed) failures.push(`${file} > ${a.fullName}`);
    if (suite.status === 'failed' && !failed.length) failures.push(`${file} (suite failed to run)`);
  }
  return failures;
}

function parseMocha(cwd: string, raw: string): string[] {
  const data = JSON.parse(raw);
  return (data.failures ?? []).map((f: any) => `${rel(cwd, f.file ?? '?')} > ${f.fullTitle}`);
}

function parseEslint(cwd: string, raw: string): string[] {
  const data = JSON.parse(raw);
  const failures: string[] = [];
  for (const file of data) {
    for (const m of file.messages ?? []) {
      if (m.severity === 2) failures.push(`${rel(cwd, file.filePath)} ${m.ruleId ?? 'parse-error'}`);
    }
  }
  return failures;
}

const PARSERS = { 'vitest-json': parseVitest, 'mocha-json': parseMocha, 'eslint-json': parseEslint } as const;

async function runOne(gate: Gate, cwd: string, files: string[], outDir: string, label: string): Promise<{ failures: string[]; output: string; crashed: boolean }> {
  const out = path.join(outDir, `${label}.json`);
  fs.rmSync(out, { force: true });
  const cmd = gate.cmd
    .replaceAll('{files}', files.map(shellQuote).join(' '))
    .replaceAll('{out}', shellQuote(out))
    .replaceAll('{tmp}', shellQuote(outDir));
  const res = await exec('sh', ['-c', cmd], { cwd, timeoutMs: gate.timeout_min * 60_000, env: { ...process.env, ...SAFE_ENV, CI: 'true', FORCE_COLOR: '0' } });
  const output = tail(`$ ${cmd}\n${res.stdout}\n${res.stderr}`, 6000);
  if (res.timedOut) return { failures: [`timed out after ${gate.timeout_min} min`], output, crashed: true };
  if (gate.parser === 'exit-code') return { failures: res.code === 0 ? [] : [`exit code ${res.code}`], output, crashed: false };
  if (!fs.existsSync(out)) {
    if (/No test files found/i.test(res.stdout + res.stderr)) return { failures: [], output, crashed: false };
    return { failures: [`gate crashed before writing results (exit ${res.code})`], output, crashed: true };
  }
  try {
    return { failures: PARSERS[gate.parser](cwd, fs.readFileSync(out, 'utf8')), output, crashed: false };
  } catch (err) {
    return { failures: [`could not parse gate output: ${(err as Error).message}`], output, crashed: true };
  }
}

function matchingFiles(gate: Gate, changed: string[], cwd: string): string[] {
  const re = gate.match ? new RegExp(gate.match) : null;
  return changed.filter((f) => (!re || re.test(f)) && fs.existsSync(path.join(cwd, f)));
}

// failures present before the ticket, per gate command, so gates only fail on new breakage
export type Baseline = Record<string, string[]>;

export async function computeBaseline(repo: Repo, cwd: string, outDir: string): Promise<Baseline> {
  ensureDir(outDir);
  const baseline: Baseline = {};
  const gates = [...repo.gates.focused, ...repo.gates.final].filter((g) => g.scope === 'all');
  let i = 0;
  for (const gate of gates) {
    if (gate.cmd in baseline) continue;
    const res = await runOne(gate, cwd, [], outDir, `baseline-${i++}`);
    // a crashing gate is a config problem, and caching it would hide later crashes
    if (res.crashed) throw new Error(`Gate could not run on the untouched branch, so it cannot judge changes. Fix the command in agent.config.yaml:\n${res.output}`);
    baseline[gate.cmd] = res.failures;
  }
  return baseline;
}

// eslint on the base version of a file, fed via stdin, to know which errors were already there
async function eslintBaseline(gate: Gate, cwd: string, files: string[], base: string): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const original = await exec('git', ['-C', cwd, 'show', `${base}:${file}`]);
    if (original.code !== 0) continue;
    const cmd = gate.cmd.replace(/-o \{out\}/, '').replace('{files}', `--stdin --stdin-filename ${shellQuote(file)}`);
    const res = await exec('sh', ['-c', cmd], { cwd, input: original.stdout });
    try {
      failures.push(...parseEslint(cwd, res.stdout));
    } catch {
      // unparsable baseline just means we cannot discount anything
    }
  }
  return failures;
}

export async function runGates(
  gates: Gate[],
  cwd: string,
  changed: string[],
  baseline: Baseline,
  base: string,
  outDir: string,
  label: string,
): Promise<GateResult[]> {
  ensureDir(outDir);
  const results: GateResult[] = [];
  for (const [i, gate] of gates.entries()) {
    const files = gate.scope === 'changed' ? matchingFiles(gate, changed, cwd) : [];
    if (gate.scope === 'changed' && !files.length) {
      results.push({ cmd: gate.cmd, ok: true, skipped: true, failures: [], preexisting: [], output: 'no matching changed files' });
      continue;
    }
    const res = await runOne(gate, cwd, files, outDir, `${label}-${i}`);
    let known = baseline[gate.cmd] ?? [];
    if (gate.parser === 'eslint-json' && gate.scope === 'changed') known = await eslintBaseline(gate, cwd, files, base);
    // vitest related and the full suite share one baseline
    if (gate.parser === 'vitest-json') known = Object.entries(baseline).filter(([cmd]) => cmd.includes('vitest')).flatMap(([, f]) => f);
    const knownSet = new Set(known);
    const fresh = res.crashed ? res.failures : res.failures.filter((f) => !knownSet.has(f));
    results.push({
      cmd: gate.cmd,
      ok: fresh.length === 0,
      skipped: false,
      failures: fresh,
      preexisting: res.crashed ? [] : res.failures.filter((f) => knownSet.has(f)),
      output: res.output,
    });
  }
  return results;
}

export function gatesOk(results: GateResult[]): boolean {
  return results.every((r) => r.ok);
}

export function gateReport(results: GateResult[]): string {
  if (!results.length) return 'No gates configured for this repo.';
  return results
    .map((r) => {
      const head = `- \`${r.cmd.split(' ').slice(0, 4).join(' ')}…\`: ${r.skipped ? 'skipped (no matching files)' : r.ok ? 'PASS' : `FAIL (${r.failures.length} new)`}`;
      const pre = r.preexisting.length ? ` (${r.preexisting.length} failure${r.preexisting.length === 1 ? '' : 's'} already present before this ticket, ignored)` : '';
      const list = r.failures.slice(0, 25).map((f) => `    - ${f}`).join('\n');
      return [head + pre, list].filter(Boolean).join('\n');
    })
    .join('\n');
}

export function gateFailureDetail(results: GateResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `### ${r.cmd}\nNew failures:\n${r.failures.map((f) => `- ${f}`).join('\n')}\n\nOutput (tail):\n\`\`\`\n${r.output}\n\`\`\``)
    .join('\n\n');
}
