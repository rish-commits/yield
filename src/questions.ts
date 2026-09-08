// The scripted question/acknowledgment tables — yield-conversational-flow.html
// §04 and handoff §5.
//
// Everything here is DATA, not branching code: §08's whole point is that Level
// 2a (LLM replies) swaps "pick from the list" for "ask the model" without
// touching the UI or the flow. The webview never sees this file — it renders
// the question rows and the reply text the extension hands it — so the swap is
// one async function, right here.
//
// Voice is agent-neutral throughout (handoff §3) — never "Claude". The mock's
// "Claude" strings were an artifact.

export type Ask = {
  /** stable id, so a later LLM path can still report which slot it filled */
  id: string;
  /** keywords in the current prompt that make this question worth asking */
  triggers: RegExp;
  /** one line, strictly — the row is nowrap + ellipsis (handoff §2) */
  question: string;
  /** short acknowledgment once the user ANSWERS this specific question */
  ack: string;
};

export const ASKS: Ask[] = [
  {
    id: 'auth',
    triggers: /\b(auth|login|session|oauth|jwt|sign[- ]?in)\b/i,
    question: 'Any auth patterns or libraries your agent should stick to?',
    ack: "Noted. I'll keep that in mind for anything auth-related."
  },
  {
    id: 'db',
    triggers: /\b(db|database|schema|migration|table|quer(y|ies)|sql|postgres|sqlite)\b/i,
    question: 'Any conventions for how tables or queries should be written?',
    ack: 'Got it, saved.'
  },
  {
    id: 'api',
    triggers: /\b(api|endpoint|route|handler|rest|graphql)\b/i,
    question: 'Any API conventions your agent should follow?',
    ack: 'Saved. That will shape how it builds endpoints.'
  },
  {
    id: 'deploy',
    triggers: /\b(deploy|build|ci|release|pipeline|vercel|netlify|docker)\b/i,
    question: 'Where does this deploy, and any gotchas to know?',
    ack: 'Noted for future runs.'
  },
  {
    id: 'test',
    triggers: /\b(test|tests|spec|e2e|jest|vitest|pytest)\b/i,
    question: 'How do you want tests written, and anything to skip?',
    ack: 'Got it.'
  },
  {
    id: 'style',
    triggers: /\b(style|css|ui|component|design|tailwind|layout)\b/i,
    question: 'Any design system or styling rules to follow?',
    ack: 'Saved. It will respect that going forward.'
  },
  {
    id: 'refactor',
    triggers: /\b(refactor|cleanup|clean[- ]?up|migrate|rewrite|rename)\b/i,
    question: 'Anything your agent should avoid changing while it refactors?',
    ack: 'Noted, it will steer clear of that.'
  }
];

// No keyword match → ONE soft opener, never two invented ones (flow §03 step 2).
export const SOFT_OPENER: Ask = {
  id: 'opener',
  triggers: /$^/,
  question: 'Anything your agent should know before it digs in?',
  ack: 'Got it, saved.'
};

/**
 * Questions for the current task. Never more than `max` (handoff §2: never more
 * than 2). No prompt at all → nothing to ask: silence is a feature, and the
 * cold state shows no questions by design.
 */
export function pickAsks(prompt: string, max = 2): Ask[] {
  if (!prompt.trim()) { return []; }
  const hits = ASKS.filter((a) => a.triggers.test(prompt));
  return hits.length ? hits.slice(0, max) : [SOFT_OPENER];
}

// ---------------------------------------------------------- the reply model
// Handoff §5: [honest ack, keyword-echoed if possible] + [soft optional door].

/** A — honest, never fakes understanding. Rotates so it doesn't feel canned. */
const ACKS = ['Saved.', 'Got it.', 'Noted.', 'Added.'];

/** C — the soft door. An optional invitation, never a forced question, never
 *  a dead end. Rotates too. */
const DOORS = [
  'Add anything else, or you’re set.',
  'Anything more? Otherwise you’re good.',
  'Keep going, or leave it there.',
  'That’s in. Add more whenever.'
];

/** B — reflect a term that is ACTUALLY in the user's text. Never fabricates
 *  comprehension: no match means we fall back to A rather than guess. */
const ECHOES: { re: RegExp; term: string }[] = [
  { re: /supabase/i, term: 'the Supabase detail' },
  { re: /firebase/i, term: 'the Firebase note' },
  { re: /\b(pnpm|npm|yarn|bun)\b/i, term: 'your package manager' },
  { re: /vercel|netlify|deploy/i, term: 'the deploy note' },
  { re: /auth|login|session/i, term: 'the auth note' },
  { re: /test|spec|e2e/i, term: 'the testing note' },
  { re: /snake_case|camelcase|naming/i, term: 'the naming rule' },
  { re: /typescript|\bts\b/i, term: 'the TypeScript note' },
  { re: /tailwind|css|styl/i, term: 'the styling note' },
  { re: /\bapi\b|endpoint|route/i, term: 'the API note' },
  { re: /postgres|\bsql\b|schema|migration|table|quer/i, term: 'the database note' }
];

let ackStep = 0;
let doorStep = 0;

/**
 * The whole reply, in one place. Level 2a replaces the body of this function
 * with a model call (falling back to this when it is slow) — the extension and
 * the webview both stay exactly as they are.
 *
 * @param text        what the user actually typed
 * @param answeringId the ask they clicked before typing, if any. Free-typing
 *                    instead of answering is valid (flow §06 behaviour 3): it
 *                    gets a neutral ack and is never re-asked.
 */
export function buildReply(text: string, answeringId?: string): string {
  const answering = answeringId
    ? [...ASKS, SOFT_OPENER].find((a) => a.id === answeringId)
    : undefined;

  let ack: string;
  if (answering) {
    ack = answering.ack;                       // they answered THAT question
  } else {
    const echo = ECHOES.find((e) => e.re.test(text));
    ack = echo ? `Noted ${echo.term}.` : ACKS[ackStep++ % ACKS.length];
  }

  const door = DOORS[doorStep++ % DOORS.length];
  return `${ack} ${door}`;
}
