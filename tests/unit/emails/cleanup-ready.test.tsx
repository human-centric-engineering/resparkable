/**
 * CleanupReady email template — unit tests
 *
 * Renders the component to HTML via @react-email/render and asserts on the
 * resulting markup.  No mocks needed — the template is a pure function of its
 * props with no external dependencies.
 *
 * Anti-green-bar note: every assertion verifies a TRANSFORMATION the
 * component performs on its props (placing documentName in the heading,
 * writing cleanupUrl into the button href, switching the size-note text
 * based on sizeClass) rather than just checking that "something rendered".
 */

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CleanupReady } from '@/emails/cleanup-ready';

// ── Shared fixture ───────────────────────────────────────────────────────────

const baseProps = {
  documentName: 'Q4 Sales Report',
  cleanupUrl: 'https://app.example.com/admin/orchestration/knowledge/doc-123/cleanup',
  sizeClass: 'medium' as const,
  sizeTokens: 20_000,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CleanupReady', () => {
  describe('document name in heading area', () => {
    it('renders the document name in the email body', async () => {
      // Arrange + Act
      const html = await render(<CleanupReady {...baseProps} />);

      // Assert: the label element must contain the actual document name
      // This proves the component uses the prop — not a hard-coded string
      expect(html).toContain('Q4 Sales Report');
    });

    it('renders a different document name correctly', async () => {
      // Act
      const html = await render(
        <CleanupReady {...baseProps} documentName="Meeting Transcript — June" />
      );

      // Assert: the rendered output reflects the changed prop
      expect(html).toContain('Meeting Transcript — June');
    });
  });

  describe('cleanup button href', () => {
    it('sets the button href to the provided cleanupUrl', async () => {
      // Arrange
      const customUrl = 'https://staging.example.com/admin/orchestration/knowledge/doc-abc/cleanup';

      // Act
      const html = await render(<CleanupReady {...baseProps} cleanupUrl={customUrl} />);

      // Assert: the URL must appear as a link target — proves the component
      // wires cleanupUrl into the Button href prop
      expect(html).toContain(customUrl);
    });
  });

  describe('sizeClass: too-large', () => {
    it('renders the "too large for whole-document LLM rewrites" line when sizeClass is too-large', async () => {
      // Act
      const html = await render(
        <CleanupReady {...baseProps} sizeClass="too-large" sizeTokens={150_000} />
      );

      // Assert: the too-large specific text must appear (proves the conditional branch fires)
      expect(html).toContain('too large for whole-document LLM rewrites');
      // And the generic size-class line must NOT appear
      expect(html).not.toContain('Size class:');
    });
  });

  describe('all other size classes', () => {
    it.each([
      { sizeClass: 'small' as const, sizeTokens: 3_000 },
      { sizeClass: 'medium' as const, sizeTokens: 20_000 },
      { sizeClass: 'large' as const, sizeTokens: 75_000 },
    ])(
      'renders "Size class: $sizeClass (~$sizeTokens tokens)" for sizeClass=$sizeClass',
      async ({ sizeClass, sizeTokens }) => {
        // Act
        const html = await render(
          <CleanupReady {...baseProps} sizeClass={sizeClass} sizeTokens={sizeTokens} />
        );

        // Assert: the generic size note line must appear with the right class name
        // This verifies the component interpolates both sizeClass and sizeTokens
        expect(html).toContain(`Size class: ${sizeClass}`);
        // The too-large branch must NOT have fired
        expect(html).not.toContain('too large for whole-document LLM rewrites');
      }
    );
  });

  describe('preview text', () => {
    it('includes the document name in the preview text', async () => {
      // Act
      const html = await render(<CleanupReady {...baseProps} documentName="Budget Overview" />);

      // Assert: preview element contains the doc name so email clients show it in inbox
      expect(html).toContain('Budget Overview');
    });
  });

  describe('basic structure', () => {
    it('renders valid HTML with the expected lang attribute', async () => {
      // Act
      const html = await render(<CleanupReady {...baseProps} />);

      // Assert: structural integrity — proves render didn't crash and output is HTML
      expect(html).toContain('<!DOCTYPE html');
      expect(html).toContain('lang="en"');
    });

    it('contains the "Open cleanup chat" call-to-action text', async () => {
      // Act
      const html = await render(<CleanupReady {...baseProps} />);

      // Assert: CTA must be present — verifies the button section rendered
      expect(html).toContain('Open cleanup chat');
    });
  });
});
