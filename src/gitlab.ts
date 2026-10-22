import type { Config } from './config.ts';
import { requireEnv } from './config.ts';
import { request } from './http.ts';
import { MARKER } from './util.ts';

export type MergeRequest = {
  iid: number;
  projectId: number;
  webUrl: string;
  state: string;
  hasConflicts: boolean;
  mergeStatus: string;
  sha: string;
  targetBranch: string;
};

export type MrNote = {
  discussionId: string;
  noteId: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  resolved: boolean;
  ours: boolean;
};

const VPN_HINT = 'GitLab is behind the VPN; check the connection.';

export class GitLab {
  private config: Config;
  private token: string;
  private projectIds = new Map<string, number>();

  constructor(config: Config) {
    this.config = config;
    this.token = requireEnv('GITLAB_TOKEN');
  }

  private call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(method, `${this.config.gitlab.base_url}/api/v4${path}`, { 'PRIVATE-TOKEN': this.token }, body, VPN_HINT);
  }

  async me(): Promise<{ id: number; username: string }> {
    return this.call('GET', '/user');
  }

  async projectId(remotePath: string): Promise<number> {
    const cached = this.projectIds.get(remotePath);
    if (cached) return cached;
    const project = await this.call('GET', `/projects/${encodeURIComponent(remotePath)}`);
    this.projectIds.set(remotePath, project.id);
    return project.id;
  }

  async userIds(usernames: string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const username of usernames) {
      const users = await this.call<any[]>('GET', `/users?username=${encodeURIComponent(username)}`);
      if (users[0]) ids.push(users[0].id);
    }
    return ids;
  }

  private toMr(projectId: number, mr: any): MergeRequest {
    return {
      iid: mr.iid,
      projectId,
      webUrl: mr.web_url,
      state: mr.state,
      hasConflicts: Boolean(mr.has_conflicts),
      mergeStatus: mr.detailed_merge_status ?? mr.merge_status,
      sha: mr.sha,
      targetBranch: mr.target_branch,
    };
  }

  // reuses an open MR for the same source branch, so a re-run never opens a duplicate
  async createOrGetMr(opts: {
    remotePath: string;
    source: string;
    target: string;
    title: string;
    description: string;
    reviewers: string[];
    draft?: boolean;
  }): Promise<MergeRequest> {
    const projectId = await this.projectId(opts.remotePath);
    const existing = await this.call<any[]>('GET', `/projects/${projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(opts.source)}`);
    if (existing[0]) return this.toMr(projectId, existing[0]);
    const mr = this.config.gitlab.mr;
    const created = await this.call('POST', `/projects/${projectId}/merge_requests`, {
      source_branch: opts.source,
      target_branch: opts.target,
      title: (opts.draft ?? mr.draft) ? `Draft: ${opts.title}` : opts.title,
      description: opts.description,
      remove_source_branch: mr.remove_source_branch,
      reviewer_ids: await this.userIds(opts.reviewers),
    });
    return this.toMr(projectId, created);
  }

  async openMrs(remotePath: string): Promise<Array<{ branch: string; url: string; iid: number; projectId: number }>> {
    const projectId = await this.projectId(remotePath);
    const mrs = await this.call<any[]>('GET', `/projects/${projectId}/merge_requests?state=opened&per_page=100`);
    return mrs.map((m) => ({ branch: m.source_branch, url: m.web_url, iid: m.iid, projectId }));
  }

  async updateDescription(projectId: number, iid: number, description: string): Promise<void> {
    await this.call('PUT', `/projects/${projectId}/merge_requests/${iid}`, { description });
  }

  async getMr(projectId: number, iid: number): Promise<MergeRequest> {
    return this.toMr(projectId, await this.call('GET', `/projects/${projectId}/merge_requests/${iid}`));
  }

  async notes(projectId: number, iid: number): Promise<MrNote[]> {
    const discussions = await this.call<any[]>('GET', `/projects/${projectId}/merge_requests/${iid}/discussions?per_page=100`);
    const notes: MrNote[] = [];
    for (const d of discussions) {
      for (const n of d.notes ?? []) {
        if (n.system) continue;
        notes.push({
          discussionId: d.id,
          noteId: n.id,
          author: n.author?.username,
          body: n.body,
          path: n.position?.new_path,
          line: n.position?.new_line ?? undefined,
          resolved: Boolean(n.resolved),
          ours: String(n.body ?? '').includes(MARKER),
        });
      }
    }
    return notes;
  }

  async comment(projectId: number, iid: number, body: string): Promise<void> {
    await this.call('POST', `/projects/${projectId}/merge_requests/${iid}/notes`, { body: `${body}\n\n<sub>${MARKER}</sub>` });
  }

  async reply(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    await this.call('POST', `/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}/notes`, {
      body: `${body}\n\n<sub>${MARKER}</sub>`,
    });
  }
}
