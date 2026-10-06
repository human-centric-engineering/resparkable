/**
 * "Your membership of a group changed" (§23.13, phase 58).
 *
 * The second of exactly three things the tier emails about: a group was
 * deleted, your membership or role changed, and the admin-only budget
 * thresholds. It earns an email because somebody else did something to the
 * reader's access, and finding out from a switcher entry that has moved or
 * gone is the version to avoid. Nothing the reader did themselves is emailed:
 * leaving, accepting an invitation, or any content activity.
 *
 * Three changes, one template: a role changed, the reader was removed, or
 * their request to join was approved.
 *
 * ## What the copy may not say
 *
 * Nothing about the group's content, for the reason every email in this tier
 * gives: a subject line lands in a preview pane, a lock screen and a mail
 * provider's index. The group's name is included, as in the invitation,
 * because a person in more than one group cannot act on "a group". The admin
 * is named, because the reader should know who to ask.
 *
 * Lives here rather than in `emails/` for the reason `share-invite.tsx` gives.
 */

import * as React from 'react';
import { Body, Container, Head, Heading, Hr, Html, Preview, Text } from '@react-email/components';

import { BRAND } from '@/lib/brand';

export type MembershipChange =
  | { kind: 'role_changed'; from: string; to: string }
  | { kind: 'removed' }
  | { kind: 'join_approved'; role: string };

export interface MembershipChangedEmailProps {
  /** The admin's display name, or their address when they have set no name. */
  changedByName: string;
  groupName: string;
  change: MembershipChange;
}

/** What a role lets the reader do, in a sentence. Never the internal word alone. */
const ROLE_MEANS: Record<string, string> = {
  admin: 'an admin, so you can manage its members and settings as well as add to it',
  member: 'a member, so you can read and add to everything in it',
  viewer: 'a viewer, so you can read everything in it but not change it',
};

function roleSentence(role: string): string {
  return ROLE_MEANS[role] ?? `a ${role}`;
}

/** The subject line, kept beside the copy so the two cannot disagree. */
export function membershipChangedSubject(groupName: string, change: MembershipChange): string {
  switch (change.kind) {
    case 'role_changed':
      return `Your role in ${groupName} has changed`;
    case 'removed':
      return `You have been removed from ${groupName}`;
    case 'join_approved':
      return `You have joined ${groupName}`;
  }
}

export function MembershipChangedEmail({
  changedByName,
  groupName,
  change,
}: MembershipChangedEmailProps): React.ReactElement {
  const appName = BRAND.name;
  const subject = membershipChangedSubject(groupName, change);

  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{subject}</Heading>

          {change.kind === 'role_changed' && (
            <Text style={text}>
              <strong>{changedByName}</strong> changed your role in <strong>{groupName}</strong> on{' '}
              <strong>{appName}</strong>. You are now {roleSentence(change.to)}.
            </Text>
          )}

          {change.kind === 'removed' && (
            <>
              <Text style={text}>
                <strong>{changedByName}</strong> removed you from <strong>{groupName}</strong> on{' '}
                <strong>{appName}</strong>. You can no longer open its workspace.
              </Text>
              <Text style={text}>
                Anything you added there stays with the group. Your own workspace is not affected.
              </Text>
            </>
          )}

          {change.kind === 'join_approved' && (
            <Text style={text}>
              <strong>{changedByName}</strong> accepted your request to join{' '}
              <strong>{groupName}</strong> on <strong>{appName}</strong>. You are{' '}
              {roleSentence(change.role)}. It is in the workspace switcher now.
            </Text>
          )}

          <Hr style={hr} />

          <Text style={footer}>
            You are receiving this because an admin of {groupName} changed your membership. If you
            have questions about it, {changedByName} is the person to ask.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default MembershipChangedEmail;

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
