import fs from 'node:fs';
import path from 'node:path';
import { exec, execOk, ensureDir, log, network } from './util.ts';

export function git(cwd: string, ...args: string[]): Promise<string> {
  return execOk('git', ['-C', cwd, ...args]).then((s) => s.trim());
}

const IGNORED = ['node_modules', '.test-logs'];

function isIgnored(file: string): boolean {
  return IGNORED.some((p) => file === p || file.startsWith(p + '/'));
}

export function isSecretFile(file: string): boolean {
  const base = path.basename(file);
  if (base.endsWith('.example') || base.endsWith('.sample')) return false;
  return base === '.env' || base.startsWith('.env.') || base === '.agent-secrets.env' || /\.(pem|key|p12)$/.test(base);
}

// `src/views/x/**` = the folder and everything in it, `*` = any name within one folder
export function matchesPath(file: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) {
    const p = pattern.replace(/\/+$/, '');
    return file === p || file.startsWith(p + '/');
  }
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      // "dir/**" also matches "dir" itself; "**/x" also matches "x" at the top
      if (re.endsWith('/') && i + 2 === pattern.length) re = re.slice(0, -1) + '(/.*)?';
      else if (slashAfter) re += '(.*/)?';
      else re += '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(file);
}

const MIGRATION = /(^|\/)(migrations|seeders)\//;

// undoes bot edits to protected files and to migrations that already existed (new migrations are fine)
export async function revertProtectedEdits(cwd: string, patterns: string[], allowed: string[], isBackend: boolean): Promise<string[]> {
  const undone: string[] = [];
  for (const file of await changedFiles(cwd)) {
    if (allowed.some((a) => matchesPath(file, a))) continue;
    const tracked = (await exec('git', ['-C', cwd, 'cat-file', '-e', `HEAD:${file}`])).code === 0;
    const isProtected = patterns.some((p) => matchesPath(file, p));
    const oldMigration = isBackend && tracked && MIGRATION.test(file);
    if (!isProtected && !oldMigration) continue;
    if (tracked) await exec('git', ['-C', cwd, 'checkout', 'HEAD', '--', file]);
    else fs.rmSync(path.join(cwd, file), { force: true });
    undone.push(file);
  }
  return undone;
}

export async function head(cwd: string): Promise<string> {
  return git(cwd, 'rev-parse', 'HEAD');
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, 'branch', '--show-current');
}

// files changed in the working tree vs HEAD, including untracked ones
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await execOk('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // renames carry the old path as the next entry; keep it, so moving a guarded file away is caught too
    if (status.startsWith('R') || status.startsWith('C')) {
      i++;
      if (entries[i]) files.push(entries[i]);
    }
  }
  return files.filter((f) => !isIgnored(f));
}

export async function filesChangedSince(cwd: string, base: string): Promise<string[]> {
  const out = await git(cwd, 'diff', '--name-only', `${base}...HEAD`);
  return out.split('\n').filter(Boolean);
}

export async function prepareDiffForReview(cwd: string): Promise<void> {
  // intent-to-add makes new files show up in plain `git diff`
  const files = await changedFiles(cwd);
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean);
  const toAdd = untracked.filter((f) => files.includes(f));
  if (toAdd.length) await execOk('git', ['-C', cwd, 'add', '-N', '--', ...toAdd]);
}

export async function diffStat(cwd: string, base?: string): Promise<string> {
  return git(cwd, 'diff', '--stat', ...(base ? [`${base}...HEAD`] : []));
}

export type CommitResult = { sha: string; files: string[] };

export async function commitChanges(cwd: string, message: string, skipHooks = false): Promise<CommitResult | null> {
  const files = await changedFiles(cwd);
  const secrets = files.filter(isSecretFile);
  if (secrets.length) {
    for (const file of secrets) {
      await exec('git', ['-C', cwd, 'checkout', '--', file]);
      await exec('git', ['-C', cwd, 'rm', '--cached', '-q', '--', file]);
    }
    log(`  refused to commit secret files: ${secrets.join(', ')}`);
  }
  const toCommit = files.filter((f) => !isSecretFile(f));
  if (!toCommit.length) return null;
  await execOk('git', ['-C', cwd, 'add', '-A', '--', ...toCommit]);
  await execOk('git', ['-C', cwd, 'commit', '-q', ...(skipHooks ? ['--no-verify'] : []), '-m', message]);
  return { sha: await head(cwd), files: toCommit };
}

// undo any commit an agent made behind our back, keeping its changes in the tree
export async function enforceHead(cwd: string, expected: string): Promise<boolean> {
  const actual = await head(cwd);
  if (actual === expected) return false;
  await execOk('git', ['-C', cwd, 'reset', '--soft', expected]);
  await exec('git', ['-C', cwd, 'reset', '-q']);
  return true;
}

export async function revertSecretEdits(cwd: string): Promise<string[]> {
  const touched = (await changedFiles(cwd)).filter(isSecretFile);
  for (const file of touched) {
    const tracked = await exec('git', ['-C', cwd, 'ls-files', '--error-unmatch', file]);
    if (tracked.code === 0) await exec('git', ['-C', cwd, 'checkout', '--', file]);
    else fs.rmSync(path.join(cwd, file), { force: true });
  }
  return touched;
}

export type WorktreeSpec = {
  repoPath: string;
  worktreePath: string;
  branch: string;
  // e.g. origin/development, or a commit sha for replays
  base: string;
  fetchBranch?: string;
};

export async function ensureWorktree(spec: WorktreeSpec): Promise<{ created: boolean; base: string }> {
  if (fs.existsSync(path.join(spec.worktreePath, '.git'))) {
    const branch = await currentBranch(spec.worktreePath);
    if (branch !== spec.branch) throw new Error(`Worktree ${spec.worktreePath} is on '${branch}', expected '${spec.branch}'`);
    return { created: false, base: await git(spec.worktreePath, 'merge-base', 'HEAD', spec.base) };
  }
  if (spec.fetchBranch) {
    let fetched = await exec('git', ['-C', spec.repoPath, 'fetch', 'origin', spec.fetchBranch]);
    if (fetched.code !== 0 && network.recover && (await network.recover())) fetched = await exec('git', ['-C', spec.repoPath, 'fetch', 'origin', spec.fetchBranch]);
    if (fetched.code !== 0) throw new Error(`git fetch failed in ${spec.repoPath}. On VPN? ${fetched.stderr.trim()}`);
  }
  ensureDir(path.dirname(spec.worktreePath));
  const branchExists = (await exec('git', ['-C', spec.repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${spec.branch}`])).code === 0;
  if (branchExists) {
    await execOk('git', ['-C', spec.repoPath, 'worktree', 'add', spec.worktreePath, spec.branch]);
  } else {
    await execOk('git', ['-C', spec.repoPath, 'worktree', 'add', '-b', spec.branch, spec.worktreePath, spec.base]);
  }
  await excludeLocalLinks(spec.repoPath);
  return { created: true, base: await git(spec.worktreePath, 'rev-parse', spec.base) };
}

async function excludeLocalLinks(repoPath: string): Promise<void> {
  // a symlinked node_modules is a file, so `node_modules/` in .gitignore does not hide it
  const common = path.resolve(repoPath, await git(repoPath, 'rev-parse', '--git-common-dir'));
  const exclude = path.join(common, 'info', 'exclude');
  ensureDir(path.dirname(exclude));
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('/node_modules')) fs.appendFileSync(exclude, '\n/node_modules\n');
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
}

export async function linkDependencies(repoPath: string, worktreePath: string, mode: 'symlink' | 'npm-ci' | 'none'): Promise<void> {
  if (mode === 'none' || !fs.existsSync(path.join(worktreePath, 'package.json'))) return;
  const target = path.join(worktreePath, 'node_modules');
  if (fs.existsSync(target)) return;
  const lock = (dir: string) => {
    const f = path.join(dir, 'package-lock.json');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  const source = path.join(repoPath, 'node_modules');
  if (mode === 'symlink' && fs.existsSync(source) && lock(repoPath) === lock(worktreePath)) {
    fs.symlinkSync(source, target, 'dir');
    return;
  }
  log(`  installing dependencies in ${worktreePath} (lockfile differs from main checkout)`);
  await execOk('npm', ['ci', '--no-audit', '--no-fund'], { cwd: worktreePath, timeoutMs: 20 * 60_000 });
}

export async function push(cwd: string, branch: string, force = false): Promise<void> {
  const args = ['-C', cwd, 'push', '-u', 'origin', branch];
  if (force) args.push('--force-with-lease');
  for (let attempt = 1; ; attempt++) {
    const res = await exec('git', args, { timeoutMs: 5 * 60_000 });
    if (res.code === 0) return;
    if (attempt >= 3) throw new Error(`git push failed in ${cwd}. On VPN? ${res.stderr.trim()}`);
    log(`  push failed, retrying (${attempt}/3)`);
    if (attempt === 1 && network.recover) await network.recover();
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

export async function startRebase(cwd: string, onto: string): Promise<string[]> {
  const res = await exec('git', ['-C', cwd, '-c', 'core.editor=true', 'rebase', onto]);
  if (res.code === 0) return [];
  return conflictedFiles(cwd);
}

export async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, 'diff', '--name-only', '--diff-filter=U');
  return out.split('\n').filter(Boolean);
}

export async function continueRebase(cwd: string, files: string[]): Promise<string[]> {
  if (files.length) await execOk('git', ['-C', cwd, 'add', '--', ...files]);
  const res = await exec('git', ['-C', cwd, '-c', 'core.editor=true', 'rebase', '--continue'], {
    env: { ...process.env, GIT_EDITOR: 'true' },
  });
  if (res.code === 0) return [];
  const remaining = await conflictedFiles(cwd);
  if (!remaining.length && !fs.existsSync(path.join(await git(cwd, 'rev-parse', '--git-dir'), 'rebase-merge'))) return [];
  if (!remaining.length) throw new Error(`rebase --continue failed: ${res.stderr.trim()}`);
  return remaining;
}

// a local-only copy of the branch before anything rewrites it; never pushed
export async function backupBranch(cwd: string, branch: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `backup/${branch}-${stamp}`;
  await git(cwd, 'branch', '-f', name, 'HEAD');
  return name;
}
