/**
 * "A group you were in has been deleted" (§23.6).
 *
 * One of exactly three events the tier emails about (plan.md, "Notifications,
 * scoped here rather than discovered in phase 48"). It earns an email because it
 * removes something the reader was writing into, and they did not do it. Finding
 * out from a switcher entry that has quietly gone is the version to avoid.
 *
 * ## What the copy may not say
 *
 * Nothing about the group's content, for the reason every email in this tier
 * gives: a subject line lands in a preview pane, a lock screen and a mail
 * provider's index. The group's NAME is included, as it is in the invitation,
 * because a person in more than one group cannot act on "a group was deleted".
 *
 * The admin who deleted it is named. A member losing a shared workspace should
 * know who to ask about it, and every member could already see who the admins
 * were.
 *
 * Lives here rather than in `emails/` for the reason `share-invite.tsx` gives.
 */

import * as React from 'react';
import { Body, Container, Head, Heading, Hr, Html, Preview, Text } from '@react-email/components';

import { BRAND } from '@/lib/brand';

export interface GroupDeletedEmailProps {
  /** The admin's display name, or their address when they have set no name. */
  deletedByName: string;
  /** The group's name, captured before the delete. */
  groupName: string;
}

export function GroupDeletedEmail({
  deletedByName,
  groupName,
}: GroupDeletedEmailProps): React.ReactElement {
  const appName = BRAND.name;

  return (
    <Html lang="en">
      <Head />
      <Preview>{`${groupName} has been deleted`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>A group you were in has been deleted</Heading>

          <Text style={text}>
            <strong>{deletedByName}</strong> deleted <strong>{groupName}</strong> on{' '}
            <strong>{appName}</strong>.
          </Text>

          <Text style={text}>
            The group workspace and everything in it have been removed, including anything you added
            there. It cannot be restored.
          </Text>

          <Text style={text}>Your own workspace is not affected.</Text>

          <Hr style={hr} />

          <Text style={footer}>
            You are receiving this because you were a member of {groupName}. If you have questions
            about why it was deleted, {deletedByName} is the person to ask.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default GroupDeletedEmail;

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
