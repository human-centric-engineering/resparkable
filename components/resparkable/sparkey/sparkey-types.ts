/**
 * Shared types for the Sparkey pane — the composer's mode, and the shape of
 * one entry in its unified transcript.
 *
 * A transcript entry is one of four kinds. `chat` and `instruct` both ride
 * the same underlying agent turn (`useChatStream`, `resparkable-companion`)
 * — the build plan's "Instruct mode routes through the existing
 * resparkable-companion agent... with a UI-level 'instruct' framing" means
 * exactly that: no separate backend path, just a different receipt style
 * once it's on screen. `capture` never touches the agent at all — a plain
 * `POST /thoughts`, the same one-line write `QuickCapture` makes. `declined`
 * is the local, agent-free "not available through Sparkey yet" receipt for
 * a board-shaped Instruct request (`isBoardInstruction`).
 */

export type SparkeyMode = 'chat' | 'capture' | 'instruct';

interface AgentTurnEntry {
  id: string;
  userText: string;
  assistantText: string;
  tools: string[];
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
}

export interface ChatEntry extends AgentTurnEntry {
  kind: 'chat';
}

export interface InstructEntry extends AgentTurnEntry {
  kind: 'instruct';
}

export interface CaptureEntry {
  kind: 'capture';
  id: string;
  content: string;
  status: 'saving' | 'saved' | 'error';
  errorMessage?: string;
}

export interface DeclinedEntry {
  kind: 'declined';
  id: string;
  text: string;
}

export type TranscriptEntry = ChatEntry | InstructEntry | CaptureEntry | DeclinedEntry;
