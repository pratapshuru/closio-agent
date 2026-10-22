import type { Config } from './config.ts';
import { requireEnv } from './config.ts';
import { download, request } from './http.ts';
import { MARKER } from './util.ts';

export type JiraComment = { id: string; authorId: string; author: string; created: string; text: string };

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  type: string;
  labels: string[];
  description: string;
  attachments: Array<{ filename: string; mimeType: string; url: string }>;
  comments: JiraComment[];
  epic?: string;
  // keys of tickets linked in Jira (any link type, e.g. "Relates")
  links: string[];
  reporterId?: string;
  sprints: Array<{ id: number; name: string; state: string }>;
};

// one line of the sprint map: enough to judge relevance without the full text
export type JiraSummary = { key: string; summary: string; status: string; done?: boolean; type: string; epic?: string; links: string[] };

// Atlassian Document Format to markdown, enough for tickets: text, lists, tables, code, links
export function adfToMarkdown(node: any, depth = 0): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map((n) => adfToMarkdown(n, depth)).join('');
  const kids = () => adfToMarkdown(node.content ?? [], depth);
  switch (node.type) {
    case 'doc':
      return kids().trim();
    case 'paragraph':
      return kids() + '\n\n';
    case 'heading':
      return '#'.repeat(node.attrs?.level ?? 2) + ' ' + kids() + '\n\n';
    case 'text': {
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        if (mark.type === 'code') text = '`' + text + '`';
        if (mark.type === 'strong') text = `**${text}**`;
        if (mark.type === 'link') text = `[${text}](${mark.attrs?.href})`;
      }
      return text;
    }
    case 'hardBreak':
      return '\n';
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item: any, i: number) => '  '.repeat(depth) + (node.type === 'orderedList' ? `${i + 1}. ` : '- ') + adfToMarkdown(item.content ?? [], depth + 1).trim())
        .join('\n') + '\n\n';
    case 'codeBlock':
      return '```\n' + kids() + '\n```\n\n';
    case 'blockquote':
      return kids().split('\n').map((l) => (l ? '> ' + l : l)).join('\n');
    case 'rule':
      return '---\n\n';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ? `<${node.attrs.url}>` : '';
    case 'mention':
      return node.attrs?.text ?? '@user';
    case 'emoji':
      return node.attrs?.text ?? '';
    case 'table': {
      const rows = (node.content ?? []).map((row: any) =>
        (row.content ?? []).map((cell: any) => adfToMarkdown(cell.content ?? [], depth).replace(/\n+/g, ' ').trim()),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r: string[]) => r.length));
      const line = (r: string[]) => '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |';
      return [line(rows[0]), '|' + ' --- |'.repeat(width), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]\n\n';
    default:
      return kids();
  }
}

// markdown-ish to ADF: paragraphs, code fences, bullets, links and @mentions
export function markdownToAdf(markdown: string, mentions: Record<string, string> = {}): object {
  const content: any[] = [];
  const lines = markdown.split('\n');
  let para: string[] = [];
  let bullets: string[] = [];
  const inline = (text: string): any[] => {
    const parts: any[] = [];
    const re = /(@\w+)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index! > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
      if (m[1] && mentions[m[1].slice(1)]) parts.push({ type: 'mention', attrs: { id: mentions[m[1].slice(1)] } });
      else if (m[1]) parts.push({ type: 'text', text: m[1] });
      else if (m[2]) parts.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[3] } }] });
      else if (m[4]) parts.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] });
      else if (m[5]) parts.push({ type: 'text', text: m[5], marks: [{ type: 'strong' }] });
      last = m.index! + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return parts.length ? parts : [{ type: 'text', text: ' ' }];
  };
  const flush = () => {
    if (para.length) content.push({ type: 'paragraph', content: inline(para.join(' ')) });
    if (bullets.length) {
      content.push({
        type: 'bulletList',
        content: bullets.map((b) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inline(b) }] })),
      });
    }
    para = [];
    bullets = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      // Jira rejects language: null, so leave attrs out when there's no language
      const language = line.slice(3).trim();
      content.push({ type: 'codeBlock', ...(language ? { attrs: { language } } : {}), content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
    } else if (/^#{1,6} /.test(line)) {
      flush();
      const level = line.match(/^#+/)![0].length;
      content.push({ type: 'heading', attrs: { level }, content: inline(line.replace(/^#+ /, '')) });
    } else if (/^\s*[-*] /.test(line)) {
      if (para.length) flush();
      bullets.push(line.replace(/^\s*[-*] /, ''));
    } else if (!line.trim()) {
      flush();
    } else {
      if (bullets.length) flush();
      para.push(line);
    }
  }
  flush();
  return { type: 'doc', version: 1, content };
}

export class Jira {
  private config: Config;
  private auth: string;

  constructor(config: Config) {
    this.config = config;
    this.auth = 'Basic ' + Buffer.from(`${requireEnv('JIRA_EMAIL')}:${requireEnv('JIRA_API_TOKEN')}`).toString('base64');
  }

  private call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(method, this.config.jira.base_url + path, { Authorization: this.auth }, body);
  }

  async myself(): Promise<{ accountId: string; displayName: string }> {
    return this.call('GET', '/rest/api/3/myself');
  }

  async findAccountId(email: string): Promise<string | undefined> {
    const users = await this.call<any[]>('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
    return users[0]?.accountId;
  }

  private sprintField?: string | null;

  // the sprint field is a custom field whose id differs per Jira site
  async sprintFieldId(): Promise<string | null> {
    if (this.sprintField !== undefined) return this.sprintField ?? null;
    const fields = await this.call<any[]>('GET', '/rest/api/3/field');
    const id: string | null = fields.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id ?? null;
    this.sprintField = id;
    return id;
  }

  async search(jql: string, max = 300): Promise<JiraSummary[]> {
    const out: JiraSummary[] = [];
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ jql, fields: 'summary,status,issuetype,parent,issuelinks', maxResults: '100' });
      if (token) params.set('nextPageToken', token);
      const data = await this.call('GET', `/rest/api/3/search/jql?${params}`);
      for (const i of data.issues ?? []) {
        out.push({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status?.name,
          done: i.fields.status?.statusCategory?.key === 'done',
          type: i.fields.issuetype?.name,
          epic: i.fields.parent?.key,
          links: linkKeys(i.fields.issuelinks),
        });
      }
      token = data.nextPageToken;
    } while (token && out.length < max);
    return out;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const sprint = await this.sprintFieldId().catch(() => null);
    const fields = ['summary', 'status', 'issuetype', 'labels', 'description', 'attachment', 'comment', 'parent', 'issuelinks', 'reporter', sprint].filter(Boolean).join(',');
    const data = await this.call('GET', `/rest/api/3/issue/${key}?fields=${fields}`);
    const f = data.fields;
    return {
      epic: f.parent?.key,
      links: linkKeys(f.issuelinks),
      reporterId: f.reporter?.accountId,
      sprints: (sprint ? f[sprint] ?? [] : []).map((x: any) => ({ id: x.id, name: x.name, state: x.state })),
      key: data.key,
      summary: f.summary,
      status: f.status?.name,
      type: f.issuetype?.name,
      labels: f.labels ?? [],
      description: adfToMarkdown(f.description),
      attachments: (f.attachment ?? []).map((a: any) => ({ filename: a.filename, mimeType: a.mimeType, url: a.content })),
      comments: (f.comment?.comments ?? []).map((c: any) => ({
        id: c.id,
        authorId: c.author?.accountId,
        author: c.author?.displayName,
        created: c.created,
        text: adfToMarkdown(c.body),
      })),
    };
  }

  async comments(key: string): Promise<JiraComment[]> {
    // newest 100, handed back oldest first, so a long thread never hides the latest comments
    const data = await this.call('GET', `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=100`);
    return [...(data.comments ?? [])].reverse().map((c: any) => ({
      id: c.id,
      authorId: c.author?.accountId,
      author: c.author?.displayName,
      created: c.created,
      text: adfToMarkdown(c.body),
    }));
  }

  async addComment(key: string, markdown: string, mentions: Record<string, string> = {}): Promise<string> {
    const text = `${markdown}\n\n_${MARKER}_`;
    try {
      const res = await this.call('POST', `/rest/api/3/issue/${key}/comment`, { body: markdownToAdf(text, mentions) });
      return res.id;
    } catch (err) {
      if (!/HTTP 400/.test((err as Error).message)) throw err;
      // a formatting bug must never block publishing: resend as plain paragraphs
      const plain = { type: 'doc', version: 1, content: text.split(/\n{2,}/).filter((p) => p.trim()).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) };
      const res = await this.call('POST', `/rest/api/3/issue/${key}/comment`, { body: plain });
      return res.id;
    }
  }

  // done = Jira's own "Done" group (Done, Closed, Resolved, …), whatever the board calls it
  async status(key: string): Promise<{ name: string; done: boolean }> {
    const issue = await this.call('GET', `/rest/api/3/issue/${key}?fields=status`);
    return { name: issue.fields.status?.name ?? '', done: issue.fields.status?.statusCategory?.key === 'done' };
  }

  async transition(key: string, status: string): Promise<boolean> {
    const issue = await this.call('GET', `/rest/api/3/issue/${key}?fields=status`);
    if (issue.fields.status?.name?.toLowerCase() === status.toLowerCase()) return false;
    const data = await this.call('GET', `/rest/api/3/issue/${key}/transitions`);
    const match = (data.transitions ?? []).find(
      (t: any) => t.to?.name?.toLowerCase() === status.toLowerCase() || t.name?.toLowerCase() === status.toLowerCase(),
    );
    if (!match) {
      const names = (data.transitions ?? []).map((t: any) => t.to?.name).join(', ');
      throw new Error(`Jira ${key}: no transition to '${status}'. Available: ${names}`);
    }
    await this.call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: match.id } });
    return true;
  }

  async attachment(url: string): Promise<Buffer> {
    return download(url, { Authorization: this.auth });
  }
}

function linkKeys(links: any[] | undefined): string[] {
  return (links ?? []).map((l) => (l.outwardIssue ?? l.inwardIssue)?.key).filter(Boolean);
}

export function isOurComment(text: string): boolean {
  return text.includes(MARKER);
}
