/**
 * AI-slop check for prose and code. Prose rules come from petergyang/no-ai-slop (MIT): banned
 * words, empty phrases and filler patterns. Code rules target what generated code tends to leave
 * behind: comments that narrate or address the reader, change-log comments, elided code,
 * placeholders, swallowed errors and emoji. Deterministic and language-neutral: comments are found
 * by the file's comment syntax, nothing is parsed.
 */

export interface SlopFinding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

export const BANNED_WORDS = ['delve', 'foster', 'leverage', 'utilize', 'facilitate', 'empower', 'streamline', 'robust', 'cutting-edge', 'paradigm shift', 'game changer', 'this is huge', 'this changes everything', 'tapestry', 'realm', 'beacon', 'multifaceted', 'meticulous', 'intricate', 'paramount', 'transformative', 'elevate', 'embark', 'supercharge', 'ever-evolving', 'seamless', 'seamlessly', 'blazingly'];
export const EMPTY_PHRASES = ["it's worth noting", "it's important to note", 'at the end of the day', 'when it comes to', 'at its core', "in today's world", 'in the age of', 'the reality is', 'the truth is', 'with regard to', 'in order to', 'going forward', "let's dive in", 'stands as a testament', 'pivotal moment', 'plays a vital role', 'underscores', 'needless to say'];
export const EMPTY_ADVERBS = ['honestly', 'simply', 'truly', 'fundamentally', 'importantly', 'crucially', 'literally'];

const PROSE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:it|this) (?:is|isn't|is not) (?:just |only )?[^.]{1,40}[.,] (?:it|this)(?:'s| is) /i, 'binary contrast ("not X, it\'s Y")'],
  [/\bhere's the thing\b|\blet me be clear\b|\bthe uncomfortable truth\b/i, 'throat-clearing opener'],
  [/\bwhat (?:most|nobody|no one) (?:people )?(?:get wrong|tells you|skip)/i, 'faux-insight setup'],
  [/\b(?:in conclusion|to sum up)\b/i, 'summary-recap ending'],
  [/—.*—.*—/, 'em-dash cluster'],
  [/,\s(?:highlighting|underscoring|showcasing|reflecting)\b/i, 'superficial -ing analysis'],
  [/\bexperts agree\b|\bstudies show\b|\bwidely regarded\b/i, 'weasel attribution'],
];

/** Rules applied to the text of a code comment. */
const COMMENT_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:here|now) (?:we|i)\b/i, 'narrating comment'],
  [/^(?:this|the following|below) (?:function|method|class|code|block|line|snippet|helper) (?:will |is used to |is responsible for |handles |does )/i, 'comment restates the code'],
  [/^step \d+\s*[:.)-]/i, 'step-numbered narration'],
  [/^(?:added|updated|changed|modified|fixed|removed|new)\s*:|^(?:added|updated|changed|modified|fixed|removed)(?: this| the| a)? (?:line|code|function|method|logic|check|import|field|variable|version)\b/i, 'change-log comment (belongs in the commit message)'],
  [/\bas an ai\b|\bi(?:'ve| have) (?:added|updated|changed|implemented|fixed|refactored)\b|\blet me\b|\bcertainly[,!]|\bhope this helps\b|\bin this (?:updated|modified|revised|new) version\b/i, 'assistant voice in code'],
  [/\b(?:rest|remainder) of (?:the )?(?:code|file|implementation|function)\b|\.\.\.\s*(?:existing|previous|other|rest of|remaining) (?:code|logic|implementation)|\bexisting code (?:here|unchanged|remains)\b|\byour (?:code|logic|implementation) (?:goes )?here\b/i, 'elided code'],
  [/\b(?:todo|fixme)\b:?\s*(?:implement|add (?:the )?(?:logic|implementation)|finish this|fill in)|\bplaceholder (?:implementation|logic|value)\b|\bnot (?:yet )?implemented yet\b/i, 'placeholder left in'],
  [/\p{Extended_Pictographic}/u, 'emoji in a comment'],
];

/** Rules applied to whole code lines. */
const CODE_PATTERNS: Array<[RegExp, string, RegExp?]> = [
  [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/, 'swallowed error (empty catch)'],
  [/^\s*except(?:\s+[\w.]+(?:\s+as\s+\w+)?)?\s*:\s*pass\s*$/, 'swallowed error (except: pass)', /\.py$/],
  [/(?:throw new \w*Error|raise \w*Error)\(\s*['"`](?:not implemented|todo|implement me)/i, 'placeholder left in'],
];

type Syntax = 'prose' | 'c' | 'hash' | 'dash' | 'html' | 'none';

const HASH = /\.(?:py|sh|bash|zsh|rb|pl|r|ya?ml|toml|ex|exs|cfg|conf|ini|tf|ps1|nim|cr)$|(?:^|\/)(?:Makefile|Dockerfile|Gemfile|Rakefile|\.gitignore|\.env\.example)$/i;
const CSTYLE = /\.(?:[cm]?[jt]sx?|java|kt|kts|scala|go|rs|c|h|cc|cpp|hpp|cs|swift|dart|php|groovy|gradle|proto|scss|less|css|zig|v|sol|fs|fsx|fsi)$/i;
const DASH = /\.(?:sql|lua|hs|elm|ada)$/i;
const HTML = /\.(?:html?|xml|vue|svelte|xaml|cshtml|razor)$/i;
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

function syntaxFor(path: string): Syntax {
  if (PROSE.test(path)) return 'prose';
  if (CSTYLE.test(path)) return 'c';
  if (HASH.test(path)) return 'hash';
  if (DASH.test(path)) return 'dash';
  if (HTML.test(path)) return 'html';
  return 'none';
}

/** The comment part of a code line, or undefined. Rough on purpose: no string parsing. */
export function commentText(line: string, syntax: Syntax, inBlock: boolean): { text?: string; inBlock: boolean } {
  if (syntax === 'c') {
    if (inBlock) {
      const end = line.indexOf('*/');
      return { text: line.slice(0, end < 0 ? undefined : end).replace(/^\s*\*?\s?/, ''), inBlock: end < 0 };
    }
    const block = /(?:^|\s)\/\*+\s?(.*)$/.exec(line);
    if (block) {
      const rest = block[1]!;
      const end = rest.indexOf('*/');
      return { text: end < 0 ? rest : rest.slice(0, end), inBlock: end < 0 };
    }
    const m = /(?:^|\s)\/\/+\s?(.*)$/.exec(line);
    return { text: m?.[1], inBlock: false };
  }
  if (syntax === 'hash') {
    if (/^#!/.test(line)) return { inBlock: false };
    const m = /(?:^|\s)#+\s(.*)$|^\s*#+$/.exec(line);
    return { text: m?.[1], inBlock: false };
  }
  if (syntax === 'dash') return { text: /(?:^|\s)--\s(.*)$/.exec(line)?.[1], inBlock: false };
  if (syntax === 'html') return { text: /<!--\s?(.*?)(?:-->|$)/.exec(line)?.[1], inBlock: false };
  return { inBlock: false };
}

function proseHits(text: string): string[] {
  const t = text.replace(/`[^`]*`/g, '');
  const lower = t.toLowerCase();
  const hits: string[] = [];
  for (const w of BANNED_WORDS) if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) hits.push(`banned word "${w}"`);
  for (const p of EMPTY_PHRASES) if (lower.includes(p)) hits.push(`empty phrase "${p}"`);
  for (const a of EMPTY_ADVERBS) if (new RegExp(`\\b${a}\\b`, 'i').test(lower)) hits.push(`empty adverb "${a}"`);
  return hits;
}

/**
 * Scan lines of one file. `only` limits findings to those 1-based line numbers (added lines of
 * a diff); every line is still read so block-comment and code-fence state stay correct.
 */
export function scanLines(path: string, lines: string[], only?: Set<number>): SlopFinding[] {
  const syntax = syntaxFor(path);
  const found: SlopFinding[] = [];
  let inBlock = false;
  let inFence = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    const hits: string[] = [];
    if (syntax === 'prose') {
      if (/^\s*```/.test(line)) inFence = !inFence;
      else if (!inFence) {
        hits.push(...proseHits(line));
        for (const [re, label] of PROSE_PATTERNS) if (re.test(line.replace(/`[^`]*`/g, ''))) hits.push(label);
      }
    } else if (syntax !== 'none') {
      const c = commentText(line, syntax, inBlock);
      inBlock = c.inBlock;
      const text = c.text?.trim();
      if (text) {
        hits.push(...proseHits(text));
        for (const [re, label] of COMMENT_PATTERNS) if (re.test(text)) hits.push(label);
      }
      for (const [re, label, fileRe] of CODE_PATTERNS) if ((!fileRe || fileRe.test(path)) && re.test(line)) hits.push(label);
    }
    if (only && !only.has(n)) return;
    for (const rule of hits) found.push({ path, line: n, rule, text: line.trim().slice(0, 120) });
  });
  return found;
}

/** Findings on the lines a unified diff adds (the factory's own output). */
export function scanDiff(diff: string): SlopFinding[] {
  const files = new Map<string, { lines: Map<number, string>; added: Set<number> }>();
  let cur: { lines: Map<number, string>; added: Set<number> } | undefined;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      cur = p === '/dev/null' ? undefined : { lines: new Map(), added: new Set() };
      if (cur) files.set(p, cur);
      lineNo = 1;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      lineNo = Number(h[1]);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+')) {
      cur.lines.set(lineNo, raw.slice(1));
      cur.added.add(lineNo);
      lineNo++;
    } else if (raw.startsWith(' ')) {
      cur.lines.set(lineNo, raw.slice(1));
      lineNo++;
    }
  }
  const out: SlopFinding[] = [];
  for (const [path, f] of files) {
    if (!f.added.size) continue;
    const max = Math.max(...f.lines.keys());
    const lines = Array.from({ length: max }, (_, i) => f.lines.get(i + 1) ?? '');
    out.push(...scanLines(path, lines, f.added));
  }
  return out;
}

export function formatFindings(fs: SlopFinding[], limit = 20): string {
  const shown = fs.slice(0, limit).map((f) => `${f.path}:${f.line}: ${f.rule}: ${f.text}`);
  if (fs.length > limit) shown.push(`... ${fs.length - limit} more`);
  return shown.join('\n');
}
