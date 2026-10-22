import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveModels, resolvePlanner } from '../src/config.ts';
import { runGates } from '../src/gates.ts';
import { isSecretFile } from '../src/git.ts';
import { adfToMarkdown, markdownToAdf } from '../src/jira.ts';
import { figmaLinks } from '../src/ingest.ts';
import { collectDesignFiles, designBrief, findBrief, findDesignFolders } from '../src/design.ts';
import { adviceFor, planFiles, renderPlan } from '../src/sprintplan.ts';
import { relatedText } from '../src/sprint.ts';
import { writeJson } from '../src/util.ts';
import { branchMatches, mentionedKeys, sameFeature } from '../src/sprint.ts';
import { Run, stripFieldTags } from '../src/pipeline.ts';
import { sandbox, testConfig } from './helpers.ts';

describe('jira formatting', () => {
  it('turns ADF tables, lists and links into markdown', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'see ' }, { type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://x' } }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AC 1' }] }] }] },
        { type: 'table', content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Code' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '409' }] }] }] },
        ] },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain('see [spec](https://x)');
    expect(md).toContain('- AC 1');
    expect(md).toContain('| Code |');
    expect(md).toContain('| 409 |');
  });

  it('turns @role into a real Jira mention and keeps code blocks', () => {
    const adf = markdownToAdf('@pm please check\n\n```\ncurl x\n```', { pm: 'acc-1' }) as any;
    expect(adf.content[0].content[0]).toEqual({ type: 'mention', attrs: { id: 'acc-1' } });
    expect(adf.content[1]).toMatchObject({ type: 'codeBlock', content: [{ text: 'curl x' }] });
  });
});

describe('gates', () => {
  it('only fails on failures that were not there before the ticket', async () => {
    const { root } = sandbox();
    const out = path.join(root, 'out');
    const gate = { cmd: `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({failures:[{file:'a.js',fullTitle:'old'},{file:'b.js',fullTitle:'new'}]}))" {out}`, parser: 'mocha-json' as const, scope: 'all' as const, timeout_min: 1 };
    const [result] = await runGates([gate], root, [], { [gate.cmd]: ['a.js > old'] }, 'HEAD', out, 't');
    expect(result.failures).toEqual(['b.js > new']);
    expect(result.preexisting).toEqual(['a.js > old']);
    expect(result.ok).toBe(false);
  });

  it('never treats a crashing gate as a pre-existing failure', async () => {
    const { root } = sandbox();
    const gate = { cmd: 'exit 3', parser: 'mocha-json' as const, scope: 'all' as const, timeout_min: 1 };
    const crash = 'gate crashed before writing results (exit 3)';
    const [result] = await runGates([gate], root, [], { [gate.cmd]: [crash] }, 'HEAD', path.join(root, 'out'), 't');
    expect(result.ok).toBe(false);
  });

  it('skips changed-file gates when nothing relevant changed', async () => {
    const { root } = sandbox();
    const gate = { cmd: 'exit 1', parser: 'exit-code' as const, scope: 'changed' as const, match: '\\.vue$', timeout_min: 1 };
    const [result] = await runGates([gate], root, ['index.js'], {}, 'HEAD', path.join(root, 'out'), 't');
    expect(result.skipped).toBe(true);
  });
});

describe('safety and config', () => {
  it('recognises secret files but not examples', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('config/.env.local')).toBe(true);
    expect(isSecretFile('.env.example')).toBe(false);
    expect(isSecretFile('src/env.ts')).toBe(false);
  });

  it('picks the sprint-plan model: --set planner, else the profile planner, else dev', () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    expect(resolvePlanner(config, 'fake')).toEqual({ provider: 'fake' });
    config.models.profiles.fake.planner = { provider: 'claude', model: 'opus', effort: 'high' };
    expect(resolvePlanner(config, 'fake').model).toBe('opus');
    expect(resolvePlanner(config, 'fake', ['planner=codex:gpt-5.6-sol:high'])).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    expect(() => resolvePlanner(config, 'fake', ['dev=claude:sonnet'])).toThrow(/only takes --set planner/);
  });

  it('lets one role be overridden per run', () => {
    const { root, repo } = sandbox();
    const models = resolveModels(testConfig(root, repo), 'fake', ['reviewer=claude:opus:high']);
    expect(models.reviewer).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    expect(models.dev.provider).toBe('fake');
    expect(() => resolveModels(testConfig(root, repo), 'nope')).toThrow(/Unknown model profile/);
  });

  it('routes backend tickets to the gateway plus the best matching service', () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    config.repos.gw = { ...config.repos.svc, kind: 'backend-gateway' };
    config.repos.other = { ...config.repos.svc, hints: ['notification'] };
    config.repos.svc.hints = ['ageing'];
    config.routing.backend = ['gw'];
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
    const run = new Run(config, { key: 'X', repos: {} } as any);
    expect(run.inferRepos('# Backend - PATCH ageing config status', [])).toEqual(['gw', 'svc']);
    expect(run.inferRepos('# anything', ['repo:other'])).toEqual(['other']);
  });

  it('strips echoed schema tags from handoff text but keeps html', () => {
    expect(stripFieldTags('Fixed it.</jira_summary>')).toBe('Fixed it.');
    expect(stripFieldTags('<mr_summary_md>ok <b>bold</b></mr_summary_md>')).toBe('ok <b>bold</b>');
  });

  it('finds figma links in ticket text', () => {
    expect(figmaLinks('see https://www.figma.com/design/Kx/SFA?node-id=1-2&t=x) and more')).toEqual(['https://www.figma.com/design/Kx/SFA?node-id=1-2&t=x']);
  });

  it('finds the old .claude/<number>/figma folder for SCRUM tickets and follows screenshot lists', () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    config.design.legacy_folders = true;
    config.repos.svc.kind = 'frontend';
    const legacy = path.join(repo, '.claude', '524', 'figma');
    fs.mkdirSync(legacy, { recursive: true });
    const shot = path.join(root, 'Desktop-1.png');
    fs.writeFileSync(shot, 'png');
    const spaced = path.join(root, 'Mapping skor shots');
    fs.mkdirSync(spaced);
    fs.writeFileSync(path.join(spaced, '7.png'), 'png');
    fs.writeFileSync(path.join(legacy, 'screenshots.md'), `1- ${shot}\n2- /nope/missing.png\ndialog: '${spaced}/7.png'`);
    fs.writeFileSync(path.join(legacy, 'cssAll.md'), '/* main */');
    expect(findDesignFolders(config, 'SCRUM-524')).toEqual([legacy]);
    expect(findDesignFolders(config, 'AGENT-524')).toEqual([]);
    const files = collectDesignFiles([legacy]);
    expect(files.images.sort()).toEqual([shot, path.join(spaced, '7.png')].sort());
    expect(files.docs).toHaveLength(2);
  });

  it('tells the dev bot how to fetch and cache Figma when MCP is the source', () => {
    const brief = designBrief({ mode: 'mcp', links: ['https://www.figma.com/design/Kx/SFA?node-id=1455-398825'], folders: [], docs: [], images: [], mcpDir: '/runs/T/inputs/figma/mcp', mcp: 'connected' });
    expect(brief).toContain('node 1455:398825');
    expect(brief).toContain('/runs/T/inputs/figma/mcp');
    expect(brief).toContain('Never fetch a node that is already saved');
  });

  it('matches ticket branches by key without false hits', () => {
    expect(branchMatches('scrum-560', 'SCRUM-560')).toBe(true);
    expect(branchMatches('feature/SCRUM-560-add-form', 'SCRUM-560')).toBe(true);
    expect(branchMatches('scrum-5600', 'SCRUM-560')).toBe(false);
    expect(branchMatches('scrum-56', 'SCRUM-560')).toBe(false);
  });

  it('spots the same feature across Add/Edit titles but not unrelated ones', () => {
    expect(sameFeature('Frontend - Add Config Screen (Overdue Date)', 'Frontend - Edit Config Screen (Overdue date)')).toBe(true);
    expect(sameFeature('Frontend - Edit Config Screen (Overdue date)', 'Error message translation to Bahasa')).toBe(false);
  });

  it('finds ticket keys mentioned in a ticket', () => {
    expect(mentionedKeys('same rule as SCRUM-557 and SCRUM-557; see AGENT-6', 'SCRUM-600')).toEqual(['SCRUM-557', 'AGENT-6']);
  });

  it('gives each ticket only the sprint plan advice that concerns it', () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    const sprintPlan = {
      summary: 's',
      start_order: [{ ticket: 'SCRUM-560', why: 'parent' }],
      dependencies: [{ ticket: 'SCRUM-561', depends_on: 'SCRUM-560', repo: 'frontend', reason: 'shared form' }],
      fe_be_pairs: [{ fe: 'SCRUM-561', be: 'SCRUM-559', contract: 'PATCH /configs/:id' }],
      collisions: [{ tickets: ['SCRUM-562', 'SCRUM-565'], area: 'api/incentive.ts', advice: 'sequence them' }],
      build_for_reuse: [{ ticket: 'SCRUM-560', for_tickets: ['SCRUM-561'], what: 'shared form' }],
      ticket_issues: [{ ticket: 'SCRUM-563', problem: 'no ACs', suggestion: 'add them' }],
    };
    writeJson(planFiles(config, 'Sprint 28').json, sprintPlan);
    const edit = adviceFor(config, 'Sprint 28', 'SCRUM-561')!;
    expect(edit.text).toContain('Depends on SCRUM-560');
    expect(edit.text).toContain('SCRUM-559');
    expect(edit.text).toContain('SCRUM-560 builds something this ticket should reuse');
    expect(edit.keys.sort()).toEqual(['SCRUM-559', 'SCRUM-560']);
    expect(adviceFor(config, 'Sprint 28', 'SCRUM-560')!.text).toContain('SCRUM-561 will be built on this ticket');
    expect(adviceFor(config, 'Sprint 28', 'SCRUM-999')).toBeNull();
    expect(adviceFor(config, 'Sprint 99', 'SCRUM-561')).toBeNull();
    expect(renderPlan('Sprint 28', sprintPlan)).toContain('Ticket issues (for the tech lead)');
  });

  it("finds the developer's brief in the ticket folder or the old .claude prompt files", () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    config.repos.svc.kind = 'frontend';
    expect(findBrief(config, 'SCRUM-524')).toBeUndefined();
    const legacy = path.join(repo, '.claude', '524');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '524Ticket.md'), 'ticket');
    fs.writeFileSync(path.join(legacy, '524-prompt.md'), 'brief');
    expect(findBrief(config, 'SCRUM-524')).toBe(path.join(legacy, '524-prompt.md'));
    const own = path.join(root, 'runs', 'SCRUM-524', '1-input');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'brief.md'), 'team brief');
    expect(findBrief(config, 'SCRUM-524')).toBe(path.join(own, 'brief.md'));
  });

  it("shows a connected ticket together with its run's handoff note", () => {
    const { root, repo } = sandbox();
    const config = testConfig(root, repo);
    fs.mkdirSync(path.join(root, 'runs', 'SCRUM-560'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runs', 'SCRUM-560', 'handoff-note.md'), 'Reuse ConfigForm.vue');
    const issue = { key: 'SCRUM-560', summary: 'Add', status: 'Code Review', type: 'Story', labels: [], description: 'd', attachments: [], comments: [], links: [], sprints: [] };
    const text = relatedText(config, issue, [{ repo: 'frontend', branch: 'scrum-560' }]);
    expect(text).toContain('branch `scrum-560`');
    expect(text).toContain('Reuse ConfigForm.vue');
  });
});
