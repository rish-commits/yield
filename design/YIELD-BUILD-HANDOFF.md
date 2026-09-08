# YIELD — BUILD HANDOFF (Phase 4 — real extension)

This is the single source of truth for porting the designed panel into the real VS Code / Claude Code extension webview. The visual design is **locked** (mock `yield-panel-mock-v77.html`). This doc captures everything the mock does NOT show: the *why*, the behavior rules, the integration wiring, and the build gotchas.

**Read alongside these files (put all in the project):**
- `yield-panel-mock-v77.html` — visual source of truth (exact CSS/HTML/motion)
- `yield-state-model.html` — agent/user timeline behavior + collision rules
- `yield-conversational-flow.html` — scripted chat blueprint (questions, acks, safety behaviors, LLM upgrade path)
- `yield-logo.svg` — the vector logo (frame removed, crisp at all sizes)

---

## 0. WHAT YIELD IS (one paragraph, so context is never lost)

Yield is a docked VS Code / Claude Code panel that turns agent wait-time into context capture. While the agent works, the user types (or speaks) context; it's saved to `.yield/yield-context.md` and injected into future agent runs via the Claude Code hook system, so the agent matures on the project. The panel is a *nicer way to write to that file*. **Notes are the product; the chat is a disposable funnel; the file is the history.**

---

## 1. DESIGN TOKENS (exact, from v77)

```css
/* spacing — 8pt grid */
--s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px; --s8:32px; --s10:40px;

/* type scale */
--t-xs:11px; --t-sm:12px; --t-base:12.5px; --t-md:13.5px; --t-lg:19px;

/* color (LIGHT mode) */
--bg:#f4f4f5; --card:#fff; --muted:#f4f4f5; --muted-2:#e4e4e7;
--border:rgba(0,0,0,.08); --border-2:rgba(0,0,0,.13);
--fg:#18181b; --mfg:#52525b; --mfg-2:#a1a1aa; --ring:rgba(0,0,0,.22);
--green:#22c55e;

/* type families */
--sans:'Geist','Geist Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
--mono:'Geist Mono',ui-monospace,monospace;
```

**Font rule:** Geist Sans = normal/reading text (headlines, chat replies, questions, input/placeholder, status). Geist Mono = technical text (the descriptor line, `yield-context.md` filename, note-count, keyboard hints, labels). Geist is open-source (Vercel) — self-host the woff2 files in the extension; don't rely on a CDN.

**Card:** `width:min(400px,94vw)` in mock — in the real panel it's fluid to the dock width. `border:1px solid --border; border-radius:16px; box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 30px -12px rgba(0,0,0,.12)`. Icons: Lucide, stroke 1.75. Radii scale: 16 card / 13–14 logo tile / 12 input / 10 rows / 8 buttons.

**Theme:** built light-mode. OPEN DECISION — ship light only, or follow the editor theme (leaning follow-theme since it's token-based and cheap). Resolve during build.

---

## 2. THE THREE STATES (the mock's core logic — NOT visible statically)

The panel renders one of three states. A preview switcher in the mock toggles them; in the real build the state is derived (see §4).

| State | When | Descriptor copy | Questions | Input |
|---|---|---|---|---|
| **cold** (first · from scratch) | First-ever use, no context, no active task signal | **Shown** (teaching) | **None** — Yield has nothing legit to ask; don't fake it | Taller, 2-line placeholder |
| **with-context** (first · has signal) | Has an active task to key off | **Shown** (teaching) | **Exactly 2**, one line each, contextual | Normal |
| **returning** | Regular user, has history/notes | **HIDDEN** — they know the mechanism; don't repeat it | 2 contextual (optional) | Normal |

**Hard rules:**
- Descriptor ("Everything you add is saved to yield-context.md…") is **teaching copy**: show in cold + with-context, **hide for returning**.
- Cold start: **no questions at all.** Just the input + placeholder. Chat wakes on the first send.
- Questions: **never more than 2**, **strictly one line each** (nowrap + ellipsis so they can't wrap). Font 11px, icon 12px, ↵ glyph leading each row, thin dividers between.

---

## 3. COPY SYSTEM (locked)

- **Primary headline** (Geist Sans, `--t-lg`/600): `Every wait can yield something` — "Yield" is same weight as the rest (capital Y only, no emphasis, no shimmer on the word).
- **Secondary headline** (Geist Sans, `--t-md`/500, muted): `Feed your agent, sharpen its output`
- **Descriptor** (Geist Mono, ~11.5px, muted; first-time states only): `Everything you add is saved to yield-context.md and read before every response, so your agent always has your context on hand.` — `yield-context.md` is an inline mono chip.
- **Placeholder** (2 lines, all states): `Add context in as much detail as you like.` / `The richer it is, the better its replies.`
- Agent-neutral voice: **"your agent"**, not "Claude". No em-dashes. Warm, calm, brief.
- **Filename shown in UI:** `yield-context.md`. On disk: `.yield/yield-context.md`. NEVER the user's CLAUDE.md.

---

## 4. CHAT MECHANICS (the interaction — build carefully, this took many passes)

**Model:** a single continuous stack, only the **last 2 messages visible**, moves **one at a time**. Left = Yield (light `--muted` bubble + logo avatar). Right = user (dark `#18181b` bubble). NO transcript UI, NO growing height — fixed-height window, history lives in the DOM behind a fade mask.

**Arrival motion (new message):**
- Incoming message: `msgin .55s cubic-bezier(.16,1,.3,1)` — rise `translateY(10px)→0` + blur `3px→0` (subtle motion blur).
- Outgoing (top message leaving the 2-visible window): `.fadeup` = `opacity:0; filter:blur(7px); transform:translateY(-14px) scale(.985)` over `.7s cubic-bezier(.4,0,.2,1)`. Drifts up + blurs + slightly shrinks = the "motion-blur dissolve."
- One in at the bottom, one out at the top, middle glides up a slot. NOT a pair-swap — a single rolling stack.

**Scroll-back (history):**
- **Native smooth scroll** (`scroll-behavior:smooth`, hidden scrollbar). NO custom per-step animation — that felt jaggy. Just plain smooth native scrolling through the DOM.
- Fade mask at **both** top and bottom edges of the window so messages dissolve in/out cleanly:
  `mask-image:linear-gradient(to bottom, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%)`
- Auto-pin to bottom (newest) on each new message and while the typewriter grows.

**Typewriter:** Yield's (assistant) replies type out char-by-char, ~14–40ms/char (natural jitter), with a blinking caret. User messages appear instantly (correct asymmetry). This also sets up cleanly for real LLM streaming later.

**Logo sheen:** `marksheen 6s ease-in-out infinite` — a specular band sweeps the tile once per ~6s cycle, then rests. Respects `prefers-reduced-motion`.

---

## 5. THE REPLY MODEL (scripted v1 — honest, never a dead end)

Each Yield reply = **[honest acknowledgment, keyword-echoed if possible] + [soft optional door]**.

- **A — honest ack:** never fakes understanding. Worst case: "Saved." / "Got it." / "Noted."
- **B — keyword echo:** if the user's text contains a detectable term (supabase, pnpm, vercel, auth, tests, typescript, tailwind, api, postgres/sql…), reflect it: "Noted the Supabase detail." Only echoes words *actually present* — never fabricates comprehension. Falls back to A on no match.
- **C — soft door (the lead):** the next move is a gentle optional invitation, NOT a forced question: "Add anything else, or you're set." Never nags, never a dead end.

Questions & acks live in a **data structure** (trigger keywords → question → ack) so the LLM can later replace "pick from list" with "ask the model" WITHOUT any UI/flow rewrite. See `yield-conversational-flow.html` §04 + §08.

**Four safety behaviors** (from the flow doc):
1. Nothing relevant to ask — stay silent, show input only. Silence is a feature.
2. User skips/ignores repeatedly — back off, stop offering questions this session.
3. User free-types instead of answering — accept & save normally, don't re-ask.
4. Interrupted mid-answer (task ends) — preserve draft, never discard (see state model).

---

## 6. FOOTER / NOTE-COUNT (locked)

Quiet link, mono. States: `yield-context.md` at 0 notes (first-timer) → `1 note` → `2 notes` → … (singular handled). On save: brief green `Saved` flash → settles to the new count. Clickable → opens `.yield/yield-context.md` in the editor. This is the ONLY history affordance — the file is the archive; no separate history UI.

---

## 7. INTEGRATION — mock → real extension

The mock is a **browser approximation**. Real wiring needed:

- **`CURRENT_PROMPT` is hardcoded in the mock.** In reality it comes from the **`UserPromptSubmit` hook** (the prompt text arrives in the `prompt` field, NOT `user_input`). This drives keyword→question matching and the with-context vs cold state.
- **Agent working/idle** (the status chip + green dot) comes from the hook lifecycle (`UserPromptSubmit` = working starts; `Stop` = idle). One HTTP round-trip both notifies the panel AND injects context via `hookSpecificOutput.additionalContext`.
- **Save** writes the note to `.yield/yield-context.md` (create the `.yield/` folder if absent). Injection reads that file on the next run.
- **Motion/feel** (docked width, real timing) gets final tuning in the webview — mocks approximate it.
- **Logo:** use `yield-logo.svg` at all sizes (panel header ~20–56px, status bar 16px, marketplace 128px).
- **Onboarding intro copy** exists in `yield-conversational-flow.html` §05 but isn't wired into a mock — wire it for the true first-run.

**Deferred, logged, do NOT lose (conversational-flow §08):**
- **2a — LLM replies** (free/local model: Gemini Flash, Groq, OpenRouter, or route via the agent — NOT paid; blocker is latency, layer with script fallback).
- **2b — file-based project detection** (read package.json/lockfiles → project-aware questions; no AI, cheap; likely the next thing after v1).
- **2c — deep codebase analysis** (the heavy one; later).

---

## 8. BUILD GOTCHAS (hard-won — do not relearn these)

- **Antigravity: install the extension via UI ONLY** (Extensions → "…" → Install from VSIX). The `antigravity-ide --install-extension` CLI **corrupts the extension registry**. Hard rule.
- **F5 / Extension Dev Host does NOT work in Antigravity.** Build the VSIX and install it.
- **Hooks snapshot at session start** — after changing a hook, restart Claude Code or it won't pick it up.
- Prompt arrives in **`prompt`** field, not `user_input`.
- One HTTP round-trip does both notify + inject (`hookSpecificOutput.additionalContext`).
- File is `.yield/yield-context.md` — never touch the user's CLAUDE.md.

---

## 9. PHASED BUILD PROMPTS (paste into Claude Code one at a time)

Work in order; confirm each phase before the next (matches how the earlier phases went).

**PHASE A — static webview shell**
> Build the extension webview panel as a static render of `yield-panel-mock-v77.html`. Reproduce the exact tokens in §1 of YIELD-BUILD-HANDOFF.md (spacing, type scale, colors, Geist Sans/Mono split, radii, card shadow). Self-host Geist + Geist Mono woff2. Use `yield-logo.svg` for the header mark. No interactivity yet — just pixel-match the returning-state layout: top bar (status chip + file icon + close), centered logo with sheen animation, headlines, chat area, composer, note-count footer.

**PHASE B — the three states**
> Implement the three states from §2: cold (no questions, taller 2-line placeholder, descriptor shown), with-context (2 one-line contextual questions, descriptor shown), returning (descriptor HIDDEN, 2 optional questions). Wire the copy system from §3 exactly. Descriptor is teaching copy — hidden for returning.

**PHASE C — chat mechanics + motion**
> Implement the chat from §4: single rolling stack, only 2 messages visible, moves one at a time. Arrival = msgin rise+blur-clear; exit = fadeup (blur7 + drift-up + slight shrink). Scroll-back = native smooth scroll with both-edge fade mask, no custom scroll animation. Typewriter on assistant replies with blinking caret; user messages instant. Left=Yield light bubble+avatar, right=user dark bubble.

**PHASE D — reply engine (scripted)**
> Implement the reply model from §5: honest ack + keyword echo (only when term present) + soft optional door. Keep questions/acks in a data structure (trigger→question→ack) so an LLM can replace the lookup later. Implement the four safety behaviors. Note-count footer per §6 with the Saved flash.

**PHASE E — hook wiring**
> Connect the webview to the existing Phase 0–3 hooks. `CURRENT_PROMPT` comes from `UserPromptSubmit` (`prompt` field). Status chip reflects working/idle from the hook lifecycle. Save writes to `.yield/yield-context.md`; injection reads it on the next run via `hookSpecificOutput.additionalContext`. Respect the build gotchas in §8 (VSIX install only, restart after hook changes).

---

## 10. OPEN DECISIONS (resolve during build, none are blockers)

- Light-only vs follow-editor-theme (lean follow-theme).
- Onboarding first-run intro (copy exists in flow doc §05, not yet in a mock).
- When to pull LLM replies (2a) forward — the single biggest experience upgrade left.

---

*Visual design locked at v77. Notes are the product, the chat is the funnel, the file is the history. Build it in phases, confirm each, and keep the deferred LLM path (§7) on the roadmap.*
