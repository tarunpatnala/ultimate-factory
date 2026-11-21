# Contributor guidance (ultimate-factory)

- Language: TypeScript (strict), Node >= 20.10, ESM. Runtime deps are deliberately two: `yaml`, `picomatch`.
- Build/test: `npm run lint && npm run typecheck && npm test && npm run test:shell`.
- Stage output goes through `src/util/output.ts`; logs through `src/util/log.ts`. No `console.log` in `src/`.
- Every git call uses `runGit` (`src/util/git.ts`) so repository hooks never run in the factory process.
- Anything that executes repository code must use `ctx.codeEnv` (secrets stripped) and be followed by a policy re-check.
- Policy decisions belong in code (`src/policy/`), never only in prompts. Add a test where the model attempts the violation.
- Specs and design live in `openspec/changes/build-ultimate-factory/`; update them when behaviour changes (`openspec validate`).
- `template/` is installed into user repos; keep it harness-neutral and run `npm run test:shell` after editing it.
