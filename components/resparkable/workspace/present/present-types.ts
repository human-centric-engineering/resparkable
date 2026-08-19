/**
 * PresentMode — the three modes `plan.md` §22.1 names.
 *
 * Only `'deck'` builds real slides today, via `buildSlidesFromSelection()`.
 * `'lightweight'` is deliberately inert — "no deck, no sequencing" is the
 * whole point of it, so there is nothing for this phase to wire up beyond
 * the mode itself existing. `'on-the-fly'` is real too, but in the narrow,
 * no-model sense §22.1.3 doesn't actually require: dictation becomes a
 * slide's content verbatim, the same "deliberately dumb" contract Capture
 * mode holds elsewhere in this app — not Sparkey generating slides from
 * what was said, which needs a model call this phase excludes (see the
 * build plan's deferred follow-ups).
 */
export type PresentMode = 'lightweight' | 'deck' | 'on-the-fly';
