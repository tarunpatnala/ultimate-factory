import type { ToolDefinition } from '../llm/types.js';

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const AGENT_TOOLS: ToolDefinition[] = [
  fn('list_files', 'List repository files (git-tracked and untracked, not ignored). Optionally under a directory and/or filtered by a glob.', {
    path: { type: 'string', description: 'Repo-relative directory, default "."' },
    glob: { type: 'string', description: 'Glob such as "src/**/*.ts"' },
  }),
  fn('read_file', 'Read a text file, optionally a 1-based inclusive line range. Large files are truncated; use next_start_line to continue.', {
    path: { type: 'string' },
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
  }, ['path']),
  fn('search', 'Search file contents line by line. Literal by default; set regex=true for a JavaScript regular expression. Max 200 matches.', {
    pattern: { type: 'string' },
    glob: { type: 'string' },
    regex: { type: 'boolean' },
  }, ['pattern']),
  fn('write_file', 'Create or overwrite a text file with the full new content. Protected, load-bearing and secret paths are refused.', {
    path: { type: 'string' },
    content: { type: 'string' },
  }, ['path', 'content']),
  fn('edit_file', 'Replace one exact, unique occurrence of old_text with new_text in a file. Prefer this over write_file for small changes to existing files.', {
    path: { type: 'string' },
    old_text: { type: 'string', description: 'Exact text to replace; must occur exactly once' },
    new_text: { type: 'string' },
  }, ['path', 'old_text', 'new_text']),
  fn('give_up', 'Stop without a pull request: every file you changed is reverted and the item goes back to a human with your reason. Use when the item cannot be done within the rules.', {
    reason: { type: 'string' },
  }, ['reason']),
  fn('delete_file', 'Delete a file. Protected, load-bearing and existing test files are refused.', { path: { type: 'string' } }, ['path']),
  fn('run_gates', 'Run the deterministic gate script at a level (diagnostic). Returns the verdict line and output tail.', {
    level: { type: 'string', enum: ['fast', 'full', 'deep'] },
  }, ['level']),
  fn('run_tests', 'Run the configured test command and return exit code and output tail.', {}),
  fn('run_command', 'Run one allowlisted command by name (see the list in the system prompt).', { name: { type: 'string' } }, ['name']),
  fn('finish', 'Declare the work complete. The runtime will run gates, a negative-test proof and an independent verifier. Provide the test files that prove the change.', {
    summary: { type: 'string', description: 'One paragraph: what changed and why it is safe.' },
    test_paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative test files added for this change.' },
  }, ['summary', 'test_paths']),
];

export const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.function.name));
