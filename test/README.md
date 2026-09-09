# Tests

Every suite drives the **compiled build** in `out/`, not the TypeScript — the
thing that ships is the thing worth testing. So compile first:

```bash
npm run compile
npm test
```

`npm test` runs the 13 suites that need nothing but Node and, for two of them,
Chrome. It exits non-zero if any fail.

## What each one covers

| suite | what it proves |
| --- | --- |
| `store-format.js` | the context file format is lossless and a hand-edited file survives |
| `setup.js` | hook install: merge never overwrite, backup, the six setup states |
| `settings-ignore.js` | the `yield.smartSuggestions` toggle and the `.gitignore` rule |
| `listener.js` | route-by-cwd across platforms, and hook retargeting |
| `port-claim.js` | probe-and-claim on REAL sockets, and notes saving with no port |
| `loop-guard.js` | Yield's own model call cannot trigger Yield |
| `llm-gating.js` | when a model call happens at all, the follow-up, mash suppression |
| `chip-lifecycle.js` | the status chip across two consecutive runs |
| `firstframe.js` | a panel opened mid-run paints the right opening frame |
| `stack-behaviour.js` | the scrolling stack, in real Chrome |
| `layout-check.js` | composer geometry, in real Chrome |
| `voice-off.js` | the shipped `VOICE_ENABLED=false` configuration |
| `flag-roundtrip.js` | flipping `VOICE_ENABLED` and restoring it |

## The ones `npm test` skips

**`llm-tone.js`** spends real money on real model calls. `npm test -- --tone`.

**`voice-pipeline.js` / `voice-states.js`** need `VOICE_ENABLED=true` **and**
audio fixtures that are deliberately not committed, because they are recordings
of someone's voice. Point `YIELD_TEST_FIXTURES` at a directory holding
`known.wav` and `src48.wav`, then `npm test -- --voice`.

## Environment

- `YIELD_TEST_CHROME` — path to a Chrome/Chromium binary. Without it the two
  browser suites look in the usual macOS and Linux locations and skip cleanly
  if there is none.
- `YIELD_TEST_FIXTURES` — the audio directory described above.

Nothing here writes inside the repo: temporary workspaces and rendered HTML go
to the OS temp directory.

## Two harness traps worth knowing

Headless Chrome under `--virtual-time-budget` **freezes CSS animations that
start after load** and **never delivers scroll events**, so a message can render
at `opacity: 0` and a pin can read as "never scrolled". Both are harness
artifacts, not bugs. `stack-behaviour.js` shims around them.

`loop-guard.js` needs the real extension host running — it reads the live
process's environment. Open the project in the editor with Yield active first,
or it will tell you it could not find one.
