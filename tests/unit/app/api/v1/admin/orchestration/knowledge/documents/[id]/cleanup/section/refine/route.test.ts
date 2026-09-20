import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// vi.hoisted so refs exist when vi.mock factories run
const {
  mockGetEditLockState,
  mockFindFirstDoc,
  mockFindFirstConv,
  mockFindUniqueAgent,
  mockCreatePending,
  mockProviderChat,
  mockGetProvider,
  mockGetModel,
} = vi.hoisted(() => {
  const mockProviderChat = vi.fn();
  const mockGetProvider = vi.fn();
  return {
    mockGetEditLockState: vi.fn(),
    mockFindFirstDoc: vi.fn(),
    mockFindFirstConv: vi.fn(),
    mockFindUniqueAgent: vi.fn(),
    mockCreatePending: vi.fn(),
    mockProviderChat,
    mockGetProvider,
    mockGetModel: vi.fn(),
  };
});

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: { findFirst: mockFindFirstDoc },
    aiConversation: { findFirst: mockFindFirstConv },
    aiAgent: { findUnique: mockFindUniqueAgent },
    aiKnowledgeDocumentPendingChange: { create: mockCreatePending },
  },
}));

vi.mock('@/lib/orchestration/knowledge/edit-lock', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/knowledge/edit-lock')>(
    '@/lib/orchestration/knowledge/edit-lock'
  );
  return { ...actual, getEditLockState: mockGetEditLockState };
});

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: mockGetProvider,
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: mockGetModel,
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    cleanupRefineLimiter: {
      check: vi.fn(() => ({ success: true, limit: 12, remaining: 11, reset: 0 })),
    },
  };
});

import { auth } from '@/lib/auth/config';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/section/refine/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { detectSections } from '@/lib/orchestration/knowledge/section-detection';

// ADMIN_ID matches the hardcoded id in mockAuthenticatedUser. The route
// compares lockState.heldBy to session.user.id — they must agree for happy-path.
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';
const PENDING_CHANGE_ID = 'cmjbv4i3x00003wsloputgwu4';

// Two-heading doc — detectSections (the REAL implementation, not mocked) splits into two sections.
const FULL_DOC = '# Intro\nfirst body\n# Body\nsecond body';
// Sections are addressed by their detectSections id, never by marker — markers
// repeat within a document. Derived from the real detector.
const INTRO_ID = detectSections(FULL_DOC)[0].id;
const LLM_REWRITTEN_BODY = 'rewritten intro body text';

const mockAgent = { provider: 'anthropic', model: 'claude-3-5-sonnet', temperature: 0.2 };
const mockConv = { agentId: 'agent-123' };

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/section/refine`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /cleanup/section/refine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Happy-path defaults: caller owns the lock
    mockGetEditLockState.mockResolvedValue({
      heldBy: ADMIN_ID,
      acquiredAt: new Date(),
      active: true,
    });
    mockFindFirstDoc.mockResolvedValue({
      processedContent: FULL_DOC,
      originalContent: null,
    });
    mockFindFirstConv.mockResolvedValue(mockConv);
    mockFindUniqueAgent.mockResolvedValue(mockAgent);
    mockProviderChat.mockResolvedValue({
      content: LLM_REWRITTEN_BODY,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'claude-3-5-sonnet',
      finishReason: 'stop',
    });
    mockGetProvider.mockResolvedValue({ chat: mockProviderChat });
    mockCreatePending.mockResolvedValue({ id: PENDING_CHANGE_ID });
    // Default: model registry returns a comfortably-large context window so
    // the guard is a no-op. Tests that exercise the guard override this.
    mockGetModel.mockReturnValue({ maxContext: 200_000 });
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid document CUID', async () => {
      const r = await POST(
        req({ sectionId: INTRO_ID, instructions: 'clean it' }),
        params(INVALID_ID)
      );
      expect(r.status).toBe(400);
    });

    it('400 when sectionId is missing from body', async () => {
      const r = await POST(req({ instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(400);
    });

    it('400 when instructions is missing from body', async () => {
      const r = await POST(req({ sectionId: INTRO_ID }), params(DOC_ID));
      expect(r.status).toBe(400);
    });

    it('400 when instructions exceed 2000 characters', async () => {
      const r = await POST(
        req({ sectionId: INTRO_ID, instructions: 'x'.repeat(2001) }),
        params(DOC_ID)
      );
      expect(r.status).toBe(400);
    });
  });

  describe('lock check', () => {
    it('423 LOCK_HELD when another admin owns the lock; LLM not called', async () => {
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'other-admin',
        acquiredAt: new Date(),
        active: true,
      });

      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));

      expect(r.status).toBe(423);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('LOCK_HELD');
      // LLM must not be called when lock is held by another admin
      expect(mockProviderChat).not.toHaveBeenCalled();
    });
  });

  describe('document state', () => {
    it('400 when doc is not in cleaning status or not owned by the caller', async () => {
      mockFindFirstDoc.mockResolvedValue(null);
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('conversation and agent lookup', () => {
    it('400 when no cleanup conversation found for the doc', async () => {
      mockFindFirstConv.mockResolvedValue(null);
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(400);
    });

    it('500 AGENT_MISCONFIGURED when agent has no provider', async () => {
      mockFindUniqueAgent.mockResolvedValue({
        provider: null,
        model: 'claude-3-5-sonnet',
        temperature: 0.2,
      });
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.error.code).toBe('AGENT_MISCONFIGURED');
    });

    it('500 AGENT_MISCONFIGURED when agent has no model', async () => {
      mockFindUniqueAgent.mockResolvedValue({
        provider: 'anthropic',
        model: null,
        temperature: 0.2,
      });
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.error.code).toBe('AGENT_MISCONFIGURED');
    });
  });

  describe('section detection', () => {
    it('404 SECTION_NOT_FOUND when the id matches nothing in detectSections', async () => {
      const r = await POST(
        req({ sectionId: 'deadbeef', instructions: 'clean it' }),
        params(DOC_ID)
      );
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.error.code).toBe('SECTION_NOT_FOUND');
    });
  });

  describe('duplicate markers', () => {
    // Addressing by marker proposed a rewrite of the FIRST match's body.
    it('refines the second of two identically-marked sections', async () => {
      const dupDoc = '# Intro\nfirst body\n# Intro\nsecond body';
      mockFindFirstDoc.mockResolvedValue({ processedContent: dupDoc, originalContent: null });
      const [first, second] = detectSections(dupDoc);
      expect(second.marker).toBe(first.marker);

      const r = await POST(req({ sectionId: second.id, instructions: 'clean it' }), params(DOC_ID));

      expect(r.status).toBe(200);
      // The prompt must carry the SECOND section's body.
      const userMessage = mockProviderChat.mock.calls[0][0].find(
        (m: { role: string }) => m.role === 'user'
      ) as { content: string } | undefined;
      expect(userMessage?.content).toContain('SECTION BODY:\nsecond body');
      expect(userMessage?.content).not.toContain('first body');
      // ...and the splice must leave the first section intact.
      const pendingData = mockCreatePending.mock.calls[0][0].data as { afterContent: string };
      expect(pendingData.afterContent).toBe(`# Intro\nfirst body\n# Intro\n${LLM_REWRITTEN_BODY}`);
    });
  });

  describe('token budget guard', () => {
    it('413 SECTION_TOO_LARGE when estimated prompt + response budget exceeds the model context window; LLM not called', async () => {
      // Shrink the registry's context window to a value that any non-empty
      // prompt will exceed once the 4096-token response budget is added.
      mockGetModel.mockReturnValue({ maxContext: 1_000 });

      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));

      expect(r.status).toBe(413);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SECTION_TOO_LARGE');
      expect(body.error.details).toMatchObject({
        contextWindow: ['1000'],
        responseBudget: ['4096'],
      });
      // LLM must not be invoked once the guard fires.
      expect(mockProviderChat).not.toHaveBeenCalled();
      // Pending change must not be written.
      expect(mockCreatePending).not.toHaveBeenCalled();
    });

    it('falls back to a 128k context window when the model is not in the registry; small section still succeeds', async () => {
      // getModel returns undefined for unknown ids — guard should use the
      // 128k fallback, which trivially fits a short section.
      mockGetModel.mockReturnValue(undefined);

      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));

      expect(r.status).toBe(200);
      expect(mockProviderChat).toHaveBeenCalledTimes(1);
    });
  });

  describe('LLM errors', () => {
    it('502 PROVIDER_UNAVAILABLE when getProvider throws', async () => {
      mockGetProvider.mockRejectedValue(new Error('connection refused'));
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body.error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('502 EMPTY_RESPONSE when LLM returns whitespace-only content', async () => {
      mockProviderChat.mockResolvedValue({
        content: '   \n  ',
        usage: { inputTokens: 10, outputTokens: 1 },
        model: 'claude-3-5-sonnet',
        finishReason: 'stop',
      });
      const r = await POST(req({ sectionId: INTRO_ID, instructions: 'clean it' }), params(DOC_ID));
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body.error.code).toBe('EMPTY_RESPONSE');
    });
  });

  describe('section without a leading markdown heading', () => {
    it('uses (section: <marker>) as the SECTION HEADING label when the section body has no leading # heading', async () => {
      // Arrange: doc whose sections have no markdown heading lines — detectSections
      // falls back to paragraph-run detection, producing sections with plain body text.
      // We use a multi-paragraph doc (≥2 paragraph breaks) so the fallback produces ≥2 sections.
      // The section body will NOT match LEADING_HEADING, so headingForPrompt must
      // fall back to `(section: <marker>)`, and newSectionBody must be `${rewritten}${trailing}`
      // (no headingLine prefix) — covering the L108/L109/L142/L143 no-heading branches.
      const plainDoc =
        'First paragraph without any heading.\n\nSecond paragraph also without heading.\n\nThird paragraph plain.';
      mockFindFirstDoc.mockResolvedValue({
        processedContent: plainDoc,
        originalContent: null,
      });

      // Use the real detectSections to find the actual first section.
      const sections = detectSections(plainDoc);
      expect(sections.length).toBeGreaterThan(0);
      const firstSection = sections[0];

      const r = await POST(
        req({ sectionId: firstSection.id, instructions: 'clean it' }),
        params(DOC_ID)
      );

      expect(r.status).toBe(200);

      // The user message sent to LLM must use `(section: <marker>)` as the heading label,
      // NOT a markdown heading line — exercises the `headingLine ?? \`(section: ...)\`` branch.
      const chatCall = mockProviderChat.mock.calls[0];
      const userMessage = chatCall[0].find((m: { role: string }) => m.role === 'user') as
        { role: string; content: string } | undefined;
      expect(userMessage?.content).toContain(`(section: ${firstSection.marker})`);
      // The SECTION BODY must equal the full first-section body (no heading stripped).
      expect(userMessage?.content).toContain(`SECTION BODY:\n${firstSection.body}`);

      // afterContent in the pending change must contain the LLM output directly
      // (no headingLine prefix) — covering the `headingLine ? ... : ...` cond-expr at L142/L143.
      const pendingData = mockCreatePending.mock.calls[0][0].data as { afterContent: string };
      expect(pendingData.afterContent).toContain(LLM_REWRITTEN_BODY);
    });
  });

  describe('deltaPct with empty current content', () => {
    it('returns deltaPct=0 when processedContent and originalContent are both absent (null/null)', async () => {
      // detectSections('') always returns at least one section (the '(empty)' fallback).
      // This means we can feed processedContent=null, originalContent=null to the route,
      // currentContent becomes '', detectSections finds the '(empty)' section whose id we address,
      // and the deltaPct guard `currentContent.length === 0 ? 0 : ...` must fire → deltaPct=0.
      const emptySections = detectSections('');
      // The paragraph-run fallback always produces at least one section for empty input.
      expect(emptySections.length).toBeGreaterThan(0);
      const emptyId = emptySections[0].id;

      mockFindFirstDoc.mockResolvedValue({ processedContent: null, originalContent: null });

      const r = await POST(req({ sectionId: emptyId, instructions: 'clean it' }), params(DOC_ID));

      expect(r.status).toBe(200);
      const body = await r.json();
      // currentContent = '' → length === 0 → deltaPct must be 0 (guards against division-by-zero)
      expect(body.data.summary.deltaPct).toBe(0);
      expect(body.data.summary.charsBefore).toBe(0);
    });
  });

  describe('happy path', () => {
    it('sends SECTION HEADING and SECTION BODY as separate prompt parts; body must not contain the heading line', async () => {
      await POST(req({ sectionId: INTRO_ID, instructions: 'make it concise' }), params(DOC_ID));

      // The route must strip the leading heading from the body before sending to LLM.
      // FULL_DOC = '# Intro\nfirst body\n# Body\nsecond body'
      // Section 'Intro' body = '# Intro\nfirst body\n'
      // After heading separation: heading = '# Intro', body after = 'first body\n'
      const chatCall = mockProviderChat.mock.calls[0];
      const userMessage = chatCall[0].find((m: { role: string }) => m.role === 'user') as
        { role: string; content: string } | undefined;
      expect(userMessage).toBeDefined();
      expect(userMessage?.content).toContain('SECTION HEADING:\n# Intro');
      expect(userMessage?.content).toContain('SECTION BODY:\nfirst body\n');
      // The body sent to LLM must NOT include the heading '# Intro'
      const bodyPart = userMessage?.content.split('SECTION BODY:\n')[1] ?? '';
      expect(bodyPart).not.toMatch(/^# Intro/);
    });

    it('creates aiKnowledgeDocumentPendingChange with correct source, markers, and actor', async () => {
      await POST(req({ sectionId: INTRO_ID, instructions: 'make it concise' }), params(DOC_ID));

      expect(mockCreatePending).toHaveBeenCalledTimes(1);
      expect(mockCreatePending).toHaveBeenCalledWith({
        data: expect.objectContaining({
          documentId: DOC_ID,
          source: 'rewrite_section_with_llm',
          beforeContent: FULL_DOC,
          sectionMarker: 'Intro',
          instructions: 'make it concise',
          actorId: ADMIN_ID,
        }),
      });
    });

    it('afterContent in the pending change splices the rewritten body into the full doc', async () => {
      await POST(req({ sectionId: INTRO_ID, instructions: 'make it concise' }), params(DOC_ID));

      const callData = mockCreatePending.mock.calls[0][0].data as { afterContent: string };
      // afterContent should contain the rewritten section and preserve the rest of the doc
      expect(callData.afterContent).toContain(LLM_REWRITTEN_BODY);
      expect(callData.afterContent).toContain('# Body\nsecond body');
      // afterContent must NOT equal the original full doc unchanged
      expect(callData.afterContent).not.toBe(FULL_DOC);
    });

    it('returns { pendingChangeId, sectionId, sectionMarker, summary: { charsBefore, charsAfter, deltaPct } }', async () => {
      const r = await POST(
        req({ sectionId: INTRO_ID, instructions: 'make it concise' }),
        params(DOC_ID)
      );

      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        pendingChangeId: PENDING_CHANGE_ID,
        sectionId: INTRO_ID,
        // The label is the RESOLVED section's marker, not client-supplied.
        sectionMarker: 'Intro',
        summary: expect.objectContaining({
          charsBefore: expect.any(Number),
          charsAfter: expect.any(Number),
          deltaPct: expect.any(Number),
        }),
      });
      // charsBefore must be the actual full document length, not zero or a mock artefact
      expect(body.data.summary.charsBefore).toBe(FULL_DOC.length);
    });
  });
});
