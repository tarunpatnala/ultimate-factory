import type { Redactor } from './redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export class Logger {
  constructor(
    private level: LogLevel = 'info',
    private redactor?: Redactor,
    private readonly sink: (line: string) => void = (l) => process.stderr.write(l + '\n'),
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }
  setRedactor(r: Redactor): void {
    this.redactor = r;
  }

  private emit(level: LogLevel, msg: string): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const text = this.redactor ? this.redactor.redact(msg) : msg;
    const tag = level === 'info' ? '' : `[${level}] `;
    this.sink(`${tag}${text}`);
  }
  debug(msg: string): void {
    this.emit('debug', msg);
  }
  info(msg: string): void {
    this.emit('info', msg);
  }
  warn(msg: string): void {
    this.emit('warn', msg);
  }
  error(msg: string): void {
    this.emit('error', msg);
  }
}

export const log = new Logger();
