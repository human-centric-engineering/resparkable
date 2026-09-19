/**
 * "You are the only admin of this group" (succession, phase 48 follow-up).
 *
 * Falls under plan.md's "your membership or role changed", one of the three
 * kinds of event the tier emails about. Nobody else's action announces this
 * one: a person becomes the only admin because another admin left, was
 * demoted, or closed their account, or because the sweep promoted them. What it
 * tells them is the one consequence of that they would not otherwise know about,
 * which is what happens to the role if they close their own account.
 *
 * Sent once per membership. The group page carries the same notice, naming the
 * member who would inherit, for as long as it stays true. The email does not
 * name anybody, because by the time it is read that answer may have changed.
 *
 * ## What the copy may not say
 *
 * Nothing about the group's content, for the reason every email in this tier
 * gives. The group's name only, as in the invitation and the deletion notice.
 *
 * Lives here rather than in `emails/` for the reason `share-invite.tsx` gives.
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

export interface SoleAdminEmailProps {
  groupName: string;
  /** The group's setting, so the email describes what will actually happen. */
  viewersCanInheritAdmin: boolean;
  /** Absolute URL of the group's page, where the setting lives. */
  groupUrl: string;
}

export function SoleAdminEmail({
  groupName,
  viewersCanInheritAdmin,
  groupUrl,
}: SoleAdminEmailProps): React.ReactElement {
  const appName = BRAND.name;

  return (
    <Html lang="en">
      <Head />
      <Preview>{`You are the only admin of ${groupName}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You are the only admin of {groupName}</Heading>

          <Text style={text}>
            You are now the only admin of <strong>{groupName}</strong> on <strong>{appName}</strong>
            .
          </Text>

          <Text style={text}>
            If you close your account, the person who has been in the group longest becomes admin in
            your place.{' '}
            {viewersCanInheritAdmin
              ? 'That can be a viewer.'
              : 'Viewers are skipped. If only viewers are left, nobody becomes admin, and nobody will be able to invite people, change roles or delete the group.'}
          </Text>

          <Text style={text}>
            You can change whether a viewer can become admin in the group&apos;s settings. You can
            also make someone else an admin now, so the group never depends on this.
          </Text>

          <Section style={buttonContainer}>
            <Button href={groupUrl} style={button}>
              Open the group
            </Button>
          </Section>

          <Hr style={hr} />

          <Text style={footer}>
            You are receiving this because you are an admin of {groupName}. We send it once.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default SoleAdminEmail;

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
