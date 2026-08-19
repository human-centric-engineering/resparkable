/**
 * Sparkey's mode-mismatch classifier — a heuristic, not a model call.
 *
 * The composer has three modes (Chat / Capture / Instruct); this guesses
 * which one a piece of typed or spoken text actually belongs in, so a
 * mismatch ("Chat mode, but this reads like an instruction") can be flagged
 * as a dismissible inline prompt rather than silently routing to the wrong
 * place. It is deliberately dumb — cheap surface signals only, no network
 * call — matching Capture's own "no model call" design and the codebase's
 * cost discipline of keeping background/ambient checks off paid hot paths.
 *
 * The three rules, in the order they're checked:
 *
 *   1. A trailing `?`, or a leading interrogative word ("what", "is this
 *      still…") → `chat`.
 *   2. A leading imperative verb ("create a project", "move this to Doing")
 *      → `instruct`.
 *   3. Anything else → `capture`, the safe default. A false "capture" costs
 *      a thought sitting in the inbox a little longer; a false "chat" or
 *      "instruct" on a real thought loses it outright — so ambiguous text
 *      always falls to the outcome that never loses one.
 *
 * This never hard-blocks: `classifyIntent` only informs the mismatch
 * prompt, and the prompt is always dismissible.
 */

export type IntentKind = 'chat' | 'capture' | 'instruct';

/** Leading word that reads as a question, independent of a trailing `?`. */
const INTERROGATIVE_LEADERS = new Set([
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'is',
  'are',
  'was',
  'were',
  'am',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'has',
  'have',
  'had',
]);

/** Leading verb that reads as a command directed at Sparkey, not a note about the world. */
const IMPERATIVE_LEADERS = new Set([
  'create',
  'add',
  'make',
  'move',
  'update',
  'edit',
  'change',
  'set',
  'delete',
  'remove',
  'rename',
  'mark',
  'complete',
  'finish',
  'close',
  'archive',
  'restore',
  'snooze',
  'assign',
  'link',
  'unlink',
  'tag',
  'schedule',
  'book',
  'start',
  'cancel',
  'open',
  'promote',
  'reject',
  'accept',
  'file',
  'split',
]);

/**
 * The leading run of letters, lowercased, stopping before any apostrophe —
 * `"Can't"` → `"can"`, `"Who's"` → `"who"` — so a contraction of a leader
 * word still matches the leader, rather than needing every contracted form
 * spelled out in both sets.
 */
function leadingWord(text: string): string {
  const match = /^[a-zA-Z]+/.exec(text);
  return match ? match[0].toLowerCase() : '';
}

export function classifyIntent(text: string): IntentKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'capture';

  const leader = leadingWord(trimmed);
  if (trimmed.endsWith('?') || INTERROGATIVE_LEADERS.has(leader)) return 'chat';
  if (IMPERATIVE_LEADERS.has(leader)) return 'instruct';
  return 'capture';
}
