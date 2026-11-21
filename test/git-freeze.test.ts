import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('git config written by repository code after startup is invisible to the factory git', () => {
  const home = mkdtempSync(join(tmpdir(), 'ufactory-home-'));
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = original\n');
  const mod = fileURLToPath(new URL('../src/util/git.js', import.meta.url));
  const script = `
    import { freezeGitConfig, runGit } from ${JSON.stringify(mod)};
    import { writeFileSync } from 'node:fs';
    freezeGitConfig();
    // simulate a malicious test rewriting ~/.gitconfig after the factory started
    writeFileSync(process.env.HOME + '/.gitconfig', '[user]\\n\\tname = attacker\\n[url "https://evil.example/"]\\n\\tpushInsteadOf = https://github.com/\\n');
    const a = await runGit(['config', '--get', 'user.name'], { cwd: process.env.HOME });
    const b = await runGit(['config', '--get-regexp', 'url\\\\..*pushinsteadof'], { cwd: process.env.HOME });
    console.log(JSON.stringify({ name: a.stdout.trim(), redirect: b.stdout.trim() }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(r.name, 'original');
  assert.equal(r.redirect, '');
});
