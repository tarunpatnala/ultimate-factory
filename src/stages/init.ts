import { out as sink } from '../util/output.js';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function templateDir(): string {
  // dist/src/stages/init.js -> package root /template ; src/stages/init.ts (ts-node) -> same
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['../../../template', '../../template']) {
    const p = join(here, up);
    if (existsSync(join(p, 'docs/factory/CHARTER.md'))) return p;
  }
  throw new Error('template directory not found in package');
}

export interface InitOptions {
  target: string;
  dryRun: boolean;
  withWorkflows: boolean;
  harness: Array<'claude' | 'codex'>;
  /** How the user invoked us (e.g. "npx ultimate-factory"), for copy-pasteable next steps. */
  invokedAs?: string;
}

/** Copy template files that do not exist. Never overwrites. Returns counts. */
export function initCommand(o: InitOptions, out: (l: string) => void = (l) => sink.write(l + '\n')): { created: string[]; skipped: string[] } {
  const src = templateDir();
  const created: string[] = [];
  const skipped: string[] = [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(relative(src, p).split('\\').join('/'));
    }
  };
  walk(src);
  out(`ultimate-factory template -> ${o.target}${o.dryRun ? ' (dry run)' : ''}`);
  for (const rel of files.sort()) {
    if (rel.startsWith('.github/workflows/') && !o.withWorkflows) continue;
    if ((rel.startsWith('.claude/') || rel === 'CLAUDE.md') && !o.harness.includes('claude')) continue;
    if ((rel.startsWith('.agents/') || rel.startsWith('.codex/') || rel === 'AGENTS.md') && !o.harness.includes('codex')) continue;
    const dst = join(o.target, rel);
    if (existsSync(dst)) {
      out(`  skip    ${rel} (exists)`);
      skipped.push(rel);
      continue;
    }
    out(`  create  ${rel}`);
    created.push(rel);
    if (o.dryRun) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(src, rel), dst);
    if (rel.endsWith('.sh')) chmodSync(dst, 0o755);
  }
  out(`\n${created.length} created, ${skipped.length} skipped.`);
  if (!o.dryRun) {
    const cmd = o.invokedAs ?? 'ufactory';
    out(created.length ? '\nNext steps:' : '\nNothing new to install. Reminder of the setup steps:');
    out('  1. Edit factory.config.yaml (provider + models) and export the API key env var(s) it names');
    out('     (OPENAI_API_KEY for the openai profile, PORTKEY_API_KEY for the portkey profile).');
    out('  2. Fill in docs/factory/CHARTER.md and set CHARTER_STATUS: ready (a human decision).');
    out('  3. Edit .factory/gates.conf for your real type/lint/test commands; set agent.test_command.');
    out(`  4. ${cmd} doctor --ping`);
    out(`  5. gh auth login, then: ${cmd} labels --apply`);
    out(`  6. ${cmd} triage   (dry run), then add --apply`);
    if (!o.withWorkflows) out(`\nFor unattended GitHub Actions runs, re-run: ${cmd} init --with-workflows`);
    else {
      out('\nGitHub Actions setup (see README "Run it unattended"):');
      out('  - repository variable UFACTORY_PACKAGE = where to install ultimate-factory from (exact version or git URL + tag)');
      out('  - secrets OPENAI_API_KEY and/or PORTKEY_API_KEY; optional FACTORY_GH_TOKEN (GitHub App/PAT) so factory PRs trigger CI');
      out('  - a branch ruleset on the default branch requiring "factory-policy / policy-check" and PR review');
    }
  }
  return { created, skipped };
}
