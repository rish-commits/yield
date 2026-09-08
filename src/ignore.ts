// Keeping notes private by default.
//
// Someone's notes are personal working memory. Discovering them in a code review
// is a bad surprise, so `.yield/` goes into .gitignore on first run and sharing
// is opt-in rather than opt-out.
//
// THE ONE RULE THAT MATTERS: if the user deletes that line, it never comes back.
// Deleting it is exactly how a team opts into sharing context, and silently
// re-adding it would overrule a deliberate decision. So this is driven by "have
// we ever written it", remembered by the caller, and NOT by "is the line there
// right now" — the latter would undo their choice on the next activation.
//
// vscode-free so the rules can be tested directly.

import * as fs from 'fs/promises';
import * as path from 'path';

/** What goes in the file. Trailing slash: it is a directory. */
export const ENTRY = '.yield/';

export type IgnoreState =
  /** written just now */
  | 'added'
  /** we have written it before; whatever the user did with it since is theirs */
  | 'already-done'
  /** the line was already there, by their hand or another tool */
  | 'already-present'
  /** not a git repo, so there is nothing to ignore into */
  | 'not-a-repo'
  /** could not write; silent, since this is a convenience and not the product */
  | 'failed';

export type IgnoreResult = { state: IgnoreState; path?: string; detail?: string };

/**
 * A `.git` ENTRY, not necessarily a directory: worktrees and submodules use a
 * `.git` file pointing elsewhere, and those are still repos.
 */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Does this file already ignore us? Tolerant of the forms people write. */
export function alreadyIgnored(contents: string): boolean {
  return contents.split('\n').some((line) => {
    const l = line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return l === '.yield' || l === '.yield/*' || l === '.yield/**';
  });
}

/**
 * Adds `.yield/` to .gitignore, once, ever.
 *
 * `hasWrittenBefore` is the caller's memory of whether we have done this in
 * this workspace already. When true this is a no-op no matter what the file
 * says, which is what protects a user who removed the line on purpose.
 */
export async function ensureIgnored(
  root: string | undefined,
  hasWrittenBefore: boolean
): Promise<IgnoreResult> {
  if (!root) { return { state: 'not-a-repo' }; }
  if (!(await isGitRepo(root))) { return { state: 'not-a-repo' }; }
  // Their decision to remove it outranks our preference for privacy.
  if (hasWrittenBefore) { return { state: 'already-done' }; }

  const file = path.join(root, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'failed', path: file, detail: (err as Error).message };
    }
  }

  if (alreadyIgnored(existing)) { return { state: 'already-present', path: file }; }

  // Append, preserving every byte that was there. A file that does not end in a
  // newline would otherwise have our entry glued onto its last line.
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsNewline ? '\n' : ''}${existing.length ? '\n' : ''}# Yield notes, local to you\n${ENTRY}\n`;

  try {
    await fs.writeFile(file, existing + addition, 'utf8');
  } catch (err) {
    return { state: 'failed', path: file, detail: (err as Error).message };
  }
  return { state: 'added', path: file };
}
