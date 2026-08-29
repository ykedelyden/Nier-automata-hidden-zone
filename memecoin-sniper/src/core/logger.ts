type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const COLOR: Record<Level, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

let threshold = ORDER.info;
let useColor = process.stdout.isTTY === true;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

export function setColor(on: boolean): void {
  useColor = on;
}

function stamp(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const tail = fields && Object.keys(fields).length > 0 ? ' ' + fmtFields(fields) : '';
  const head = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const line = `${head} ${msg}${tail}`;
  const stream = ORDER[level] >= ORDER.warn ? process.stderr : process.stdout;
  stream.write(useColor ? `${COLOR[level]}${line}\x1b[0m\n` : `${line}\n`);
}

function fmtFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmtValue(v)}`);
  }
  return parts.join(' ');
}

function fmtValue(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (v instanceof Error) return JSON.stringify(`${v.name}: ${v.message}`);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(sub: string): Logger;
}

export function makeLogger(scope: string): Logger {
  return {
    trace: (m, f) => emit('trace', scope, m, f),
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => makeLogger(`${scope}:${sub}`),
  };
}
