# Yield

## What this is
Yield turns Claude Code's working/"thinking" wait time into a moment to collect
context from the user. While Claude Code works on a task, a small non-blocking
panel appears in the editor. The user can optionally drop in context ("anything
I should know?"). What they enter is saved and injected into future Claude Code
turns, so the assistant gets progressively better tuned to the user and project.
Everyone else tries to hide/mask agent wait time; Yield treats it as prime real
estate for making the AI smarter about you.

The name: yield = to give way / pause (the wait) AND what you produce / the
return (the payoff). The pause and the worth, in one word. (Bonus: `yield` is
also the keyword that means "pause and hand back a value" — same idea again.)

## Two layers (important)
- Shell: the IDE (VS Code / Cursor / Antigravity — all VS Code forks). Our
  extension installs into any of them.
- Agent: Claude Code. It emits the lifecycle hooks we depend on. Yield rides
  Claude Code's lifecycle in whatever shell it runs. It does NOT hook the IDE's
  own native agent.

## Phase 0/1/2 findings (confirmed)

Hooks (Phase 0) — empirically verified on Claude Code v2.1.153, both wires
proven working via a detached local listener on 127.0.0.1.
- The prompt text arrives in the `prompt` field, NOT `user_input` — the docs are
  wrong for v2.1.153. Anything reading the user's prompt must use `prompt`.
- Hooks snapshot at session start; a newly-installed hook needs a session
  restart to activate. Consequence: installing Yield will not affect the session
  that installs it — onboarding needs a "restart to activate" nudge.
- `suppressOutput: true` hides the injected context from the transcript while
  still feeding it to Claude. Wanted in Phase 3/4 so injection is invisible.

Shell / install (Phase 1) — verified on Antigravity IDE 1.107.0 (VS Code base).
- F5 / the Extension Development Host does NOT work in Antigravity (fork quirk).
  Do not rely on it. The dev-test loop is: rebuild .vsix → install via UI →
  reload → check.
- The `antigravity-ide --install-extension` CLI is not just cosmetically crashy
  (antigravityAnalytics not registered / v8 fatal) — it can CORRUPT Antigravity's
  extension registry: it marks the extension `.obsolete` without deleting it and
  fails to register it, leaving a "Cannot read the extension" half-install.
  HARD RULE: install via UI only — Extensions view (Cmd+Shift+X) → "..." menu →
  "Install from VSIX...". Never the CLI, here or in any user-facing install
  instructions. If a half-install happens, clean it: remove the stale extension
  folder in `~/.antigravity-ide/extensions/` AND its entry in that directory's
  `.obsolete` file, then reinstall fresh.
- Iteration rhythm for Phases 2-4: every extension change = rebuild .vsix +
  reinstall via the VSIX UI + reload window.

Trigger seam (Phase 2) — confirmed live end to end.
- `UserPromptSubmit` drives WORKING, `Stop` drives DONE. Sending a Claude Code
  prompt walks the panel through IDLE → WORKING → DONE → IDLE, with the hook
  payload reaching the extension's listener and the prompt text arriving in the
  `prompt` field as expected.
- The listener now lives INSIDE the extension: it starts on activate and binds
  127.0.0.1:41777, and it persists — the throwaway Phase 0 spike server is gone.

## Architecture (3 pieces)
1. Trigger + injection — ONE HTTP hook does both jobs, not two mechanisms. The
   plugin ships a UserPromptSubmit HTTP hook: a single round-trip that notifies
   the extension work is starting (→ open panel) AND carries the injected
   context back in its response body. A second hook, Stop, signals work done
   (→ close panel). HTTP hooks POST event JSON to a localhost port.
2. Panel — a VS Code extension hosting a webview (the crafted, non-blocking
   wait window). The extension also runs the local HTTP listener that receives
   the hook POSTs, and owns the context store.
3. Memory — user input is written to a local file. There is no separate
   injection step: on the next UserPromptSubmit, the extension reads the store
   and returns it as `additionalContext` in the hook reply. A 2xx JSON response
   is parsed like command-hook output, so one request/response both triggers the
   panel and lands the context. Payoff is shown to the user ("used what you told
   me").

## The context file format (v1.1) — a brief, not a log
`src/store.ts` owns the format; it is pure and dependency-free like gate/questions/ports.
- **The prompt is NEVER written.** The old format paired every note with the
  full prompt verbatim, so the file was ~95% transcript and all of it was
  injected every run. `Task:` is gone, and so are per-note timestamps.
- **A FIXED set of nine headings**, in this order: Project, Architecture,
  Commands, Conventions, Design, Avoid, Workflow, Gotchas, Notes. Never invent
  one outside `SECTIONS`.
- **Empty sections do not exist in the file.** The structure lives in
  `SECTIONS`; a heading only materialises when something is filed under it, and
  it is placed in SECTIONS order, not the order sections happened to be filled.
- **Everything goes to `## Notes` for now.** Automatic placement swaps
  `DEFAULT_SECTION` for a classifier and nothing else in store.ts moves — that
  is the whole reason the structure exists ahead of the placement logic.
- **Parsing is LOSSLESS.** `parse()` keeps raw lines per block, so a
  hand-edited file comes back byte-identical apart from the inserted bullet —
  the user's own headings and prose included. Verified by diffing a hand-written
  file against the result.
- **The header never mentions Yield.** Someone opening the file cold should
  understand it with no other context: standing instructions, later entries win.
- **Writes are atomic** (`writeAtomic`: temp file then rename), so a crash
  cannot leave a half-written brief.
- **Legacy files are archived, not converted** — `yield-context-archive-<date>.md`.
  The old content was bookkeeping; nothing the user wrote is ever destroyed.
- The one byte we add to what was typed: a multi-line note keeps its newlines
  but indents continuations two spaces so it stays one bullet.
- Verified by `scratchpad/store-format.js` (45/45) against the compiled build.

## Phase 3 design — the memory store
- Yield owns its OWN file: `.yield/yield-context.md` in the project. It NEVER reads
  or writes the user's CLAUDE.md. The store is created on first save (dir and
  file), seeded with a short header explaining what it is.
- Every entry pairs the user's NOTE with the TASK they were doing — the most
  recent `prompt` text seen on UserPromptSubmit. Appended newest at bottom:
    ## <timestamp> — <first ~60 chars of the task>
    **Task:** <prompt text>
    **Note:** <what the user typed>
  If no prompt has been seen yet this session, the task is `(none yet)`.
- The composer is typeable at ANY state (IDLE or WORKING), not just during a
  wait. Enter saves and clears; the box stays put for the next note. Each save
  logs `saved: <note>` to the Yield output channel and flashes the footer.
- The UI says `yield-context.md`; on disk it is `.yield/yield-context.md`
  (handoff §3/§7 is authoritative on the filename).
- Injection rides the SAME UserPromptSubmit round-trip that drives WORKING: the
  listener reads `.yield/yield-context.md` and returns it as
  `hookSpecificOutput.additionalContext` (with `suppressOutput: true`) in the
  2xx JSON reply. No separate injection mechanism. Empty/missing store → `{}`
  and a "no stored context to inject yet" log line.
- Store root = the extension's first workspace folder, falling back to the
  `cwd` reported by the hook payload if the window has no folder open.

## Phase 3 known simplifications — fix in later phases
Deliberate dumbness. The point of Phase 3 is only to prove the loop closes;
these are the improvements NOT to lose:
- (a) Distill the prompt into "what the task was really about" instead of
  storing it verbatim.
- (b) Merge / dedupe / resolve contradictions between entries.
- (c) Optionally enrich the task with what actually changed (files touched,
  what Claude did) — not just what was asked.
- (d) A persistence/legibility model that keeps the file a readable, living
  project-memory doc: lean, no append-only bloat, editable and clearable from
  the panel.

## The loop
Send task → UserPromptSubmit → panel slides in → user optionally adds context
→ Stop → panel shows "saved" → next task → stored context injected → Claude
visibly smarter.

## Build principle
Prove the plumbing before polishing. The risk is in the wires (do hooks reach
the extension? does injection land?), not the visuals. Build ugly-but-working,
validate every seam, then invest in craft.

## Phases
- Phase 0 (spike): prove the two wires — HTTP hook reaches a local listener,
  and UserPromptSubmit injection lands in Claude's view. Throwaway. ✅ DONE
  (see "Phase 0 findings" above; spike torn down)
- Phase 1: scaffold both halves empty — extension opens a blank docked panel;
  plugin hook fires and logs. ✅ DONE (panel installs, opens as a movable
  editor-area tab, docks anywhere)
- Phase 2: connect the wire — task → hook → panel reacts live (ugly); Stop →
  panel reacts. Trigger seam proven end to end. ✅ DONE (IDLE → WORKING → DONE
  → IDLE driven live; listener now in-extension on 127.0.0.1:41777)
- Phase 3: close the memory loop — note saved to `.yield/yield-context.md` →
  next task injects it → the agent demonstrably acts on it. ✅ DONE and VERIFIED
  LIVE — the BANANA smoke test (a note saved in one turn changed the agent's
  behaviour in the next) proved capture → file → injection → agent end to end.
- Phase 4: craft. Driven by YIELD-BUILD-HANDOFF.md and run as the A–E track
  below — the design is locked at mock v77. ✅ DONE (A–E all built and checked).
- Phase 5 (optional): make the question smart via a free-tier model. This is
  the handoff's Level 2a; 2b (file-based project detection) likely lands first.
  ← NEXT, and post-v1. See "Deferred past v1" below for the full list.

**v1 is complete.** Every phase above is built and verified; the loop closes on
a real clock. Packaged as `yield-0.1.0.vsix`.

## Phase 4 build track (handoff §9) — A through E
The visual design is LOCKED at `design/yield-panel-mock-v77.html`. The spec is
YIELD-BUILD-HANDOFF.md; behaviour references are the state model and the
conversational flow. Ported design lives in `media/` (panel.html + panel.css +
panel.js + self-hosted Geist woff2 + yield-logo.svg); reference docs live in
`design/` and are excluded from the VSIX.
- Phase A: static webview shell — exact tokens, self-hosted Geist Sans/Mono,
  logo, returning-state layout. ✅ DONE (measured against §1: card 400/r16,
  h1 19px/600/-.02em, mono footer, mark 52/r13).
- Phase B: the three states — cold / with-context / returning, copy system
  wired. ✅ DONE. The extension DERIVES the state and pushes
  it; the webview is a pure renderer that owns no state.
- Phase C: chat mechanics + motion — rolling stack, only 2 visible, msgin /
  fadeup, native smooth scroll, typewriter. ✅ DONE (verified on a real clock:
  older pair carries `fadeup`, live pair doesn't; scrollTop 0 reaches the first
  message; pin lands exactly at max scroll).
- Phase D: scripted reply engine (§5) + the four safety behaviours. ✅ DONE
  (footer + Saved flash from §6 were already live from B/C).
- Phase E: full hook wiring — status chip from the lifecycle, CURRENT_PROMPT
  from `prompt`, save + inject against `.yield/yield-context.md`, and the panel's
  own controls. ✅ DONE (17/17 lifecycle checks against the compiled build; see
  "Phase E — what the wiring audit found" below).

### State derivation (Phase B, built)
- `returning` — the store has ≥1 note. Descriptor HIDDEN: they know the
  mechanism, so don't re-teach it.
- `with-context` — no notes yet, but a live task to key questions off.
- `cold` — no notes and no task signal. NO questions at all (nothing legit to
  ask; silence is a feature) and the taller two-line composer.
- Questions come from `src/questions.ts` — a trigger → question → ack DATA
  table (flow §04/§08), never branching code, so Level 2a swaps "pick from the
  list" for "ask the model" without touching the UI. Never more than 2, one
  line each; no keyword match → ONE soft opener.

### Phase D — where the reply lives, and why
- `buildReply()` in `src/questions.ts` composes [honest ack (+keyword echo when
  the term is genuinely present)] + [soft optional door], per handoff §5. Acks
  and doors rotate so they never feel canned.
- It runs in the EXTENSION, not the webview. The webview posts the note and
  receives a finished `reply` string; it only decides when it lands (a ~520ms
  beat, minus however long the write took) and types it out. That is the whole
  point of §08: Level 2a replaces the body of `buildReply` with a model call —
  falling back to the script when slow — and neither the extension's flow nor
  the webview changes at all.
- An ack is only used for a question the user ACTUALLY took up: clicking a row
  sets `answering: <ask id>`, free-typing leaves it null and gets the neutral
  echo/generic path.

### The four safety behaviours (flow §06) — where each one lives
1. Nothing relevant to ask → `pickAsks` returns [] for an empty prompt, and the
   cold state never shows rows. Silence is a feature.
2. Skipped/ignored → `src/gate.ts`, a pure testable unit. A ROUND is one wait
   (opens on UserPromptSubmit, judged on the next). Three consecutive rounds
   where rows were offered and met with total silence mute questions for the
   session. Any engagement resets the counter; rounds where nothing was offered
   never count. NOTE: the locked design has no skip control, so "skipped" can
   only mean silence — don't invent a skip button to satisfy this rule.
3. Free-typing instead of answering → accepted and saved normally with a
   neutral ack, and never re-asked: rows give way to the stream once the
   conversation starts, and `answering` is null.
4. Interrupted mid-answer → the draft survives. `applyRender` touches the card
   class, status, questions and footer, and NEVER `input.value`. Verified: a
   half-written note survived a render that flipped the agent to Idle.

### Decisions taken during the port (resolved, don't relitigate)
- Store filename: `.yield/yield-context.md`. The handoff is authoritative.
- Voice is agent-neutral everywhere — "your agent", "Agent is working", never
  "Claude". The mock's "Claude" strings were an artifact that slipped through;
  this also governs the question copy in `src/questions.ts`.
- The stream uses handoff §4's both-edge fade mask + native smooth scroll, NOT
  v77's older top-only mask with `overflow:hidden`. §4 wins.
- Light-only for now; every colour is a token on `:root` so a dark set can drop
  in. Follow-editor-theme stays open (§10).
- Narrow docks (<400px of card width) clip the two-line placeholder and wrap
  the status chip. KNOWN and deferred to Phase C/4 — the composition was drawn
  at 400.
- Composer Enter → save was pulled forward into A/B (with the footer's Saved
  flash) so the capture loop stays testable before the Phase C chat exists.
- The footer shows the REAL note count (0 → `yield-context.md`, then `1 note`,
  `N notes`), counted from `**Note:**` lines so a hand-edited store stays
  accurate. A Saved flash settles to the new count.

### The chat became a scrolling stack (v1.3.0) — supersedes the 2-message window
The fixed 132px window over the last 2 messages is gone. There is now ONE
scrollable column holding the header and every message.
- **The header is the first item IN the column**, not chrome above it. It
  scrolls away and comes back. `.centre` moved inside `.stream .inner`, so the
  stream owns the horizontal inset and `.centre`'s own padding dropped to 0.
- **The top mask only exists once scrolled** (`.stream.scrolled`). Without that
  the opening state would show a dimmed logo, which the old layout never did.
- **`fadeup` is gone.** Nothing leaves the stack, so the dissolve is written
  from scroll position in `dissolve()` — blur/opacity/scale straight onto the
  node, no transition, so it tracks the finger. Same language as the old exit
  animation, driven by scroll instead of by a message leaving.
- **Auto-pin only when already at the bottom.** `stick` is the state; a message
  arriving while the user reads history shows the `.newmsg` pill instead of
  yanking the view. The pill uses the send button's exact weights and the status
  chip's pill radius — no new token, no new colour.
- **`wasAtBottom` is captured BEFORE inserting**, because appending changes
  scrollHeight and asking afterwards misreports someone who was at the bottom.
- **Nothing dissolves until it has actually been scrolled PAST.** Distance from
  the top edge alone is not enough: at rest the first item sits ~6px from that
  edge, well inside the 78px band, so the HEADER came out blurred on a panel
  nobody had scrolled. `dissolve()` caps the effect by `scrollTop /
  DISSOLVE_BAND`, which makes it impossible at the top and ramps it in.
- **`dissolve()` runs straight from the scroll handler, not via rAF.** The
  browser already coalesces scroll to one event per frame, so the hop bought
  nothing and cost a frame of lag on an effect meant to track the finger. It
  also made the whole path invisible to the harness, since rAF does not fire
  under virtual time either — the bug above was live for a release because of
  exactly that.

### Testing the stack needs a real browser, and virtual time lies twice
`scratchpad/stack-behaviour.js` drives real Chrome against the shipped files.
Two harness artifacts cost real time and are worth knowing:
- **No scroll animation advances under `--virtual-time-budget`** — and because
  `scroll-behavior:smooth` animates even a direct `scrollTop` assignment, every
  pin read as "never scrolled". The harness forces `scroll-behavior:auto` AND
  shims `scrollTo`; that smoothness is still declared is asserted from the
  stylesheet instead.
- **Scroll EVENTS are never delivered either.** `.scrolled` only appeared
  because `pin()` calls `onScroll()` itself. The harness dispatches the scroll
  event a real browser would.
- A real bug the Node stub caught that Chrome hid: `newmsg` was never declared,
  and worked in the browser ONLY because element ids are implicit globals. The
  stub has no such fallback. Declare every element handle explicitly.

### Motion: three named curves, and why there is no animation library
An audit found **19 of 22 transitions had no easing curve at all** — every
hover, the status dot, the send button, the question rows, the footer were all
on the browser's default `ease`. That, not a missing library, was why the panel
felt flat. `:root` now carries three curves chosen by intent:
- `--ease-out` `cubic-bezier(.16,1,.3,1)` — things ARRIVING. Hard start, long
  soft settle, so an entrance reads as expressive rather than mechanical.
- `--ease-move` `cubic-bezier(.4,0,.2,1)` — things TRAVELLING between two
  states. Symmetric, no overshoot.
- `--ease-ui` `cubic-bezier(.33,1,.68,1)` — small state changes (hover, colour,
  opacity). Quick out, so the panel answers the cursor immediately.

Every literal bezier was replaced by its token, so there is one source of truth.
Zero transitions are now uncurved (the only `transition:none` left are the
deliberate reduced-motion ones).

The dissolve ramp is eased too (`p = p * p`): a linear ramp starts softening
text that is still squarely in view, whereas quadratic ease-IN keeps the column
legible for most of the band and concentrates the dissolve at the edge.

NO ANIMATION LIBRARY. anime.js was considered and is not needed: everything in
the panel is a CSS transition or keyframe, where a curve is the whole answer.
The ONE thing CSS cannot express is the scroll tween — `scroll-behavior:smooth`
has a fixed browser easing — and that is ~20 lines of custom rAF if it is ever
wanted, not a runtime dependency in a zero-dependency project.

### Phase C deviations from v77's CSS (deliberate, keep them)
- `.stream .inner` is bottom-anchored by `margin-top:auto` on the first child,
  NOT `justify-content:flex-end`. With real overflow, flex-end pushes the top
  of the stack outside the scrollable area — history becomes unreachable.
- `.stream .inner` has 26px of BOTTOM padding to clear the §4 mask's bottom
  fade, so the newest message stays crisp while history still dissolves at both
  edges. Without it the message you most want to read is the one fading out.
- Messages that scroll out keep `fadeup` but the class is neutralised under
  `.stream.browsing`, so scrolled-back history is legible. Nodes never leave
  the DOM.

### Two traps this phase cost real time on — don't repeat them
- Headless Chrome with `--virtual-time-budget` FREEZES CSS animations that
  start after load: `msgin` sat at `currentTime=0`, so every message rendered
  at `opacity:0` and the panel looked broken. It is a harness artifact, not a
  bug. Verify motion over CDP on the real clock (`scratchpad/shot.js`) before
  believing a blank frame.
- Pin AFTER the message has its text. `pin()` reads `scrollHeight`, so pinning
  before setting `textContent` scrolls to a stale height and the newest message
  hangs below the window. Typed messages hid this because the typewriter
  re-pins per character; instant user messages did not.

### Phase E — what the wiring audit found (fixed, don't regress)
The hooks were already reaching the extension; what was broken was the panel's
FIRST FRAME, plus a handful of controls the mock had drawn but nothing had ever
wired.
- **The stale chip.** `{{cardClass}}` was painted server-side, so the dot went
  green — but the chip's LABEL was a hardcoded `Idle` in panel.html, and the
  seed `render()` fired immediately after assigning `webview.html`, before the
  webview had registered its message listener. That first push was dropped on
  the floor. Open the panel while the agent is working and you got a green dot
  reading "Idle", with no resync until the next hook. THE FIX IS THE HANDSHAKE:
  the webview posts `{type:'ready'}` once it can actually hear, and the
  extension answers with a full render. Never push state at a webview you have
  not heard from.
- **Everything the first frame paints now comes from the same helpers `render()`
  uses** — `statusLabel()`, `noteLabel()`, `cardClass()` — so the opening frame
  cannot disagree with itself. `{{statusLabel}}` and `{{footerLabel}}` are
  substituted alongside `{{cardClass}}`.
- **The footer was showing `12 notes`** — the mock's invented figure, shipped
  verbatim in panel.html and only corrected if a render happened to land.
- **`{{wordmarkUri}}` was still being substituted** though the wordmark became
  inline SVG in Phase A; the asset preflight still checked a file the page no
  longer loads. Both gone. panel.html's placeholders and extension.ts's
  substitutions now match EXACTLY, which is a cheap thing to re-check.
- **Dead controls, now wired** (handoff §6: the file is the only history
  affordance, and "always visible, editable, clearable" is a stated constraint):
  the header file icon and the footer note-count both open the real
  `.yield/yield-context.md` in an editor tab, seeding it first if absent so the
  click is never a dead end; the close control disposes the panel.
- **The status chip is no longer a `<button>`.** In v77 it was a hand-toggle for
  demoing WORKING; here the hooks own that state, so a clickable-looking chip
  promised something it could not do. It is a `role="status"` readout now.
- **The mic is `disabled`** with an honest title. Voice is spec'd in the state
  model but is not in v1, and a live-looking control that does nothing is worse
  than one that says so.
- **`setState` logs the chip transition** (`chip: Idle → Agent is working`). The
  chip is the only part of the lifecycle a user can see, so the log says what it
  now READS, not just which state was entered. A run that logs WORKING with no
  `chip:` line is a render that did not land.
- Dead webview state removed: an unread `history[]` array (the DOM already is
  the scrollback) and an unused `PLACEHOLDER` const.

### How the lifecycle is verified
`scratchpad/chip-lifecycle.js` and `scratchpad/firstframe.js` drive
`out/extension.js` — the actual compiled build — with `vscode` and `http`
stubbed, feeding the real hook handler real payloads. They assert the chip
sequence across two consecutive runs, that the injection rides the same
round-trip, that saving mid-run does not disturb the chip (the two timelines are
independent, state model §01), and that a panel opened MID-RUN paints
"Agent is working" on its opening frame. 17/17 + 6/6. Re-run them after touching
the listener, `render()`, or panel.html's placeholders — they cost a second and
they catch exactly the class of bug Phase E was cleaning up.

## Deferred past v1 (logged on purpose — the roadmap, not a bug list)
Nothing here blocks v1; each is a deliberate cut.
- ~~2a — LLM replies~~ SHIPPED in v1.2.0, but NOT as originally planned: the
  ACKNOWLEDGMENT stays scripted (a model version is not worth 3s), and the
  QUESTION became the model's job. See "LLM questions" below.
- **2b — file-based project detection.** Read package.json / lockfiles for
  project-aware questions. No AI, cheap, and likely the next thing to land.
- **2c — deep codebase analysis.** The heavy one, much later.
- **The Phase 3 store simplifications (a)–(d) above** — distilling the prompt,
  merging/deduping entries, enriching with what actually changed, and a
  persistence model that keeps the file lean instead of append-only. The store
  is still deliberately dumb.
- **Dark theme / follow-editor-theme** (handoff §10). Light-only for now, but
  every colour is already a token on `:root`, so a dark set drops in.
- **Onboarding intro copy.** Exists in `yield-conversational-flow.html` §05,
  never wired into a mock or the panel. The state model has the first-run slot.
  Pairs with the "hooks snapshot at session start" nudge — installing Yield
  cannot affect the session that installs it, so onboarding must say "restart to
  activate".
- **Narrow-dock responsive.** Below ~400px of card width the two-line
  placeholder clips and the status chip wraps. The composition was drawn at 400.
- **Voice — BLOCKED AT THE PLATFORM LEVEL, next step is a spike.** Extension
  webviews have no `microphone` delegation in their iframe Permissions Policy and
  no extension option can add it, so capture can never happen in the panel. The
  open question is whether a binary SPAWNED BY THE EXTENSION HOST can capture at
  all inside Antigravity: macOS TCC attributes microphone access to the
  *responsible process*, so the grant would belong to the IDE, not to Yield.
  THE SPIKE MUST BE SPAWNED BY THE HOST, NOT RUN FROM A TERMINAL — a terminal
  test inherits Terminal's own TCC grant and proves nothing. Everything
  downstream (staged whisper binary, transcription, retry, the v78 states) is
  built and tested behind `VOICE_ENABLED`.
- **Cross-platform whisper binaries.** Currently arm64 macOS only, because that
  is what we compiled. The fix is DOWNLOADING prebuilt per-platform releases on
  demand, not compiling on the user's machine.
- **Cost, before anyone else installs this.** Once LLM-generated questions ship,
  Yield spends the user's own Claude quota on every note. Fine for personal use;
  it must be surfaced plainly before this goes to anyone else. Measured in the
  v1.1 spike: ~13,600 tokens and ~$0.007 per call via `claude -p` with haiku,
  because Claude Code's own system prompt rides along on every call.
- **A visible DONE beat.** The agent model has IDLE → WORKING → DONE → IDLE, but
  DONE currently renders identically to IDLE — the locked design has no DONE
  treatment, and state model §07 has Stop return straight to IDLE. The state
  exists (a 2s settle) if a "saved / here's what I used" payoff moment ever wants
  it.
- **Short/long-task polish** (state model §06): debounce the alive transition
  under ~400ms, and settle the ambient after ~30s. Not built.

## Voice — BUILT BUT OFF IN v1 (`VOICE_ENABLED = false`)
**It cannot work in this shell.** Extension webviews are hosted in an iframe
whose Permissions Policy grants only `cross-origin-isolated`, `autoplay`,
`local-network-access` and the clipboard — see where `allowRules` is built in
`…/app/out/vs/workbench/contrib/webview/browser/pre/index.html`. `microphone` is
never delegated, and NO webview option can add it (`allowScripts`,
`enableForms`, `enableCommandUris`, `portMapping` are the only knobs). That is
the VS Code webview model, not an Antigravity quirk, so it is the same in VS
Code and Cursor. `getUserMedia` can never succeed from the panel.

THE FLAG: `VOICE_ENABLED` in `src/whisper.ts`. It gates (a) the `voice`
capability extension.ts reports, so `runTranscription` refuses and no host-side
voice work runs, (b) the `no-voice` class painted onto the card, which hides the
mic from the first frame and rebalances the composer's right padding for one
button, and (c) the webview removing the mic node outright. v1.1 flips one
boolean. `scratchpad/flag-roundtrip.js` PROVES that: it flips the flag,
recompiles, and re-runs the full stage 2 + stage 3 suites (18/18 + 55/55) before
restoring.

The mic is REMOVED, not disabled — a permanently disabled control reads as
broken or coming-soon and it is neither. v1.1 most likely pairs the flag with a
native recorder spawned from the host, which has no permission policy over it.

Everything below is built and tested and stays in the tree. The
visual source of truth is `design/yield-panel-mock-v78.html` for the voice
states ONLY; v77 remains authoritative for everything else.

- **Why a subprocess, not a native binding.** The extension host is Electron's
  Node (24.x, ABI 137), never the Node that built anything locally (25.x, ABI
  141). An in-process N-API addon must match; a spawned Mach-O binary does not
  care. That is why `nodejs-whisper` (shells out) beat `smart-whisper` (N-API).
  nodejs-whisper is a devDependency that BUILDS whisper.cpp; at runtime
  `src/whisper.ts` spawns the staged binary directly, so none of its npm tree
  ships.
- **`scripts/stage-whisper.js` is not optional.** cmake bakes an ABSOLUTE
  LC_RPATH into the binary pointing at the build tree, so a copied binary cannot
  find its dylibs — and it fails only AFTER install, never on the build machine.
  The script dereferences the version symlinks (a VSIX is a zip), rewrites the
  rpath to `@loader_path`, and re-signs ad-hoc because Apple silicon kills a
  Mach-O whose signature you invalidated. Re-run it after any whisper.cpp
  rebuild. Only 6 dylibs are actually referenced; libparakeet is built but unused.
- **No ffmpeg, at build time or runtime.** `media/wav.js` decodes the recording
  with the Web Audio API and conditions it to 16 kHz mono in about a hundred
  lines. nodejs-whisper only reaches for ffmpeg when the input needs resampling,
  so handing it a file that is already 16 kHz means that path is never taken.
- **The 0.5s lead silence is load-bearing.** whisper drops the first word when a
  clip starts abruptly on speech — proven both ways on `scratchpad/audio/known.wav`
  ("quick brown fox…" unpadded, "The quick brown fox…" padded). Done in the
  BUFFER, not by starting the recorder early, which would depend on user timing.
- **One MediaStream, one permission, ONE AudioContext.** The AnalyserNode hangs
  off the same stream MediaRecorder uses, and the same context that visualises
  the recording then decodes it — two consumers in sequence, not two contexts.
  `releaseMic()` frees the mic the instant capture ends (so the OS indicator
  clears); `closeAudioContext()` runs only after the decode. Never call
  getUserMedia twice.
- **The voice and notice overlays must FILL the composer** (top/right/bottom/
  left:0, no fixed height) and the wave uses `align-self:stretch`. v78's original
  `inset:0` plus `height:64px` pinned them to the top and only looked centred
  because the composer happened to be exactly 64px. Measured centred at 66px and
  86px by `scratchpad/layout-check.js`, which drives real Chrome.
- **Light is the chosen surface** (`--muted` ground, `--border` at unchanged
  weight, `--fg` bars, stop button at the send button's exact weights). The dark
  variant exists only in the v78 mock for comparison and is deliberately NOT
  ported.
- **arm64 macOS only.** `checkVoiceSupport()` gates the mic BEFORE it is
  enabled, so everywhere else it stays visibly disabled wearing the real reason.
  Cross-platform prebuilts are v1.1.
- **First run costs ~15s** while macOS verifies the newly installed binaries
  (Gatekeeper/XProtect across 7 new Mach-O files) — NOT model load, which is
  ~70ms. A `.voice-verified` marker in the model cache is what lets the panel
  show "Preparing voice…" BEFORE that hang instead of after it. Steady state is
  0.26–0.5s for a few seconds of audio.
- **The transcript is a draft, never a save.** It appends to the composer (a
  half-typed note survives), and saving stays the user's deliberate act.
  Failures RETAIN the audio so Retry re-runs it without re-recording.
- Verified by `scratchpad/voice-pipeline.js` (18/18), `scratchpad/voice-states.js`
  (55/55), `scratchpad/voice-off.js` (29/29, the shipped config) and
  `scratchpad/layout-check.js` (18/18, real Chrome geometry) — all against the
  compiled build.
- **The dead mic click was a real defect**, now fixed: reaching straight for
  `navigator.mediaDevices.getUserMedia` throws a TypeError SYNCHRONOUSLY when
  `mediaDevices` is absent, before the promise exists, so the `.catch()` never
  attaches and the click dies in silence. Guard for it first and fail loudly.
- **No harness can catch a platform permission boundary it supplies itself.**
  The stage 3 suite stubbed `getUserMedia` as always-present and always-resolving
  and passed 55/55 while the feature could not work at all. Check the host's
  permission model BEFORE designing against a browser API.
- **Fixed in passing, a live v77 bug:** `.composer textarea` was inline-level, so
  it sat on a line box and the descender space left the composer's visual bottom
  padding 3px deeper than its top (69px tall instead of 66px). `display:block`
  fixes it; measured both ways.

## Ports: probe-and-claim (v1.6.0) — supersedes the v1.0.1 fix
v1 bound ONE fixed port (41777) from EVERY window, so five restored windows
raced for it and four went permanently deaf while looking perfectly healthy.
v1.0.1 derived a port per project and retried the bind forever. That still had
two holes: a 100-wide band gave a ~50% chance some pair of a dozen projects
collided, and a colliding window WAITED instead of working.

The model now is CLAIM, not wait. `src/ports.ts` stays pure and testable.
- **Bind first, never check first.** `tryBind()` calls `listen` and treats
  `EADDRINUSE` as "taken". Asking whether a port is free and then binding it is
  a race with itself; the bind IS the question.
- **`probeSequence()` walks the band** from the remembered port, then the hashed
  one, then upward, wrapping. The REMEMBERED port comes first
  (`workspaceState` key `yield.claimedPort`) because drifting would rewrite
  settings and demand a Claude Code restart on every launch.
- **The band is 1000 wide** (41800-42799), not 100. The birthday maths is the
  whole reason: every probe that lands elsewhere costs the user a restart, so
  the range exists to keep that rare rather than routine.
- **`PROBE_LIMIT = 40`.** Scanning the whole band would hang activation, and an
  honest "cannot hear the agent" beats a window that never finishes starting.
- **Settings are written AFTER the claim, never before.** `runSetup()` runs with
  the port actually bound, so the invariant `settings port == bound port` cannot
  be violated by a probe that moved.
- **The legacy port is gone.** 41777 is not bound, not special-cased, and
  appears nowhere in `src/`.

### Nothing ever gets stuck — the terminal states
Every wait is bounded and every outcome is a named state wearing its own honest
line. There is ONE retry loop left in the extension and it counts:
`MAX_CLAIM_ATTEMPTS = 5` at `CLAIM_RETRY_MS = 5000`, then it stops for good and
`listenerState` settles on `no-port`.

| state | line |
| --- | --- |
| `ok` | *(says nothing)* |
| `restart-needed` | Restart Claude Code to activate. |
| `no-claude` | Claude Code was not found, so Yield cannot see when your agent is working. |
| `no-workspace` | Open a folder to use Yield. It keeps your notes alongside the project. |
| `malformed` | Your Claude Code settings file could not be read, so nothing was changed. The path is in the Yield output. |
| `no-permission` | Yield could not write to your Claude Code settings. The path is in the Yield output. |
| `no-port` | Yield could not claim a port, so it cannot see when your agent is working. Your notes still save. Reload the window to try again. |

- **`no-port` outranks the setup state** in `setupNote()`: a window that cannot
  hear is not going to be helped by a restart line.
- **CAPTURE NEVER DEPENDS ON THE LISTENER.** Notes save during the retries and
  after giving up — proven in the suite, not asserted. The port only carries the
  agent's lifecycle; the store is local file I/O and has nothing to do with it.
- The chip still says `Not hearing the agent` with a HOLLOW dot
  (`.card.deaf .sdot`, no new colour) whenever `isListening()` is false.
- **Route by `cwd`.** `isOurs(cwd)` gates whether the chip reacts, so another
  project's run never moves this panel. Injection independently serves the
  CALLER's store (`readStoreAt`) — injecting one project's notes into another
  project's session is worse than injecting nothing.
- **`retargetHooks()` rewrites only Yield's own 127.0.0.1 `/hook` entries**,
  preserving indentation, unrelated settings, command hooks and foreign http
  hooks. Hooks snapshot at session start, so a rewrite says RESTART CLAUDE CODE.
- Verified by `scratchpad/port-claim.js` (32/32) on REAL sockets — two colliding
  projects both listening and both reacting to their own prompts, the
  settings==bound invariant, port memory across relaunch, probing past a
  squatter, and the all-ports-taken terminal state with notes still saving.
  `scratchpad/listener.js` (20/20) keeps the routing and retarget coverage; its
  wait-for-the-holder sections are gone with the behaviour they tested.
- **A stub server must set `.listening`.** `isListening()` reads it the way a
  real `http.Server` does, and two harnesses that never set it read as deaf and
  failed 6 checks against perfectly good code.

## LLM questions (v1.2.0) — `src/ask.ts`
The question is generated by the user's OWN already-authenticated Claude Code
CLI, spawned headless. No API key, no signup, no new dependency; Yield never
sees a credential. Acknowledgments stay SCRIPTED and instant.

- **THE LOOP IS THE WHOLE DANGER.** Yield's own UserPromptSubmit hook fires for
  any `claude -p` started inside the project — measured: 1/1 hook fires from the
  project cwd, chip flickering each time. Three layers stop it now:
  NEUTRAL CWD (the real prevention: hooks load from the cwd, so a directory
  outside every project loads none), the existing `isOurs(cwd)` foreign-project
  rejection, and the SENTINEL in the prompt. `--settings` pointing at an empty
  file does NOT work — project hooks still load. Proven from the REAL extension
  host's environment, and with a temporary global hook installed, by
  `scratchpad/loop-guard.js` (18/18).
- **`MAX_THINKING_TOKENS=0` is the single biggest win**: without it haiku emits
  ~2,000 thinking tokens for a one-line answer and the call takes 19-43s. With
  it, ~30 tokens and ~2.9s.
- **`< /dev/null`** — the CLI otherwise waits 3s for stdin that never comes.
- **`--strict-mcp-config` is NOT load-bearing** (20,982 tokens without vs 20,728
  with). Kept as cheap insurance. cwd is the whole isolation story.
- **THREE OUTCOMES, deliberately distinct.** `question` → show it. `silent`
  (the model returned NONE) → show NOTHING; that is a designed feature and must
  never be papered over with a canned line. `failed` (missing CLI, timeout,
  unauthenticated, network) → fall back to the SCRIPTED question, silently;
  there was a real reason to ask. NEVER prompt anyone to log in.
- **GATE BEFORE SPAWNING.** `mayGenerate()` checks the panel is open and the
  gate is not muted BEFORE the call, so an ignoring user costs zero model calls
  (~$8/month of otherwise wasted generations).
- **Cache key is task + note count + store length**, so a new task or ANY edit
  to the file — including a hand-edit — invalidates it, while panel
  close/reopen within one run does not.
- **A pending generation shows nothing**, not the scripted question, so the
  question never visibly swaps out from under someone mid-read.
- **Timeout 4500ms with SIGKILL.** Network failures do NOT fail fast:
  connection-refused hung past 45s in the spike.
- **Phrasing rotates deterministically**, not by asking the model for variety.
  The ending advances once per full cycle of openings — a stride inside the same
  modulus would leave both indices functions of `i mod 4`, so the PAIR would
  still repeat every 4. 16 distinct pairings.
- **The noun-phrase constraint is what fixed the word budget.** Longer openings
  ("Might be worth noting") invite a `that…` clause, which turns an offer into a
  statement and blew the budget to 15-24 words. Forcing OPENING + short noun
  phrase + ENDING gave 10/10 within 10-16 words, range 11-15.
- **No parentheses, no listed examples** — 9 of 10 reached for "(A, B, C)"
  otherwise, which is exactly what a nowrap row ellipsizes away.
- Cost ~13,600 tokens and ~$0.007 per call; a 50-note file adds only ~800.
- Verified by `scratchpad/llm-gating.js` (42/42, stubbed CLI) and
  `scratchpad/llm-tone.js` (real model, raw output for reading).

## Self-installing hooks (v1.4.0) — `src/hooks.ts`
Yield is useless without its hooks, so installing the extension IS the setup.
Nothing is asked, nothing is announced, no confirmation dialog.
- **PROJECT-LEVEL, not `~/.claude/settings.json`.** The port is derived from the
  workspace path, so each project needs its own hook URL; one user-level hook
  can only carry one port, which would drag back the single-port race that made
  windows silently deaf. It is also the narrower blast radius.
- **Merge, never overwrite.** Our hooks go in as their OWN group, so a user's
  existing UserPromptSubmit/Stop hooks, matchers and unrelated events survive
  untouched. Verified against a settings file carrying command hooks, a matcher
  and unrelated keys.
- **Detection is a field lookup**, never a match on the whole block:
  `statusMessage: 'yield'` OR a loopback `/hook` URL. Idempotent — a second run
  updates in place rather than duplicating.
- **Malformed JSON is never repaired.** We refuse to write, name the path, and
  leave their file byte-for-byte intact. Silently rewriting someone's config is
  worse than not working.
- **A backup is written before every change** (`settings.json.yield-backup`),
  and restoring it returns the original exactly.
- **THE RESTART LINE IS NARROW ON PURPOSE.** It shows only when WE installed the
  hooks during THIS session and no hook has fired yet — i.e. someone who had
  Claude Code already running. Anyone who installs and then opens Claude Code
  never sees it. `hookEverFired` retires it permanently on the first hook.
- Six states, each with its own honest line: ok (says nothing), restart-needed,
  no-claude, no-workspace, malformed, no-permission.
- **`findClaude()` spawns nothing** — it scans PATH under each platform's naming
  plus `~/.local/bin`, `~/.claude/local`, and accepts `~/.claude` as evidence.
  Deliberately generous: a false "not installed" is worse than staying quiet.
- `Yield: Install hooks` is RECOVERY ONLY, for someone who hit an error or wiped
  their settings. It is the only path that announces anything.
- **`render()` now no-ops until the webview says `ready`.** Setup finishes
  asynchronously and would otherwise push into a still-loading panel. Phase E's
  rule is structural now rather than incidental.
- Verified by `scratchpad/setup.js` (53/53), including the panel line appearing
  and disappearing through the compiled build.

## Public-release settings (v1.5.0)
- **`yield.smartSuggestions`**, ON by default. Read FRESH on every call
  (`smartSuggestions()`), never cached, so the toggle takes effect on the next
  call with no reload. Checked FIRST in `mayGenerate()`, so OFF means no
  subprocess is ever spawned — not a call discarded later. `onDidChangeConfiguration`
  clears `cachedAsk` and re-renders, so the panel swaps between the generated and
  the scripted question on the spot.
- **With it off, the scripted question is the product, not a degraded mode.**
  `currentAsks()` returns `pickAsks()` directly, exactly as v1 did.
- **`.yield/` goes into .gitignore on first run** (`src/ignore.ts`), silently.
  THE RULE: if the user removes that line it NEVER comes back — removing it is
  how a team opts into sharing context. Driven by a `workspaceState` flag
  (`yield.gitignoreWritten`), NOT by whether the line is currently present;
  re-deriving it would undo their decision on the next activation. Non-git
  folders are left completely alone.
- **The whisper runtime is excluded from the VSIX** (`bin/whisper/**` in
  .vscodeignore). It stays in the repo behind VOICE_ENABLED. Packaged size went
  1.40 MB -> 150 KB. The packaged extension was verified to activate cleanly with
  no binary present.
- Verified by `scratchpad/settings-ignore.js` (30/30).

## Cross-platform correctness (v1.7.0)
Everything below was found by auditing before the first public release. macOS
and Linux were already fine; Windows was where the exposure was, and none of it
is provable here — the logic is tested with injected platform values, the
syscalls are not.
- **`underRoot()` in `src/ports.ts` owns the route-by-cwd comparison**, not
  `isOurs`. It lives there because it is platform-sensitive and worth testing
  without a `vscode` stub.
- **WINDOWS IS NOT A BYTE COMPARE.** `Uri.fsPath` normalises the drive letter to
  lower-case (documented in `@types/vscode`), while the hook's cwd arrives raw
  from the agent's `process.cwd()` and does not. `c:\...` vs `C:\...` made
  `isOurs` false for EVERY hook the window owned: chip stuck on Idle,
  `lastPrompt` never set so generation died at `mayGenerate`, `hookEverFired`
  never flipped so the restart line never retired. Injection and capture still
  worked, so it looked healthy and was completely deaf.
- **POSIX STAYS CASE-SENSITIVE.** `/tmp/A` and `/tmp/a` are different projects.
  A normalisation that made everything match would be worse than the bug, and
  the foreign-project rejection is load-bearing for the loop guard.
- **`launchSpec()` in `src/ask.ts` decides how the CLI is launched.**
  CreateProcess cannot execute a `.cmd`, and the npm install on Windows IS
  `claude.cmd` — that is why the bare `spawn('claude')` ENOENTed there and smart
  suggestions fell back silently forever.
- **NOT `shell: true`.** The prompt is raw user text plus the whole context
  file, so a shell would make one `&` in a note a command. A `.cmd`/`.bat` goes
  through `cmd.exe /d /s /c` with every argument escaped for BOTH
  CommandLineToArgvW and cmd.exe, passed `windowsVerbatimArguments`. `.exe` and
  every POSIX binary spawn directly, unchanged.
- **`findClaude()` probes `claude.exe` FIRST** so the common Windows case needs
  no cmd.exe at all.
- **`findClaude()` can return a DIRECTORY** (`~/.claude`, accepted as evidence).
  `usableBinary()` stats it and drops anything that is not an executable file;
  undefined falls back to the bare name, i.e. exactly v1 behaviour.
- **`YIELD_CLAUDE_BIN` OUTRANKS the detected path.** Passing the detected
  binary first silently broke the documented user override — caught by
  llm-gating going 49/64.

## The follow-up answers the note (v1.8.0)
- **The note is the PRIMARY input**, not the task. `QuestionRequest.note`
  switches `buildSystemPrompt` to a note framing ("GO DEEPER ON WHAT THEY JUST
  WROTE… do NOT change the subject") and `buildUserPrompt` appends it LAST under
  `RESPOND TO THIS`. Putting it above the task made the model answer the task.
- **Only the framing differs between modes.** The three-part shape, the 16-word
  limit, the no-parentheses and one-hedge rules are shared — asserted in the
  suite, because a second voice would show.
- **THE SOFT DOOR IS GONE from `buildReply`** — a deliberate deviation from
  handoff §5, see the comment there. Message 2 does the inviting now, and
  keeping both put the vaguer invitation first.
- **`looksLikeMash()` gates before the spawn.** DELIBERATELY TOO CAUTIOUS: any
  whitespace, under 5 chars, `y` as a vowel, ALL CAPS — every rule is a reason
  to say no, because a wrong verdict silences a real note while a wrong
  suggestion costs nothing. It catches 11 of 18 real mash samples and zero real
  notes; the ones it lets through contain a vowel, by design.
- **`followUp()` now LOGS why it stayed quiet.** It used to return silently on
  `!mayGenerate()`, which made three of the four causes invisible in the Output
  channel and cost a whole diagnosis round.

### CANDIDATE FOR REVISITING — the per-round cap is tuned for short waits
NOT a bug and NOT changed. `MAX_SUGGESTIONS_PER_ROUND = 2` resets only on
`UserPromptSubmit`, so on a long turn — minutes, several notes written into one
wait — the third note onward gets the bare ack and nothing else. That is what
sent us looking for a broken follow-up when nothing was broken.

The original rule was "never a CHAIN", meaning never talk at someone who is not
answering. A suggestion following each note the USER initiated is not a chain in
that sense: they spoke first every time. Worth revisiting whether the budget
should be per-note-with-engagement rather than per-wait. Left alone for now
because the back-off it belongs to is what stops the panel being needy.

## Constraints
- No paid services. Everything runs locally and free. If model calls are needed
  later (Phase 5), use free tiers only (Gemini free / OpenRouter free).
- Legibility/consent is a feature, not a footnote: the store is always visible,
  editable, clearable.

## v1 scope — SHIPPED
Everything real except the "smart question". Channel, storage, injection, panel
and payoff loop are all genuinely wired and verified.

The one stub is the question/reply engine, and it is less stubbed than planned:
`src/questions.ts` is a real keyword → question → ack table (7 triggers plus a
soft opener) with a rotating ack/echo/door reply model, not a placeholder
string. It is scripted, not smart — that is 2a, and swapping it does not touch
the extension flow or the webview.
