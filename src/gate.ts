// Safety behaviour 2 (flow §06): "if the last 2–3 questions were skipped or
// ignored, Yield stops offering questions for this session and just shows the
// input. It reads the room."
//
// Kept as a pure, dependency-free unit so the rule can be tested directly
// rather than inferred from the extension's behaviour.
//
// A ROUND is one wait: it opens on UserPromptSubmit and is judged when the next
// one arrives. "Ignored" means total silence through a round where questions
// were actually on offer. Free-typing instead of answering is NOT a skip — that
// is behaviour 3, and it counts as engagement.

export type QuestionGate = {
  /** questions were shown to the user at some point this round */
  offer(): void;
  /** they clicked a question or saved a note — either way, they engaged */
  engage(): void;
  /** end the current round and open the next; returns true if it just muted */
  closeRound(): boolean;
  /** stop offering questions for the rest of the session */
  readonly muted: boolean;
  /** consecutive rounds where questions were offered and ignored */
  readonly ignoredRounds: number;
};

export function makeQuestionGate(muteAfter = 3): QuestionGate {
  let offered = false;
  let engaged = false;
  let ignored = 0;
  let muted = false;

  return {
    offer() { offered = true; },
    engage() { engaged = true; ignored = 0; },
    closeRound() {
      let justMuted = false;
      if (offered && !engaged) {
        ignored++;
        if (ignored >= muteAfter && !muted) {
          muted = true;
          justMuted = true;
        }
      }
      offered = false;
      engaged = false;
      return justMuted;
    },
    get muted() { return muted; },
    get ignoredRounds() { return ignored; }
  };
}
