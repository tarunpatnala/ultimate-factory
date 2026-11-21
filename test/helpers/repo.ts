import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../src/stages/init.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

export interface RepoOptions {
  tier?: string;
  maxLines?: number;
  baseUrl?: string;
  extraConfig?: string;
  testsAreLoadBearing?: boolean;
}

export const READY_CHARTER = (o: RepoOptions = {}) => `# Factory charter

\`\`\`
CHARTER_STATUS: ready
\`\`\`

\`\`\`
TIER: ${o.tier ?? 'greenfield'}
\`\`\`

\`\`\`
LOAD_BEARING:
  - "src/auth/**"
  - ".github/workflows/**"
\`\`\`

\`\`\`
TESTS_ARE_LOAD_BEARING: ${o.testsAreLoadBearing ?? true}
\`\`\`

\`\`\`
AUTOMATABLE:
  - Single-file bug fixes with a reproducible failing test

NEEDS_SPEC:
  - Anything touching more than 5 files

NEVER_AUTOMATE:
  - Merge decisions
\`\`\`

\`\`\`
GATES:
  default: full
  load_bearing: deep
  docs_only: fast
\`\`\`

\`\`\`
STOP_IF:
  - Gates were red twice in a row on the same item
  - The change would exceed ${o.maxLines ?? 400} changed lines
  - More than 3 items are already awaiting human review
\`\`\`
`;

/** A tiny Node project with the factory installed and a ready charter. */
export function makeRepo(o: RepoOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ufactory-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  initCommand({ target: dir, dryRun: false, withWorkflows: false, harness: ['claude', 'codex'] }, () => undefined);
  writeFileSync(join(dir, 'docs/factory/CHARTER.md'), READY_CHARTER(o));
  writeFileSync(join(dir, '.factory/gates.conf'), 'REQUIRED_FAST=""\nREQUIRED_FULL="test"\nREQUIRED_DEEP="test"\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'src/math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  writeFileSync(join(dir, 'test/smoke.test.js'), "import test from 'node:test';\ntest('smoke', () => {});\n");
  writeFileSync(
    join(dir, 'factory.config.yaml'),
    `version: 1
providers:
  mock:
    type: openai-compatible
    base_url: ${o.baseUrl ?? 'http://127.0.0.1:9/v1'}
    api_key_env: ""
    max_retries: 0
    timeout_ms: 20000
models:
  default: { provider: mock, model: mock-writer }
  roles:
    verify: { provider: mock, model: mock-verifier }
    critic: { provider: mock, model: mock-critic }
github:
  enabled: false
agent:
  test_command: "node --test"
  max_refusals: 3
budget:
  max_turns: 20
  max_runs_per_day: 1000
${o.extraConfig ?? ''}
`,
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function read(dir: string, p: string): string {
  return readFileSync(join(dir, p), 'utf8');
}
