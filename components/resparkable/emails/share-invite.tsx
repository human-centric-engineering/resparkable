/**
 * "Someone shared something with you" — the named-grant invite (§13).
 *
 * ## Two deviations from the plan, both deliberate
 *
 * **It lives here, not in `emails/`.** §13 named the file
 * `emails/resparkable-share-invite.tsx`, but `emails/` is Sunrise-owned: every
 * template in it is a platform default a fork may override through
 * `lib/email/registry.ts`. This is a **framework-tier** email, and the tier's
 * own precedent is already set by `capabilities/notify.ts`, which imports a
 * component directly and hands it to `sendEmail({ react })`. Adding a
 * Resparkable-specific template to a core directory would be a merge conflict
 * inflicted on every host project for no gain, and the registry buys nothing
 * here: there is no platform default to fall back to.
 *
 * **It is not registered as an `EmailKind`.** The registry exists so a fork can
 * override an email the *platform* sends. Nothing outside this tier sends this
 * one.
 *
 * ## What the copy is not allowed to say
 *
 * **It never names the item.** Not the project's title, not the board's name.
 * The subject line and the body of an email land in a preview pane, a
 * notification bar, a shared screen and a mail provider's index — and the whole
 * point of the access layer is that the content is behind a resolution. An email
 * that put the title in the subject would leak it to everyone who never clicked.
 *
 * **It says the invitation grants nothing.** A leaked invite email is useless
 * without the mailbox it was sent to, because the token binds an account to a
 * grant that already exists rather than creating access. That is a real property
 * of the design and worth telling the reader, because "someone forwarded me this
 * link" is otherwise a frightening sentence.
 */

import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

import { BRAND } from '@/lib/brand';

export interface ShareInviteEmailProps {
  /** The owner's display name, or their address when they have set no name. */
  sharerName: string;
  /** The address the grant was issued to. Shown so a reader on two accounts knows which. */
  inviteeEmail: string;
  /** What kind of thing was shared — "project", "board". Never its title. */
  itemKind: string;
  /** Whether they can comment as well as read. */
  canComment: boolean;
  acceptUrl: string;
  expiresAt: Date | null;
}

export function ShareInviteEmail({
  sharerName,
  inviteeEmail,
  itemKind,
  canComment,
  acceptUrl,
  expiresAt,
}: ShareInviteEmailProps): React.ReactElement {
  const appName = BRAND.name;

  const expiry =
    expiresAt === null
      ? null
      : new Date(expiresAt).toLocaleString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });

  return (
    <Html lang="en">
      <Head />
      {/* The preview text a mail client shows beside the subject. Same rule as
          the subject: it names the kind of thing, never the thing. */}
      <Preview>{`${sharerName} shared a ${itemKind} with you`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Something has been shared with you</Heading>

          <Text style={text}>
            <strong>{sharerName}</strong> has shared a {itemKind} with you on{' '}
            <strong>{appName}</strong>.
          </Text>

          <Section style={infoBox}>
            <Text style={infoText}>
              <strong>Shared with</strong>
              <br />
              {inviteeEmail}
              <br />
              <br />
              <strong>You can</strong>
              <br />
              {canComment ? 'Read it and leave comments' : 'Read it'}
            </Text>
          </Section>

          <Section style={buttonContainer}>
            <Button href={acceptUrl} style={button}>
              Open it
            </Button>
          </Section>

          <Text style={text}>
            You will need to sign in with {inviteeEmail}. This link does not give anyone else
            access: it only connects your account to the share, which was already made to your
            address.
          </Text>

          {expiry !== null && <Text style={text}>Access ends on {expiry}.</Text>}

          <Text style={text}>
            {sharerName} can withdraw this at any time. Shared items are read-only, and you will
            only ever see what was shared with you.
          </Text>

          <Hr style={hr} />

          <Text style={footer}>
            If you were not expecting this, you can ignore this email. Nothing happens until you
            open it.
          </Text>

          {/* The plain-link fallback every template here carries, for clients
              that strip buttons. */}
          <Text style={footer}>
            If the button does not work, copy this into your browser:
            <br />
            <span style={link}>{acceptUrl}</span>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default ShareInviteEmail;

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '580px',
};

const h1: React.CSSProperties = {
  color: '#333',
  fontSize: '28px',
  fontWeight: '700',
  lineHeight: '40px',
  margin: '0 0 24px',
  padding: '0 48px',
  textAlign: 'center' as const,
};

const text: React.CSSProperties = {
  color: '#333',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
  padding: '0 48px',
};

const infoBox: React.CSSProperties = {
  backgroundColor: '#f0f4ff',
  borderRadius: '5px',
  margin: '24px 48px',
  padding: '16px',
};

const infoText: React.CSSProperties = {
  color: '#333',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0',
};

const buttonContainer: React.CSSProperties = {
  padding: '27px 48px',
  textAlign: 'center' as const,
};

const button: React.CSSProperties = {
  backgroundColor: '#5469d4',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 32px',
};

const hr: React.CSSProperties = {
  borderColor: '#e6ebf1',
  margin: '32px 0',
};

const footer: React.CSSProperties = {
  color: '#8898aa',
  fontSize: '14px',
  lineHeight: '24px',
  margin: '16px 0',
  padding: '0 48px',
};

const link: React.CSSProperties = {
  color: '#5469d4',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};
