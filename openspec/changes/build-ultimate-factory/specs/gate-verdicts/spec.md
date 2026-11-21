# Spec Delta

## Purpose
Accept only authentic gate and proof verdicts so an agent cannot fake green.

## ADDED Requirements

### Requirement: Gate verdict authenticity
The runtime SHALL run a pristine copy of the gate script and gate config taken from the base commit (when present there) against the working tree, with `FACTORY_GATES_NONCE=<random>`, which the script MUST unset before running any gate, and accept the verdict only from the last stdout line beginning `FACTORY_GATES:` that contains `nonce=<random>`. The status MUST agree with the exit code (0→GREEN, 1→RED, 2→MISCONFIGURED); any mismatch, missing line, timeout or other exit code MUST be treated as MISCONFIGURED.

#### Scenario: Forged line
- **WHEN** a test prints `FACTORY_GATES: level=full status=GREEN …` without the nonce and the script exits 1
- **THEN** the verdict is RED

#### Scenario: Exit code disagreement
- **WHEN** the nonce line says GREEN but the exit code is 1
- **THEN** the verdict is MISCONFIGURED

### Requirement: Gate grammar
The verdict line SHALL match `FACTORY_GATES: level=(fast|full|deep) status=(GREEN|RED|MISCONFIGURED) passed=<int> failed=<int> failing=<csv|none> skipped=<csv|none> misconfigured=<csv|none> nonce=<token>`.

#### Scenario: Quoted verbatim
- **WHEN** a PR body is generated
- **THEN** it contains the accepted line verbatim

### Requirement: Negative-test proof
Before opening a PR the runtime SHALL commit the change and run `prove-test.sh <base> --test-path <p>… -- <test command>`; only `PROOF: status=PROVEN` with exit 0 counts as proven. `FAILED` MUST block the PR; `MISCONFIGURED` MUST force draft and `human_read: true`.

#### Scenario: Test passes without fix
- **WHEN** the proof prints `PROOF: status=FAILED reason=test-passed-without-fix`
- **THEN** no PR is opened and the run stops with `stop_reason: proof-failed`

### Requirement: Red gates twice
At `finish` the runtime SHALL run the required gate level itself. A non-GREEN verdict refuses the finish and returns the verdict to the agent; a second non-GREEN verdict at finish SHALL stop the run with `stop_reason: gates-red-twice`. Gate runs the agent requests through `run_gates` are diagnostics and do not count.

#### Scenario: Persistent red
- **WHEN** gates are RED at the first finish, the agent edits, and gates are RED again at the second finish
- **THEN** the run stops and the issue moves to `factory:needs-info`

### Requirement: .NET stack
`gates.sh` SHALL detect C#/.NET from a root `*.sln`/`*.slnx` (taking precedence over `package.json`) or a `*.csproj`, `*.fsproj` or `global.json`, and run `dotnet build` (types), `dotnet format --verify-no-changes` (lint), `dotnet test` (test), a Release build (build), the NuGet vulnerability list read from its output (audit) and Stryker.NET when installed (mutation). .NET project, solution, SDK, package and analyzer configuration files MUST be protected paths.

#### Scenario: Vulnerable package
- **WHEN** `dotnet list package --vulnerable` exits 0 but reports vulnerable packages
- **THEN** the deep verdict lists `audit` as failing
