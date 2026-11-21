// AI-slop check over this repository: prose rules (petergyang/no-ai-slop) on the docs, and code
// rules on comments in src/, test/, scripts/ and template/. Uses the same rules as the factory
// applies to its own diffs (src/policy/slop.ts), so run `npm run build` first.
// Usage: node scripts/slop-check.mjs [files...]   (exit 1 when anything is found)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatFindings, scanLines } from '../dist/src/policy/slop.js';

// Files that list the banned words and patterns themselves.
const EXEMPT = new Set(['src/policy/slop.ts', 'scripts/slop-check.mjs', 'test/hardening.test.ts', 'test/fixtures/slop/sloppy-math.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.refs', 'runs']);

function walk(d, out) {
  for (const e of readdirSync(d)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function files(args) {
  if (args.length) return args;
  const out = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'factory.config.example.yaml'];
  for (const d of ['docs', 'openspec/changes', 'src', 'test', 'scripts', 'template', 'bin']) walk(d, out);
  return out.filter((f) => !EXEMPT.has(f) && !f.endsWith('.json'));
}

const findings = files(process.argv.slice(2)).flatMap((f) => scanLines(f, readFileSync(f, 'utf8').split('\n')));
if (findings.length) {
  console.error(formatFindings(findings, 500));
  console.error(`\nslop-check: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('slop-check: ok');
