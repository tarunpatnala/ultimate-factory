// Repository lint: cheap, deterministic rules that a type checker does not cover.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    if (['node_modules', 'dist', '.git', '.refs'].includes(e)) continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
for (const f of walk('src')) {
  const s = readFileSync(f, 'utf8');
  if (/console\.log\(/.test(s)) problems.push(`${f}: console.log (use the logger or util/output)`);
  if (/process\.stdout\.write/.test(s) && !f.endsWith('util/output.ts')) problems.push(`${f}: write stage output through util/output.ts`);
  if (/\beval\(|new Function\(/.test(s)) problems.push(`${f}: dynamic code evaluation`);
  if (/shell:\s*true/.test(s)) problems.push(`${f}: spawn with shell:true`);
}
for (const f of [...walk('template/.github'), ...walk('.github')]) {
  const s = readFileSync(f, 'utf8');
  if (/pull_request_target/.test(s.replace(/#.*$/gm, ''))) problems.push(`${f}: pull_request_target is forbidden`);
  if (!/^permissions:/m.test(s)) problems.push(`${f}: workflow must declare top-level permissions`);
}
const secretRe = /\b(sk-(proj-)?[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/;
for (const f of [...walk('src'), ...walk('template'), ...walk('docs'), 'factory.config.example.yaml']) {
  if (secretRe.test(readFileSync(f, 'utf8'))) problems.push(`${f}: looks like a committed secret`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
// Prose rules from petergyang/no-ai-slop for the docs we write.
await import('./slop-check.mjs');
