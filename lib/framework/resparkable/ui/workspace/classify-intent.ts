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

/** A verb of physical/spatial relocation — the shape a board-column move takes. */
const MOVE_LEADERS = new Set(['move', 'drag', 'shift', 'put']);

/**
 * Whether an Instruct-mode message is shaped like a board-column move
 * ("move X to Doing", "put this on the board") — the one instruction
 * Sparkey can't act on, since no agent capability writes board membership
 * or card position (`resparkable-companion`'s capability list has no
 * `resparkable_*board*` entry). Checked client-side, before ever calling
 * the agent, so the composer can give an honest "not available through
 * Sparkey yet" instead of a tool call that was always going to fail —
 * or worse, an LLM inventing one.
 *
 * Deliberately narrow: this only has to catch the phrasing people actually
 * use for card moves, not board vocabulary in general — "close the Q3
 * board" is a real, fulfillable instruct request (archiving, not moving a
 * card) and must not trip this.
 */
export function isBoardInstruction(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return false;

  // Without a leading move verb, only "column"/"board" on their own are too
  // generic to act on — "What column is this task in?" is a chat question,
  // "close the Q3 board" is a real, fulfillable instruct request (archiving,
  // not moving a card), and neither should trip this.
  const leader = leadingWord(trimmed);
  if (!MOVE_LEADERS.has(leader)) return false;

  // The canonical shape ("move X to Doing") names a column, not the word
  // "column" — a destination after the move verb is enough on its own.
  // Otherwise fall back to an explicit mention of where it's moving to.
  return / to /.test(trimmed) || /\bboard\b/.test(trimmed) || /\bcolumn\b/.test(trimmed);
}
