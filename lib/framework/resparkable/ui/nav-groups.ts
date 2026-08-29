/**
 * The Resparkable section registry — the grouped list of everything the app
 * has a section for.
 *
 * This is the product's own model of its sections, not a tidying exercise:
 * things you open every day, the structure you file work under, the
 * material and its links, and the two administrative surfaces. It backs the
 * Workspace launcher's grouped picker, the section header's eyebrow
 * (`SectionHeader`), and `section-help.ts`'s coverage test.
 *
 * It was extracted from the old `resparkable-nav.tsx` rail so it could be
 * consumed without pulling in a client component, which is what let that rail
 * be deleted at the shell cutover's cleanup without taking the section model
 * with it. The rail is gone; this is what it left behind.
 *
 * There is deliberately no Ask Sparkey entry any more. Sparkey is a permanent
 * pane in the shell rather than a place you navigate to, `/resparkable/chat`
 * is a redirect, and a launcher tile for it would have been a tile that opens
 * nothing.
 */

import {
  CalendarRange,
  Compass,
  FileText,
  FolderKanban,
  FolderSync,
  Inbox,
  Handshake,
  LayoutGrid,
  Link2,
  Settings,
  Send,
  Share2,
  Sun,
  Target,
  Users,
} from 'lucide-react';
import type * as React from 'react';

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface NavItem {
  href: string;
  label: string;
  /**
   * Typed to the shape every call site here actually uses (`className`,
   * `aria-hidden`) rather than to `LucideIcon`. That was originally to admit
   * `SparkIcon` alongside the Lucide set for the retired Ask Sparkey entry;
   * it stays because it is the smaller, truer contract, and because the
   * launcher renders these icons through it without needing anything more.
   */
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  /** Index route — match exactly, or it lights up everywhere. */
  exact?: boolean;
}

export interface NavGroup {
  /** One word, plain English, and true of every item under it. */
  label: string;
  items: NavItem[];
}

/**
 * The four groups, in the order the product is used: what you do today, where
 * you file it, what it connects to, and the two surfaces you visit on purpose.
 */
export const RESPARKABLE_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Daily',
    items: [
      { href: RESPARKABLE_ROUTES.TODAY, label: 'Today', icon: Sun, exact: true },
      { href: RESPARKABLE_ROUTES.INBOX, label: 'Inbox', icon: Inbox },
      { href: RESPARKABLE_ROUTES.PLAN, label: 'Plan', icon: CalendarRange },
    ],
  },
  {
    label: 'Organise',
    items: [
      { href: RESPARKABLE_ROUTES.PROJECTS, label: 'Projects', icon: FolderKanban },
      { href: RESPARKABLE_ROUTES.GOALS, label: 'Goals', icon: Target },
      { href: RESPARKABLE_ROUTES.AREAS, label: 'Life', icon: Compass },
      { href: RESPARKABLE_ROUTES.BOARDS, label: 'Boards', icon: LayoutGrid },
      // Under Organise rather than Daily. It is a place you go when you want
      // somebody else's material, not part of the loop you run every morning —
      // and putting it in Daily would start blurring the line the whole access
      // layer is built to keep sharp between your work and theirs.
      { href: RESPARKABLE_ROUTES.SHARED, label: 'Shared with me', icon: Handshake },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { href: RESPARKABLE_ROUTES.DOCUMENTS, label: 'Documents', icon: FileText },
      { href: RESPARKABLE_ROUTES.ENTITIES, label: 'People', icon: Users },
      { href: RESPARKABLE_ROUTES.CONNECTIONS, label: 'Connections', icon: Link2 },
      { href: RESPARKABLE_ROUTES.GRAPH, label: 'Graph', icon: Share2 },
    ],
  },
  {
    label: 'Manage',
    items: [
      // Under Manage rather than beside "Shared with me" in Organise, and the
      // two really are different jobs. That one is a place you go to read
      // somebody else's material; this one is a place you go to audit and
      // close your own outbound shares, which is housekeeping and sits with
      // the vault and the settings.
      { href: RESPARKABLE_ROUTES.SHARING, label: 'Shared by me', icon: Send },
      { href: RESPARKABLE_ROUTES.VAULT, label: 'Vault', icon: FolderSync },
      { href: RESPARKABLE_ROUTES.SETTINGS, label: 'Settings', icon: Settings },
    ],
  },
];

/**
 * Every section, flattened.
 *
 * Exported so `section-help.test.ts` can assert each one has an explanation. A
 * nav entry with no help entry loses its heading *and* its ⓘ, and nothing else
 * would catch that. Derived rather than hand-maintained, so a section added to a
 * group cannot slip past that test by being absent from a second list.
 */
export const RESPARKABLE_NAV_ITEMS: NavItem[] = RESPARKABLE_NAV_GROUPS.flatMap(
  (group) => group.items
);
