// @vitest-environment happy-dom

/**
 * SoleAdminEmail: says what the group's setting will actually do, links to the
 * group, and names nobody (the successor can change before it is read).
 *
 * @see components/resparkable/emails/sole-admin.tsx
 */

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';

import { SoleAdminEmail } from '@/components/resparkable/emails/sole-admin';

const PROPS = {
  groupName: 'Study Group B',
  viewersCanInheritAdmin: true,
  groupUrl: 'https://app.example/resparkable/groups/grp_1',
};

describe('SoleAdminEmail', () => {
  it('names the group and links to it', async () => {
    const html = await render(<SoleAdminEmail {...PROPS} />);

    expect(html).toContain('You are the only admin of Study Group B');
    expect(html).toContain('href="https://app.example/resparkable/groups/grp_1"');
  });

  it('says a viewer can inherit when the group allows it', async () => {
    const html = await render(<SoleAdminEmail {...PROPS} />);

    expect(html).toContain('That can be a viewer.');
    expect(html).not.toContain('Viewers are skipped');
  });

  it('says what happens when viewers are skipped and only viewers are left', async () => {
    const html = await render(<SoleAdminEmail {...PROPS} viewersCanInheritAdmin={false} />);

    expect(html).toContain('Viewers are skipped');
    expect(html).toContain('nobody becomes admin');
  });
});
