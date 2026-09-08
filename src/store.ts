// The shape of .yield/yield-context.md.
//
// The file is a standalone project brief, not a log. It should make sense to a
// human, a teammate, or any AI that has never heard of this extension — so the
// header never mentions it, and nothing in the file is machine bookkeeping.
//
// Pure and dependency-free, like gate.ts, questions.ts and ports.ts, so the
// format rules can be tested directly rather than inferred from file writes.
//
// TWO RULES SHAPE EVERYTHING HERE:
//   1. The user's words are never touched. No summarising, no cleanup, no
//      capitalisation fixes, no reordering, no deleting.
//   2. Parsing is LOSSLESS. A hand-edited file must come back byte-identical
//      apart from the one bullet being added, including any headings or prose
//      the user wrote themselves.

/** The fixed set. Never invent a heading outside this list. */
export const SECTIONS = [
  'Project',        // what it is, stack, what it's for
  'Architecture',   // where things live, key directories, non-obvious patterns
  'Commands',       // install, dev, build, test, lint
  'Conventions',    // how code should be written
  'Design',         // UI, styling, spacing, component rules
  'Avoid',          // hard nevers
  'Workflow',       // git, branching, PRs, deploy
  'Gotchas',        // traps and environment quirks that aren't obvious
  'Notes'           // catch-all
] as const;

export type Section = (typeof SECTIONS)[number];

/**
 * Where a note goes today. Automatic placement into the other sections is a
 * later change: it swaps this one constant for a classifier and nothing else
 * in this file moves.
 */
export const DEFAULT_SECTION: Section = 'Notes';

/**
 * Written once, when the file is created. Deliberately says nothing about how
 * the file is maintained — someone opening it cold should understand what it is
 * and how to use it, with no other context.
 */
export const STORE_HEADER = `# Project context

Standing instructions for anyone working on this project, human or AI.
Read this before making changes, and follow it unless the user says otherwise.

Where two entries conflict, the later one wins.
`;

type Block = {
  /** the section name if this is one of ours, else null (preamble or the user's own heading) */
  section: Section | null;
  /** raw lines, heading included, exactly as they appear in the file */
  lines: string[];
};

const HEADING = /^##\s+(.+?)\s*$/;

function asSection(heading: string): Section | null {
  return (SECTIONS as readonly string[]).includes(heading) ? (heading as Section) : null;
}

/**
 * Splits the file into blocks without losing a single character. The first
 * block is whatever precedes the first `## ` heading.
 */
export function parse(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [{ section: null, lines: [] }];
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      blocks.push({ section: asSection(m[1]), lines: [line] });
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return blocks;
}

export function render(blocks: Block[]): string {
  return blocks.map((b) => b.lines.join('\n')).join('\n');
}

/**
 * A note becomes ONE bullet, in the user's exact words. A multi-line note keeps
 * its line breaks but indents continuations so the whole thing stays one bullet
 * — the only byte we add to what was typed.
 */
function bullet(note: string): string[] {
  const lines = note.split('\n');
  return lines.map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`));
}

/** Trailing blank lines in a block, so we append after the content, not after the gap. */
function lastContentIndex(lines: string[]): number {
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') { i--; }
  return i;
}

/**
 * Appends a note to its section, creating the section only if it is needed.
 *
 * An empty section is never written: the structure exists here, in SECTIONS,
 * and only materialises in the file once something is actually filed under it.
 * A newly created heading is placed in SECTIONS order relative to the other
 * headings we know, never in the order sections happened to be filled.
 */
export function addNote(text: string, note: string, section: Section = DEFAULT_SECTION): string {
  const blocks = parse(text.length ? text : STORE_HEADER);
  const target = blocks.find((b) => b.section === section);

  if (target) {
    // Newest at the bottom of its section, after the existing content.
    const at = lastContentIndex(target.lines);
    target.lines.splice(at + 1, 0, ...bullet(note));
    return render(blocks);
  }

  const fresh: Block = { section, lines: [`## ${section}`, '', ...bullet(note)] };
  const rank = SECTIONS.indexOf(section);

  // before the first known section that sorts after this one …
  const before = blocks.findIndex(
    (b) => b.section !== null && SECTIONS.indexOf(b.section) > rank
  );
  if (before !== -1) {
    padTail(blocks[before - 1]);
    blocks.splice(before, 0, fresh);
    fresh.lines.push('');
    return render(blocks);
  }

  // … otherwise at the end, after whatever is already there
  padTail(blocks[blocks.length - 1]);
  blocks.push(fresh);
  fresh.lines.push('');
  return render(blocks);
}

/** Exactly one blank line between blocks, without disturbing existing content. */
function padTail(block: Block) {
  const at = lastContentIndex(block.lines);
  block.lines.length = at + 1;
  block.lines.push('');
}

/**
 * How many notes the file holds. Counts bullets under headings, so a
 * hand-edited file — notes added or deleted by hand — still reports honestly.
 */
export function countNotes(text: string): number {
  let count = 0;
  let inSection = false;
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) { inSection = true; continue; }
    if (inSection && /^-\s+\S/.test(line)) { count++; }
  }
  return count;
}

/** True for a file still in the old Task/Note log format. */
export function isLegacyFormat(text: string): boolean {
  return /^\*\*Task:\*\*/m.test(text) || /^\*\*Note:\*\*/m.test(text);
}
