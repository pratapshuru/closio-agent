import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { resolvePath } from './config.ts';
import { ensureDir, exec, log } from './util.ts';

// both run through the one-time admin rule (README "VPN"), so no password prompt
const OPENFORTIVPN = '/opt/homebrew/bin/openfortivpn';
const PKILL = '/usr/bin/pkill';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkUrl(config: Config): string {
  return config.vpn?.check_url ?? `${config.gitlab.base_url}/api/v4/version`;
}

function logFile(config: Config): string {
  return path.join(ensureDir(path.join(resolvePath(config.workspace.runs_dir), '_vpn')), 'openfortivpn.log');
}

// any HTTP answer counts; only a network failure means we're off the VPN
export async function reachable(config: Config): Promise<boolean> {
  try {
    await fetch(checkUrl(config), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

export async function vpnRunning(): Promise<boolean> {
  return (await exec('pgrep', ['-x', 'openfortivpn'])).code === 0;
}

let inFlight: Promise<boolean> | null = null;

// one check-and-connect at a time, however many calls fail together
export function ensureVpn(config: Config): Promise<boolean> {
  inFlight ??= (async () => {
    if (await reachable(config)) return true;
    if (!config.vpn) {
      log('  GitLab is not reachable. Connect the VPN (or add vpn: to agent.local.yaml to connect automatically)');
      return false;
    }
    return connect(config);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function connect(config: Config): Promise<boolean> {
  const vpn = config.vpn;
  if (!vpn) throw new Error('No vpn: settings in agent.local.yaml');
  // a tunnel that is up but can't reach GitLab is stuck; start over
  if (await vpnRunning()) await disconnect();
  const file = logFile(config);
  const out = fs.openSync(file, 'w');
  const args = ['-n', OPENFORTIVPN, vpn.gateway, '--saml-login', ...(vpn.realm ? [`--realm=${vpn.realm}`] : []), ...(vpn.trusted_cert ? ['--trusted-cert', vpn.trusted_cert] : [])];
  log(`  connecting the VPN (${vpn.gateway}); the browser finishes the SSO login`);
  // detached, so the VPN stays up after this command ends, like FortiClient
  const child = spawn('sudo', args, { detached: true, stdio: ['ignore', out, out] });
  let exited = false;
  child.on('exit', () => (exited = true));
  child.unref();
  fs.closeSync(out);

  let opened = false;
  const deadline = Date.now() + vpn.connect_timeout_sec * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const text = fs.readFileSync(file, 'utf8');
    if (/password is required|terminal is required/.test(text)) {
      log('  VPN: openfortivpn needs the one-time admin rule (README, "VPN")');
      return false;
    }
    if (/certificate validation failed/i.test(text)) {
      const digest = text.match(/--trusted-cert ([0-9a-f]{64})/)?.[1];
      log(`  VPN: the server's certificate changed${digest ? ` (new digest ${digest})` : ''}. If IT renewed it, put the new digest in vpn.trusted_cert in agent.local.yaml`);
      await disconnect();
      return false;
    }
    const login = text.match(/Authenticate at '([^']+)'/)?.[1];
    if (login && !opened) {
      opened = true;
      await exec('open', [login]);
    }
    if (/Tunnel is up and running/.test(text) && (await reachable(config))) {
      log('  VPN connected');
      return true;
    }
    if (exited) {
      log(`  VPN: openfortivpn stopped. Last lines:\n${text.trim().split('\n').slice(-5).join('\n')}`);
      return false;
    }
  }
  // left running: if the browser is waiting on a sign-in, finishing it still brings the VPN up
  log(`  VPN did not come up within ${vpn.connect_timeout_sec}s. If the browser shows a login page, sign in there. Log: ${file}`);
  return false;
}

export async function disconnect(): Promise<void> {
  await exec('sudo', ['-n', PKILL, '-x', 'openfortivpn']);
  for (let i = 0; i < 10 && (await vpnRunning()); i++) await sleep(1000);
}
