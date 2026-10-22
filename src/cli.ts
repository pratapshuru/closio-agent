import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, repoPath, resolveModels, type Config } from './config.ts';
import { figmaMcpStatus } from './design.ts';
import * as g from './git.ts';
import { GitLab } from './gitlab.ts';
import { Jira } from './jira.ts';
import { Run, type StartOptions } from './pipeline.ts';
import { scoreReplay } from './score.ts';
import { buildSprintContext } from './sprint.ts';
import { runSprintPlan } from './sprintplan.ts';
import { hasRun, listRuns, runsDir, totals } from './state.ts';
import { exec, log, network, PipelineStop } from './util.ts';
import { connect, disconnect, ensureVpn, reachable, vpnRunning } from './vpn.ts';

// how often `agent watch` checks for QA questions on Jira (free API, no AI tokens unless there's a question)
const JIRA_CHECK_MINUTES = 5;

// how often `agent watch` checks GitLab and Jira; checks cost no AI tokens
const WATCH_INTERVAL_MINUTES = 30;

const HELP = `closio-agent: ticket to merge request, with an independent reviewer

Usage:
  agent run <KEY> [options]        start or continue a ticket (resumes where it stopped)
  agent status [KEY]               show runs, or one run in detail
  agent answer <KEY> "<text>"      answer the agent's pending questions
  agent feedback <KEY> "<text>"    give the agent feedback after the MR is open
  agent sync [KEY]                 check now: QA questions → answer; MRs merged → Ready For Test, conflicts → rebase, comments → fix
  agent watch [--interval 30]      answer QA-Question comments every 5 min; check open MRs and paused runs every N min (default 30)
  agent sprint-plan [KEY]          once per sprint: AI reads the whole sprint and writes a local report
                                   (model: profile's planner; override with --set planner=provider:model[:effort])
                                   (dependencies, start order, FE/BE pairs, collisions, ticket issues)
  agent rebase <KEY> [--repo key]  rebase the MR branch onto the latest target branch now, even without a conflict
                                   (backup branch first; conflicts → dev agent → checks, tests, reviewer → push)
  agent impact <KEY> [--post]      what this ticket's changes and gaps affect: other tickets, uncovered work, spec
                                   (runs by itself before the MR opens when there are any; --post notes it on affected tickets)
  agent align <KEY>                check the ticket against its connected tickets now (also runs before every MR)
  agent sprint <KEY>               refresh the sprint map for this ticket's sprint and print where it is
  agent session <KEY>              print the command to open a safe copy of the dev agent's conversation
  agent replay <NAME> --repo <key> --base <sha> --reference <sha> --ticket-file <md> [options]
                                   rebuild an already-merged ticket from its parent commit and score it
  agent score <NAME>               (re)score a finished replay
  agent clean <KEY>                remove a finished run's worktrees and its backup branches
  agent vpn [off|status]           connect the VPN (openfortivpn + browser SSO), disconnect it, or show its state
  agent doctor                     check config, CLIs, credentials and repos

Options for run/replay:
  --profile <name>                 model profile from agent.config.yaml (quality, balanced, cheap, claude-only)
  --set role=provider:model[:effort]   override one role, e.g. --set reviewer=claude:opus:high
  --repos a,b                      repos to work in (default: from ticket labels or title)
  --spec <file>                    techspec PDF or markdown (repeatable)
  --context <dir>                  extra material: screenshots, Figma layer dumps, notes (repeatable)
  --base <KEY|develop>             build on this ticket's branch, or on the target branch (overrides the bot's dependency choice)
  --related A,B                    also treat these tickets as connected
  --allow-edit <path>              let this run edit a protected file or folder (repeatable)
  --parent <KEY>                   bug ticket: the story it's a bug in (default: found from Jira links)
  --fresh                          bug ticket: don't start from the story's conversation
  --ticket-file <md>               use a local ticket instead of Jira (no Jira updates)
  --no-publish                     stop before push/MR
  --auto-answer                    never wait on humans; take the agent's recommendation and log it
  --ask                            ask you every grill decision (options, recommendation) instead of letting the agent choose
  --simulate                       trial run on a live ticket: read Jira but never write to it (see runs/<KEY>/would-post.md);
                                   MRs are opened as drafts with no reviewers
`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      set: { type: 'string', multiple: true },
      repos: { type: 'string' },
      spec: { type: 'string', multiple: true },
      context: { type: 'string', multiple: true },
      'ticket-file': { type: 'string' },
      'no-publish': { type: 'boolean' },
      'auto-answer': { type: 'boolean' },
      ask: { type: 'boolean' },
      simulate: { type: 'boolean' },
      repo: { type: 'string' },
      base: { type: 'string' },
      reference: { type: 'string' },
      interval: { type: 'string' },
      related: { type: 'string' },
      post: { type: 'boolean' },
      'allow-edit': { type: 'string', multiple: true },
      parent: { type: 'string' },
      fresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function startOptions(key: string, v: ReturnType<typeof parse>['values'], replay?: StartOptions['replay']): StartOptions {
  return {
    key,
    profile: v.profile,
    set: v.set,
    repos: v.repos?.split(',').map((s) => s.trim()).filter(Boolean),
    specs: (v.spec ?? []).map((p) => path.resolve(p)),
    contexts: (v.context ?? []).map((p) => path.resolve(p)),
    ticketFile: v['ticket-file'] ? path.resolve(v['ticket-file']) : undefined,
    publish: !v['no-publish'],
    jira: !v['ticket-file'],
    autoAnswer: Boolean(v['auto-answer']) || Boolean(replay),
    ask: Boolean(v.ask) && !v['auto-answer'] && !replay,
    simulate: Boolean(v.simulate),
    replay,
    // for replays --base is the starting commit, handled separately
    base: !replay && v.base ? (/^[a-z]+-\d+$/i.test(v.base) ? v.base.toUpperCase() : v.base) : undefined,
    related: v.related?.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean),
    allowEdit: v['allow-edit'],
    parent: v.parent?.toUpperCase(),
    fresh: Boolean(v.fresh),
  };
}

async function drive(run: Run, opts?: StartOptions): Promise<number> {
  try {
    await run.advance(opts);
    if (run.state.phase === 'in_review') {
      console.log(`\n${run.state.key} is in code review.`);
      for (const r of Object.values(run.state.repos)) if (r.mr) console.log(`  ${r.key}: ${r.mr.url}`);
      console.log(`Run \`agent watch\` (or \`agent sync ${run.state.key}\`) to handle review comments, conflicts and the merge.`);
    } else if (run.state.phase === 'done') {
      console.log(`\n${run.state.key} done. Artifacts in ${run.dir}`);
    }
    printTotals(run);
    return 0;
  } catch (err) {
    if (err instanceof PipelineStop) {
      console.log(`\n${run.state.key}: ${err.message}`);
      printTotals(run);
      return err.kind === 'waiting' ? 0 : 1;
    }
    console.error(`\n${run.state.key} stopped in phase '${run.state.phase}': ${(err as Error).message}`);
    console.error(`Fix the cause and re-run \`agent run ${run.state.key}\` to continue from there. Logs: ${path.join(run.dir, 'logs')}`);
    return 1;
  }
}

function printTotals(run: Run): void {
  const t = totals(run.state);
  console.log(`(${t.calls} agent calls, ~$${t.costUsd.toFixed(2)} reported, ${t.minutes.toFixed(0)} agent-minutes)`);
}

function status(config: Config, key?: string): void {
  if (!key) {
    const runs = listRuns(config);
    if (!runs.length) return console.log('No runs yet.');
    for (const r of runs) {
      const t = totals(r);
      const chunks = r.plan ? `${r.nextChunk}/${r.plan.chunks.length} chunks` : '';
      console.log(`${r.key.padEnd(14)} ${r.phase.padEnd(17)} ${chunks.padEnd(12)} $${t.costUsd.toFixed(2).padStart(6)}  ${r.summary.slice(0, 60)}${r.error ? `  ⚠ ${r.error.slice(0, 80)}` : ''}`);
    }
    return;
  }
  const run = Run.load(config, key);
  const s = run.state;
  console.log(`${s.key}: ${s.summary}\nphase: ${s.phase}${s.error ? `\nerror: ${s.error}` : ''}`);
  if (s.plan) {
    console.log(`\nplan (${run.file('plan.md')}):`);
    s.plan.chunks.forEach((c, i) => console.log(`  ${i < s.nextChunk ? '✓' : i === s.nextChunk ? '→' : ' '} ${c.id} [${c.repo}] ${c.title}`));
  }
  for (const r of Object.values(s.repos)) {
    console.log(`\n${r.key}: ${r.worktree}`);
    r.commits.forEach((c) => console.log(`  ${c.sha.slice(0, 8)} ${c.message}`));
    if (r.mr) console.log(`  MR: ${r.mr.url}`);
  }
  if (s.questions.pending.length) console.log(`\nwaiting on: ${run.file('questions.md')}`);
  if (s.disagreements.length) console.log(`\n${s.disagreements.length} unresolved reviewer disagreement(s), listed in the MR description`);
  printTotals(run);
}

async function doctor(config: Config): Promise<number> {
  let bad = 0;
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      console.log(`✓ ${label}: ${await fn()}`);
    } catch (err) {
      bad++;
      console.log(`✗ ${label}: ${(err as Error).message.split('\n')[0]}`);
    }
  };
  for (const bin of ['claude', 'codex', 'pdftotext', 'git']) {
    await check(bin, async () => {
      const res = await exec(bin, [bin === 'pdftotext' ? '-v' : '--version']);
      if (res.code !== 0 && bin !== 'pdftotext') throw new Error('not working');
      return (res.stdout || res.stderr).split('\n')[0].trim();
    });
  }
  await check('jira', async () => `${(await new Jira(config).myself()).displayName}`);
  await check('gitlab', async () => `${(await new GitLab(config).me()).username}`);
  for (const key of Object.keys(config.repos)) {
    await check(`repo ${key}`, async () => {
      const p = repoPath(config, key);
      if (!fs.existsSync(path.join(p, '.git'))) throw new Error(`${p} is not a git repo`);
      return `${p} (on ${await g.currentBranch(p)})`;
    });
  }
  // optional, so a warning rather than a failure
  if (config.vpn) {
    const installed = fs.existsSync('/opt/homebrew/bin/openfortivpn');
    const allowed = installed && (await exec('sudo', ['-n', '-l', '/opt/homebrew/bin/openfortivpn'])).code === 0;
    if (allowed) console.log(`✓ vpn auto-connect: openfortivpn ready (${config.vpn.gateway})`);
    else console.log(`⚠ vpn auto-connect: ${installed ? 'needs the one-time admin rule (README, "VPN")' : 'brew install openfortivpn'}`);
  }
  const figma = await figmaMcpStatus();
  if (figma === 'connected') console.log('✓ figma mcp: connected');
  else if (figma === 'needs_auth') console.log('⚠ figma mcp (optional): needs login. Run claude, type /mcp, choose figma');
  else console.log('⚠ figma mcp (optional): not set up. claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp, then /mcp in claude to log in. Without it, drop design files in runs/<KEY>/1-input/design/');
  return bad ? 1 : 0;
}

// commands that talk to GitLab or fetch from it; each makes sure the VPN is up first
const NEEDS_GITLAB = new Set(['run', 'answer', 'feedback', 'sync', 'rebase', 'align', 'impact', 'sprint', 'sprint-plan']);

async function preflight(config: Config): Promise<void> {
  for (;;) {
    if (await ensureVpn(config)) return;
    // nobody at the terminal, or no auto-connect set up: carry on, a later step says what failed
    if (!config.vpn || !process.stdin.isTTY || process.env.CLOSIO_AGENT_NO_PROMPT) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const a = (await rl.question('VPN is not up. Finish the browser login (or connect FortiClient), then press Enter to retry, or type "skip": ')).trim();
    rl.close();
    if (/^skip$/i.test(a)) return;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  const { values: v, positionals: [key, text] } = parse(rest);
  const config = loadConfig();
  network.recover = () => ensureVpn(config);
  if (NEEDS_GITLAB.has(command)) await preflight(config);

  switch (command) {
    case 'run': {
      if (!key) throw new Error('Usage: agent run <KEY>');
      const opts = startOptions(key, v);
      if (hasRun(config, key)) {
        const run = Run.load(config, key);
        // before anything that could touch Jira, including the in-review check below
        if (v.simulate && !run.state.simulate) {
          // its branches already carry the real name, so it can't become a clean simulation now
          if (Object.keys(run.state.repos).length) {
            throw new Error(`${key} already has its branches, so it can't become a simulation now. To try it as one: \`agent clean ${key}\`, delete runs/${key}, then \`agent run ${key} --simulate\`.`);
          }
          run.state.simulate = true;
          log('  simulating from now on: Jira is only read');
          run.save();
        }
        if (run.state.phase === 'in_review') {
          console.log(await run.sync());
          return 0;
        }
        log(`continuing ${key} from '${run.state.phase}'`);
        if (v.ask && !run.state.autoAnswer && !run.state.askGrill) {
          run.state.askGrill = true;
          log('  grill decisions will be asked of you from now on');
          run.save();
        }
        if (v['allow-edit']?.length) {
          run.state.allowEdit = [...new Set([...(run.state.allowEdit ?? []), ...v['allow-edit']])];
          log(`  may edit protected: ${run.state.allowEdit.join(', ')}`);
          run.save();
        }
        // --profile/--set on a run in progress switch its models from here on
        if (v.profile || v.set?.length) {
          const before = run.state.models.reviewer;
          run.state.models = resolveModels(config, v.profile, v.set);
          const after = run.state.models.reviewer;
          if (before.provider !== after.provider || before.model !== after.model) run.state.reviewerSession = undefined;
          log(`  models now: ${Object.entries(run.state.models).map(([r, m]) => `${r}=${m.provider}:${m.model ?? 'default'}`).join(', ')}`);
          run.save();
        }
        return drive(run);
      }
      return drive(Run.create(config, opts), opts);
    }
    case 'replay': {
      if (!key || !v.repo || !v.base || !v['ticket-file']) throw new Error('Usage: agent replay <NAME> --repo <key> --base <sha> --reference <sha> --ticket-file <md>');
      if (hasRun(config, key)) {
        const run = Run.load(config, key);
        const code = await drive(run);
        if (run.state.phase === 'done' && run.state.replay?.reference) console.log('\n' + (await scoreReplay(run)));
        return code;
      }
      const source = repoPath(config, v.repo);
      const base = await g.git(source, 'rev-parse', v.base);
      const reference = v.reference ? await g.git(source, 'rev-parse', v.reference) : undefined;
      const opts = startOptions(key, v, { repo: v.repo, base, reference });
      const run = Run.create(config, opts);
      const code = await drive(run, opts);
      if (run.state.phase === 'done' && reference) console.log('\n' + (await scoreReplay(run)));
      return code;
    }
    case 'score': {
      if (!key) throw new Error('Usage: agent score <NAME>');
      console.log(await scoreReplay(Run.load(config, key)));
      return 0;
    }
    case 'status':
      status(config, key);
      return 0;
    case 'answer': {
      if (!key) throw new Error('Usage: agent answer <KEY> "<answer text>"');
      const run = Run.load(config, key);
      // grill questions are answered one at a time at the prompt
      if (run.state.waitingFor === 'grill') return drive(run);
      if (!text) throw new Error('Usage: agent answer <KEY> "<answer text>"');
      run.state.questions.inbox.push(`Developer (CLI): ${text}`);
      run.save();
      if (run.state.phase !== 'awaiting_answers') {
        console.log(`Saved. ${key} is not waiting on answers right now (phase ${run.state.phase}); it will use this as a decision.`);
        run.state.questions.answers.push(`Developer (CLI): ${text}`);
        run.state.questions.inbox = [];
        run.save();
        return 0;
      }
      return drive(run);
    }
    case 'feedback': {
      if (!key || !text) throw new Error('Usage: agent feedback <KEY> "<feedback>"');
      const run = Run.load(config, key);
      if (!['in_review', 'done'].includes(run.state.phase)) throw new Error(`${key} has no MR yet (phase ${run.state.phase})`);
      await run.feedback([{ id: `manual:${Date.now()}`, source: 'manual', text: `Developer: ${text}` }]);
      console.log('Feedback handled and pushed.');
      return 0;
    }
    case 'sync': {
      const runs = key ? [Run.load(config, key)] : listRuns(config).filter((r) => ['in_review', 'done'].includes(r.phase)).map((r) => Run.load(config, r.key));
      for (const run of runs) {
        for (const line of await run.qaCheck()) console.log(line);
        if (run.state.phase === 'in_review') console.log(await run.sync());
      }
      if (!runs.length) console.log('No runs in code review or testing.');
      return 0;
    }
    case 'watch': {
      const minutes = Number(v.interval ?? WATCH_INTERVAL_MINUTES);
      log(`watching: QA questions on Jira every ${JIRA_CHECK_MINUTES} min, MRs every ${minutes} min (Ctrl+C to stop)`);
      // unattended: new questions go to Jira instead of waiting on this terminal
      process.env.CLOSIO_AGENT_NO_PROMPT = '1';
      let lastMrCheck = 0;
      for (;;) {
        // Jira needs no VPN, so QA questions are answered even when GitLab is unreachable
        for (const r of listRuns(config)) {
          if (!['in_review', 'done'].includes(r.phase)) continue;
          try {
            for (const line of await Run.load(config, r.key).qaCheck()) console.log(line);
          } catch (err) {
            log(`${r.key}: ${(err as Error).message}`);
          }
        }
        if (Date.now() - lastMrCheck >= minutes * 60_000) {
          if (await ensureVpn(config)) {
            lastMrCheck = Date.now();
            for (const r of listRuns(config)) {
              try {
                const run = Run.load(config, r.key);
                if (r.phase === 'in_review') console.log(await run.sync());
                if (r.phase === 'awaiting_answers') await drive(run);
              } catch (err) {
                log(`${r.key}: ${(err as Error).message}`);
              }
            }
          } else log('VPN not up; MR checks wait for the next round');
        }
        await new Promise((res) => setTimeout(res, JIRA_CHECK_MINUTES * 60_000));
      }
    }
    case 'rebase': {
      if (!key) throw new Error('Usage: agent rebase <KEY> [--repo <key>]');
      const run = Run.load(config, key);
      if (!['in_review', 'done'].includes(run.state.phase)) throw new Error(`${key} is ${run.state.phase}; rebase is for a finished branch (after the MR is open)`);
      const repos = Object.values(run.state.repos).filter((r) => r.commits.length && (!v.repo || r.key === v.repo));
      if (!repos.length) throw new Error(v.repo ? `${key} has no commits in ${v.repo}` : `${key} has no commits to rebase`);
      for (const r of repos) {
        // a stacked branch follows its parent until the parent merges
        if (r.parent) {
          console.log(`${r.key}: built on ${r.parent.ticket}, so it follows that branch. Run \`agent align ${key}\` to move it onto ${r.parent.ticket}'s latest; rebase onto the target once ${r.parent.ticket} merges.`);
          continue;
        }
        await run.rebase(r.key);
        console.log(`${r.key}: rebased and pushed`);
      }
      return 0;
    }
    case 'impact': {
      if (!key) throw new Error('Usage: agent impact <KEY> [--post]');
      const run = Run.load(config, key);
      if (v.post) {
        if (!run.state.impact) throw new Error(`No impact report for ${key} yet. Run \`agent impact ${key}\` first and read it.`);
        const posted = await run.postImpact();
        console.log(posted.length ? `Noted on ${posted.join(', ')}` : 'Nothing new to post');
        return 0;
      }
      if (!run.state.changes?.length && !run.state.plan?.gaps?.length) {
        console.log(`${key} has no recorded changes from the ticket and no gaps, so nothing else should be affected.`);
        return 0;
      }
      await run.impact();
      console.log(fs.readFileSync(run.file('impact.md'), 'utf8'));
      return 0;
    }
    case 'align': {
      if (!key) throw new Error('Usage: agent align <KEY>');
      const run = Run.load(config, key);
      if (!run.state.plan) throw new Error(`${key} has no plan yet`);
      const changed = await run.align('manual');
      if (changed) {
        for (const r of Object.values(run.state.repos)) {
          if (r.mr) {
            await g.push(r.worktree, r.branch, true);
            r.pushedSha = await g.head(r.worktree);
          }
        }
        run.save();
      }
      const issues = run.state.alignment ?? [];
      console.log(issues.length ? issues.map((a) => `${a.ticket} [${a.action}]: ${a.problem}`).join('\n') : 'Aligned with all connected tickets.');
      if (changed) console.log(Object.values(run.state.repos).some((r) => r.mr) ? 'Fixes committed and pushed.' : 'Fixes committed.');
      return 0;
    }
    case 'sprint-plan': {
      const { md, costUsd } = await runSprintPlan(config, new Jira(config), { key, profile: v.profile, set: v.set });
      console.log(`Sprint plan: ${md}${costUsd ? ` (~$${costUsd.toFixed(2)})` : ''}\nShare it with the tech lead. Every run in this sprint reads the parts about its ticket.`);
      return 0;
    }
    case 'sprint': {
      if (!key) throw new Error('Usage: agent sprint <KEY>');
      const jira = new Jira(config);
      const issue = await jira.getIssue(key);
      const ctx = await buildSprintContext({ config, jira, issue, key, ticketText: issue.description, relatedDir: path.join(runsDir(config), '_sprint', key), forcedRelated: [], ownRuns: [] });
      console.log(ctx.sprintFile ? `${ctx.sprintName}: ${ctx.sprintFile}` : `${key} is not in a sprint or epic`);
      return 0;
    }
    case 'session': {
      if (!key) throw new Error('Usage: agent session <KEY>');
      const run = Run.load(config, key);
      const s = run.state.devSession;
      if (!s) throw new Error('No dev session yet');
      // a fork is a copy: reading or chatting in it never touches the conversation the pipeline resumes
      const cmd = s.provider === 'claude' ? `claude --resume ${s.id} --fork-session` : `codex resume ${s.id}`;
      console.log(`cd ${run.root} && ${cmd}`);
      if (s.provider === 'claude') console.log('(opens a copy, so the pipeline is not affected; it shows the conversation up to now)');
      else console.log('(codex: read only, don\'t type while a run is going)');
      return 0;
    }
    case 'clean': {
      if (!key) throw new Error('Usage: agent clean <KEY>');
      const run = Run.load(config, key);
      for (const r of Object.values(run.state.repos)) {
        if ((await g.changedFiles(r.worktree)).length) throw new Error(`${r.worktree} has uncommitted changes; not removing`);
        await g.removeWorktree(repoPath(config, r.key), r.worktree);
        console.log(`removed ${r.worktree}`);
        for (const b of r.backups ?? []) {
          await g.git(repoPath(config, r.key), 'branch', '-D', b).catch(() => undefined);
          console.log(`removed backup branch ${b}`);
        }
      }
      return 0;
    }
    case 'vpn': {
      if (key === 'off') {
        await disconnect();
        console.log((await vpnRunning()) ? 'openfortivpn is still running' : 'VPN disconnected');
        return 0;
      }
      const up = await reachable(config);
      if (key === 'status' || up) {
        console.log(`GitLab ${up ? 'reachable' : 'not reachable'}; openfortivpn ${(await vpnRunning()) ? 'running' : 'not running'}`);
        return 0;
      }
      return (await connect(config)) ? 0 : 1;
    }
    case 'doctor':
      return doctor(config);
    default:
      console.log(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
