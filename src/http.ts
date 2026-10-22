import { log, network } from './util.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// JSON request with retries on network errors, 429 and 5xx
export async function request<T = any>(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  hint = '',
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt >= 3) throw new Error(`${method} ${new URL(url).host} failed: ${(err as Error).message}. ${hint}`);
      log(`  network error, retrying (${attempt}/3)`);
      // a hint means this host sits behind the VPN; try bringing it back before the retry
      if (hint && attempt === 1 && network.recover) await network.recover();
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep the raw text
    }
    if (res.ok) return parsed as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    throw new HttpError(res.status, `${method} ${url} → HTTP ${res.status}: ${typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500)}`, parsed);
  }
}

export async function download(url: string, headers: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new HttpError(res.status, `download ${url} → HTTP ${res.status}`, null);
  return Buffer.from(await res.arrayBuffer());
}
