import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from './config.ts';
import * as g from './git.ts';
import { runGates } from './gates.ts';
import type { Run } from './pipeline.ts';
import { scratchDir, totals } from './state.ts';
import { exec, log, writeText } from './util.ts';

const TEST_FILE = /(__tests__\/|\.test\.|\.spec\.|^test\/)/;

function overlap(ours: string[], theirs: string[]) {
  const a = new Set(ours);
  const both = theirs.filter((f) => a.has(f));
  return {
    both,
    precision: ours.length ? both.length / ours.length : 0,
    recall: theirs.length ? both.length / theirs.length : 0,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

// compares a replay run with the change that actually merged for the same ticket
export async function scoreReplay(run: Run): Promise<string> {
  const replay = run.state.replay;
  if (!replay?.reference) throw new Error('This run has no --reference commit to score against');
  const repo = run.state.repos[replay.repo];
  const source = repoPath(run.config, replay.repo);
  const kind = run.config.repos[replay.repo].kind;

  const refFiles = (await g.git(source, 'diff', '--name-only', replay.base, replay.reference)).split('\n').filter(Boolean);
  const ourFiles = (await g.git(repo.worktree, 'diff', '--name-only', `${replay.base}...HEAD`)).split('\n').filter(Boolean);
  const src = overlap(ourFiles.filter((f) => !TEST_FILE.test(f)), refFiles.filter((f) => !TEST_FILE.test(f)));
  const refStat = await g.git(source, 'diff', '--shortstat', replay.base, replay.reference);
  const ourStat = await g.git(repo.worktree, 'diff', '--shortstat', `${replay.base}...HEAD`);

  // the human's own tests from the merged change, run against the pipeline's code
  const hidden = refFiles.filter((f) => TEST_FILE.test(f));
  let hiddenSummary = 'No test files in the reference change.';
  let hiddenFailures: string[] = [];
  if (hidden.length) {
    const tmp = path.join(scratchDir(run.config), 'score', run.state.key);
    if (fs.existsSync(tmp)) await g.removeWorktree(source, tmp);
    await g.git(source, 'worktree', 'add', '--detach', tmp, await g.head(repo.worktree));
    try {
      await g.linkDependencies(source, tmp, run.config.repos[replay.repo].install);
      const present: string[] = [];
      for (const f of hidden) {
        const res = await exec('git', ['-C', tmp, 'checkout', replay.reference, '--', f]);
        if (res.code === 0) present.push(f);
      }
      const gate = kind === 'frontend'
        ? { cmd: 'npx vitest run --reporter=json --outputFile={out} {files}', parser: 'vitest-json' as const, scope: 'changed' as const, timeout_min: 20 }
        : { cmd: 'DOTENV_CONFIG_PATH=.env.example npx cross-env NODE_ENV=test APP_LOG_DIR=./.test-logs mocha --require dotenv/config --exit --reporter json --reporter-option output={out} {files}', parser: 'mocha-json' as const, scope: 'changed' as const, timeout_min: 20 };
      log(`  running ${present.length} hidden test file(s) from the reference change`);
      const [result] = await runGates([gate], tmp, present, {}, replay.base, run.file('score'), 'hidden');
      hiddenFailures = result.failures;
      const raw = path.join(run.file('score'), 'hidden-0.json');
      let total = 0;
      if (fs.existsSync(raw)) {
        const data = JSON.parse(fs.readFileSync(raw, 'utf8'));
        total = kind === 'frontend' ? data.numTotalTests ?? 0 : data.stats?.tests ?? 0;
      }
      const suiteErrors = hiddenFailures.filter((f) => f.includes('suite failed'));
      hiddenSummary = `${present.length} test file(s), ${total} tests: ${total - (hiddenFailures.length - suiteErrors.length)} passed, ${hiddenFailures.length - suiteErrors.length} failed, ${suiteErrors.length} suite(s) could not load (usually different file or export names, not wrong behaviour).`;
    } finally {
      await g.removeWorktree(source, tmp);
    }
  }

  const t = totals(run.state);
  const reviews = run.state.ledger.filter((e) => e.ok && /review|audit/.test(e.step)).length;
  const asked = run.state.assumptions.filter((a) => a.startsWith('Auto-answered')).length;

  const ours = await g.git(repo.worktree, 'diff', `${replay.base}...HEAD`);
  const theirs = await g.git(source, 'diff', replay.base, replay.reference);
  const flip = Math.random() < 0.5;
  writeText(run.file('blind', 'A.patch'), flip ? ours : theirs);
  writeText(run.file('blind', 'B.patch'), flip ? theirs : ours);
  writeText(run.file('blind', '.key'), `A=${flip ? 'pipeline' : 'human'} B=${flip ? 'human' : 'pipeline'}`);

  const card = [
    `# Replay scorecard: ${run.state.key}`,
    `Repo ${replay.repo}, base \`${replay.base.slice(0, 10)}\`, reference \`${replay.reference.slice(0, 10)}\`, profile ${Object.entries(run.state.models).map(([r, m]) => `${r}=${m.provider}:${m.model ?? 'default'}`).join(', ')}`,
    `## Hidden tests (the human's tests run against the pipeline's code)\n\n${hiddenSummary}${hiddenFailures.length ? '\n\n' + hiddenFailures.slice(0, 40).map((f) => `- ${f}`).join('\n') : ''}`,
    `## Scope\n\n| | Pipeline | Human |\n|---|---|---|\n| Diff | ${ourStat || 'none'} | ${refStat} |\n| Source files | ${ourFiles.filter((f) => !TEST_FILE.test(f)).length} | ${refFiles.filter((f) => !TEST_FILE.test(f)).length} |\n\nSource files in common: ${src.both.length} (precision ${pct(src.precision)}, recall ${pct(src.recall)}). Low overlap is not automatically wrong; read the blind patches.`,
    `## Process\n\n- Phase: ${run.state.phase}\n- Commits: ${repo.commits.length}\n- Agent calls: ${t.calls}, reviews/audits: ${reviews}\n- Questions that would have gone to a human: ${asked}\n- Unresolved reviewer disagreements: ${run.state.disagreements.length}\n- Cost: ~$${t.costUsd.toFixed(2)} (Claude reports cost; Codex reports tokens only)\n- Agent time: ${t.minutes.toFixed(0)} min`,
    `## Blind review\n\n\`blind/A.patch\` and \`blind/B.patch\` are the pipeline's and the human's change in random order. The answer is in \`blind/.key\`. Ask the tech lead which one they would approve, and why, before revealing it.`,
  ].join('\n\n');
  writeText(run.file('scorecard.md'), card);
  return card;
}
