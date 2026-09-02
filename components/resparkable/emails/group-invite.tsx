/**
 * "You have been invited to join a group" (§23.3).
 *
 * ## Why this is not the share-invite template with different words
 *
 * A share invite tells somebody about access they **already have**: the grant is
 * live for their address before they open the email, and the token only binds an
 * account to it. That template is allowed to be reassuring about a forwarded
 * copy, because a forwarded copy really is inert.
 *
 * A group invite is the opposite. Until it is accepted the invitee has nothing,
 * and when it is accepted they can read and write an entire shared brain. The
 * token is the only thing between the two states. So the copy has a different
 * job: it has to say what accepting means, and it has to be honest that this is
 * a bigger door than a shared project.
 *
 * Accepting still requires being signed in as the address the invitation names,
 * which is what makes a forwarded email useless here too. That is worth saying
 * plainly rather than leaving the reader to worry about it.
 *
 * ## What the copy may not say
 *
 * **Nothing about the group's content**, for the reason the share invite never
 * names an item: a subject line lands in a preview pane, a lock screen, a shared
 * screen and a mail provider's index. The group's NAME is different and is
 * included, because "join Study Group B" is the only version of this message a
 * person can act on, and the name is what every member already tells people.
 *
 * Lives here rather than in `emails/` for the reason `share-invite.tsx` gives:
 * that directory is Sunrise-owned, this is a framework-tier email, and there is
 * no platform default for the registry to fall back to.
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

export interface GroupInviteEmailProps {
  /** The inviter's display name, or their address when they have set no name. */
  inviterName: string;
  /** The group's name. Included on purpose: see this file's header. */
  groupName: string;
  /** The address the invitation was issued to. */
  inviteeEmail: string;
  /** `member` or `viewer`. Never `admin`: that is granted inside the group. */
  role: 'member' | 'viewer';
  acceptUrl: string;
  expiresAt: Date | null;
}

export function GroupInviteEmail({
  inviterName,
  groupName,
  inviteeEmail,
  role,
  acceptUrl,
  expiresAt,
}: GroupInviteEmailProps): React.ReactElement {
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
      <Preview>{`${inviterName} invited you to join ${groupName}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You have been invited to a group</Heading>

          <Text style={text}>
            <strong>{inviterName}</strong> has invited you to join <strong>{groupName}</strong> on{' '}
            <strong>{appName}</strong>.
          </Text>

          <Section style={infoBox}>
            <Text style={infoText}>
              <strong>Invited</strong>
              <br />
              {inviteeEmail}
              <br />
              <br />
              <strong>You will be able to</strong>
              <br />
              {role === 'viewer'
                ? 'Read everything in the group workspace'
                : 'Read and add to everything in the group workspace'}
            </Text>
          </Section>

          <Section style={buttonContainer}>
            <Button href={acceptUrl} style={button}>
              Join the group
            </Button>
          </Section>

          {/* The one paragraph this template exists for. A group is a shared
              workspace, not a shared document, and somebody accepting should
              know that before they click rather than after. */}
          <Text style={text}>
            A group workspace is shared with everyone in it. Anything you add there can be seen by
            every other member, and anything they add is visible to you. Your own workspace stays
            private and separate.
          </Text>

          <Text style={text}>
            You will need to sign in with {inviteeEmail}. Nobody else can use this link, and it does
            nothing until you accept it.
          </Text>

          {expiry !== null && <Text style={text}>This invitation expires on {expiry}.</Text>}

          <Hr style={hr} />

          <Text style={footer}>
            If you were not expecting this, you can ignore this email. You will not be added to
            anything.
          </Text>

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

export default GroupInviteEmail;

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
