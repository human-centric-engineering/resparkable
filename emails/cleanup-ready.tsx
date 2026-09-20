import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

interface CleanupReadyProps {
  documentName: string;
  cleanupUrl: string;
  sizeClass: 'small' | 'medium' | 'large' | 'too-large';
  sizeTokens: number;
}

export function CleanupReady({
  documentName,
  cleanupUrl,
  sizeClass,
  sizeTokens,
}: CleanupReadyProps): React.ReactElement {
  const sizeNote =
    sizeClass === 'too-large'
      ? 'This document is too large for whole-document LLM rewrites — deterministic strips and per-section rewrites still work.'
      : `Size class: ${sizeClass} (~${sizeTokens.toLocaleString()} tokens).`;

  return (
    <Html lang="en">
      <Head />
      <Preview>Document Clean Up session ready: {documentName}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>Document Clean Up</Text>
            <Text style={label}>{documentName}</Text>
            <Hr style={divider} />
            <Text style={text}>
              You opened a Document Clean Up session. The cleanup chat is ready whenever you are —
              your session is saved, so you can come back to it at any time.
            </Text>
            <Text style={text}>{sizeNote}</Text>
            <Section style={{ textAlign: 'center', margin: '24px 0 8px' }}>
              <Button href={cleanupUrl} style={button}>
                Open cleanup chat
              </Button>
            </Section>
            <Text style={fineprint}>
              Until you click <strong>Mark cleaned</strong> or <strong>Use original</strong>, the
              document stays in the <em>Cleaning</em> tab of your knowledge base and won&apos;t be
              searchable by your agents.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default CleanupReady;

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '40px 20px',
  maxWidth: '560px',
};

const section: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  padding: '32px',
  border: '1px solid #e5e7eb',
};

const heading: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: '600',
  color: '#111827',
  margin: '0 0 8px',
};

const label: React.CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  margin: '0 0 16px',
};

const divider: React.CSSProperties = {
  borderColor: '#e5e7eb',
  margin: '16px 0',
};

const text: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '22px',
  color: '#374151',
  margin: '0 0 12px',
};

const fineprint: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: '#6b7280',
  margin: '12px 0 0',
};

const button: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  borderRadius: '6px',
  padding: '10px 24px',
  fontSize: '14px',
  fontWeight: '600',
  textDecoration: 'none',
  display: 'inline-block',
};
