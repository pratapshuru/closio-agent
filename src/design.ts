import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { resolvePath } from './config.ts';
import { figmaLinks } from './ingest.ts';
import { runDir } from './state.ts';
import { ensureDir, exec, render, TOOL_ROOT, writeText } from './util.ts';

export type McpStatus = 'connected' | 'needs_auth' | 'missing';

// how the dev bot gets the design for this ticket, in order of preference
export type DesignMode = 'folder' | 'saved' | 'mcp' | 'unavailable' | 'skipped' | 'none';

export type Design = {
  mode: DesignMode;
  links: string[];
  folders: string[];
  docs: string[];
  images: string[];
  // where the dev bot saves what it fetches through Figma MCP
  mcpDir: string;
  mcp: McpStatus;
};

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const DOC = /\.(md|css|txt)$/i;

// read-only Figma MCP tools the dev bot may call
export const FIGMA_TOOLS = ['get_design_context', 'get_screenshot', 'get_metadata', 'get_variable_defs'];

export async function figmaMcpStatus(): Promise<McpStatus> {
  const forced = process.env.CLOSIO_FIGMA_MCP;
  if (forced === 'connected' || forced === 'needs_auth' || forced === 'missing') return forced;
  const res = await exec('claude', ['mcp', 'list'], { timeoutMs: 60_000 }).catch(() => null);
  const line = res?.stdout.split('\n').find((l) => /^figma:/i.test(l.trim()));
  if (!line) return 'missing';
  return /connected/i.test(line) && !/needs|fail/i.test(line) ? 'connected' : 'needs_auth';
}

// where the developer drops screenshots and CSS dumps for a ticket
export function designDropDir(config: Config, key: string): string {
  return path.join(runDir(config, key), '1-input', 'design');
}

// the developer's own per-ticket prompt or brief, if they wrote one
export function findBrief(config: Config, key: string): string | undefined {
  const own = path.join(runDir(config, key), '1-input', 'brief.md');
  if (fs.existsSync(own)) return own;
  const number = key.match(/-(\d+)$/)?.[1];
  const numbered = number && config.design.legacy_number_projects.some((p) => key.startsWith(`${p}-`));
  for (const repo of Object.values(config.repos)) {
    if (repo.kind !== 'frontend' || !repo.path) continue;
    for (const dir of [key, ...(numbered ? [number] : [])]) {
      const folder = path.join(resolvePath(repo.path), '.claude', dir);
      const hit = listFiles(folder).find((f) => /(prompt|brief)[^/]*\.md$/i.test(path.basename(f)));
      if (hit) return hit;
    }
  }
  return undefined;
}

// folders where a developer dropped screenshots and CSS dumps for this ticket
export function findDesignFolders(config: Config, key: string): string[] {
  const found: string[] = [];
  const add = (dir: string) => {
    const figmaSub = path.join(dir, 'figma');
    const pick = fs.existsSync(figmaSub) && fs.statSync(figmaSub).isDirectory() ? figmaSub : dir;
    if (fs.existsSync(pick) && fs.statSync(pick).isDirectory() && !found.includes(pick)) found.push(pick);
  };
  add(designDropDir(config, key));
  if (config.design.legacy_folders) {
    const number = key.match(/-(\d+)$/)?.[1];
    const numbered = number && config.design.legacy_number_projects.some((p) => key.startsWith(`${p}-`));
    for (const repo of Object.values(config.repos)) {
      if (repo.kind !== 'frontend' || !repo.path) continue;
      const base = path.join(resolvePath(repo.path), '.claude');
      add(path.join(base, key));
      if (numbered) add(path.join(base, number));
    }
  }
  return found.filter((dir) => listFiles(dir).length);
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name));
}

// design files in the folders, plus images that index files like screenshots.md point to
export function collectDesignFiles(folders: string[]): { docs: string[]; images: string[] } {
  const docs: string[] = [];
  const images: string[] = [];
  for (const dir of folders) {
    for (const file of listFiles(dir)) {
      if (IMAGE.test(file)) images.push(file);
      else if (DOC.test(file)) {
        docs.push(file);
        const text = fs.readFileSync(file, 'utf8');
        // quoted paths may contain spaces ("Mapping skor figma screenshots/7.png"); bare ones may not
        const quoted = [...text.matchAll(/['"`](\/[^'"`\n]+?\.(?:png|jpe?g|webp|gif))['"`]/gi)].map((m) => m[1]);
        const bare = [...text.matchAll(/(\/[^\s'"`<>()]+?\.(?:png|jpe?g|webp|gif))/gi)].map((m) => m[1]);
        for (const file of [...quoted, ...bare]) {
          if (fs.existsSync(file) && !images.includes(file)) images.push(file);
        }
      }
    }
  }
  return { docs, images };
}

function savedFiles(mcpDir: string): string[] {
  return listFiles(mcpDir).filter((f) => DOC.test(f));
}

export async function prepareDesign(config: Config, key: string, inputsDir: string, ticketText: string, skipped: boolean): Promise<Design> {
  const links = figmaLinks(ticketText);
  const mcpDir = ensureDir(path.join(inputsDir, 'figma', 'mcp'));
  const folders = findDesignFolders(config, key);
  const { docs, images } = collectDesignFiles(folders);
  const saved = savedFiles(mcpDir);
  // only ask claude about MCP when it could matter
  const mcp = links.length ? await figmaMcpStatus() : 'missing';

  let mode: DesignMode;
  if (folders.length) mode = 'folder';
  else if (saved.length) mode = 'saved';
  else if (!links.length) mode = 'none';
  // the developer's "continue without design" wins, even if MCP still reports connected
  else if (skipped) mode = 'skipped';
  else if (mcp === 'connected') mode = 'mcp';
  else mode = 'unavailable';

  const design: Design = { mode, links, folders, docs: [...docs, ...saved], images, mcpDir, mcp };
  writeText(path.join(inputsDir, 'figma.md'), designBrief(design));
  return design;
}

function nodeId(link: string): string {
  return new URL(link).searchParams.get('node-id')?.replace('-', ':') ?? '(whole file)';
}

// the wording lives in prompts/design/*.md so it can be edited without touching code
function template(name: string): string {
  return fs.readFileSync(path.join(TOOL_ROOT, 'prompts', 'design', `${name}.md`), 'utf8').trim();
}

export function designBrief(d: Design): string {
  const links = d.links.length ? d.links.map((l) => `- ${l} (node ${nodeId(l)})`).join('\n') : '- none in the ticket';
  const files = (items: string[]) => items.map((f) => `- \`${f}\``).join('\n') || '- none';
  const saveRules = render(template('save-rules'), { mcpDir: d.mcpDir });
  const mcpExtras = d.mcp === 'connected' ? render(template('mcp-extras'), { saveRules }) : '';
  const vars = { images: files(d.images), docs: files(d.docs), mcpExtras, saveRules };
  const body = render(template(d.mode), vars);
  return render(template('brief'), { links, body }) + '\n';
}

export function designWaitMessage(key: string, folder: string, mcp: McpStatus): string {
  const why = mcp === 'missing'
    ? 'Figma MCP is not set up on this machine'
    : mcp === 'needs_auth'
      ? 'Figma MCP needs you to log in again (`claude`, then `/mcp`, then figma)'
      : 'Figma could not be reached (rate limit or access)';
  return render(template('wait'), { key, folder, why });
}
