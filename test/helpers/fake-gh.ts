/**
 * Fake `gh` CLI for tests. State lives in the JSON file named by FAKE_GH_STATE.
 * Supports the subset of `gh api` calls ultimate-factory makes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface State {
  login: string;
  issues: any[];
  comments: Record<string, any[]>;
  pulls: any[];
  nextId: number;
  log: string[];
}

const file = process.env.FAKE_GH_STATE!;
const state: State = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (v: unknown) => process.stdout.write(JSON.stringify(v));

function main(): number {
  if (args[0] === 'auth') return 0;
  if (args[0] === '--version') return (process.stdout.write('gh version 2.99.0 (fake)\n'), 0);
  if (args[0] === 'label') return (state.log.push(`label ${args[2]}`), save(), 0);
  if (args[0] === 'pr' && args[1] === 'diff') return 0;
  if (args[0] !== 'api') return (process.stderr.write(`fake gh: unsupported ${args.join(' ')}`), 1);
  let method = 'GET';
  let path = '';
  const fields: Record<string, any> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-X') method = args[++i]!;
    else if (a === '-H') i++;
    else if (a === '-f' || a === '-F') {
      const kv = args[++i]!;
      const eq = kv.indexOf('=');
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (k.endsWith('[]')) (fields[k.slice(0, -2)] ??= []).push(v);
      else fields[k] = a === '-F' && (v === 'true' || v === 'false') ? v === 'true' : v;
    } else path = a;
  }
  path = path.replace('repos/{owner}/{repo}', 'R').split('?')[0]!;
  state.log.push(`${method} ${path} ${JSON.stringify(fields)}`);
  let m: RegExpExecArray | null;
  if (path === 'user') return (out({ login: state.login }), 0);
  if (path === 'R') return (out({ default_branch: 'main' }), 0);
  if (path === 'R/issues' && method === 'GET') return (out(state.issues.filter((i) => i.state !== 'closed')), 0);
  if (path === 'R/issues' && method === 'POST') {
    const n = state.nextId++;
    state.issues.push({ number: n, title: fields.title, body: fields.body, labels: (fields.labels ?? []).map((name: string) => ({ name })), user: { login: state.login }, author_association: 'OWNER', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: `https://x/${n}` });
    save();
    return (out({ number: n }), 0);
  }
  if ((m = /^R\/issues\/(\d+)$/.exec(path)) && method === 'PATCH') {
    const target = state.issues.find((i) => i.number === Number(m![1]));
    if (fields.body !== undefined) target.body = fields.body;
    save();
    return (out({}), 0);
  }
  if ((m = /^R\/issues\/(\d+)$/.exec(path))) return (out(state.issues.find((i) => i.number === Number(m![1]))), 0);
  if ((m = /^R\/pulls\/(\d+)$/.exec(path))) {
    const pr = state.pulls.find((p) => p.number === Number(m![1]));
    if (!pr) return (process.stderr.write('HTTP 404: Not Found'), 1);
    return (out(pr), 0);
  }
  if ((m = /^R\/issues\/(\d+)\/comments$/.exec(path))) {
    const key = m[1]!;
    if (method === 'GET') return (out(state.comments[key] ?? []), 0);
    const c = { id: state.nextId++, body: fields.body, user: { login: state.login }, author_association: 'OWNER', created_at: new Date().toISOString() };
    (state.comments[key] ??= []).push(c);
    save();
    return (out(c), 0);
  }
  if ((m = /^R\/issues\/comments\/(\d+)$/.exec(path))) {
    for (const list of Object.values(state.comments)) for (const c of list) if (c.id === Number(m[1])) c.body = fields.body;
    save();
    return (out({}), 0);
  }
  if ((m = /^R\/issues\/(\d+)\/labels$/.exec(path))) {
    const target = state.issues.find((i) => i.number === Number(m![1])) ?? state.pulls.find((p) => p.number === Number(m![1]));
    for (const l of fields.labels ?? []) if (!target.labels.some((x: any) => x.name === l)) target.labels.push({ name: l });
    save();
    return (out([]), 0);
  }
  if ((m = /^R\/issues\/(\d+)\/labels\/(.+)$/.exec(path))) {
    const target = state.issues.find((i) => i.number === Number(m![1])) ?? state.pulls.find((p) => p.number === Number(m![1]));
    target.labels = target.labels.filter((x: any) => x.name !== decodeURIComponent(m![2]!));
    save();
    return (out({}), 0);
  }
  if (path === 'R/pulls' && method === 'POST') {
    const n = state.nextId++;
    state.pulls.push({ number: n, title: fields.title, body: fields.body, draft: fields.draft, labels: [], head: { ref: fields.head }, base: { ref: fields.base } });
    save();
    return (out({ number: n }), 0);
  }
  if (path === 'R/pulls') return (out(state.pulls), 0);
  process.stderr.write(`fake gh: unhandled ${method} ${path}`);
  return 1;
}

process.exitCode = main();
