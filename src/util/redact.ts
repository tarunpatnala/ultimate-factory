/** Secret redaction for logs, errors and run records. */

const REDACTED = '[REDACTED]';
export const SENSITIVE_HEADERS = ['authorization', 'api-key', 'x-portkey-api-key', 'x-portkey-virtual-key', 'openai-organization', 'openai-project'];

const GENERIC_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
];

export class Redactor {
  private readonly values: string[];

  constructor(secretEnvNames: string[] = [], env: NodeJS.ProcessEnv = process.env) {
    const vals = new Set<string>();
    for (const name of secretEnvNames) {
      const v = env[name];
      if (v && v.length >= 6) vals.add(v);
    }
    // Longest first so overlapping secrets are fully covered.
    this.values = [...vals].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const v of this.values) out = out.split(v).join(REDACTED);
    for (const re of GENERIC_PATTERNS) {
      out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && /^Bearer/i.test(prefix) ? `${prefix}${REDACTED}` : REDACTED));
    }
    return out;
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? REDACTED : this.redact(v);
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v);
      return out as T;
    }
    return value;
  }
}
