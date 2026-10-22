import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { TOOL_ROOT } from './util.ts';

const Provider = z.enum(['claude', 'codex', 'fake']);
export type ProviderName = z.infer<typeof Provider>;

const RoleModel = z.object({
  provider: Provider,
  model: z.string().optional(),
  effort: z.string().optional(),
});
export type RoleModel = z.infer<typeof RoleModel>;

export const ROLES = ['dev', 'reviewer', 'simplifier'] as const;
export type Role = (typeof ROLES)[number];

const Profile = z.object({
  dev: RoleModel,
  reviewer: RoleModel,
  simplifier: RoleModel,
  // the once-per-sprint analysis; falls back to dev when a profile doesn't set it
  planner: RoleModel.optional(),
});

const Gate = z.object({
  cmd: z.string(),
  parser: z.enum(['vitest-json', 'mocha-json', 'eslint-json', 'exit-code']),
  // "changed" gates get {files} substituted and are skipped when no matching files changed
  scope: z.enum(['changed', 'all']).default('all'),
  match: z.string().optional(),
  timeout_min: z.number().default(20),
});
export type Gate = z.infer<typeof Gate>;

const Repo = z.object({
  kind: z.enum(['frontend', 'backend-gateway', 'backend-service', 'mobile']),
  description: z.string().default(''),
  path: z.string().optional(),
  remote_path: z.string(),
  target_branch: z.string(),
  writable: z.boolean().default(true),
  commit_format: z.string().default('feat({key}): {summary}'),
  install: z.enum(['symlink', 'npm-ci', 'none']).default('symlink'),
  // 'skip' commits with --no-verify; use only when the repo's hook cannot pass locally
  commit_hooks: z.enum(['run', 'skip']).default('run'),
  gates: z.object({
    focused: z.array(Gate).default([]),
    final: z.array(Gate).default([]),
  }),
  hints: z.array(z.string()).default([]),
  // files the bots must never edit (`**` = a whole folder); edits are undone. Existing migrations are always protected
  protected: z.array(z.string()).default([]),
});
export type Repo = z.infer<typeof Repo>;

const Person = z.object({
  name: z.string(),
  email: z.string().optional(),
  jira_account_id: z.string().optional(),
  gitlab_username: z.string().optional(),
});

const ConfigSchema = z.object({
  jira: z.object({
    base_url: z.string(),
    statuses: z.object({
      in_development: z.string(),
      code_review: z.string(),
      ready_for_test: z.string(),
      blocked: z.string(),
      // while a merged card is in one of these, QA-Question comments still get answered
      testing: z.array(z.string()).default(['Ready For Test', 'In Testing']),
    }),
    techspec_dir: z.string().optional(),
    // the board's project, used by `agent sprint-plan` to find the open sprint
    project: z.string().default('SCRUM'),
  }),
  gitlab: z.object({
    base_url: z.string(),
    mr: z.object({
      title_format: z.string(),
      draft: z.boolean().default(false),
      remove_source_branch: z.boolean().default(true),
      reviewers: z.array(z.string()).default([]),
    }),
    reply_to_mr_comments: z.boolean().default(true),
  }),
  people: z.object({
    pm: Person.optional(),
    tech_lead: Person.optional(),
  }),
  repos: z.record(z.string(), Repo),
  routing: z.object({
    frontend: z.array(z.string()),
    backend: z.array(z.string()),
  }),
  models: z.object({
    default_profile: z.string(),
    profiles: z.record(z.string(), Profile),
  }),
  limits: z.object({
    review_rounds: z.number().default(3),
    gate_fix_attempts: z.number().default(2),
    agent_timeout_min: z.number().default(45),
    feedback_rounds: z.number().default(2),
  }),
  design: z
    .object({
      // besides runs/<KEY>/1-input/design/, also look in the frontend repo's personal .claude/<KEY> and .claude/<number> folders
      legacy_folders: z.boolean().default(true),
      legacy_number_projects: z.array(z.string()).default(['SCRUM']),
    })
    .default({ legacy_folders: true, legacy_number_projects: ['SCRUM'] }),
  // optional: reconnect the VPN by itself with openfortivpn (browser SSO); see README "VPN"
  vpn: z
    .object({
      gateway: z.string(),
      realm: z.string().optional(),
      trusted_cert: z.string().optional(),
      // any HTTP answer from here means we're on the VPN; defaults to the GitLab API
      check_url: z.string().optional(),
      connect_timeout_sec: z.number().default(90),
    })
    .optional(),
  workspace: z.object({
    runs_dir: z.string().default('runs'),
    sprints_dir: z.string().default('sprints'),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over ?? base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

function readYaml(file: string): unknown {
  return fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : {};
}

export function loadConfig(root = TOOL_ROOT): Config {
  const shared = readYaml(path.join(root, 'agent.config.yaml'));
  const local = readYaml(path.join(root, 'agent.local.yaml'));
  const parsed = ConfigSchema.safeParse(deepMerge(shared, local));
  if (!parsed.success) {
    throw new Error(`Invalid agent config:\n${z.prettifyError(parsed.error)}`);
  }
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  return parsed.data;
}

export function resolvePath(p: string, root = TOOL_ROOT): string {
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '', p.slice(2));
  return path.isAbsolute(p) ? p : path.join(root, p);
}

export function repoPath(config: Config, key: string): string {
  const repo = config.repos[key];
  if (!repo) throw new Error(`Unknown repo '${key}'. Known: ${Object.keys(config.repos).join(', ')}`);
  if (!repo.path) throw new Error(`Repo '${key}' has no local path. Set repos.${key}.path in agent.local.yaml`);
  return resolvePath(repo.path);
}

// --set dev=claude:opus:high overrides one role for a single run
export function resolveModels(config: Config, profileName?: string, overrides: string[] = []): Record<Role, RoleModel> {
  const name = profileName ?? config.models.default_profile;
  const profile = config.models.profiles[name];
  if (!profile) throw new Error(`Unknown model profile '${name}'. Known: ${Object.keys(config.models.profiles).join(', ')}`);
  // the planner is for sprint-plan only, not part of a ticket run
  const { planner: _planner, ...roles } = profile;
  const models: Record<Role, RoleModel> = { ...roles };
  for (const item of overrides) {
    const [role, spec] = item.split('=');
    if (!ROLES.includes(role as Role) || !spec) throw new Error(`Bad --set '${item}'. Use role=provider:model[:effort]`);
    const [provider, model, effort] = spec.split(':');
    models[role as Role] = RoleModel.parse({ provider, model: model || undefined, effort: effort || undefined });
  }
  return models;
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}. Add it to .env in the closio-agent folder.`);
  return value;
}

// the model for `agent sprint-plan`: --set planner=... wins, then the profile's planner, then its dev
export function resolvePlanner(config: Config, profileName?: string, overrides: string[] = []): RoleModel {
  const name = profileName ?? config.models.default_profile;
  const profile = config.models.profiles[name];
  if (!profile) throw new Error(`Unknown model profile '${name}'. Known: ${Object.keys(config.models.profiles).join(', ')}`);
  let model = profile.planner ?? profile.dev;
  for (const item of overrides) {
    const [role, spec] = item.split('=');
    if (role !== 'planner') throw new Error(`sprint-plan only takes --set planner=provider:model[:effort], got '${item}'`);
    const [provider, m, effort] = (spec ?? '').split(':');
    model = RoleModel.parse({ provider, model: m || undefined, effort: effort || undefined });
  }
  return model;
}
