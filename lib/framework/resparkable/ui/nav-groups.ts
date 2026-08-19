/**
 * The Resparkable section registry — grouped nav items, extracted from
 * `resparkable-nav.tsx` so it can be consumed without pulling in a client
 * component (or its `'use client'` boundary).
 *
 * This is the product's own model of its sections, not a tidying exercise:
 * things you open every day, the structure you file work under, the
 * material and its links, and the two administrative surfaces. It backs the
 * rail (`ResparkableNav`), the section header's eyebrow (`SectionHeader`),
 * `section-help.ts`'s coverage test, and — from Phase 2 on — the Workspace
 * launcher's grouped picker.
 *
 * @see components/resparkable/layout/resparkable-nav.tsx
 */

import {
  CalendarRange,
  Compass,
  FileText,
  FolderKanban,
  FolderSync,
  Inbox,
  LayoutGrid,
  Link2,
  MessageSquare,
  Settings,
  Share2,
  Sun,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
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
      { href: RESPARKABLE_ROUTES.CHAT, label: 'Ask Sparkey', icon: MessageSquare },
    ],
  },
  {
    label: 'Organise',
    items: [
      { href: RESPARKABLE_ROUTES.PROJECTS, label: 'Projects', icon: FolderKanban },
      { href: RESPARKABLE_ROUTES.GOALS, label: 'Goals', icon: Target },
      { href: RESPARKABLE_ROUTES.AREAS, label: 'Life', icon: Compass },
      { href: RESPARKABLE_ROUTES.BOARDS, label: 'Boards', icon: LayoutGrid },
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
