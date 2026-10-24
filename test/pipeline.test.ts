import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Run, type StartOptions } from '../src/pipeline.ts';
import { clearFakes, registerFake } from '../src/providers.ts';
import { PipelineStop } from '../src/util.ts';
import { approved, writeUp, plan, sandbox, sandboxWithRemote, sh, testConfig, work, wt } from './helpers.ts';

function start(root: string, repo: string, base: string, extra: Partial<StartOptions> = {}, ticketText = '# T-1 - add a feature\n\nBackend: add feature.js') {
  const config = testConfig(root, repo);
  // UI tickets run against a frontend repo, so they get the frontend base and the design step
  if (/frontend/i.test(ticketText)) config.repos.svc.kind = 'frontend';
  const ticket = path.join(root, 'ticket.md');
  fs.writeFileSync(ticket, ticketText);
  const opts: StartOptions = {
    key: 'T-1', specs: [], contexts: [], ticketFile: ticket, publish: false, jira: false, autoAnswer: true,
    replay: { repo: 'svc', base }, ...extra,
  };
  return { run: Run.create(config, opts), opts, config };
}

// a normal (non-replay) run against a repo with a real origin, no Jira
function startLive(root: string, repo: string, extra: Partial<StartOptions> = {}) {
  const config = testConfig(root, repo);
  const ticket = path.join(root, 'ticket.md');
  fs.writeFileSync(ticket, '# T-1 - Frontend - edit screen\n\nReuses the form from SCRUM-560.');
  const opts: StartOptions = { key: 'T-1', specs: [], contexts: [], ticketFile: ticket, publish: false, jira: false, autoAnswer: false, ...extra };
  return { run: Run.create(config, opts), opts, config };
}

const noAlignIssues = { summary: 'aligned', checked: [], issues: [], files_changed: [], commit_summary: '' };

function commonFakes() {
  registerFake('align', () => noAlignIssues);
  registerFake('plan', () => plan());
  registerFake('plan-review', () => approved);
  registerFake('audit', () => approved);
  registerFake('simplify', () => ({ suggestions: [] }));
  registerFake('write-up', () => writeUp);
}

afterEach(() => {
  clearFakes();
  delete process.env.CLOSIO_FIGMA_MCP;
});

const UI_TICKET = '# T-1 - Frontend - edit screen\n\nDesign: https://www.figma.com/design/Kx/SFA?node-id=1455-398825&t=x';

describe('pipeline', () => {
  it('runs a ticket from plan to a single reviewed commit', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'module.exports = 2;\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);

    expect(run.state.phase).toBe('done');
    const w = run.state.repos.svc.worktree;
    expect(sh(w, `git log --format=%s ${base}..HEAD`)).toBe('feat(T-1): add feature');
    expect(sh(w, 'git status --porcelain')).toBe('');
    expect(fs.existsSync(run.file('mr-svc.md'))).toBe(true);
    // the user's own checkout is untouched
    expect(sh(repo, 'git log --oneline').split('\n')).toHaveLength(1);
  });

  it("writes a handoff note for later tickets and gives the developer's brief to both bots", async () => {
    const { root, repo, base } = sandbox();
    fs.mkdirSync(path.join(root, 'runs', 'T-1', '1-input'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runs', 'T-1', '1-input', 'brief.md'), 'Reuse shared.js; Edit comes next.');
    commonFakes();
    const prompts: Record<string, string> = {};
    registerFake('plan', (call) => {
      prompts.plan = call.prompt;
      return plan({ upcoming: [{ ticket: 'T-2', needs: 'the shared form' }] });
    });
    registerFake('plan-review', (call) => {
      prompts.review = call.prompt;
      return approved;
    });
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);
    expect(prompts.plan).toContain(run.file('inputs', 'brief.md'));
    expect(prompts.review).toContain(run.file('inputs', 'brief.md'));
    expect(fs.readFileSync(path.join(root, 'runs', 'T-1', 'handoff-note.md'), 'utf8')).toContain('Built feature.js; reuse it.');
  });

  it('loops dev and reviewer until required findings are resolved, then commits once', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    let reviews = 0;
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'bug\n');
      return work();
    });
    registerFake('chunk-c1-fix', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'fixed\n');
      return work('add feature', [{ finding_id: 'F1', decision: 'accept', reasoning: 'right' }]);
    });
    registerFake('chunk-c1-review', () =>
      ++reviews === 1
        ? { ...approved, verdict: 'changes_required', findings: [{ id: 'F1', severity: 'high', title: 'bug', detail: 'd', location: 'feature.js:1', required: true }] }
        : approved,
    );
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);

    const w = run.state.repos.svc.worktree;
    expect(reviews).toBe(2);
    expect(sh(w, `git rev-list --count ${base}..HEAD`)).toBe('1');
    expect(fs.readFileSync(path.join(w, 'feature.js'), 'utf8')).toBe('fixed\n');
  });

  it('sends new gate failures back to the dev before review', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      fs.writeFileSync(path.join(wt(call), 'broken'), '');
      return work();
    });
    let fixed = false;
    registerFake('chunk-c1-gatefix', (call) => {
      fixed = true;
      fs.rmSync(path.join(wt(call), 'broken'));
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);
    expect(fixed).toBe(true);
    expect(fs.existsSync(path.join(run.state.repos.svc.worktree, 'broken'))).toBe(false);
  });

  it('undoes commits made by an agent and never commits .env files', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('chunk-c1', (call) => {
      const dir = wt(call);
      fs.writeFileSync(path.join(dir, 'feature.js'), 'x\n');
      fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
      sh(dir, 'git add feature.js && git commit -qm "sneaky"');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);

    const w = run.state.repos.svc.worktree;
    expect(sh(w, `git log --format=%s ${base}..HEAD`)).toBe('feat(T-1): add feature');
    expect(sh(w, 'git show --name-only --format= HEAD')).not.toContain('.env');
    expect(fs.existsSync(path.join(w, '.env'))).toBe(false);
  });

  it('waits on blocking questions, then continues once answered', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('plan', () => plan({ questions: [{ id: 'Q1', audience: 'pm', question: 'which copy?', why_unresolvable: 'ticket vs spec', recommendation: 'ticket', blocking: true }] }));
    registerFake('plan-review', () => ({ ...approved, question_assessments: [{ question_id: 'Q1', needs_human: true, suggested_resolution: '' }] }));
    let sawAnswer = false;
    registerFake('answers', (call) => {
      sawAnswer = call.prompt.includes('use the spec');
      return plan();
    });
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base, { autoAnswer: false });
    await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
    expect(run.state.phase).toBe('awaiting_answers');
    expect(fs.readFileSync(run.file('questions.md'), 'utf8')).toContain('which copy?');

    run.state.questions.inbox.push('Q1: use the spec');
    await run.advance();
    expect(sawAnswer).toBe(true);
    expect(run.state.phase).toBe('done');
    expect(run.state.humanTouches).toBe(1);
  });

  it('records unresolved disagreements instead of looping forever', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work('add feature', [{ finding_id: 'F1', decision: 'reject', reasoning: 'spec says so' }]);
    });
    registerFake('chunk-c1-review', () => ({ ...approved, verdict: 'changes_required', findings: [{ id: 'F1', severity: 'medium', title: 'naming', detail: 'd', location: 'x', required: true }] }));
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);
    expect(run.state.phase).toBe('done');
    expect(run.state.disagreements).toHaveLength(1);
    expect(fs.readFileSync(run.file('mr-svc.md'), 'utf8')).toContain('Unresolved reviewer concern');
  });

  it('remembers intended gate failures until the tests chunk, then requires them fixed', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('plan', () => plan({ chunks: [
      { id: 'c1', repo: 'svc', title: 'one', goal: '', expected_files: [], is_tests_chunk: false, done_when: [] },
      { id: 'c2', repo: 'svc', title: 'two', goal: '', expected_files: [], is_tests_chunk: false, done_when: [] },
      { id: 't', repo: 'svc', title: 'tests', goal: '', expected_files: [], is_tests_chunk: true, done_when: [] },
    ] }));
    const gatefixes: string[] = [];
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'one.js'), '1\n');
      fs.writeFileSync(path.join(wt(call), 'broken'), '');
      return work('one');
    });
    registerFake('chunk-c1-gatefix', () => {
      gatefixes.push('c1');
      return work('one', [{ finding_id: 'exit code 1', decision: 'reject', reasoning: 'old test, updated in tests chunk' }]);
    });
    registerFake('chunk-c2', (call) => {
      fs.writeFileSync(path.join(wt(call), 'two.js'), '2\n');
      return work('two');
    });
    registerFake('chunk-c2-gatefix', () => {
      gatefixes.push('c2');
      return work('two');
    });
    registerFake('chunk-t', (call) => {
      fs.rmSync(path.join(wt(call), 'broken'));
      fs.writeFileSync(path.join(wt(call), 'one.test.js'), 't\n');
      return work('tests');
    });
    for (const id of ['c1', 'c2', 't']) registerFake(`chunk-${id}-review`, () => approved);
    const { run, opts } = start(root, repo, base);
    await run.advance(opts);
    expect(gatefixes).toEqual(['c1']);
    expect(run.state.phase).toBe('done');
    expect(run.state.expectedFailures?.svc).toEqual({});
  });

  it('resumes after a crash without redoing finished chunks', async () => {
    const { root, repo, base } = sandbox();
    commonFakes();
    registerFake('plan', () => plan({ chunks: [
      { id: 'c1', repo: 'svc', title: 'one', goal: '', expected_files: [], is_tests_chunk: false, done_when: [] },
      { id: 'c2', repo: 'svc', title: 'two', goal: '', expected_files: [], is_tests_chunk: false, done_when: [] },
    ] }));
    const calls: string[] = [];
    registerFake('chunk-c1', (call) => {
      calls.push('c1');
      fs.writeFileSync(path.join(wt(call), 'one.js'), '1\n');
      return work('one');
    });
    registerFake('chunk-c2', () => {
      throw new Error('model limit hit');
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts, config } = start(root, repo, base);
    await expect(run.advance(opts)).rejects.toThrow('model limit hit');
    expect(run.state.nextChunk).toBe(1);

    registerFake('chunk-c2', (call) => {
      calls.push('c2');
      fs.writeFileSync(path.join(wt(call), 'two.js'), '2\n');
      return work('two');
    });
    registerFake('chunk-c2-review', () => approved);
    const resumed = Run.load(config, 'T-1');
    await resumed.advance();
    expect(calls).toEqual(['c1', 'c2']);
    expect(sh(resumed.state.repos.svc.worktree, `git rev-list --count ${base}..HEAD`)).toBe('2');
  });

  it('pauses for design files when a UI ticket has Figma links but no MCP, then uses the dropped files', async () => {
    const { root, repo, base } = sandbox();
    process.env.CLOSIO_FIGMA_MCP = 'missing';
    commonFakes();
    let planPrompt = '';
    registerFake('plan', (call) => {
      planPrompt = call.prompt;
      return plan({ design_status: 'developer_folder' });
    });
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base, { autoAnswer: false }, UI_TICKET);
    await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
    expect(run.state.phase).toBe('awaiting_answers');
    expect(run.state.waitingFor).toBe('design');
    const folder = path.join(root, 'runs', 'T-1', '1-input', 'design');
    expect(fs.readFileSync(run.file('questions.md'), 'utf8')).toContain(folder);

    // still nothing dropped: stays waiting
    await expect(run.advance()).rejects.toThrow(/Still waiting for design/);

    fs.writeFileSync(path.join(folder, 'edit.png'), 'png');
    fs.writeFileSync(path.join(folder, 'layers.md'), '/* main */ width: 1144px;');
    await run.advance();
    expect(run.state.phase).toBe('done');
    expect(run.state.design?.mode).toBe('folder');
    expect(run.state.design?.images).toContain(path.join(folder, 'edit.png'));
    expect(fs.readFileSync(run.file('inputs', 'figma.md'), 'utf8')).toContain(path.join(folder, 'layers.md'));
    expect(planPrompt).toContain(run.file('inputs', 'figma.md'));
  });

  it('continues without design when the developer says so, and notes it in the MR', async () => {
    const { root, repo, base } = sandbox();
    process.env.CLOSIO_FIGMA_MCP = 'needs_auth';
    commonFakes();
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base, { autoAnswer: false }, UI_TICKET);
    await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
    // a reply that is not an explicit go-ahead keeps it waiting
    run.state.questions.inbox.push("I'll send the files tonight");
    await expect(run.advance()).rejects.toThrow(/Still waiting for design/);
    expect(run.state.designSkipped).toBeFalsy();
    run.state.questions.inbox.push('continue without design');
    await run.advance();
    expect(run.state.phase).toBe('done');
    expect(run.state.design?.mode).toBe('skipped');
    expect(fs.readFileSync(run.file('mr-svc.md'), 'utf8')).toContain('without the Figma design');
  });

  it('lets only the dev bot use Figma MCP, saving results for later steps', async () => {
    const { root, repo, base } = sandbox();
    process.env.CLOSIO_FIGMA_MCP = 'connected';
    commonFakes();
    const seen: Record<string, { tools: string[]; writable: string[] }> = {};
    registerFake('plan', (call) => {
      seen.plan = { tools: call.mcpTools ?? [], writable: call.extraWritable ?? [] };
      fs.writeFileSync(path.join(call.extraWritable![0], 'edit.layers.md'), 'saved');
      return plan({ design_status: 'figma_mcp' });
    });
    registerFake('plan-review', (call) => {
      seen.review = { tools: call.mcpTools ?? [], writable: call.extraWritable ?? [] };
      return approved;
    });
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base, {}, UI_TICKET);
    await run.advance(opts);
    expect(run.state.design?.mode).toBe('mcp');
    expect(fs.existsSync(path.join(run.state.design!.mcpDir, 'edit.layers.md'))).toBe(true);
    expect(seen.plan.tools).toContain('mcp__figma__get_design_context');
    expect(seen.plan.writable).toEqual([run.state.design!.mcpDir]);
    expect(seen.review.tools).toEqual([]);
    expect(seen.review.writable).toEqual([]);
  });

  it('pauses for design when Figma MCP fails during planning', async () => {
    const { root, repo, base } = sandbox();
    process.env.CLOSIO_FIGMA_MCP = 'connected';
    commonFakes();
    registerFake('plan', () => plan({ design_status: 'unavailable' }));
    const { run, opts } = start(root, repo, base, { autoAnswer: false }, UI_TICKET);
    await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
    expect(run.state.waitingFor).toBe('design');
    expect(run.state.plan).toBeUndefined();
  });

  it('honours "continue without design" after Figma MCP failed mid-planning, and drops Figma access', async () => {
    const { root, repo, base } = sandbox();
    process.env.CLOSIO_FIGMA_MCP = 'connected';
    commonFakes();
    const plans: { tools: string[] }[] = [];
    registerFake('plan', (call) => {
      plans.push({ tools: call.mcpTools ?? [] });
      return plan({ design_status: plans.length === 1 ? 'unavailable' : 'not_needed' });
    });
    registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'feature.js'), 'x\n');
      return work();
    });
    registerFake('chunk-c1-review', () => approved);
    const { run, opts } = start(root, repo, base, { autoAnswer: false }, UI_TICKET);
    await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
    expect(run.state.waitingFor).toBe('design');

    run.state.questions.inbox.push('continue without design');
    await run.advance();
    expect(run.state.phase).toBe('done');
    expect(run.state.design?.mode).toBe('skipped');
    expect(plans).toHaveLength(2);
    expect(plans[0].tools.length).toBeGreaterThan(0);
    expect(plans[1].tools).toEqual([]);
  });

  describe('stacked branches', () => {
    const dependsOn560 = () => plan({ dependencies: [{ repo: 'svc', ticket: 'SCRUM-560', reason: 'reuses the shared form' }] });
    const editChunk = () => registerFake('chunk-c1', (call) => {
      fs.writeFileSync(path.join(wt(call), 'edit.js'), 'require("./shared");\n');
      return work('add edit screen');
    });

    it('builds on the parent ticket branch and says so in the MR', async () => {
      const { root, repo } = sandboxWithRemote();
      commonFakes();
      registerFake('plan', dependsOn560);
      editChunk();
      registerFake('chunk-c1-review', () => approved);
      const { run, opts } = startLive(root, repo);
      await run.advance(opts);

      const r = run.state.repos.svc;
      expect(r.branch).toBe('t-1');
      expect(r.parent?.ticket).toBe('SCRUM-560');
      expect(sh(r.worktree, 'git log --format=%s')).toBe('feat(T-1): add edit screen\nadd shared form\ninit');
      expect(fs.readFileSync(run.file('mr-svc.md'), 'utf8')).toContain('**Depends on SCRUM-560:** review that one first.');
    });

    it('moves onto the parent when it changes, keeps every own commit, and tells the dev bot', async () => {
      const { root, repo, seed } = sandboxWithRemote();
      commonFakes();
      registerFake('plan', dependsOn560);
      registerFake('chunk-c1', (call) => {
        fs.writeFileSync(path.join(wt(call), 'edit.js'), 'require("./shared");\n');
        // the lead asks 560 for a fix while 561 is being built
        sh(seed, 'git checkout -q scrum-560');
        fs.writeFileSync(path.join(seed, 'shared.js'), 'module.exports = "form v2";\n');
        sh(seed, 'git commit -qam "rename form prop per review" && git push -q origin scrum-560 && git checkout -q develop');
        return work('add edit screen');
      });
      registerFake('chunk-c1-review', () => approved);
      let alignPrompt = '';
      registerFake('align', (call) => {
        alignPrompt = call.prompt;
        return noAlignIssues;
      });
      const { run, opts } = startLive(root, repo);
      await run.advance(opts);

      const w = run.state.repos.svc.worktree;
      expect(sh(w, 'git log --format=%s')).toBe('feat(T-1): add edit screen\nrename form prop per review\nadd shared form\ninit');
      expect(fs.readFileSync(path.join(w, 'shared.js'), 'utf8')).toContain('v2');
      expect(alignPrompt).toContain('changed since we built on it');
      expect(alignPrompt).toContain('rename form prop per review');
    });

    it('pauses when the parent ticket has no branch, and continues from develop when told', async () => {
      const { root, repo } = sandboxWithRemote();
      commonFakes();
      registerFake('plan', () => plan({ dependencies: [{ repo: 'svc', ticket: 'SCRUM-999', reason: 'needs its form' }] }));
      editChunk();
      registerFake('chunk-c1-review', () => approved);
      const { run, opts } = startLive(root, repo);
      await expect(run.advance(opts)).rejects.toBeInstanceOf(PipelineStop);
      expect(run.state.waitingFor).toBe('dependency');
      expect(fs.readFileSync(run.file('questions.md'), 'utf8')).toContain('SCRUM-999 has no branch yet');

      run.state.questions.inbox.push('ok, will start it tomorrow');
      await expect(run.advance()).rejects.toThrow(/Still waiting/);

      run.state.questions.inbox.push('continue from develop');
      await run.advance();
      expect(run.state.phase).toBe('done');
      expect(run.state.repos.svc.parent).toBeUndefined();
      expect(sh(run.state.repos.svc.worktree, 'git log --format=%s')).toBe('feat(T-1): add edit screen\ninit');
    });

    it('--base develop overrides the dependency the bot found', async () => {
      const { root, repo } = sandboxWithRemote();
      commonFakes();
      registerFake('plan', dependsOn560);
      editChunk();
      registerFake('chunk-c1-review', () => approved);
      const { run, opts } = startLive(root, repo, { base: 'develop' });
      await run.advance(opts);
      expect(run.state.repos.svc.parent).toBeUndefined();
      expect(fs.existsSync(path.join(run.state.repos.svc.worktree, 'shared.js'))).toBe(false);
    });

    it('picks up a branch the lead rebased in GitLab after the parent merged', async () => {
      const { root, repo, seed } = sandboxWithRemote();
      commonFakes();
      registerFake('plan', dependsOn560);
      editChunk();
      registerFake('chunk-c1-review', () => approved);
      const { run, opts } = startLive(root, repo);
      await run.advance(opts);
      const r = run.state.repos.svc;
      sh(r.worktree, 'git push -q origin t-1');
      r.pushedSha = sh(r.worktree, 'git rev-parse HEAD');

      // lead merges 560, then presses Rebase on 561's MR in GitLab
      sh(seed, 'git fetch -q origin && git checkout -q develop && git pull -q origin develop');
      sh(seed, 'git merge -q --no-ff origin/scrum-560 -m "Merge branch scrum-560" && git push -q origin develop');
      sh(seed, 'git checkout -q -b t-1 origin/t-1 && git rebase -q origin/develop && git push -q -f origin t-1');
      const remoteSha = sh(seed, 'git rev-parse HEAD');

      const note = await (run as any).adoptRemote('svc', remoteSha);
      expect(note).toContain('picked up the branch');
      expect(sh(r.worktree, 'git rev-parse HEAD')).toBe(remoteSha);
      expect(r.parent).toBeUndefined();
      expect(r.commits.map((c) => c.message)).toEqual(['feat(T-1): add edit screen']);
    });

    it('treats an already merged parent as no dependency', async () => {
      const { root, repo, seed } = sandboxWithRemote();
      sh(seed, 'git merge -q --no-ff scrum-560 -m "Merge branch scrum-560" && git push -q origin develop');
      commonFakes();
      registerFake('plan', dependsOn560);
      editChunk();
      registerFake('chunk-c1-review', () => approved);
      const { run, opts } = startLive(root, repo);
      await run.advance(opts);
      expect(run.state.repos.svc.parent).toBeUndefined();
      expect(run.state.gateNotes.join(' ')).toContain('already merged');
    });
  });
});
