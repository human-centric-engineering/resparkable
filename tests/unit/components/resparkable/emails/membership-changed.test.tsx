/**
 * Unit Tests: the "your membership changed" email (phase 58, §23.13).
 *
 * @see components/resparkable/emails/membership-changed.tsx
 */

import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';

import {
  MembershipChangedEmail,
  membershipChangedSubject,
} from '@/components/resparkable/emails/membership-changed';

const BASE = { changedByName: 'Sam', groupName: 'Study group' };

describe('MembershipChangedEmail', () => {
  it('says what the new role lets the reader do, not just its name', async () => {
    const html = await render(
      <MembershipChangedEmail
        {...BASE}
        change={{ kind: 'role_changed', from: 'member', to: 'viewer' }}
      />
    );

    expect(html).toContain('Sam');
    expect(html).toContain('Study group');
    expect(html).toContain('read everything in it but not change it');
  });

  it('tells a removed member their work stays with the group and their own workspace is untouched', async () => {
    const html = await render(<MembershipChangedEmail {...BASE} change={{ kind: 'removed' }} />);

    expect(html).toContain('removed you from');
    expect(html).toContain('Anything you added there stays with the group');
  });

  it('tells somebody who asked to join that they are in', async () => {
    const html = await render(
      <MembershipChangedEmail {...BASE} change={{ kind: 'join_approved', role: 'member' }} />
    );

    expect(html).toContain('accepted your request to join');
    expect(html).toContain('read and add to everything in it');
  });

  it('falls back to the role’s own word for a role it does not describe', async () => {
    const html = await render(
      <MembershipChangedEmail
        {...BASE}
        change={{ kind: 'role_changed', from: 'member', to: 'editor' }}
      />
    );

    expect(html).toContain('a editor');
  });
});

describe('membershipChangedSubject', () => {
  it('names the group and the change, and nothing in the group', () => {
    expect(
      membershipChangedSubject('Study group', { kind: 'role_changed', from: 'a', to: 'b' })
    ).toBe('Your role in Study group has changed');
    expect(membershipChangedSubject('Study group', { kind: 'removed' })).toBe(
      'You have been removed from Study group'
    );
    expect(membershipChangedSubject('Study group', { kind: 'join_approved', role: 'member' })).toBe(
      'You have joined Study group'
    );
  });
});
