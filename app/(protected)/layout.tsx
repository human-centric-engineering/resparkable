import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { SparkeyPronounProvider } from '@/components/resparkable/sparkey-pronoun-provider';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { parseUserPreferences } from '@/lib/validations/user';
import { DEFAULT_SPARKEY_PRONOUN } from '@/lib/resparkable/sparkey-pronoun';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: `Dashboard - ${BRAND.name}`,
  },
  description: 'Your dashboard',
};

/**
 * Protected Layout
 *
 * Layout for all protected routes (dashboard, settings, profile, etc.)
 * Protected by proxy - unauthenticated users are redirected to /login
 *
 * Phase 3.2: Added navigation links
 * Phase 4.4: Added maintenance mode support
 */
export default async function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const sparkeyPronoun = await getSparkeyPronoun();

  return (
    <MaintenanceWrapperWithAdminNotice>
      {/* `.lattice-field-hex` (brand-theme.css) replaces the flat `bg-background`:
          the same base colour and warm top-left bloom as `.lattice-field`, but
          with the honeycomb grid used on the public marketing pages instead of
          the square one — same ground across authenticated and public surfaces.
          It sets its own background-color, so the utility would only fight it. */}
      <div className="lattice-field-hex flex min-h-screen flex-col">
        {/* Full-bleed: this is an application, not a document. `container`
            capped it at the largest breakpoint and centred the remainder, which
            on a wide display spent ~450px on empty margins while the app's own
            sidebar sat mid-screen. See `.app-shell` in `globals.css`. */}
        <AppHeader logoHref={AUTH_LANDING_ROUTE} navigation={<ProtectedNav />} fullWidth />
        <SparkeyPronounProvider pronoun={sparkeyPronoun}>
          <main className="app-shell flex-1 py-8">{children}</main>
        </SparkeyPronounProvider>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}

/**
 * Every protected page renders through this layout, so this is the one place
 * to resolve the user's Sparkey pronoun preference once and hand it down via
 * context, rather than each component that mentions Sparkey fetching it itself.
 */
async function getSparkeyPronoun() {
  const session = await getServerSession();
  if (!session) return DEFAULT_SPARKEY_PRONOUN;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  if (!user) return DEFAULT_SPARKEY_PRONOUN;

  return parseUserPreferences(user.preferences).sparkey.pronoun;
}
