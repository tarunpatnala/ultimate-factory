import { out } from './util/output.js';
import { resolve } from 'node:path';
import { loadConfig, loadConfigFromString } from './config/load.js';
import { RunContext, type GlobalOptions } from './context.js';
import type { GateLevel } from './policy/charter.js';
import { implementCommand } from './stages/implement.js';
import { initCommand } from './stages/init.js';
import { bootstrapLabels, doctorCommand, gatesCommand, modelsCommand, monitorCommand, statusCommand } from './stages/ops.js';
import { metricsCommand } from './stages/metrics.js';
import { policyCheckCommand } from './stages/policy-check.js';
import { reviewCommand } from './stages/review.js';
import { GATES as SPEC_GATES, specApproveCommand, specDraftCommand, specPublishCommand, type SpecGate } from './stages/spec.js';
import { triageCommand } from './stages/triage.js';
import { verifyCommand } from './stages/verify.js';
import { recordsCommand } from './stages/records.js';
import { slopCommand } from './stages/slop.js';
import { tuneCommand } from './stages/tune.js';
import { FactoryError } from './util/errors.js';
import { log } from './util/log.js';
import { freezeGitConfig } from './util/git.js';
import { VERSION } from './version.js';

const HELP = `ufactory ${VERSION} - provider-neutral software factory (OpenAI, Portkey, Azure, any OpenAI-compatible endpoint)

Usage: ufactory <command> [options]

Setup
  init [path]            Install charter, contract, gates, adapters and config (never overwrites)
                         --dry-run  --with-workflows  --harness claude,codex
  doctor                 Check tools, factory files, charter and model config   --ping  (real tool-call round trip)
  models                 Show which provider/model each role resolves to
  labels                 Create the factory:* GitHub labels                       --apply

Stages (GitHub writes only with --apply; default is a dry run)
  triage                 Classify untriaged issues into the label queue            [--issue N]
  spec draft|approve|publish   Human-gated spec: draft next gate / approve it / publish slices
                         --issue N  [--gate product|architecture|design|slices --by NAME]  [--notes TEXT]
  implement              Claim one ready issue, implement, gate, prove, verify, open PR   [--issue N]
                         --local --task TEXT --done-when TEXT [--files a,b] [--gate fast|full|deep]  (no GitHub)
  verify --pr N          Re-run gates, proof, policy, verifier (+critic) and post a verdict   [--test-paths a,b]
  review                 10-persona engineering review panel
                         --diff BASE | --pr N | --path FILE_OR_DIR   [--personas a,b] [--out FILE]
  monitor                Health sweep; files deduplicated factory:monitor issues
  run                    triage then implement (for cron)
  status                 Control room: review queue first
  metrics [--json]       Attempted / opened / merged rates, stop reasons, proof and verifier mix, cost per merged PR
  tune                   Learning loop: record PR outcomes, find recurring problems, post proposals to one issue
                         [--days N]  [--open-pr] (draft PR adding proposed lessons; merging it is the approval)

Checks (no LLM, no secrets)
  policy-check --base REF   Enforce the charter on the real diff; prints a FACTORY_POLICY v=1 line
                         [--human-approved-by LOGIN] (a maintainer who approved the head commit) [--json]
  gates [fast|full|deep]    Run the gate script with verdict authentication
  slop [--base REF] [paths]  AI-slop check: added lines since REF, or whole files (exit 1 on findings)
  records pull|push         Sync run records with the factory-records branch (durable CI history)  --apply

Global options
  --config FILE   --profile NAME   --cwd DIR   --apply   --verbose   --quiet   --version   --help

Exit codes
  0  success, dry run, or deliberate stop (nothing to do, review queue full, already claimed)
  1  failing verdict (gates RED, policy FAIL, verifier/panel rejected, run stopped on its rules)
  2  configuration or setup problem (bad config/flags, MISCONFIGURED gates or policy, dirty tree)
  3  budget exceeded (tokens, USD, turns, wall clock)
  4  charter not ready, or the work needs a spec/human (load-bearing or protected scope)
  5  provider, GitHub or git infrastructure error`;

interface Parsed {
  cmd: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const cmd: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const BOOL = new Set(['apply', 'dry-run', 'with-workflows', 'local', 'ping', 'verbose', 'quiet', 'help', 'version', 'json', 'allow-load-bearing', 'open-pr']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (BOOL.has(name)) flags[name] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new FactoryError(`--${name} needs a value`, 'USAGE', 2);
        flags[name] = v;
        i++;
      }
    } else if (a === '-h') flags.help = true;
    else cmd.push(a);
  }
  return { cmd, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: string | boolean | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new FactoryError(`--${name} must be a non-negative integer`, 'USAGE', 2);
  return n;
};
const list = (v: string | boolean | undefined): string[] | undefined =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const level = (v: string | undefined, def: GateLevel): GateLevel => {
  const l = (v ?? def) as GateLevel;
  if (!['fast', 'full', 'deep'].includes(l)) throw new FactoryError('gate level must be fast, full or deep', 'USAGE', 2);
  return l;
};

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  if (flags.version) {
    out.write(`${VERSION}\n`);
    return 0;
  }
  const [command, sub] = cmd;
  if (!command || flags.help || command === 'help') {
    out.write(HELP + '\n');
    return 0;
  }
  const cwd = resolve(str(flags.cwd) ?? process.cwd());
  const g: GlobalOptions = { cwd, config: str(flags.config), profile: str(flags.profile), apply: flags.apply === true, verbose: flags.verbose === true, quiet: flags.quiet === true };
  if (g.verbose) log.setLevel('debug');

  switch (command) {
    case 'init': {
      const harness = (list(flags.harness) ?? ['claude', 'codex']) as Array<'claude' | 'codex'>;
      const invokedAs = process.env.npm_command === 'exec' || /_npx|npm-cache/.test(process.argv[1] ?? '') ? 'npx ultimate-factory' : 'ufactory';
      initCommand({ target: resolve(cwd, sub ?? '.'), dryRun: flags['dry-run'] === true, withWorkflows: flags['with-workflows'] === true, harness, invokedAs });
      return 0;
    }
    case 'doctor':
      return doctorCommand(loadConfig({ cwd, configPath: g.config, profile: g.profile }), { ping: flags.ping === true, log });
    case 'models':
      return modelsCommand(loadConfig({ cwd, configPath: g.config, profile: g.profile }));
    case 'policy-check': {
      const base = str(flags.base);
      if (!base) throw new FactoryError('policy-check needs --base <ref>', 'USAGE', 2);
      let cfg;
      try {
        cfg = loadConfig({ cwd, configPath: g.config, profile: g.profile, policyOnly: true }).config;
      } catch (e) {
        if (!/no config file found/.test((e as Error).message)) throw e;
        cfg = loadConfigFromString('version: 1\n', { cwd, policyOnly: true }).config; // defaults
      }
      return policyCheckCommand({ cwd, cfg, base, humanApprovedBy: str(flags['human-approved-by']), json: flags.json === true });
    }
    case 'gates':
      return gatesCommand(RunContext.create('gates', { ...g, noRecord: true }), level(sub, 'full'));
    case 'labels':
      return bootstrapLabels(RunContext.create('labels', { ...g, noRecord: true }));
    case 'status':
      return statusCommand(RunContext.create('status', { ...g, noRecord: true }));
    case 'triage': {
      const issue = int(flags.issue, 'issue');
      return triageCommand(RunContext.create('triage', g, issue), { issue });
    }
    case 'implement': {
      const issue = int(flags.issue, 'issue');
      const gate = str(flags.gate);
      return implementCommand(RunContext.create('implement', g, issue), {
        issue,
        local: flags.local === true,
        task: str(flags.task),
        doneWhen: str(flags['done-when']),
        files: list(flags.files),
        gate: gate ? level(gate, 'full') : undefined,
      });
    }
    case 'verify': {
      const pr = int(flags.pr, 'pr');
      if (pr === undefined) throw new FactoryError('verify needs --pr <number>', 'USAGE', 2);
      return verifyCommand(RunContext.create('verify', g, pr), { pr, testPaths: list(flags['test-paths']) });
    }
    case 'review': {
      const pr = int(flags.pr, 'pr');
      return reviewCommand(RunContext.create('review', g, pr), { diff: str(flags.diff), pr, path: str(flags.path), personas: list(flags.personas), out: str(flags.out) });
    }
    case 'spec': {
      const issue = int(flags.issue, 'issue');
      if (issue === undefined) throw new FactoryError('spec needs --issue <number>', 'USAGE', 2);
      if (sub === 'approve') {
        const gate = str(flags.gate) as SpecGate;
        if (!SPEC_GATES.includes(gate)) throw new FactoryError(`--gate must be one of ${SPEC_GATES.join(', ')}`, 'USAGE', 2);
        const by = str(flags.by);
        if (!by) throw new FactoryError('spec approve needs --by <your name or GitHub login> (recorded as the approver)', 'USAGE', 2);
        return specApproveCommand(RunContext.create('spec', { ...g, noRecord: true }, issue), { issue, gate, by });
      }
      if (sub === 'publish') return specPublishCommand(RunContext.create('spec', g, issue), { issue });
      if (sub && sub !== 'draft') throw new FactoryError('spec subcommand must be draft, approve or publish', 'USAGE', 2);
      return specDraftCommand(RunContext.create('spec', g, issue), { issue, notes: str(flags.notes) });
    }
    case 'slop':
      return slopCommand({ cwd, base: str(flags.base), paths: cmd.slice(1) });
    case 'records': {
      if (sub !== 'pull' && sub !== 'push') throw new FactoryError('records subcommand must be pull or push', 'USAGE', 2);
      return recordsCommand(loadConfig({ cwd, configPath: g.config, profile: g.profile, policyOnly: true }).config, { cwd, sub, apply: g.apply, days: int(flags.days, 'days') });
    }
    case 'metrics':
      return metricsCommand(RunContext.create('metrics', { ...g, noRecord: true }), { json: flags.json === true });
    case 'monitor':
      return monitorCommand(RunContext.create('monitor', g));
    case 'tune':
      return tuneCommand(RunContext.create('tune', g), { days: int(flags.days, 'days'), openPr: flags['open-pr'] === true });
    case 'run': {
      const t = await triageCommand(RunContext.create('triage', g), {});
      if (t === 3) return t;
      return implementCommand(RunContext.create('implement', g), { local: false });
    }
    default:
      throw new FactoryError(`unknown command "${command}". Run ufactory --help.`, 'USAGE', 2);
  }
}

export async function cli(): Promise<void> {
  freezeGitConfig();
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    const err = e as FactoryError;
    log.error(err.message ?? String(e));
    if (process.env.UFACTORY_DEBUG) log.error(String(err.stack));
    process.exitCode = typeof err.exitCode === 'number' ? err.exitCode : 1;
  }
}
