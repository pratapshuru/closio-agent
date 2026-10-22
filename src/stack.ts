import { exec, execOk } from './util.ts';
import { git } from './git.ts';

// a ticket branch built on another ticket's unmerged branch
export type Parent = {
  ticket: string;
  repo: string;
  branch: string;
  // what git resolves: a local branch for this tool's own runs, origin/<branch> otherwise
  ref: string;
  // the parent commit this branch currently sits on
  sha: string;
  reason: string;
  mr?: string;
};

export async function resolveRef(repoDir: string, branch: string, local: boolean): Promise<{ ref: string; sha: string } | null> {
  if (local) {
    const res = await exec('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (res.code === 0) return { ref: branch, sha: res.stdout.trim() };
  }
  const fetched = await exec('git', ['-C', repoDir, 'fetch', 'origin', branch], { timeoutMs: 60_000 });
  if (fetched.code !== 0) return null;
  const sha = await git(repoDir, 'rev-parse', `origin/${branch}`);
  return { ref: `origin/${branch}`, sha };
}

export async function isMergedInto(repoDir: string, sha: string, target: string): Promise<boolean> {
  return (await exec('git', ['-C', repoDir, 'merge-base', '--is-ancestor', sha, target])).code === 0;
}

// a fresh ticket branch with no work yet simply moves to the parent's tip
export async function startOn(worktree: string, sha: string): Promise<void> {
  const own = await git(worktree, 'status', '--porcelain', '--untracked-files=no');
  if (own) throw new Error(`cannot move ${worktree} onto its parent: it has uncommitted changes`);
  await execOk('git', ['-C', worktree, 'reset', '-q', '--hard', sha]);
}

export async function ownSubjects(worktree: string, base: string): Promise<string[]> {
  return (await git(worktree, 'log', '--reverse', '--format=%s', `${base}..HEAD`)).split('\n').filter(Boolean);
}

// starts moving this ticket's own commits (oldBase..HEAD) onto newBase; returns conflicted files
export async function startRestack(worktree: string, oldBase: string, newBase: string): Promise<string[]> {
  const res = await exec('git', ['-C', worktree, '-c', 'core.editor=true', 'rebase', '--onto', newBase, oldBase]);
  if (res.code === 0) return [];
  const out = await git(worktree, 'diff', '--name-only', '--diff-filter=U');
  const files = out.split('\n').filter(Boolean);
  if (!files.length) throw new Error(`rebase failed in ${worktree}: ${res.stderr.trim()}`);
  return files;
}

// the "nothing lost" check after any move: new base underneath, every own commit present in order, no markers
export async function verifyRestack(worktree: string, newBase: string, expected: string[]): Promise<string | null> {
  if (!(await isMergedInto(worktree, newBase, 'HEAD'))) return `the new base ${newBase.slice(0, 8)} is not under HEAD`;
  const now = await ownSubjects(worktree, newBase);
  const missing = expected.filter((s) => !now.includes(s));
  if (missing.length) return `commits lost: ${missing.join('; ')}`;
  const markers = await exec('git', ['-C', worktree, 'grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ']);
  if (markers.stdout.trim()) return `conflict markers left in ${markers.stdout.trim().split('\n').join(', ')}`;
  return null;
}
