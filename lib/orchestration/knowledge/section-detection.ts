// Section detection for the Document Clean Up editor. Breaks any text into
// editable sections via layered detectors run in priority order; the first
// detector that finds ≥2 sections wins. The paragraph-runs fallback always
// produces a result, so the editor never has to special-case "no structure
// found" — it just degrades to coarser chunks.
//
// Used by the cleanup editor UI (Phase 5) to render one EditableSection per
// detected section. The rewrite-section-with-llm capability deliberately
// uses its own more-lenient private finder (substring match against any
// heading-shaped line; accepts single-heading docs) — the two contracts
// aren't identical and forcing them to share would change user-visible
// agent behaviour.

export interface Section {
  /** Stable across small body edits: FNV-1a hash of marker + index. */
  id: string;
  /** Human-facing label — heading text, speaker name, or "Paragraphs M–N". */
  marker: string;
  /** Inclusive offset of the section start in the original content. */
  startOffset: number;
  /** Exclusive offset of the section end. */
  endOffset: number;
  /** content.slice(startOffset, endOffset). Includes the heading line for
   *  markdown-heading sections (the splice contract is round-trippable). */
  body: string;
}

export interface DetectSectionsOptions {
  /** Paragraphs grouped per section by the fallback detector. */
  paragraphGroupSize?: number;
}

// Above this count, a detector is treated as "too noisy" — a transcript with
// 200 speaker turns would be unworkable as 200 editable sections. The next
// detector in the priority chain takes over.
const MAX_SECTIONS = 50;

const DEFAULT_PARAGRAPH_GROUP = 5;

function sectionId(marker: string, index: number): string {
  let hash = 0x811c9dc5;
  const str = `${marker} ${index}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildSectionsFromBoundaries(
  content: string,
  boundaries: { offset: number; marker: string }[]
): Section[] {
  if (boundaries.length === 0) return [];
  const sorted = [...boundaries].sort((a, b) => a.offset - b.offset);
  // Preamble: if the first boundary isn't at 0, the leading text is its own
  // section so every char of `content` lands in exactly one section.
  if (sorted[0].offset > 0) {
    sorted.unshift({ offset: 0, marker: '(preamble)' });
  }
  const sections: Section[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const startOffset = sorted[i].offset;
    const endOffset = i + 1 < sorted.length ? sorted[i + 1].offset : content.length;
    sections.push({
      id: sectionId(sorted[i].marker, i),
      marker: sorted[i].marker,
      startOffset,
      endOffset,
      body: content.slice(startOffset, endOffset),
    });
  }
  return sections;
}

// Detector 1: Markdown headings (#, ##, ..., ######).
function detectHeadings(content: string): Section[] | null {
  const HEADING = /^(#{1,6})\s+(.+?)\s*$/gm;
  const boundaries: { offset: number; marker: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = HEADING.exec(content)) !== null) {
    boundaries.push({ offset: match.index, marker: match[2].trim() });
  }
  if (boundaries.length === 0) return null;
  const sections = buildSectionsFromBoundaries(content, boundaries);
  if (sections.length > MAX_SECTIONS || sections.length < 2) return null;
  return sections;
}

// Detector 2: Speaker labels at line start. `Name:` or `[Name]`. Each CHANGE
// of speaker becomes a section boundary — back-to-back turns from the same
// speaker stay grouped to keep the count manageable.
function detectSpeakerTurns(content: string): Section[] | null {
  const SPEAKER =
    /^(?:([A-Z][A-Za-z'’-]+(?:\s[A-Z][A-Za-z'’-]+){0,3}):\s?|\[([A-Z][A-Za-z'’-]+(?:\s[A-Z][A-Za-z'’-]+){0,3})\]\s?)/gm;
  const boundaries: { offset: number; marker: string }[] = [];
  let lastSpeaker: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = SPEAKER.exec(content)) !== null) {
    const speaker = (match[1] ?? match[2]).trim();
    if (speaker !== lastSpeaker) {
      boundaries.push({ offset: match.index, marker: speaker });
      lastSpeaker = speaker;
    }
  }
  if (boundaries.length < 2) return null;
  const sections = buildSectionsFromBoundaries(content, boundaries);
  if (sections.length > MAX_SECTIONS) return null;
  return sections;
}

// Detector 3: Informal section breaks — Title Case Line followed by a blank
// line. Useful for transcripts that have been lightly structured but lack
// Markdown headings.
function detectTitleCase(content: string): Section[] | null {
  const TITLE_LINE = /^([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]+){0,7})$/gm;
  const boundaries: { offset: number; marker: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = TITLE_LINE.exec(content)) !== null) {
    const end = match.index + match[0].length;
    // Look at the next 2 chars — they must be \n then either \n or EOF for
    // a true blank-line break. Avoids matching every capitalised inline phrase.
    if (content.slice(end, end + 2) === '\n\n' || content.slice(end, end + 1) === '\n') {
      // Single-newline-then-EOF isn't a true break; require explicit blank line.
      if (content.slice(end, end + 2) !== '\n\n') continue;
      boundaries.push({ offset: match.index, marker: match[1].trim() });
    }
  }
  if (boundaries.length < 1) return null;
  const sections = buildSectionsFromBoundaries(content, boundaries);
  if (sections.length > MAX_SECTIONS || sections.length < 2) return null;
  return sections;
}

// Detector 4 (fallback): split every N paragraphs. Always returns at least
// one section so the editor never sees an empty section list.
function detectParagraphRuns(content: string, groupSize: number): Section[] {
  if (content.trim().length === 0) {
    return [
      {
        id: sectionId('(empty)', 0),
        marker: '(empty)',
        startOffset: 0,
        endOffset: content.length,
        body: content,
      },
    ];
  }
  // Paragraph boundaries: position 0 plus the end-offset of each \n\n run.
  const paragraphStarts: number[] = [0];
  const PARA_BREAK = /\n[ \t]*\n+/g;
  let m: RegExpExecArray | null;
  while ((m = PARA_BREAK.exec(content)) !== null) {
    paragraphStarts.push(m.index + m[0].length);
  }
  // Group every `groupSize` paragraph-starts into one section.
  const boundaries: { offset: number; marker: string }[] = [];
  for (let i = 0; i < paragraphStarts.length; i += groupSize) {
    const fromPara = i + 1;
    const toPara = Math.min(i + groupSize, paragraphStarts.length);
    boundaries.push({
      offset: paragraphStarts[i],
      marker: fromPara === toPara ? `Paragraph ${fromPara}` : `Paragraphs ${fromPara}–${toPara}`,
    });
  }
  return buildSectionsFromBoundaries(content, boundaries);
}

export function detectSections(content: string, opts: DetectSectionsOptions = {}): Section[] {
  if (content.length === 0) {
    return [
      { id: sectionId('(empty)', 0), marker: '(empty)', startOffset: 0, endOffset: 0, body: '' },
    ];
  }
  for (const detector of [detectHeadings, detectSpeakerTurns, detectTitleCase]) {
    const result = detector(content);
    if (result !== null) return result;
  }
  return detectParagraphRuns(content, opts.paragraphGroupSize ?? DEFAULT_PARAGRAPH_GROUP);
}

// Look up a section by marker (exact match) or by id. Returns null when no
// match — used by rewrite-section-with-llm to resolve user-supplied markers.
export function findSectionByMarker(content: string, lookup: string): Section | null {
  const sections = detectSections(content);
  return sections.find((s) => s.marker === lookup || s.id === lookup) ?? null;
}

// Splice a new body into a section. Returns the full document with the
// section's content replaced. Caller must hold the edit lock.
export function spliceSection(content: string, section: Section, newBody: string): string {
  return content.slice(0, section.startOffset) + newBody + content.slice(section.endOffset);
}
