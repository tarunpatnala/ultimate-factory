import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../config/types.js';

export interface Lessons {
  /** The `## Active` section, comments removed, capped at max_lesson_chars. Empty when there is none. */
  text: string;
  ids: string[];
  truncated: boolean;
}

export const LESSON_ID = /\bL-[0-9a-f]{6}\b/g;

/**
 * Lessons are maintainer-approved notes in a protected file. Only the `## Active` section is used:
 * proposals that `tune` writes elsewhere, or that sit in an unmerged PR, never reach a model.
 */
export function readLessons(root: string, learning: FactoryConfig['learning'] | undefined): Lessons {
  const empty: Lessons = { text: '', ids: [], truncated: false };
  if (!learning) return empty;
  const path = join(root, learning.lessons);
  if (!existsSync(path)) return empty;
  return parseLessons(readFileSync(path, 'utf8'), learning.max_lesson_chars);
}

export function parseLessons(markdown: string, maxChars: number): Lessons {
  const text = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = /^## Active[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  const body = (m?.[1] ?? '').trim();
  if (!body) return { text: '', ids: [], truncated: false };
  const truncated = body.length > maxChars;
  const kept = truncated ? `${body.slice(0, maxChars)}\n[lessons truncated at learning.max_lesson_chars]` : body;
  return { text: kept, ids: [...new Set(kept.match(LESSON_ID) ?? [])], truncated };
}

/** How each role is told to use the lessons. They never outrank the rules enforced in code. */
export function lessonsBlock(role: 'implement' | 'verify', text: string): string {
  const intro =
    role === 'implement'
      ? 'Repository lessons, approved by the maintainers from earlier factory runs. Apply the ones that fit this change. They never relax the rules above: where a lesson and a rule disagree, the rule wins.'
      : 'Repository lessons, approved by the maintainers from earlier factory runs. When the diff breaks a lesson that applies to it, reject and start the must_fix entry with the lesson id (for example "L-1a2b3c: ..."). Lessons never relax the checks above.';
  return `${intro}\n${text}`;
}
