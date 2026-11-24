// mend — one patch tool for every AI edit format.
//
// A model writes an edit as a unified diff (usually with wrong line
// numbers), as SEARCH/REPLACE blocks, as a V4A patch, or as JSON tool
// calls. mend reads any of the four, finds the lines each edit names
// even when their whitespace drifted, and changes every file or none.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// The working directory is the root of the tree. PATCH defaults to
// standard input. SPEC.md (version 1) is the whole contract; this file
// implements it. Node 22, standard library only, no dependencies.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type FormatName = (typeof FORMAT_NAMES)[number];

/** A patch that cannot be read: exit 2 with this one line. */
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and
 * the empty piece after a final \n dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no
 * backslash, and none of its segments is empty, . or ... */
function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

type Tier = 0 | 1 | 2;

/** How a line compares at a tier: exact, trailing whitespace ignored, or
 * leading and trailing whitespace ignored. */
function tierKey(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return trimTrailWs(line);
  return trimBothWs(line);
}

/** Positions where `old` occurs in `lines` at `tier`, at or after `from`.
 * When `endAnchored` is set, only occurrences ending at the last line. */
function findOccurrences(
  lines: string[],
  old: string[],
  tier: Tier,
  from: number,
  endAnchored: boolean,
): number[] {
  const hits: number[] = [];
  if (old.length === 0) return hits;
  const lastStart = lines.length - old.length;
  for (let i = Math.max(from, 0); i <= lastStart; i += 1) {
    if (endAnchored && i !== lastStart) continue;
    if (tierKey(lines[i]!, tier) !== tierKey(old[0]!, tier)) continue;
    let ok = true;
    for (let j = 1; j < old.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `old`
 * occurs at or after `from`, with its positions, or null. */
function findAtTier(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
  endAnchored: boolean,
): { tier: Tier; at: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = findOccurrences(lines, old, tier, from, endAnchored);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** At tier 2 a new line is re-indented: the leading whitespace of the
 * old block's first line is replaced by that of the file's first matched
 * line. Blank lines are left alone. */
function reindent(line: string, oldLead: string, fileLead: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(oldLead)) return fileLead + line.slice(oldLead.length);
  return line;
}

/** A file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  eol: '\n' | '\r\n';
  finalBreak: boolean;
}

function splitDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const firstNl = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function joinDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.finalBreak ? doc.eol : '');
}

function fileIsCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** The tree as the edits leave it: `now` holds what changed (null means
 * deleted); everything else is read from disk on demand. */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  readDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.readDisk(p);
  }
}

/** One edit: apply it to the tree, or throw an EditFault. `moves` records
 * every successful move as [old path, new path] for the exit-0 report. */
type Edit = (tree: WorkTree, moves: Array<[string, string]>) => void;

/** A hunk/chunk body line, with whether the patch line was blank (a
 * trailing blank line of a section is not part of it). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  blank: boolean;
  noBreak: boolean;
}

/** Split a body into its old lines and its new lines. A context line is
 * both: it contributes to the old block and, as `fromOld`, to the new
 * block, so it is written as the file's own matched line. */
function splitBody(body: BodyLine[]): {
  oldLines: string[];
  newLines: Array<{ text: string; fromOld: number }>;
} {
  const oldLines: string[] = [];
  const newLines: Array<{ text: string; fromOld: number }> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      newLines.push({ text: b.text, fromOld: oldLines.length });
      oldLines.push(b.text);
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else {
      newLines.push({ text: b.text, fromOld: -1 });
    }
  }
  return { oldLines, newLines };
}

/** Build the replacement lines for a matched block: context lines come
 * from the file, added lines from the patch (re-indented at tier 2). */
function buildReplacement(
  newLines: Array<{ text: string; fromOld: number }>,
  fileLines: string[],
  at: number,
  tier: Tier,
  oldLead: string,
  fileLead: string,
): string[] {
  return newLines.map((e) => {
    if (e.fromOld >= 0) return fileLines[at + e.fromOld]!;
    if (tier === 2) return reindent(e.text, oldLead, fileLead);
    return e.text;
  });
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): FormatName | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEditObject(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;
  const path = obj.path;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    const text = obj.file_text;
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, text);
    };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFault('missing', path);
      const crlf = fileIsCrlf(before);
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = fold(before);
      const oldFolded = fold(oldStr);
      let count = 0;
      let at = -1;
      for (let k = text.indexOf(oldFolded); k >= 0; k = text.indexOf(oldFolded, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const out = text.slice(0, at) + fold(newStr) + text.slice(at + oldFolded.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    const atLine = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFault('missing', path);
      const doc = splitDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFault('no-match', path);
      const lines = doc.lines.slice();
      lines.splice(atLine, 0, ...added);
      tree.now.set(path, joinDoc({ lines, eol: doc.eol, finalBreak: doc.finalBreak }));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    let edit: Edit | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseFault(`error: parse ${idx + 1}`);
    edits.push(edit);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  start: number;
  body: BodyLine[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
}

/** A path named by a `---`/`+++` line: text after the four characters, up
 * to the first tab, surrounding spaces removed, a leading a/ or b/
 * removed. `/dev/null` means no file. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

function freshSection(): UnifiedSection {
  return {
    gitOld: null,
    gitNew: null,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEAD = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** Read one hunk body starting at `at`. Returns the body and the index of
 * the first line after it. */
function readHunkBody(lines: string[], at: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = at;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', blank: true, noBreak: false });
      i += 1;
      continue;
    }
    const mark = line[0]!;
    if (mark === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1), blank: false, noBreak: false });
      i += 1;
      continue;
    }
    if (mark === '-') {
      body.push({ kind: 'old', text: line.slice(1), blank: false, noBreak: false });
      i += 1;
      continue;
    }
    if (mark === '+') {
      body.push({ kind: 'new', text: line.slice(1), blank: false, noBreak: false });
      i += 1;
      continue;
    }
    if (mark === '\\') {
      if (body.length > 0) body[body.length - 1]!.noBreak = true;
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
  return { body, next: i };
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const pushCurrent = (): void => {
    if (current !== null) sections.push(current);
    current = null;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      pushCurrent();
      current = freshSection();
      current.gitOld = m[1] === 'dev/null' ? null : m[1]!;
      current.gitNew = m[2] === 'dev/null' ? null : m[2]!;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new ParseFault(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const { body, next } = readHunkBody(lines, i + 1);
      current.hunks.push({ start: Number(m[1]), body });
      inHeader = false;
      i = next;
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          current.pairOld = headerPath(line.slice(4));
          current.pairNew = headerPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        current.pairNew = headerPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        const p = line.slice('rename from '.length).trim();
        current.renameOld = p === '/dev/null' ? null : p;
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        const p = line.slice('rename to '.length).trim();
        current.renameNew = p === '/dev/null' ? null : p;
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (current !== null && !inHeader) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        pushCurrent();
        current = freshSection();
        current.pairOld = headerPath(line.slice(4));
        current.pairNew = headerPath(lines[i + 1]!.slice(4));
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      current = freshSection();
      current.pairOld = headerPath(line.slice(4));
      current.pairNew = headerPath(lines[i + 1]!.slice(4));
      inHeader = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  pushCurrent();
  return sections;
}

/** Whether the hunk's last context or `+` line is followed by a `\` line:
 * the result then ends without a line break. */
function hunkEndsWithoutBreak(hunk: UnifiedHunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const b = hunk.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.noBreak;
  }
  return false;
}

/** Apply a section's hunks in order to a document. */
function applyHunks(doc: Doc, hunks: UnifiedHunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines.slice();
  let finalBreak = doc.finalBreak;
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines } = splitBody(hunk.body);
    const endsBare = hunkEndsWithoutBreak(hunk);
    if (oldLines.length === 0) {
      let at = hunk.start + drift;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...newLines.map((e) => e.text));
      if (atEnd) finalBreak = !endsBare;
      drift += newLines.length;
      continue;
    }
    const found = findAtTier(lines, oldLines, 0, strict, false);
    if (found === null) throw new EditFault('no-match', path);
    const target = hunk.start - 1 + drift;
    let best = found.at[0]!;
    let bestGap = Math.abs(best - target);
    for (const pos of found.at) {
      const gap = Math.abs(pos - target);
      if (gap < bestGap) {
        best = pos;
        bestGap = gap;
      }
    }
    const pos = best;
    const touchesEnd = pos + oldLines.length === lines.length;
    const replacement = buildReplacement(newLines, lines, pos, found.tier, leadingWs(oldLines[0]!), leadingWs(lines[pos]!));
    lines.splice(pos, oldLines.length, ...replacement);
    if (touchesEnd) finalBreak = !endsBare;
    drift += newLines.length - oldLines.length;
  }
  return { lines, eol: doc.eol, finalBreak };
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldPath = section.pairOld ?? section.renameOld ?? section.gitOld;
  const newPath = section.pairNew ?? section.renameNew ?? section.gitNew;
  return (tree, moves) => {
    if (oldPath !== null && !pathIsSafe(oldPath)) throw new EditFault('unsafe', oldPath);
    if (newPath !== null && !pathIsSafe(newPath)) throw new EditFault('unsafe', newPath);
    const creates = (oldPath === null || section.newFile) && newPath !== null;
    const deletes = (newPath === null || section.deletedFile) && oldPath !== null;
    if (creates) {
      const dest = newPath!;
      if (tree.get(dest) !== null) throw new EditFault('exists', dest);
      const added: string[] = [];
      let lastBare = false;
      for (const hunk of section.hunks) {
        for (const b of hunk.body) {
          if (b.kind === 'new') {
            added.push(b.text);
            lastBare = b.noBreak;
          }
        }
      }
      tree.now.set(dest, added.length === 0 ? '' : added.join('\n') + (lastBare ? '' : '\n'));
      return;
    }
    if (deletes) {
      const src = oldPath!;
      if (tree.get(src) === null) throw new EditFault('missing', src);
      tree.now.set(src, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new EditFault('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const done = applyHunks(splitDoc(before), section.hunks, strict, oldPath);
      tree.now.set(newPath, joinDoc(done));
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new EditFault('missing', oldPath);
    const done = applyHunks(splitDoc(before), section.hunks, strict, oldPath);
    tree.now.set(oldPath, joinDoc(done));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const trimmed = lines[j]!.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH' || lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchAt + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault('error: parse 1');
  return blocks.map((block) => {
    const { path, oldLines, newLines } = block;
    return (tree: WorkTree): void => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new EditFault('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new EditFault('missing', path);
      const doc = splitDoc(before);
      const found = findAtTier(doc.lines, oldLines, 0, strict, false);
      if (found === null) throw new EditFault('no-match', path);
      if (found.at.length > 1) throw new EditFault('ambiguous', path);
      const at = found.at[0]!;
      const replacement =
        found.tier === 2
          ? newLines.map((l) => reindent(l, leadingWs(oldLines[0]!), leadingWs(doc.lines[at]!)))
          : newLines.slice();
      const lines = doc.lines.slice();
      lines.splice(at, oldLines.length, ...replacement);
      tree.now.set(path, joinDoc({ lines, eol: doc.eol, finalBreak: doc.finalBreak }));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  endOfFile: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';

function v4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DELETE) || line.startsWith(V4A_UPDATE);
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      const collected: string[] = [];
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (isBlank(l)) {
          collected.push('');
          i += 1;
          continue;
        }
        if (l.startsWith('+')) {
          collected.push(l.slice(1));
          i += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      sections.push({ kind: 'add', path, lines: collected, moveTo: null, chunks: [] });
      continue;
    }
    if (line.startsWith(V4A_DELETE)) {
      sections.push({ kind: 'delete', path: line.slice(V4A_DELETE.length).trim(), lines: [], moveTo: null, chunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith(V4A_UPDATE)) {
      const path = line.slice(V4A_UPDATE.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let current: V4aChunk | null = null;
      const closeChunk = (trimBlank: boolean): void => {
        if (current === null) return;
        if (trimBlank) {
          while (current.body.length > 0 && current.body[current.body.length - 1]!.blank) current.body.pop();
        }
        chunks.push(current);
        current = null;
      };
      let sectionDone = false;
      while (i < last && !sectionDone) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          closeChunk(false);
          const anchorText = l.slice(2).trim();
          current = { anchor: anchorText === '' ? null : anchorText, body: [], endOfFile: false };
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (current !== null) {
            current.endOfFile = true;
            closeChunk(true);
          }
          i += 1;
          sectionDone = true;
          continue;
        }
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') {
          closeChunk(true);
          sectionDone = true;
          continue;
        }
        if (current === null) current = { anchor: null, body: [], endOfFile: false };
        if (l === '') {
          current.body.push({ kind: 'ctx', text: '', blank: true, noBreak: false });
          i += 1;
          continue;
        }
        const mark = l[0]!;
        if (mark === ' ') {
          current.body.push({ kind: 'ctx', text: l.slice(1), blank: isBlank(l), noBreak: false });
          i += 1;
          continue;
        }
        if (mark === '-') {
          current.body.push({ kind: 'old', text: l.slice(1), blank: false, noBreak: false });
          i += 1;
          continue;
        }
        if (mark === '+') {
          current.body.push({ kind: 'new', text: l.slice(1), blank: false, noBreak: false });
          i += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      if (!sectionDone) closeChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks });
      continue;
    }
    throw new ParseFault(`error: parse ${i + 1}`);
  }
  return sections;
}

/** The first line at or after `from` equal to the anchor, at the first
 * tier where one is, or -1. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = Math.max(from, 0); i < lines.length; i += 1) {
      if (tierKey(lines[i]!, tier) === tierKey(anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aEdit(section: V4aSection, strict: boolean): Edit {
  return (tree, moves) => {
    if (section.kind === 'add') {
      const path = section.path;
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, section.lines.length === 0 ? '' : section.lines.join('\n') + '\n');
      return;
    }
    if (section.kind === 'delete') {
      const path = section.path;
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      if (tree.get(path) === null) throw new EditFault('missing', path);
      tree.now.set(path, null);
      return;
    }
    const path = section.path;
    if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
    if (section.moveTo !== null && !pathIsSafe(section.moveTo)) throw new EditFault('unsafe', section.moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (section.moveTo !== null && tree.get(section.moveTo) !== null) throw new EditFault('exists', section.moveTo);
    const doc = splitDoc(before);
    let lines = doc.lines.slice();
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const at = chunk.endOfFile ? lines.length : cursor;
        lines.splice(at, 0, ...newLines.map((e) => e.text));
        cursor = at + newLines.length;
        continue;
      }
      const found = findAtTier(lines, oldLines, cursor, strict, chunk.endOfFile);
      if (found === null) throw new EditFault('no-match', path);
      const at = found.at[0]!;
      const replacement = buildReplacement(newLines, lines, at, found.tier, leadingWs(oldLines[0]!), leadingWs(lines[at]!));
      lines.splice(at, oldLines.length, ...replacement);
      cursor = at + replacement.length;
    }
    const done = joinDoc({ lines, eol: doc.eol, finalBreak: doc.finalBreak });
    const dest = section.moveTo ?? path;
    tree.now.set(dest, done);
    if (section.moveTo !== null) {
      tree.now.set(path, null);
      moves.push([path, section.moveTo]);
    }
  };
}

// ---------------------------------------------------------------------------
// Command line, running, reporting (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

interface Options {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options {
  let format: FormatName | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const arg of argv) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (format !== null) throw new ParseFault('error: usage');
        const value = arg.slice('--format='.length);
        if (!(FORMAT_NAMES as readonly string[]).includes(value)) throw new ParseFault('error: usage');
        format = value as FormatName;
      } else if (arg === '--check') {
        if (check) throw new ParseFault('error: usage');
        check = true;
      } else if (arg === '--strict') {
        if (strict) throw new ParseFault('error: usage');
        strict = true;
      } else {
        throw new ParseFault('error: usage');
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) throw new ParseFault('error: usage');
  return { format: format ?? 'auto', check, strict, patch: positional.length === 0 ? null : positional[0]! };
}

function buildEdits(kind: FormatName, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return parseJsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines).map((s) => unifiedEdit(s, strict));
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines).map((s) => v4aEdit(s, strict));
}

function run(argv: string[]): { code: number; out: string[] } {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  const patchFile = opts.patch === null || opts.patch === '-' ? null : opts.patch;
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = buildEdits(kind, text, lines, opts.strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const failures: EditFault[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveMark = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      moves.length = moveMark;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldPath, newPath] of moves) {
    if (tree.readDisk(oldPath) !== null && tree.get(oldPath) === null && tree.readDisk(newPath) === null && tree.get(newPath) !== null) {
      rows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
      consumed.add(oldPath);
      consumed.add(newPath);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.readDisk(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!opts.check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const linesOut = rows.map((r) => r.line);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
