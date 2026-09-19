import { describe, expect, it } from 'vitest';

import {
  detectSections,
  findSectionByMarker,
  spliceSection,
} from '@/lib/orchestration/knowledge/section-detection';

describe('detectSections', () => {
  describe('empty + degenerate input', () => {
    it('returns a single (empty) section for empty input', () => {
      const result = detectSections('');
      expect(result).toHaveLength(1);
      expect(result[0].marker).toBe('(empty)');
      expect(result[0].body).toBe('');
    });

    it('returns at least one section for whitespace-only input', () => {
      const result = detectSections('   \n\n  \n');
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('every section spans a non-overlapping slice — together they cover the whole input', () => {
      const content = '# A\nalpha\n# B\nbravo\n# C\ncharlie';
      const result = detectSections(content);
      let cursor = 0;
      for (const s of result) {
        expect(s.startOffset).toBe(cursor);
        expect(s.body).toBe(content.slice(s.startOffset, s.endOffset));
        cursor = s.endOffset;
      }
      expect(cursor).toBe(content.length);
    });
  });

  describe('detector 1: Markdown headings', () => {
    it('splits on `#` headings', () => {
      const content = '# One\nalpha\n# Two\nbravo';
      const result = detectSections(content);
      expect(result).toHaveLength(2);
      expect(result[0].marker).toBe('One');
      expect(result[1].marker).toBe('Two');
      expect(result[0].body).toBe('# One\nalpha\n');
      expect(result[1].body).toBe('# Two\nbravo');
    });

    it('honours all 1..6 heading levels', () => {
      const content = '# H1\na\n## H2\nb\n### H3\nc\n###### H6\nd';
      const result = detectSections(content);
      expect(result.map((s) => s.marker)).toEqual(['H1', 'H2', 'H3', 'H6']);
    });

    it('adds a (preamble) section when leading content has no heading', () => {
      const content = 'lead-in text\n\n# Heading\nbody';
      const result = detectSections(content);
      expect(result[0].marker).toBe('(preamble)');
      expect(result[0].body).toBe('lead-in text\n\n');
      expect(result[1].marker).toBe('Heading');
    });

    it('falls through to the next detector when a single heading produces only one section', () => {
      // Only one heading + no preamble = one section. Headings detector returns
      // null in this case so the paragraph fallback fires.
      const content = '# Only\nsome body text';
      const result = detectSections(content);
      // Paragraph fallback returns at least one section; the heading is just
      // part of the first paragraph group.
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].marker).not.toBe('Only'); // headings detector did not win
    });
  });

  describe('detector 2: speaker turns', () => {
    it('boundaries on speaker CHANGE, not on every speaker line', () => {
      const content = 'Alice: hi\nAlice: still me\nBob: hello\nBob: also me';
      const result = detectSections(content);
      expect(result.map((s) => s.marker)).toEqual(['Alice', 'Bob']);
    });

    it('matches both `Name:` and `[Name]` forms', () => {
      const content = '[Alice]\nhi\nBob: hello';
      const result = detectSections(content);
      expect(result.map((s) => s.marker)).toEqual(['Alice', 'Bob']);
    });

    it('requires capitalised speakers (rejects `alice:`)', () => {
      // Lowercase speakers → speaker detector finds nothing → falls through
      // to title-case → falls through to paragraphs.
      const content = 'alice: hi\nbob: hello';
      const result = detectSections(content);
      expect(result.length).toBeGreaterThanOrEqual(1);
      // None of the resulting markers should be a speaker name.
      for (const s of result) {
        expect(s.marker).not.toMatch(/^(alice|bob)$/i);
      }
    });

    it('falls through when only one speaker turn (boundary requires ≥ 2)', () => {
      const content = 'Alice: only one\nAlice: still her\nAlice: yet again';
      const result = detectSections(content);
      // No boundary changes → speaker detector returns null → falls through.
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('detector 3: title-case lines + blank line', () => {
    it('splits on Title Case lines followed by a blank line', () => {
      const content = 'Introduction\n\nbody one\n\nConclusion\n\nbody two';
      const result = detectSections(content);
      expect(result.map((s) => s.marker)).toEqual(['Introduction', 'Conclusion']);
    });

    it('ignores title-case lines NOT followed by a blank line', () => {
      const content = 'Title Without Break\nbody continues immediately\nMore content here';
      const result = detectSections(content);
      // Falls through to paragraph runs.
      for (const s of result) {
        expect(s.marker).not.toBe('Title Without Break');
      }
    });
  });

  describe('detector 4 (fallback): paragraph runs', () => {
    it('splits a no-structure doc into paragraph groups', () => {
      const paragraphs = Array.from({ length: 12 }, (_, i) => `para ${i + 1}`);
      const content = paragraphs.join('\n\n');
      const result = detectSections(content);
      // 12 paragraphs / default groupSize=5 → 3 sections.
      expect(result).toHaveLength(3);
      expect(result[0].marker).toBe('Paragraphs 1–5');
      expect(result[1].marker).toBe('Paragraphs 6–10');
      expect(result[2].marker).toBe('Paragraphs 11–12');
    });

    it('honours custom paragraphGroupSize', () => {
      const paragraphs = Array.from({ length: 6 }, (_, i) => `p${i + 1}`);
      const content = paragraphs.join('\n\n');
      const result = detectSections(content, { paragraphGroupSize: 2 });
      expect(result).toHaveLength(3);
    });
  });

  describe('section IDs', () => {
    it('are stable across body edits (id stays the same as long as marker + index do)', () => {
      const before = '# A\nshort body\n# B\nshort';
      const after = '# A\na very long body indeed with many words\n# B\nshort';
      const idsBefore = detectSections(before).map((s) => s.id);
      const idsAfter = detectSections(after).map((s) => s.id);
      expect(idsAfter).toEqual(idsBefore);
    });

    it('change when section ORDER changes (index changes even though marker is preserved)', () => {
      const before = '# A\nbody\n# B\nbody';
      const after = '# B\nbody\n# A\nbody';
      const idsBefore = detectSections(before).map((s) => s.id);
      const idsAfter = detectSections(after).map((s) => s.id);
      expect(idsAfter).not.toEqual(idsBefore);
    });
  });

  describe('MAX_SECTIONS cap', () => {
    it('falls through to next detector when headings exceed the cap', () => {
      // 60 headings — exceeds the 50-section cap, so headings detector returns null.
      const content = Array.from({ length: 60 }, (_, i) => `# H${i + 1}\nbody`).join('\n');
      const result = detectSections(content);
      // No section's marker should be H1..H60 (those would come from the headings detector).
      for (const s of result) {
        expect(s.marker).not.toMatch(/^H\d+$/);
      }
    });
  });
});

describe('findSectionByMarker', () => {
  const content = '# Intro\nalpha\n# Body\nbravo\n# Outro\ncharlie';

  it('finds by exact marker text', () => {
    const s = findSectionByMarker(content, 'Body');
    expect(s).not.toBeNull();
    expect(s?.body.startsWith('# Body')).toBe(true);
  });

  it('finds by section id', () => {
    const sections = detectSections(content);
    const s = findSectionByMarker(content, sections[1].id);
    expect(s?.marker).toBe(sections[1].marker);
  });

  it('returns null for an unknown marker', () => {
    expect(findSectionByMarker(content, 'No Such Section')).toBeNull();
  });
});

describe('spliceSection', () => {
  it('replaces a section body in place, leaving sister sections intact', () => {
    const content = '# A\nalpha\n# B\nbravo\n# C\ncharlie';
    const sections = detectSections(content);
    const next = spliceSection(content, sections[1], '# B\nNEW BODY\n');
    expect(next).toBe('# A\nalpha\n# B\nNEW BODY\n# C\ncharlie');
  });
});
