// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { BRAND } from '@/lib/brand';
import WelcomeEmail from '@/emails/welcome';

// Read `BRAND.name` rather than naming the product. tests/setup.ts pins the
// brand seam to null for the whole suite, so the name these templates render is
// the unconfigured default, not this fork's — and hard-coding either one makes
// the case a statement about the pin instead of about the template. The fork's
// real brand is rendered through every surface in
// tests/unit/brand-fork-surfaces.test.tsx.

describe('WelcomeEmail', () => {
  const defaultProps = {
    userName: 'John Doe',
    userEmail: 'john@example.com',
    baseUrl: 'https://example.com',
  };

  it('should render with all required props', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain(`Welcome to ${BRAND.name}!`);
    expect(html).toContain('John Doe');
    expect(html).toContain('john@example.com');
  });

  it('should include preview text', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain(`Welcome to ${BRAND.name} - Let&#x27;s get started`);
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('lang="en"');
  });

  it('should include CTA button with dashboard href using baseUrl', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain('https://example.com/dashboard');
    expect(html).toContain('Get Started');
  });

  it('should render without errors', () => {
    expect(() => render(<WelcomeEmail {...defaultProps} />)).not.toThrow();
  });

  it('should display user name in greeting', async () => {
    const html = await render(
      <WelcomeEmail
        userName="Alice Smith"
        userEmail="alice@example.com"
        baseUrl="https://example.com"
      />
    );

    expect(html).toContain('Alice Smith');
  });

  it('should display user email in footer', async () => {
    const html = await render(
      <WelcomeEmail
        userName="Bob"
        userEmail="bob.jones@testcompany.com"
        baseUrl="https://example.com"
      />
    );

    expect(html).toContain('bob.jones@testcompany.com');
  });

  it('should include welcome message content', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain('production-ready Next.js starter template');
    expect(html).toContain('rapid application development');
  });

  it('should include footer text', async () => {
    const html = await render(<WelcomeEmail {...defaultProps} />);

    expect(html).toContain('If you have any questions');
  });
});
