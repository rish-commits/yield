// Which port a window should listen on.
//
// v1 bound ONE fixed port from every window. In a multi-window IDE that is a
// race with an arbitrary winner and silently deaf losers — which is exactly how
// a panel ended up looking healthy while never hearing the agent. Deriving the
// port from the workspace path means windows on different projects never
// compete at all.
//
// Pure and dependency-free, like gate.ts and questions.ts, so the rule can be
// tested directly.

/** The band project ports live in. 1000 wide, not 100: at 100 the birthday
 *  maths gave a 50% chance that some pair of a dozen projects collided, which
 *  made the probe path routine rather than rare. Every probe that lands on a
 *  different port costs the user a Claude Code restart, so the range exists to
 *  make that uncommon. */
export const PORT_BASE = 41800;
export const PORT_SPAN = 1000;

/** How many ports to try before giving up. Bounded on purpose: scanning the
 *  whole band would hang activation, and an honest "cannot hear the agent" beats
 *  a window that never finishes starting. */
export const PROBE_LIMIT = 40;

/**
 * A stable port for a workspace. Same folder always gives the same number, so
 * the hook config written into a project keeps working across restarts, and two
 * different projects almost never collide.
 *
 * FNV-1a: tiny, deterministic, and good enough to scatter paths across the band.
 * This is not security — a collision between two unrelated projects just means
 * those two race the way v1 always did, and the retry/handoff path covers it.
 */
export function inBand(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port)
    && port >= PORT_BASE && port < PORT_BASE + PORT_SPAN;
}

export function projectPort(workspacePath: string): number {
  let hash = 2166136261;
  for (let i = 0; i < workspacePath.length; i++) {
    hash ^= workspacePath.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PORT_BASE + (Math.abs(hash) % PORT_SPAN);
}

/**
 * The order to try ports in: the one this project held last time, then the one
 * its path hashes to, then upward from there, wrapping inside the band.
 *
 * Preferring the remembered port is what keeps a project on the same number
 * across launches — drifting would rewrite settings and demand a restart every
 * time the window opened.
 */
export function probeSequence(
  preferred: number,
  remembered?: number,
  limit: number = PROBE_LIMIT
): number[] {
  const order: number[] = [];
  const push = (p: number) => { if (!order.includes(p)) { order.push(p); } };
  if (inBand(remembered)) { push(remembered); }
  push(preferred);
  for (let i = 1; order.length < limit; i++) {
    push(PORT_BASE + ((preferred - PORT_BASE + i) % PORT_SPAN));
    if (i > PORT_SPAN) { break; }   // the band is finite; never spin
  }
  return order.slice(0, limit);
}

/**
 * Does `cwd` sit at or under `root`? This is the whole of the route-by-cwd
 * rule, kept here beside projectPort because it answers the same question:
 * which project is this hook talking about.
 *
 * WINDOWS IS NOT A BYTE COMPARE. VS Code's `Uri.fsPath` normalises the drive
 * letter to lower-case (documented in @types/vscode), while the cwd in a hook
 * payload comes raw from the agent's `process.cwd()`, which does not. So
 * `c:\Users\me\proj` and `C:\Users\me\proj` are the same directory and a `===`
 * rejects every hook the window actually owns. Separators can differ for the
 * same reason, so they are folded too.
 *
 * POSIX STAYS A BYTE COMPARE. Those filesystems are case-SENSITIVE: `/tmp/A`
 * and `/tmp/a` are genuinely different projects and must keep comparing false.
 *
 * The boundary check matters as much as the casing: `/a/project` must not
 * match `/a/project-two`, which is why the prefix test appends a separator.
 */
export function underRoot(
  cwd: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!root || !cwd) { return true; }   // nothing to disagree with
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const norm = (p: string) => {
    let s = win ? p.replace(/\//g, '\\').toLowerCase() : p;
    // a trailing separator would defeat the boundary check below
    while (s.length > 1 && s.endsWith(sep)) { s = s.slice(0, -1); }
    return s;
  };
  const c = norm(cwd);
  const r = norm(root);
  return c === r || c.startsWith(r + sep);
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook`;
}

/** The port a hook URL points at, or undefined if it is not one of ours. */
export function portFromUrl(url: unknown): number | undefined {
  if (typeof url !== 'string') { return undefined; }
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/hook$/.exec(url.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * Rewrites the port in Yield's own hook entries, leaving every other hook and
 * every unrelated setting untouched. Returns the updated settings plus what
 * changed, or `undefined` when there was nothing of ours to update.
 *
 * Deliberately conservative: it only ever touches entries that already point at
 * a 127.0.0.1 `/hook` URL, so a hand-written hook of the user's own is safe.
 */
export function retargetHooks(
  settings: unknown,
  port: number
): { settings: unknown; changedFrom: number[] } | undefined {
  if (!settings || typeof settings !== 'object') { return undefined; }
  const root = settings as Record<string, unknown>;
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== 'object') { return undefined; }

  const changedFrom: number[] = [];
  const want = hookUrl(port);

  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) { continue; }
    for (const group of groups) {
      const inner = group && typeof group === 'object' ? (group as Record<string, unknown>).hooks : undefined;
      if (!Array.isArray(inner)) { continue; }
      for (const hook of inner) {
        if (!hook || typeof hook !== 'object') { continue; }
        const h = hook as Record<string, unknown>;
        const current = portFromUrl(h.url);
        if (current === undefined || current === port) { continue; }
        changedFrom.push(current);
        h.url = want;
      }
    }
  }
  return changedFrom.length ? { settings: root, changedFrom } : undefined;
}

/** Every Yield port a settings file currently points at. */
export function configuredPorts(settings: unknown): number[] {
  const found = new Set<number>();
  const hooks = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).hooks
    : undefined;
  if (!hooks || typeof hooks !== 'object') { return []; }
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) { continue; }
    for (const group of groups) {
      const inner = group && typeof group === 'object' ? (group as Record<string, unknown>).hooks : undefined;
      if (!Array.isArray(inner)) { continue; }
      for (const hook of inner) {
        const p = portFromUrl(hook && typeof hook === 'object' ? (hook as Record<string, unknown>).url : undefined);
        if (p !== undefined) { found.add(p); }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}
