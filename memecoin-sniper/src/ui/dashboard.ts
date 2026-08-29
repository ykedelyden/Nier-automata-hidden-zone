import { metrics } from '../core/metrics.js';
import { sol, truncMint } from '../core/util.js';
import type { RiskEngine } from '../risk/riskEngine.js';
import type { PositionStore } from '../position/store.js';
import type { RpcPool } from '../chain/rpcPool.js';
import type { FeeOracle } from '../chain/fees.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

function pnlColor(v: number): string {
  return v >= 0 ? GREEN : RED;
}

function bar(label: string): string {
  return `${DIM}${'─'.repeat(4)} ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}${RESET}`;
}

/**
 * Periodic status block on stdout. Deliberately append-only rather than a
 * full-screen TUI: the log stream is the primary record when something goes
 * wrong at 3am, and a redrawing UI destroys it.
 */
export class Dashboard {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: PositionStore,
    private readonly risk: RiskEngine,
    private readonly pool: RpcPool,
    private readonly fees: FeeOracle,
    private readonly intervalMs = 20_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.render(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  render(): void {
    const lines: string[] = [];
    const snap = metrics.snapshot();
    const r = this.risk.status();

    lines.push('');
    lines.push(bar('STATUS'));
    lines.push(
      `  day=${r.day}  realised=${pnlColor(Number(r.realised))}${r.realised} SOL${RESET}  ` +
        `trades=${r.trades} wins=${r.wins}  exposure=${r.openExposure} SOL` +
        (r.halted ? `  ${RED}HALTED(${r.halted})${RESET}` : '') +
        (r.cooldownMsLeft > 0 ? `  ${DIM}cooldown ${Math.ceil(r.cooldownMsLeft / 1000)}s${RESET}` : ''),
    );

    const detected = snap.counters['dispatch.unique'] ?? 0;
    const dupes = snap.counters['dispatch.duplicate'] ?? 0;
    const opened = snap.counters['position.opened'] ?? 0;
    const vetoed = snap.counters['pipeline.skipped'] ?? 0;
    lines.push(
      `  launches=${detected} (dupes ${dupes})  skipped=${vetoed}  entered=${opened}  ` +
        `entryFail=${snap.counters['position.entry_failed'] ?? 0}`,
    );

    const hot = snap.latency['filter.hot'];
    const land = snap.latency['send.land.buy'];
    const spread = snap.latency['dispatch.spread'];
    lines.push(bar('LATENCY (ms)'));
    if (hot) lines.push(`  filter   p50=${hot.p50.toFixed(0)} p90=${hot.p90.toFixed(0)} p99=${hot.p99.toFixed(0)} n=${hot.n}`);
    if (land) lines.push(`  buy land p50=${land.p50.toFixed(0)} p90=${land.p90.toFixed(0)} p99=${land.p99.toFixed(0)} n=${land.n}`);
    if (spread) lines.push(`  rpc edge p50=${spread.p50.toFixed(0)} p90=${spread.p90.toFixed(0)} ${DIM}(gap between fastest and slowest provider)${RESET}`);

    const f = this.fees.stats();
    lines.push(`  fees     p50=${f.p50.toFixed(0)} p75=${f.p75.toFixed(0)} p95=${f.p95.toFixed(0)} µlamports/CU (n=${f.samples})`);

    const health = this.pool.health();
    lines.push(
      `  rpc      ${health.map((h) => `${h.node}:${h.p50 < 0 ? '-' : h.p50.toFixed(0)}${h.rested ? '(rested)' : ''}`).join('  ')}`,
    );

    const open = this.store.open();
    if (open.length > 0) {
      lines.push(bar('OPEN'));
      for (const p of open) {
        const mult = p.entryPrice > 0 ? p.lastPrice / p.entryPrice : 0;
        const pct = (mult - 1) * 100;
        lines.push(
          `  ${truncMint(p.mint)}  ${BOLD}${mult.toFixed(2)}x${RESET} ` +
            `${pnlColor(pct)}${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%${RESET}  ` +
            `peak=${(p.peakPrice / (p.entryPrice || 1)).toFixed(2)}x  ` +
            `cost=${sol(p.costLamports)}  held=${Math.round((Date.now() - p.openedAt) / 1000)}s  ` +
            `rungs=[${p.rungsHit.filter((i) => i >= 0).join(',')}]`,
        );
      }
    }
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  }
}
