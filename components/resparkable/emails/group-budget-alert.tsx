/**
 * The two admin-only budget alerts (§23.12, phase 50).
 *
 * One of the three kinds of event the tier emails about (§23.13). Sent to the
 * group's admins only. Members see the balance in the app and hear nothing
 * about who spent it: that line is 23.8's, reached through the invoice.
 *
 * ## What the copy may not say
 *
 * Who spent, for the reason above, and nothing about the group's content. The
 * group's name and two numbers. An admin who wants to know which run it was
 * opens the budget, where per-person spend is theirs to see.
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

export type GroupBudgetAlertKind = 'low_balance' | 'large_run';

export interface GroupBudgetAlertEmailProps {
  kind: GroupBudgetAlertKind;
  groupName: string;
  /** Credits left after the run that tripped the alert, already rounded. */
  balanceCredits: number;
  /** `low_balance`: the mark it fell to. `large_run`: what the one run cost. */
  figureCredits: number;
  /** Absolute URL of the group's page, where the budget lives. */
  groupUrl: string;
}

export function groupBudgetAlertSubject(kind: GroupBudgetAlertKind, groupName: string): string {
  return kind === 'low_balance'
    ? `${groupName} is running low on credits`
    : `One run in ${groupName} used a large share of its credits`;
}

export function GroupBudgetAlertEmail({
  kind,
  groupName,
  balanceCredits,
  figureCredits,
  groupUrl,
}: GroupBudgetAlertEmailProps): React.ReactElement {
  const subject = groupBudgetAlertSubject(kind, groupName);

  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{subject}</Heading>

          {kind === 'low_balance' ? (
            <Text style={text}>
              <strong>{groupName}</strong> has {balanceCredits} credits left, at or below the{' '}
              {figureCredits} you asked to hear about. When it reaches zero, nobody in the group can
              use features that cost credits until it is topped up.
            </Text>
          ) : (
            <Text style={text}>
              One run in <strong>{groupName}</strong> used {figureCredits} credits. The group has{' '}
              {balanceCredits} left.
            </Text>
          )}

          <Text style={text}>
            You can top up the balance, change these alerts, or set a daily limit for a member from
            the group&apos;s page.
          </Text>

          <Section style={buttonContainer}>
            <Button href={groupUrl} style={button}>
              Open the group
            </Button>
          </Section>

          <Hr style={hr} />

          <Text style={footer}>
            You are receiving this because you are an admin of {groupName} and this alert is
            switched on. Members of the group are not sent it.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default GroupBudgetAlertEmail;

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
