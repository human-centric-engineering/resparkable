'use client';

import { List, useDynamicRowHeight, type RowComponentProps } from 'react-window';

import { EditableSection } from '@/components/admin/orchestration/knowledge/editable-section';
import type { Section } from '@/lib/orchestration/knowledge/section-detection';

interface SectionListProps {
  documentId: string;
  sections: Section[];
  contextWindow: number;
  acquireLock: () => Promise<boolean>;
  onSaved: () => void;
  onPendingChange: (pendingChangeId: string) => void;
}

// Section counts under this threshold render the entire list directly. The
// reconciliation cost is negligible at that size and the simpler DOM means
// Ctrl-F across the document and existing tests continue to behave the way
// they always have. Above the threshold, we hand off to react-window so the
// browser only mounts the rows currently in view.
const VIRTUALISATION_THRESHOLD = 50;
// Fallback row height for the dynamic measurer's first paint. Roughly two
// lines of monospace 12px text plus padding — close enough that the initial
// scrollbar isn't wildly miscalibrated before measurement settles.
const DEFAULT_ROW_HEIGHT = 80;
// Fallback list height before resize observers report the actual container
// size. Matches the legacy `max-h-[60vh]` envelope at typical viewport heights.
const DEFAULT_LIST_HEIGHT = 480;

interface RowProps {
  sections: Section[];
  documentId: string;
  contextWindow: number;
  acquireLock: () => Promise<boolean>;
  onSaved: () => void;
  onPendingChange: (pendingChangeId: string) => void;
}

function Row({
  index,
  style,
  sections,
  documentId,
  contextWindow,
  acquireLock,
  onSaved,
  onPendingChange,
}: RowComponentProps<RowProps>) {
  const section = sections[index];
  return (
    <div style={style}>
      <EditableSection
        documentId={documentId}
        section={section}
        contextWindow={contextWindow}
        acquireLock={acquireLock}
        onSaved={onSaved}
        onPendingChange={onPendingChange}
      />
    </div>
  );
}

// Direct (non-virtualised) section list. Used when section count is below
// VIRTUALISATION_THRESHOLD — at that size the reconciliation cost is
// negligible and the simpler DOM keeps Ctrl-F and existing tests working.
function DirectSectionList({
  documentId,
  sections,
  contextWindow,
  acquireLock,
  onSaved,
  onPendingChange,
}: SectionListProps) {
  return (
    <div className="max-h-[60vh] overflow-auto" data-testid="section-list-direct">
      {sections.map((section) => (
        <EditableSection
          key={section.id}
          documentId={documentId}
          section={section}
          contextWindow={contextWindow}
          acquireLock={acquireLock}
          onSaved={onSaved}
          onPendingChange={onPendingChange}
        />
      ))}
    </div>
  );
}

// Virtualised section list. Used for large docs (books, long manuals) so
// only on-screen rows mount, keeping reconciliation fast as the doc scales.
function VirtualSectionList({
  documentId,
  sections,
  contextWindow,
  acquireLock,
  onSaved,
  onPendingChange,
}: SectionListProps) {
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: DEFAULT_ROW_HEIGHT });

  return (
    <List
      rowCount={sections.length}
      rowHeight={rowHeight}
      rowComponent={Row}
      rowProps={{
        sections,
        documentId,
        contextWindow,
        acquireLock,
        onSaved,
        onPendingChange,
      }}
      defaultHeight={DEFAULT_LIST_HEIGHT}
      style={{ height: '60vh' }}
      overscanCount={3}
      data-testid="section-list-virtual"
    />
  );
}

// Adaptive section list. Picks direct or virtualised rendering based on
// section count — the components are siblings (no shared hooks) so the
// React tree remounts cleanly when crossing the threshold rather than
// violating the Rules of Hooks.
export function SectionList(props: SectionListProps) {
  return props.sections.length < VIRTUALISATION_THRESHOLD ? (
    <DirectSectionList {...props} />
  ) : (
    <VirtualSectionList {...props} />
  );
}
