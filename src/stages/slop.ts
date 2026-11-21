import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { diffText } from '../policy/diff.js';
import { formatFindings, scanDiff, scanLines, type SlopFinding } from '../policy/slop.js';
import { FactoryError } from '../util/errors.js';
import { runGit } from '../util/git.js';
import { out } from '../util/output.js';

const SKIP = new Set(['node_modules', 'dist', 'build', 'bin', 'obj', 'target', 'vendor', '.git', '.venv', '__pycache__']);

function walk(root: string, p: string, acc: string[]): void {
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) if (!SKIP.has(e)) walk(root, join(p, e), acc);
  } else acc.push(relative(root, p).split('\\').join('/'));
}

/** `ufactory slop`: the same check implement applies at finish, for any diff or file set. */
export async function slopCommand(o: { cwd: string; base?: string; paths: string[] }): Promise<number> {
  let found: SlopFinding[];
  if (o.base) {
    if ((await runGit(['rev-parse', '--verify', `${o.base}^{commit}`], { cwd: o.cwd })).code !== 0) throw new FactoryError(`cannot resolve ${o.base}`, 'USAGE', 2);
    found = scanDiff(await diffText(o.cwd, o.base, 2_000_000));
  } else {
    const files: string[] = [];
    for (const p of o.paths.length ? o.paths : ['.']) walk(o.cwd, join(o.cwd, p), files);
    found = files.flatMap((f) => {
      try {
        return scanLines(f, readFileSync(join(o.cwd, f), 'utf8').split('\n'));
      } catch {
        return [];
      }
    });
  }
  out.write(found.length ? `${formatFindings(found, 500)}\n\nslop: ${found.length} finding(s)\n` : 'slop: ok\n');
  return found.length ? 1 : 0;
}
