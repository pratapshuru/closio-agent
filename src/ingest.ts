import fs from 'node:fs';
import path from 'node:path';
import type { Jira, JiraIssue } from './jira.ts';
import { ensureDir, exec, writeText } from './util.ts';

export type Inputs = {
  dir: string;
  ticket: string;
  // specs for this ticket: given with --spec or attached to the card
  specs: string[];
  // the developer's techspecs list, newest first
  techspecs: string[];
  context: string[];
  figma: string[];
  images: string[];
};

async function pdfToText(pdf: string, out: string): Promise<void> {
  const res = await exec('pdftotext', ['-layout', pdf, out]);
  if (res.code !== 0) throw new Error(`pdftotext failed on ${pdf}: ${res.stderr}. Install with: brew install poppler`);
}

// the run's own text copy of a spec; a second file with the same name gets -2, -3…
async function addSpec(file: string, dir: string): Promise<string> {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  let out = path.join(dir, `${stem}.txt`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${stem}-${n}.txt`);
  if (file.toLowerCase().endsWith('.pdf')) await pdfToText(file, out);
  else fs.copyFileSync(file, out);
  return out;
}

export function ticketMarkdown(issue: JiraIssue): string {
  const comments = issue.comments
    .filter((c) => !c.text.includes('[closio-agent]'))
    .map((c) => `**${c.author}** (${c.created.slice(0, 10)}):\n${c.text}`)
    .join('\n\n');
  return [
    `# ${issue.key} - ${issue.summary}`,
    `Type: ${issue.type} | Status: ${issue.status} | Labels: ${issue.labels.join(', ') || 'none'}`,
    '## Description',
    issue.description || '(empty)',
    comments ? '## Comments\n\n' + comments : '',
    issue.attachments.length ? '## Attachments\n' + issue.attachments.map((a) => `- ${a.filename}`).join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function figmaLinks(text: string): string[] {
  return [...new Set(text.match(/https:\/\/(www\.)?figma\.com\/(design|file|proto)\/[^\s)>\]]+/g) ?? [])];
}

export async function buildInputs(opts: {
  dir: string;
  key: string;
  ticketText: string;
  issue?: JiraIssue;
  jira?: Jira;
  specs: string[];
  techspecs: string[];
  contexts: string[];
}): Promise<Inputs> {
  const dir = ensureDir(opts.dir);
  const specDir = ensureDir(path.join(dir, 'spec'));
  const ticket = path.join(dir, `Ticket-${opts.key}.md`);
  writeText(ticket, opts.ticketText);

  const specs: string[] = [];
  const images: string[] = [];
  for (const file of opts.specs) specs.push(await addSpec(file, specDir));
  const saved: string[] = [];
  for (const att of opts.issue?.attachments ?? []) {
    if (!opts.jira) continue;
    if (/\.(pdf|md|txt)$/i.test(att.filename)) {
      // the original goes aside; the spec folder only holds the uniquely named text copies
      const raw = path.join(ensureDir(path.join(dir, 'attachments')), att.filename);
      fs.writeFileSync(raw, await opts.jira.attachment(att.url));
      specs.push(await addSpec(raw, specDir));
    } else if (/\.(png|jpe?g|gif|webp)$/i.test(att.filename)) {
      const file = path.join(ensureDir(path.join(dir, 'attachments')), att.filename);
      fs.writeFileSync(file, await opts.jira.attachment(att.url));
      images.push(file);
      saved.push(`- ${att.filename}: \`${file}\``);
    }
  }
  if (saved.length) fs.appendFileSync(ticket, `\n## Attachment files (open these, they are part of the ticket)\n\n${saved.join('\n')}\n`);

  const context: string[] = [];
  for (const src of opts.contexts) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) throw new Error(`Context path not found: ${src}`);
    const link = path.join(dir, 'context', path.basename(abs));
    ensureDir(path.dirname(link));
    if (!fs.existsSync(link)) fs.symlinkSync(abs, link);
    context.push(abs);
  }

  const techspecs: string[] = [];
  for (const file of opts.techspecs) techspecs.push(await addSpec(file, specDir));

  // the design brief (figma.md) is written by prepareDesign at planning time
  const figma = figmaLinks(opts.ticketText);
  return { dir, ticket, specs, techspecs, context, figma, images };
}
