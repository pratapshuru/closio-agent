import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { repoPath, resolvePath } from './config.ts';
import type { GitLab } from './gitlab.ts';
import { ticketMarkdown } from './ingest.ts';
import type { Jira, JiraIssue, JiraSummary } from './jira.ts';
import { ensureDir, exec, log, writeText } from './util.ts';

// where a ticket's code lives in one repo
export type TicketBranch = { repo: string; branch: string; mr?: string };

export type SprintContext = {
  sprintName?: string;
  // the shared sprint map file, refreshed on every run
  sprintFile?: string;
  // tickets whose full text was saved for this run
  related: string[];
  relatedDir: string;
};

const TICKET_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// words that say nothing about which feature a ticket is about
const GENERIC = new Set([
  'frontend', 'backend', 'fe', 'be', 'screen', 'page', 'config', 'configs', 'api', 'add', 'edit', 'list', 'detail', 'view',
  'create', 'update', 'delete', 'get', 'post', 'patch', 'put', 'the', 'and', 'for', 'of', 'on', 'in', 'to', 'a', 'an', 'with',
  'business', 'new', 'fix', 'bug', 'status', '1', '2',
]);

export function mentionedKeys(text: string, self: string): string[] {
  return [...new Set([...text.matchAll(TICKET_KEY)].map((m) => m[1]))].filter((k) => k !== self);
}

function featureWords(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !GENERIC.has(w)));
}

// two titles are about the same feature when they share at least two meaningful words
export function sameFeature(a: string, b: string): boolean {
  const wa = featureWords(a);
  let shared = 0;
  for (const w of featureWords(b)) if (wa.has(w)) shared++;
  return shared >= 2;
}

// branch names like scrum-560, SCRUM-560, feature/scrum-560-add, but not scrum-5600
export function branchMatches(branch: string, key: string): boolean {
  const escaped = key.toLowerCase().replace(/[-]/g, '\\-');
  return new RegExp(`(^|[/_.-])${escaped}($|[/_.-])`).test(branch.toLowerCase()) || branch.toLowerCase() === key.toLowerCase();
}

async function remoteHeads(repoDir: string): Promise<string[] | null> {
  const res = await exec('git', ['-C', repoDir, 'ls-remote', '--heads', 'origin'], { timeoutMs: 15_000 }).catch(() => null);
  if (!res || res.code !== 0 || res.timedOut) return null;
  return res.stdout.split('\n').map((l) => l.split('refs/heads/')[1]).filter(Boolean);
}

async function openMrs(config: Config, gitlab: GitLab | undefined, repoKey: string): Promise<Array<{ branch: string; url: string }>> {
  if (!gitlab) return [];
  try {
    return await gitlab.openMrs(config.repos[repoKey].remote_path);
  } catch {
    return [];
  }
}

// where each ticket's code lives, across all configured repos; network failures just mean less info
export async function findBranches(
  config: Config,
  keys: string[],
  ownRuns: Array<{ key: string; branches: Record<string, string> }>,
  gitlab?: GitLab,
): Promise<Map<string, TicketBranch[]>> {
  const found = new Map<string, TicketBranch[]>(keys.map((k) => [k, []]));
  // one unreachable remote usually means no VPN; don't wait on every repo
  let online = true;
  for (const [repoKey, repo] of Object.entries(config.repos)) {
    if (!repo.path || !fs.existsSync(resolvePath(repo.path))) continue;
    const heads = online ? await remoteHeads(repoPath(config, repoKey)) : null;
    if (heads === null && online) {
      online = false;
      log('  git remote unreachable (VPN?); using only this tool\'s own runs for branch info');
    }
    const mrs = online ? await openMrs(config, gitlab, repoKey) : [];
    for (const key of keys) {
      const own = ownRuns.find((r) => r.key === key)?.branches[repoKey];
      const branch = own ?? (heads ?? []).find((h) => branchMatches(h, key));
      if (!branch) continue;
      found.get(key)!.push({ repo: repoKey, branch, mr: mrs.find((m) => m.branch === branch)?.url });
    }
  }
  return found;
}

function line(t: JiraSummary, branches: TicketBranch[], self: string): string {
  const where = branches.length ? branches.map((b) => `${b.repo}: ${b.branch}${b.mr ? ` (MR ${b.mr})` : ''}`).join(', ') : 'no branch';
  const links = t.links.length ? ` | relates ${t.links.join(', ')}` : '';
  return `- ${t.key === self ? '**THIS TICKET** ' : ''}${t.key} | ${t.status} | ${t.summary.slice(0, 90)} | ${where}${links}`;
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function handoffFile(config: Config, key: string): string {
  return path.join(resolvePath(config.workspace.handoffs_dir), `${key}.md`);
}

// a connected ticket as the dev bot reads it: the ticket, where its code is, and its run's handoff note
export function relatedText(config: Config, issue: JiraIssue, where: TicketBranch[] = []): string {
  const code = where.length ? where.map((b) => `- ${b.repo}: branch \`${b.branch}\`${b.mr ? `, MR ${b.mr}` : ''}`).join('\n') : '- no branch known';
  const note = handoffFile(config, issue.key);
  const handoff = fs.existsSync(note) ? `\n\n## Handoff note from ${issue.key}'s run (written for tickets like this one)\n\n${fs.readFileSync(note, 'utf8')}` : '';
  return `${ticketMarkdown(issue)}\n\n## Code\n\n${code}${handoff}\n`;
}

export async function buildSprintContext(opts: {
  config: Config;
  jira?: Jira;
  gitlab?: GitLab;
  issue?: JiraIssue;
  key: string;
  ticketText: string;
  relatedDir: string;
  forcedRelated: string[];
  ownRuns: Array<{ key: string; branches: Record<string, string> }>;
}): Promise<SprintContext> {
  const { config, jira, issue, key } = opts;
  const relatedDir = ensureDir(opts.relatedDir);
  const mentioned = mentionedKeys(opts.ticketText, key);

  let sprintName: string | undefined;
  let sprintTickets: JiraSummary[] = [];
  let epicTickets: JiraSummary[] = [];
  if (jira && issue) {
    const sprint = issue.sprints.find((s) => s.state === 'active') ?? issue.sprints.at(-1);
    if (sprint) {
      sprintName = sprint.name;
      sprintTickets = await jira.search(`sprint = ${sprint.id} ORDER BY key DESC`);
    }
    if (issue.epic) epicTickets = (await jira.search(`parent = ${issue.epic} ORDER BY key DESC`)).filter((t) => !sprintTickets.some((s) => s.key === t.key));
  }

  // full text for the tickets that are obviously connected; the dev bot can fetch more itself
  const obvious = new Set<string>([...(issue?.links ?? []), ...mentioned, ...opts.forcedRelated]);
  for (const t of [...sprintTickets, ...epicTickets]) {
    if (t.key !== key && issue && sameFeature(t.summary, issue.summary)) obvious.add(t.key);
  }
  obvious.delete(key);
  const related = [...obvious].slice(0, 10);

  const allKeys = [...new Set([key, ...sprintTickets.map((t) => t.key), ...epicTickets.map((t) => t.key), ...related])];
  const branches = await findBranches(config, allKeys, opts.ownRuns, opts.gitlab);

  if (jira) {
    for (const k of related) {
      try {
        writeText(path.join(relatedDir, `${k}.md`), relatedText(config, await jira.getIssue(k), branches.get(k) ?? []));
      } catch (err) {
        log(`  could not fetch ${k}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  let sprintFile: string | undefined;
  if (sprintTickets.length || epicTickets.length) {
    const dir = ensureDir(resolvePath(config.workspace.sprints_dir));
    sprintFile = path.join(dir, `${slug(sprintName ?? `epic-${issue?.epic}`)}.md`);
    const epicSection = epicTickets.length
      ? `\n## Same epic (${issue?.epic}), other sprints or backlog\n\n${epicTickets.map((t) => line(t, branches.get(t.key) ?? [], key)).join('\n')}\n`
      : '';
    writeText(sprintFile, `# ${sprintName ?? 'No active sprint'}\n\nRefreshed ${new Date().toISOString().slice(0, 16)} by closio-agent. One line per ticket: key | status | title | where its code is.\n\n## This sprint\n\n${sprintTickets.map((t) => line(t, branches.get(t.key) ?? [], key)).join('\n') || '- none'}\n${epicSection}`);
  }
  return { sprintName, sprintFile, related: related.filter((k) => fs.existsSync(path.join(relatedDir, `${k}.md`))), relatedDir };
}
