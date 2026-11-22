// main.ts — mend: one patch tool for every AI edit format.
//
// Applies AI-written edits (unified diff, SEARCH/REPLACE blocks, V4A patches,
// JSON tool calls) to a tree of text files, per SPEC.md. Node 22, stdlib only.
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// Written fresh in this build session from SPEC.md + CHECKLIST.md + DESIGN.md.
// Sections: 1 invocation, 2 output/exit codes, 3 files/lines/paths,
// 4 format detection, 5 three-tier line matching, 6 unified, 7 SEARCH/REPLACE,
// 8 V4A, 9 JSON, 10 order and atomicity.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 condition: exactly one `error: ...` line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; reported on exit 1, in patch order. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, no empty
 *  piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a safe path is non-empty, not absolute, holds no `\`, and
 *  none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// Files as lines + break metadata (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileRep {
  lines: string[]; // lines WITHOUT their break; the empty piece after a final break is not a line
  br: '\n' | '\r\n'; // the file's own break: CRLF when its first LF follows a CR, else LF
  finalBreak: boolean; // the text ends with that break (an empty file: false)
}

function parseFile(text: string): FileRep {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const i = text.indexOf('\n');
  const br: '\n' | '\r\n' = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  if (text.endsWith(br)) parts.pop();
  return { lines: parts, br, finalBreak: text.endsWith(br) };
}

function serialize(rep: FileRep): string {
  return rep.lines.length === 0 ? '' : rep.lines.join(rep.br) + (rep.finalBreak ? rep.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk on demand. Moves are recorded explicitly so the
 *  output can print `R old -> new` for them. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }

  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.moves.push([oldPath, newPath]);
  }

  /** Snapshot of everything an edit may change, for rollback on failure. */
  snapshot(): { now: Map<string, string | null>; moves: Array<[string, string]> } {
    return { now: new Map(this.now), moves: [...this.moves] };
  }

  restore(s: { now: Map<string, string | null>; moves: Array<[string, string]> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves = [...s.moves];
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching engine (SPEC section 5)
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Only spaces and tabs are stripped — never trim(), which would also eat
 *  other whitespace. */
function tierKey(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? stripTrail(line) : stripBoth(line);
}

/** One body item: a context line (in both O and N), an old line, or a new line. */
interface BodyItem {
  text: string;
  kind: 'ctx' | 'old' | 'new';
}

const textsOf = (items: BodyItem[]): string[] => items.map((it) => it.text);

/** Every 0-based position where O matches fileLines at this tier. Occurrences
 *  may overlap, so the scan advances one line at a time. */
function occurrences(fileLines: string[], oldTexts: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldTexts.length === 0 || oldTexts.length > fileLines.length) return out;
  for (let i = 0; i + oldTexts.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldTexts.length; j++) {
      if (tierKey(fileLines[i + j]!, tier) !== tierKey(oldTexts[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs
 *  at least once, with all its positions there. Null when it occurs nowhere. */
function findTier(
  fileLines: string[],
  oldTexts: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(fileLines, oldTexts, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The leading spaces/tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Tier-2 re-indentation of one non-context new line: F (leading whitespace
 *  of the file's first matched line) replaces P (leading whitespace of O's
 *  first line) when the line is non-empty, not only whitespace, and starts
 *  with P; anything else is written as it is. */
function reindentLine(nLine: string, firstFileLine: string, firstOldLine: string): string {
  if (nLine === '' || nLine.trim() === '') return nLine;
  const p = leadingWs(firstOldLine);
  if (!nLine.startsWith(p)) return nLine;
  return leadingWs(firstFileLine) + nLine.slice(p.length);
}

/** Replace the matched lines at `pos` with N. A context line is written as
 *  the file's own matched line, never the patch's: the k-th context item of N
 *  maps to the file line of the k-th context item of O (context order, not
 *  raw O position — an old item may sit before a context item). Every other
 *  new line is re-indented at tier 2 and written as it is at tiers 0 and 1. */
function applyMatch(
  fileLines: string[],
  pos: number,
  oldItems: BodyItem[],
  newItems: BodyItem[],
  tier: number,
): string[] {
  const ctxPosInO: number[] = [];
  for (let i = 0; i < oldItems.length; i++) if (oldItems[i]!.kind === 'ctx') ctxPosInO.push(i);
  const firstFileLine = fileLines[pos]!;
  const firstOldLine = oldItems[0]!.text;
  const replaced: string[] = [];
  let ctxSeen = 0;
  for (const item of newItems) {
    if (item.kind === 'ctx') {
      replaced.push(fileLines[pos + ctxPosInO[ctxSeen]!]!);
      ctxSeen++;
    } else if (tier === 2) {
      replaced.push(reindentLine(item.text, firstFileLine, firstOldLine));
    } else {
      replaced.push(item.text);
    }
  }
  return [...fileLines.slice(0, pos), ...replaced, ...fileLines.slice(pos + oldItems.length)];
}

/** Render N for an empty-O insertion: only new items exist, written as they
 *  are (tier 0, no context to map, no re-indentation). */
function renderNew(newItems: BodyItem[]): string[] {
  return newItems.filter((it) => it.kind === 'new').map((it) => it.text);
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  /** The file's current text, after the safe check and the missing check. */
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const rep = parseFile(before);
      if (line < 0 || line > rep.lines.length) throw new Fail('no-match', p);
      rep.lines.splice(line, 0, ...added);
      tree.set(p, serialize(rep));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number; // A: the 1-based start line the hunk names in the old file
  oldItems: BodyItem[]; // context + `-` lines, in body order
  newItems: BodyItem[]; // context + `+` lines, in body order
  /** A `\` line directly follows the hunk's last context/`+` line. */
  noFinalBreak: boolean;
  /** A `\` line directly follows the hunk's last `+` line. */
  noFinalBreakPlus: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headerOld: string | null; // from `--- ` in the header
  headerNew: string | null; // from `+++ ` in the header
  renameOld: string | null; // from `rename from`
  renameNew: string | null; // from `rename to`
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the
 *  first tab, surrounding spaces removed; `/dev/null` means no file; a
 *  leading `a/` or `b/` is removed. */
function unifiedPath(raw: string): string | null {
  let s = raw.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;

  /** Parse the header lines of a section (before its first hunk) and its
   *  hunks, starting at index i. Returns the next unconsumed index. */
  const parseSectionBody = (section: Section, start: number): number => {
    let j = start;
    // Header lines, until the first hunk, the next section, or the end.
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        // The pair belongs to this section's header: consume it. A `--- `
        // line not followed by `+++ ` inside a header is a parse error
        // naming the line after it.
        if (!(lines[j + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
        section.headerOld = unifiedPath(l);
        section.headerNew = unifiedPath(lines[j + 1]!);
        j += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        section.headerNew = unifiedPath(l);
        j++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        section.renameOld = l.slice(12).trim();
        j++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        section.renameNew = l.slice(10).trim();
        j++;
        continue;
      }
      if (l.startsWith('new file mode')) section.creation = true;
      else if (l.startsWith('deleted file mode')) section.deletion = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line: ignored.
      j++;
    }
    // Hunks.
    while (j < lines.length && lines[j]!.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[j]!);
      if (header === null) throw new Exit2(`error: parse ${j + 1}`);
      const a = Number(header[1]);
      j++;
      const body: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it; a blank line
      // here is empty or only whitespace.
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      const oldItems: BodyItem[] = [];
      const newItems: BodyItem[] = [];
      for (const l of body) {
        if (l.startsWith('\\')) continue; // refers to the body line before it
        if (l.startsWith(' ')) {
          const t = l.slice(1);
          oldItems.push({ text: t, kind: 'ctx' });
          newItems.push({ text: t, kind: 'ctx' });
        } else if (l === '') {
          oldItems.push({ text: '', kind: 'ctx' });
          newItems.push({ text: '', kind: 'ctx' });
        } else if (l.startsWith('-')) oldItems.push({ text: l.slice(1), kind: 'old' });
        else if (l.startsWith('+')) newItems.push({ text: l.slice(1), kind: 'new' });
      }
      let noFinalBreak = false;
      if (body.length >= 2 && body[body.length - 1]!.startsWith('\\')) {
        const prev = body[body.length - 2]!;
        if (prev.startsWith(' ') || prev.startsWith('+') || prev === '') noFinalBreak = true;
      }
      let noFinalBreakPlus = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.startsWith('+')) {
          if (body[k + 1] !== undefined && body[k + 1]!.startsWith('\\')) noFinalBreakPlus = true;
          break;
        }
      }
      section.hunks.push({ a, oldItems, newItems, noFinalBreak, noFinalBreakPlus });
    }
    return j;
  };

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const body = rest.slice(2);
      const cut = body.indexOf(' b/');
      if (cut < 0) throw new Exit2(`error: parse ${i + 1}`);
      const diffOld = body.slice(0, cut);
      const diffNew = body.slice(cut + 3);
      if (diffOld === '' || diffNew === '') throw new Exit2(`error: parse ${i + 1}`);
      const section: Section = {
        diffOld,
        diffNew,
        headerOld: null,
        headerNew: null,
        renameOld: null,
        renameNew: null,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseSectionBody(section, i + 1);
      sections.push(section);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const section: Section = {
        diffOld: null,
        diffNew: null,
        headerOld: unifiedPath(l),
        headerNew: unifiedPath(lines[i + 1]!),
        renameOld: null,
        renameNew: null,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseSectionBody(section, i + 2);
      sections.push(section);
    } else if (l.startsWith('@@')) {
      // A hunk before any section.
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      // Prose / code fences outside sections: ignored.
      i++;
    }
  }

  const edits = sections.map((s) => unifiedEdit(s, strict));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Apply one section's hunks in order to a file's lines. `d` is the sum over
 *  this section's hunks applied so far of (N's length minus O's length). */
function applyHunks(rep: FileRep, hunks: Hunk[], path: string, strict: boolean): FileRep {
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.oldItems.length === 0) {
      const at = Math.min(hunk.a + d, rep.lines.length);
      const atEnd = at === rep.lines.length;
      rep.lines.splice(at, 0, ...renderNew(hunk.newItems));
      if (atEnd) rep.finalBreak = !hunk.noFinalBreak;
    } else {
      const found = findTier(rep.lines, textsOf(hunk.oldItems), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const touchesEof = pos + hunk.oldItems.length === rep.lines.length;
      rep.lines = applyMatch(rep.lines, pos, hunk.oldItems, hunk.newItems, found.tier);
      if (touchesEof) rep.finalBreak = !hunk.noFinalBreak;
      d += hunk.newItems.length - hunk.oldItems.length;
    }
  }
  return rep;
}

function unifiedEdit(section: Section, strict: boolean): Edit {
  // Path precedence: `---`/`+++` header pair, then `rename from/to`, then
  // the `diff --git` paths.
  const oldPath = section.headerOld ?? section.renameOld ?? section.diffOld;
  const newPath = section.headerNew ?? section.renameNew ?? section.diffNew;
  const isCreation = oldPath === null || section.creation;
  const isDeletion = newPath === null || section.deletion;
  return (tree) => {
    if (isCreation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      let lastPlusBackslash = false;
      for (const hunk of section.hunks) {
        for (const item of hunk.newItems) if (item.kind === 'new') plusLines.push(item.text);
      }
      for (let h = section.hunks.length - 1; h >= 0; h--) {
        const hunk = section.hunks[h]!;
        if (hunk.newItems.some((it) => it.kind === 'new')) {
          lastPlusBackslash = hunk.noFinalBreakPlus;
          break;
        }
      }
      tree.set(p, serialize({ lines: plusLines, br: '\n', finalBreak: !lastPlusBackslash }));
    } else if (isDeletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null); // its hunks are not read
    } else if (oldPath !== newPath) {
      const oldP = oldPath!;
      const newP = newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const rep = applyHunks(parseFile(before), section.hunks, oldP, strict);
      tree.move(oldP, newP, serialize(rep));
    } else {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const rep = applyHunks(parseFile(before), section.hunks, p, strict);
      tree.set(p, serialize(rep));
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path is the nearest line before SEARCH and after the previous
    // block's REPLACE that is not blank and, trimmed, does not start with
    // three backticks; the path is that line trimmed.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    // Find `=======` then `>>>>>>> REPLACE` after SEARCH. A second SEARCH
    // before the `=======` means this block has none.
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, serialize({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const rep = parseFile(before);
    const found = findTier(rep.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const oldItems: BodyItem[] = oldLines.map((text) => ({ text, kind: 'old' as const }));
    const newItems: BodyItem[] = newLines.map((text) => ({ text, kind: 'new' as const }));
    rep.lines = applyMatch(rep.lines, found.positions[0]!, oldItems, newItems, found.tier);
    tree.set(path, serialize(rep));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

interface V4aChunk {
  anchor: string | null; // null: no anchor
  eof: boolean; // `*** End of File` anchors the chunk to the end of the file
  oldItems: BodyItem[];
  newItems: BodyItem[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.findLastIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const body: Array<{ text: string; fromPlus: boolean }> = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) body.push({ text: bl.slice(1), fromPlus: true });
        else if (bl === '') body.push({ text: '', fromPlus: false });
        else if (blank(bl)) body.push({ text: '', fromPlus: false });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      // Blank lines at the end of a section are not part of it — but only
      // blank patch lines are dropped, never a `+` line (even one that
      // yields an empty file line).
      while (body.length > 0 && !body[body.length - 1]!.fromPlus) body.pop();
      edits.push(v4aAddEdit(path, body.map((b) => b.text)));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let firstChunk = true;
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        const cl = lines[i]!;
        if (cl.startsWith('@@')) {
          const anchorText = cl.slice(2).trim();
          i++;
          const parsed = parseV4aChunk(lines, i, last, anchorText === '' ? null : anchorText);
          chunks.push(parsed.chunk);
          i = parsed.nextI;
          firstChunk = false;
        } else if (firstChunk && isV4aBodyLine(cl)) {
          const parsed = parseV4aChunk(lines, i, last, null);
          chunks.push(parsed.chunk);
          i = parsed.nextI;
          firstChunk = false;
        } else if (blank(cl)) {
          // Blank lines between chunks are ignored; inside a chunk they
          // are body lines, handled by parseV4aChunk.
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Read one chunk body starting at index `start` (the line after its `@@`
 *  line, or the first body line of the first chunk). Stops at the next `@@`,
 *  at `*** End of File` (which ends the chunk and anchors it to the end of
 *  the file), at the next section, or at `*** End Patch`. Returns the chunk
 *  and the next unconsumed index. */
function parseV4aChunk(
  lines: string[],
  start: number,
  last: number,
  anchor: string | null,
): { chunk: V4aChunk; nextI: number } {
  const rawBody: string[] = [];
  let eof = false;
  let i = start;
  while (i < last) {
    const l = lines[i]!;
    if (l === '*** End of File') {
      eof = true;
      i++;
      break;
    }
    if (l.startsWith('@@')) break;
    if (isV4aSectionStart(l)) break;
    if (!isV4aBodyLine(l)) throw new Exit2(`error: parse ${i + 1}`);
    rawBody.push(l);
    i++;
  }
  // Blank lines at the end of a chunk are not part of it.
  while (rawBody.length > 0 && blank(rawBody[rawBody.length - 1]!)) rawBody.pop();
  const oldItems: BodyItem[] = [];
  const newItems: BodyItem[] = [];
  for (const l of rawBody) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      oldItems.push({ text: t, kind: 'ctx' });
      newItems.push({ text: t, kind: 'ctx' });
    } else if (l === '' || blank(l)) {
      oldItems.push({ text: '', kind: 'ctx' });
      newItems.push({ text: '', kind: 'ctx' });
    } else if (l.startsWith('-')) oldItems.push({ text: l.slice(1), kind: 'old' });
    else if (l.startsWith('+')) newItems.push({ text: l.slice(1), kind: 'new' });
  }
  return { chunk: { anchor, eof, oldItems, newItems }, nextI: i };
}

const isV4aBodyLine = (l: string): boolean =>
  l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '' || blank(l);

function v4aAddEdit(path: string, bodyLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, bodyLines.length === 0 ? '' : bodyLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const rep = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt: number | null = null;
        for (const tier of tiers) {
          for (let j = cursor; j < rep.lines.length; j++) {
            if (tierKey(rep.lines[j]!, tier) === tierKey(chunk.anchor, tier)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (chunk.oldItems.length === 0) {
        const at = chunk.eof ? rep.lines.length : cursor;
        rep.lines.splice(at, 0, ...renderNew(chunk.newItems));
        cursor = at + chunk.newItems.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; pos: number } | null = null;
        for (const tier of tiers) {
          let positions = occurrences(rep.lines, textsOf(chunk.oldItems), tier).filter((p) => p >= cursor);
          if (chunk.eof) positions = positions.filter((p) => p + chunk.oldItems.length === rep.lines.length);
          if (positions.length > 0) {
            found = { tier, pos: positions[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        rep.lines = applyMatch(rep.lines, found.pos, chunk.oldItems, chunk.newItems, found.tier);
        cursor = found.pos + chunk.newItems.length;
      }
    }
    if (moveTo !== null) tree.move(path, moveTo, serialize(rep));
    else tree.set(path, serialize(rep));
  };
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  // Apply in patch order; a failed edit changes nothing, and the edits
  // after it still run, so every failure is reported.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Output rows: one per changed path, in byte order of the path — except a
  // successful move prints `R <old> -> <new>` and sorts by `<new>`.
  const satisfiedMoves = new Map<string, string>(); // new path -> old path
  const movedOlds = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(newP) !== null && tree.get(oldP) === null && tree.original(newP) === null) {
      satisfiedMoves.set(newP, oldP);
      movedOlds.add(oldP);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    if (satisfiedMoves.has(p)) {
      rows.push({ key: p, line: `R ${satisfiedMoves.get(p)} -> ${p}` });
      continue;
    }
    if (movedOlds.has(p)) continue; // replaced by the R line
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
