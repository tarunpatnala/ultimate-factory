import picomatch from 'picomatch';
import type { FactoryConfig } from '../config/types.js';
import type { Charter } from './charter.js';

/** Paths the factory itself depends on, plus build/test configuration an agent could use to cheat. */
export const BUILTIN_PROTECTED = [
  'docs/factory/CHARTER.md',
  'docs/factory/CONTRACT.md',
  'docs/factory/LESSONS.md',
  '.factory/**',
  '.claude/**',
  '.agents/**',
  '.codex/**',
  '.github/**',
  'AGENTS.md',
  'CLAUDE.md',
  'factory.config.yaml',
  'factory.config.yml',
  '.git/**',
  // Build manifests and lockfiles (dependency changes are a NEEDS_SPEC decision).
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/pyproject.toml',
  '**/setup.py',
  '**/setup.cfg',
  '**/requirements*.txt',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/go.mod',
  '**/go.sum',
  '**/Makefile',
  // .NET: project, solution, SDK and package configuration.
  '**/*.csproj',
  '**/*.fsproj',
  '**/*.vbproj',
  '**/*.sln',
  '**/*.slnx',
  '**/Directory.Build.props',
  '**/Directory.Build.targets',
  '**/Directory.Packages.props',
  '**/global.json',
  '**/[Nn]u[Gg]et.[Cc]onfig',
  '**/packages.lock.json',
  '**/.config/dotnet-tools.json',
  // Test runner configuration (skip/ignore patterns would hide failing tests).
  '**/conftest.py',
  '**/pytest.ini',
  '**/tox.ini',
  '**/jest.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/karma.conf.*',
  '**/.mocharc*',
  '**/playwright.config.*',
  '**/cypress.config.*',
  '**/tsconfig*.json',
  '**/.eslintrc*',
  '**/eslint.config.*',
  '**/ruff.toml',
  '**/.ruff.toml',
  '**/mypy.ini',
  '**/.golangci.*',
  '**/*.runsettings',
  '**/xunit.runner.json',
  '**/.editorconfig',
  '**/stylecop.json',
  '**/*.ruleset',
];

export const SECRET_FILES = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/*.keystore', '**/.aws/**', '**/.ssh/**'];

export const DOC_FILES = ['**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/*.adoc', '**/LICENSE', '**/LICENSE.*'];

export interface PathClasses {
  protected: boolean;
  loadBearing: boolean;
  test: boolean;
  secret: boolean;
  doc: boolean;
}

const OPTS = { dot: true, nocase: true } as const;

export class PathPolicy {
  private readonly isProtected: (p: string) => boolean;
  private readonly isLoadBearing: (p: string) => boolean;
  private readonly isTest: (p: string) => boolean;
  private readonly isSecret: (p: string) => boolean;
  private readonly isDoc: (p: string) => boolean;

  constructor(
    readonly charter: Pick<Charter, 'loadBearing'>,
    readonly cfg: Pick<FactoryConfig, 'agent' | 'factory'> & Partial<Pick<FactoryConfig, 'learning'>>,
  ) {
    const protectedGlobs = [...BUILTIN_PROTECTED, cfg.factory.charter, cfg.factory.contract, cfg.factory.gates_script, cfg.factory.prove_script, ...(cfg.learning ? [cfg.learning.lessons] : []), ...cfg.agent.protected_extra];
    this.isProtected = picomatch(protectedGlobs.map(norm), OPTS);
    this.isLoadBearing = charter.loadBearing.length ? picomatch(charter.loadBearing.map(norm), OPTS) : () => false;
    this.isTest = picomatch(cfg.agent.test_paths.map(norm), OPTS);
    this.isSecret = picomatch(SECRET_FILES, OPTS);
    this.isDoc = picomatch(DOC_FILES, OPTS);
  }

  classify(path: string): PathClasses {
    const p = norm(path);
    return {
      protected: this.isProtected(p),
      loadBearing: this.isLoadBearing(p),
      test: this.isTest(p),
      secret: this.isSecret(p),
      doc: this.isDoc(p),
    };
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
