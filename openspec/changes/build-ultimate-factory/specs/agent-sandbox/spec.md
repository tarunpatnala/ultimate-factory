# Spec Delta

## Purpose
Give the implement agent enough tools to do scoped work and nothing that can bypass the charter.

## ADDED Requirements

### Requirement: Tool set
The implement agent SHALL be offered exactly these tools: `list_files(path?, glob?)`, `read_file(path, start_line?, end_line?)`, `search(pattern, glob?, regex?)`, `write_file(path, content)`, `delete_file(path)`, `run_gates(level)`, `run_tests()`, `run_command(name)` and `finish(summary, test_paths[])`. Tool results MUST be JSON objects with `ok` and either a result or `error`.

#### Scenario: Unknown tool
- **WHEN** the model calls `shell`
- **THEN** the tool result is `{ok:false,error:"unknown tool"}` and the call counts toward the refusal limit

### Requirement: Path guard
File tools MUST reject absolute paths, paths containing `..` segments, paths resolving (after symlinks) outside the repository, `.git/**`, `secret` paths for reads, and `protected` or `load_bearing` paths for writes and deletes.

#### Scenario: Charter write refused
- **WHEN** the model calls `write_file("docs/factory/CHARTER.md", …)`
- **THEN** the file is unchanged and the result is `{ok:false,error:"protected path"}`

#### Scenario: Symlink escape
- **WHEN** `link` is a symlink to `/etc` and the model reads `link/passwd`
- **THEN** the read is refused

### Requirement: Output limits
`read_file` SHALL return at most `agent.max_file_bytes` (default 200000) bytes and mark truncation; `list_files` at most `agent.max_files_listed` (default 500) entries; `search` at most 200 matches; command output at most 20000 characters (tail kept).

#### Scenario: Large file
- **WHEN** a 1 MB file is read
- **THEN** the result has `truncated: true` and the next range hint

### Requirement: Command allowlist
`run_command(name)` SHALL only run commands declared by name in `agent.allowed_commands`; `run_gates` and `run_tests` run the configured gate script and test command. All three MUST run with a scrubbed environment that excludes configured secret env vars, `GITHUB_TOKEN`, `GH_TOKEN` and any variable whose name contains `KEY`, `TOKEN`, `SECRET` or `PASSWORD`.

#### Scenario: Secret not visible to tests
- **WHEN** `OPENAI_API_KEY` is set and a test prints `process.env.OPENAI_API_KEY`
- **THEN** the printed value is empty

### Requirement: Stop conditions
The agent loop SHALL stop when: `finish` is called; `budget.max_turns` is reached; 5 tool calls have been refused; the diff violates a policy rule after a write (the write is reverted first); or the budget is exceeded. Only `finish` can lead to a PR.

#### Scenario: Diff limit crossed
- **WHEN** a write makes the diff exceed the line limit
- **THEN** that write is reverted, the run stops with `stop_reason: too-many-lines` and no PR is opened

### Requirement: Container sandbox for repository code
When `agent.sandbox.mode` is `docker` or `podman`, gates, tests, allowlisted commands and the proof SHALL run in a throwaway container from `agent.sandbox.image`, with `--network` from `agent.sandbox.network` (default `none`), all capabilities dropped and `no-new-privileges`. Variables MUST be passed by name, never as values in argv.

#### Scenario: No network and no secrets in argv
- **WHEN** a gate runs with the docker sandbox and a scrubbed variable `FACTORY_X=value-1`
- **THEN** the container command contains `--network none` and `-e FACTORY_X`, and no argument contains `value-1`

### Requirement: AI-slop check on generated diffs
With `agent.slop: block` (default), `finish` SHALL be refused, at most twice per run, while the added lines contain narrating or code-restating comments, change-log comments, elided code, placeholders, empty error handlers, emoji in comments, or no-ai-slop prose patterns in comments and Markdown. Remaining findings MUST be listed in the PR body and MUST force a human read. `policy-check` SHALL print the same findings for any PR as advisory output.

#### Scenario: Narrating comment refused
- **WHEN** the agent adds `// Here we simply add the two numbers` and calls `finish`
- **THEN** the tool result names the file, line and rule, and a later `finish` without the comment is accepted
