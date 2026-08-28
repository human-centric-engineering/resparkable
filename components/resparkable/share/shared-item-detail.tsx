'use client';

/**
 * SharedItemDetail — one item somebody shared with you, opened.
 *
 * The authenticated sibling of the public reader page, and it shares that
 * page's markdown renderer deliberately: `SharedMarkdown` defers remote images
 * behind a click, and a note reaching a **grantee** has exactly the same
 * problem as one reaching a stranger. The reader did not choose the note's
 * contents, cannot see a tracking pixel fire, and never agreed to it.
 *
 * Two things this page shows that the public one never does, both of them the
 * line §13 draws between a link and a grant:
 *
 *   • **Who shared it.** A relationship has two named ends. A document handed
 *     to the internet has one.
 *   • **Where it came from**, when the item was reached through a cascade —
 *     "shared as part of Acme Redesign" rather than presenting a task as
 *     something a person picked out and handed over.
 *
 * And one thing it deliberately does not show: any way to change anything. A
 * grant is `viewer` or `commenter`, and there is no write path behind this
 * screen to wire a button to.
 */

import * as React from 'react';

import { CommentThread } from '@/components/resparkable/share/comment-thread';
import { SharedMarkdown } from '@/components/resparkable/share/shared-markdown';
import { Badge } from '@/components/ui/badge';
import { ClientDate } from '@/components/ui/client-date';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { SharedItemDetailWire } from '@/lib/framework/resparkable/ui/payloads';
import Link from 'next/link';

const TYPE_LABEL: Record<string, string> = {
  area: 'Life area',
  goal: 'Goal',
  project: 'Project',
  review: 'Review',
  board: 'Board',
  task: 'Task',
};

/** What the cascade is called on screen, per parent type. */
const CHILDREN_HEADING: Record<string, string> = {
  project: 'Tasks in this project',
  goal: 'Goals under this one',
  board: 'Cards on this board',
};

export function SharedItemDetail({ detail }: { detail: SharedItemDetailWire }): React.ReactElement {
  const { item, owner, children } = detail;

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[11px]">
            {TYPE_LABEL[item.entityType] ?? item.entityType}
          </Badge>
          {item.status !== null && (
            <Badge variant="secondary" className="text-[11px]">
              {item.status}
            </Badge>
          )}
          {item.archived && (
            <Badge variant="outline" className="text-[11px]">
              archived by its owner
            </Badge>
          )}
        </div>

        <h1 className="text-2xl font-semibold">{item.title}</h1>

        <p className="text-muted-foreground text-sm">
          Shared with you by {owner.name ?? owner.email}
          {item.dueAt !== null && (
            <>
              {' · due '}
              <ClientDate date={item.dueAt} />
            </>
          )}
        </p>

        {detail.via !== null && (
          <p className="text-muted-foreground text-sm">
            You can see this because it is part of{' '}
            <Link
              href={RESPARKABLE_ROUTES.sharedItem(detail.via.entityType, detail.via.entityId)}
              className="underline"
            >
              something else shared with you
            </Link>
            .
          </p>
        )}

        {item.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <li key={tag}>
                <Badge variant="outline" className="text-[11px]">
                  {tag}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </header>

      {item.body !== null && item.body.length > 0 ? (
        <SharedMarkdown content={item.body} />
      ) : (
        <p className="text-muted-foreground text-sm">
          {/* Absent prose and withheld prose look identical from here, and the
              copy must not pretend to tell them apart. Saying "no description"
              when notes were withheld would be a small lie about what the
              person shared. */}
          No description was shared.
        </p>
      )}

      {!detail.includeTaskDetail && item.entityType !== 'area' && (
        <p className="text-muted-foreground text-xs">Task notes are not included in this share.</p>
      )}

      {/* Renders nothing when the basis carries no comments — a cascaded
          grant, which was never chosen for sharing by its owner, and a public
          link, which is a document rather than a relationship. The component
          asks and hides itself rather than this page re-deriving the rule the
          resolver already applied. */}
      <CommentThread
        entityType={item.entityType}
        entityId={item.id}
        canComment={detail.canComment}
        isOwner={false}
      />

      {children.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">
            {CHILDREN_HEADING[item.entityType] ?? 'Included with this'}
          </h2>

          <ul className="space-y-2">
            {children.map((child) => (
              <li key={child.id} className="bg-card space-y-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{child.title}</span>
                  {child.status !== null && (
                    <Badge variant="secondary" className="text-[11px]">
                      {child.status}
                    </Badge>
                  )}
                  {child.checklist !== null && (
                    <Badge variant="outline" className="text-[11px]">
                      {child.checklist.done}/{child.checklist.total}
                    </Badge>
                  )}
                  {child.dueAt !== null && (
                    <span className="text-muted-foreground ml-auto text-xs">
                      due <ClientDate date={child.dueAt} />
                    </span>
                  )}
                </div>
                {child.body !== null && child.body.length > 0 && (
                  <p className="text-muted-foreground text-sm">{child.body}</p>
                )}
              </li>
            ))}
          </ul>

          {detail.childrenTruncated && (
            <p className="text-muted-foreground text-xs">
              {/* Said out loud rather than left as a short list. A cap that
                  truncates silently reads as "this is everything". */}
              This is the first part of a longer list. Not everything is shown here.
            </p>
          )}
        </section>
      )}
    </article>
  );
}
