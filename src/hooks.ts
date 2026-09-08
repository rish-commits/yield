// Self-installing Claude Code hooks.
//
// Yield is useless without them: no hook, no signal that the agent is working,
// and a new user sees a dead panel and uninstalls. So installing the extension
// IS the setup. Nothing is asked of the user and nothing is announced.
//
// vscode-free like gate/questions/ports/store/ask, so every rule below can be
// tested directly rather than inferred from what the extension did.
//
// WHY PROJECT-LEVEL AND NOT ~/.claude/settings.json: the port is derived from
// the workspace path (ports.ts), so each project needs its own hook URL. One
// user-level hook can only carry one port, which would drag back the
// single-port race that made windows silently deaf. Project settings are also
// the narrower blast radius: Yield never fires in projects it was never opened
// in.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { hookUrl, portFromUrl } from './ports';

/** The events Yield listens for. UserPromptSubmit drives WORKING and carries
 *  the injection; Stop drives IDLE. */
export const EVENTS = ['UserPromptSubmit', 'Stop'] as const;

/** Written into every hook we create. A human-readable label in Claude Code's
 *  own UI, and the thing we look for when deciding whether ours are already
 *  there — so detection is a field lookup, never a match on the whole block. */
export const MARKER = 'yield';

export type SetupState =
  /** hooks are in place; nothing to say */
  | 'ok'
  /** we put them there this session, so a Claude Code already running has not seen them */
  | 'restart-needed'
  /** Claude Code is not on this machine */
  | 'no-claude'
  /** no folder open, so there is no project to attach hooks to */
  | 'no-workspace'
  /** their settings file is not valid JSON — we refuse to touch it */
  | 'malformed'
  /** the file or its folder cannot be written */
  | 'no-permission'
  /** every port we tried was taken. Capture still works; only the link is gone. */
  | 'no-port';

/**
 * The one line the panel shows for each state. Agent-neutral, calm, no
 * em-dashes. `ok` is deliberately empty: a working install says nothing.
 */
export const SETUP_COPY: Record<SetupState, string> = {
  'ok': '',
  'restart-needed': 'Restart Claude Code to activate.',
  'no-claude': 'Claude Code was not found, so Yield cannot see when your agent is working.',
  'no-workspace': 'Open a folder to use Yield. It keeps your notes alongside the project.',
  'malformed': 'Your Claude Code settings file could not be read, so nothing was changed. The path is in the Yield output.',
  'no-permission': 'Yield could not write to your Claude Code settings. The path is in the Yield output.',
  'no-port': 'Yield could not claim a port, so it cannot see when your agent is working. Your notes still save. Reload the window to try again.'
};

export function settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'settings.json');
}

export function backupPath(workspaceRoot: string): string {
  return `${settingsPath(workspaceRoot)}.yield-backup`;
}

/** One hook entry, as Claude Code expects it. */
export function hookEntry(port: number) {
  return {
    type: 'http',
    url: hookUrl(port),
    timeout: 10,
    statusMessage: MARKER
  };
}

type Json = Record<string, unknown>;

/** Ours if it is a loopback /hook URL, or carries our label. Structured
 *  detection, so a user's own hook on the same event is never mistaken for it. */
function isOurHook(hook: unknown): boolean {
  if (!hook || typeof hook !== 'object') { return false; }
  const h = hook as Json;
  if (h.statusMessage === MARKER) { return true; }
  return portFromUrl(h.url) !== undefined;
}

/**
 * Adds Yield's hooks to a settings object, leaving everything else exactly as
 * it was. Never replaces a user's own hooks on the same event; ours go in
 * alongside. Idempotent: an entry that is already ours is updated in place
 * rather than duplicated.
 */
export function addOurHooks(settings: Json, port: number): { settings: Json; changed: boolean } {
  const out = settings && typeof settings === 'object' ? settings : {};
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) {
    out.hooks = {};
  }
  const hooks = out.hooks as Json;
  let changed = false;

  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) { hooks[event] = []; }
    const groups = hooks[event] as unknown[];

    // Is one of ours already in there anywhere under this event?
    let found = false;
    for (const group of groups) {
      const inner = group && typeof group === 'object' ? (group as Json).hooks : undefined;
      if (!Array.isArray(inner)) { continue; }
      for (const hook of inner) {
        if (!isOurHook(hook)) { continue; }
        found = true;
        const h = hook as Json;
        // Keep it pointed at the right port and labelled, without duplicating.
        if (h.url !== hookUrl(port) || h.statusMessage !== MARKER) {
          h.url = hookUrl(port);
          h.statusMessage = MARKER;
          changed = true;
        }
      }
    }
    if (!found) {
      // A group of our own, so a user's existing groups are untouched.
      groups.push({ hooks: [hookEntry(port)] });
      changed = true;
    }
  }
  return { settings: out, changed };
}

/** True when Yield's hooks are already present for every event it needs. */
export function hasOurHooks(settings: unknown, port: number): boolean {
  const hooks = settings && typeof settings === 'object'
    ? (settings as Json).hooks : undefined;
  if (!hooks || typeof hooks !== 'object') { return false; }
  return EVENTS.every((event) => {
    const groups = (hooks as Json)[event];
    if (!Array.isArray(groups)) { return false; }
    return groups.some((group) => {
      const inner = group && typeof group === 'object' ? (group as Json).hooks : undefined;
      return Array.isArray(inner) && inner.some((h) =>
        isOurHook(h) && (h as Json).url === hookUrl(port));
    });
  });
}

/**
 * Is Claude Code on this machine?
 *
 * Checked without spawning anything: the PATH is scanned for the executable
 * under each platform's naming, and `~/.claude` is accepted as evidence too,
 * since that is created the first time it runs. Deliberately generous — a false
 * "not installed" would be worse than staying quiet.
 */
export async function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  const names = platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude.bat']
    : ['claude'];
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':');
  // the npm-global and official installer locations, which are not always on
  // the PATH the extension host inherits
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));

  for (const dir of dirs) {
    if (!dir) { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        await fs.access(full);
        return full;
      } catch { /* keep looking */ }
    }
  }
  try {
    await fs.access(path.join(home, '.claude'));
    return path.join(home, '.claude');
  } catch {
    return undefined;
  }
}

export type EnsureResult = {
  state: SetupState;
  /** where the settings live, for the output channel */
  path?: string;
  /** true when this call is what put them there */
  installed: boolean;
  detail?: string;
};

/**
 * Makes sure Yield's hooks are in the project's Claude Code settings.
 *
 * Never overwrites. Never repairs. Backs up before writing. A file that is not
 * valid JSON is left completely alone: silently rewriting someone's config is
 * worse than not working.
 */
export async function ensureHooks(
  workspaceRoot: string | undefined,
  port: number,
  opts: { claudePath?: string | undefined } = {}
): Promise<EnsureResult> {
  if (!workspaceRoot) { return { state: 'no-workspace', installed: false }; }
  if (opts.claudePath === undefined) { return { state: 'no-claude', installed: false }; }

  const file = settingsPath(workspaceRoot);
  let raw: string | undefined;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'no-permission', path: file, installed: false, detail: (err as Error).message };
    }
  }

  let parsed: Json = {};
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) { throw new Error('not an object'); }
      parsed = p as Json;
    } catch (err) {
      // Their file, their problem to fix. We say where it is and stop.
      return { state: 'malformed', path: file, installed: false, detail: (err as Error).message };
    }
  }

  if (hasOurHooks(parsed, port)) {
    return { state: 'ok', path: file, installed: false };
  }

  const { settings, changed } = addOurHooks(parsed, port);
  if (!changed) { return { state: 'ok', path: file, installed: false }; }

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Back up whatever was there before we touch it.
    if (raw !== undefined) {
      await fs.writeFile(backupPath(workspaceRoot), raw, 'utf8');
    }
    // Preserve the file's own indentation rather than reformatting it.
    const indent = raw ? (/\n(\s+)"/.exec(raw)?.[1]?.length ?? 2) : 2;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, indent)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    return { state: 'no-permission', path: file, installed: false, detail: (err as Error).message };
  }

  // Hooks snapshot at session start, so anything already running has not seen
  // these. The caller decides whether that matters yet.
  return { state: 'restart-needed', path: file, installed: true };
}
