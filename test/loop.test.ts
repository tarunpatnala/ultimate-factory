import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactHistory, KEEP_FULL_TURNS, TOOL_RESULT_CHARS, toolMsg } from '../src/agent/loop.js';
import type { ChatMessage } from '../src/llm/types.js';

const call = { id: 'c1', type: 'function' as const, function: { name: 'x', arguments: '{}' } };

test('oversized tool results stay valid JSON and are marked truncated', () => {
  const m = toolMsg(call, { ok: true, matches: Array.from({ length: 400 }, (_, i) => ({ path: `f${i}`, text: 'x'.repeat(300) })) });
  const parsed = JSON.parse(m.content as string);
  assert.ok((m.content as string).length <= TOOL_RESULT_CHARS);
  assert.equal(parsed.truncated_by_runtime, true);
  const big = toolMsg(call, { ok: true, content: 'y'.repeat(200_000) });
  assert.ok(JSON.parse(big.content as string).content.includes('more characters not shown'));
});

test('old tool results are compacted, recent ones kept', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }];
  for (let i = 0; i < KEEP_FULL_TURNS + 3; i++) {
    msgs.push({ role: 'assistant', content: null, tool_calls: [call] });
    msgs.push({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, path: `p${i}`, content: 'z'.repeat(1000) }) });
  }
  compactHistory(msgs);
  const tools = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  assert.match(tools[0]!.content, /elided/);
  assert.match(tools[0]!.content, /p0/);
  assert.doesNotMatch(tools[tools.length - 1]!.content, /elided/);
});
