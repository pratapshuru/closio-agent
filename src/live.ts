// One status line under the step that is running, rewritten in place every second,
// so a long step never looks frozen and the log above it stays clean.

let current: Activity | null = null;

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export class Activity {
  private started = Date.now();
  private last = 'starting';
  private lastAt = Date.now();
  private lastPrinted = Date.now();
  private timer?: NodeJS.Timeout;
  private readonly tty = Boolean(process.stderr.isTTY);

  start(): void {
    current = this;
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref();
    this.render();
  }

  update(action: string): void {
    this.last = action;
    this.lastAt = Date.now();
    this.render();
  }

  private line(): string {
    const quiet = Date.now() - this.lastAt;
    // a long silence is the model thinking or writing; say so instead of showing a stale action
    const what = quiet > 20_000 ? `thinking (${duration(quiet)} since: ${this.last})` : this.last;
    return `              ⋯ ${duration(Date.now() - this.started)} · ${what}`;
  }

  render(): void {
    if (this.tty) {
      const width = (process.stderr.columns || 120) - 1;
      process.stderr.write(`\r\x1b[2K${this.line().slice(0, width)}`);
    } else if (Date.now() - this.lastPrinted > 120_000) {
      // logs redirected to a file get a quiet heartbeat instead of a live line
      this.lastPrinted = Date.now();
      process.stderr.write(`${this.line()}\n`);
    }
  }

  clear(): void {
    if (this.tty) process.stderr.write('\r\x1b[2K');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
    if (current === this) current = null;
  }
}

// normal log lines print above the live line, which then redraws under them
export function aroundLiveLine(print: () => void): void {
  current?.clear();
  print();
  current?.render();
}
