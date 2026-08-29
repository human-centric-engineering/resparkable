'use client';

/**
 * GoalsView — goals as a tree.
 *
 * ## Why a tree rather than a table
 *
 * `parentGoalId` exists so a life-level goal can own the quarterly ones that get you
 * there, and that structure *is* the content: a flat list of "ship the beta", "hire
 * two engineers", "be able to take a month off" tells you nothing about which serves
 * which. The nesting is the only place the hierarchy is visible.
 *
 * There is no goal detail page, deliberately — a goal is a short statement plus its
 * children, and both fit here. Editing happens in a dialog from this list.
 *
 * ## Orphan handling
 *
 * A goal whose parent was archived or deleted would be unreachable from any root and
 * would silently vanish from the tree. So anything whose parent is not in the
 * rendered set is treated as a root — a goal you cannot see is worse than one shown
 * at the wrong indent level.
 */

import * as React from 'react';
import { MessageCircle, Pencil, Plus, Target } from 'lucide-react';

import { ContextChatDrawer } from '@/components/resparkable/chat/context-chat-drawer';
import { GoalForm } from '@/components/resparkable/goals/goal-form';
import { ShareButton } from '@/components/resparkable/share/share-button';
import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { useNow } from '@/components/resparkable/ui/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, GoalWire } from '@/lib/framework/resparkable/ui/payloads';
import { useDialogEntity } from '@/lib/hooks/use-dialog-entity';
import {
  DEFAULT_SPARKEY_PRONOUN,
  getSparkeyPronounForms,
  type SparkeyPronoun,
} from '@/lib/resparkable/sparkey-pronoun';

/** Near horizons first — the order they become actionable in. */
const HORIZON_ORDER = ['week', 'month', 'quarter', 'year', 'life'];

export interface GoalsViewProps {
  goals: GoalWire[];
  areas: AreaWire[];
  /** How the app refers to Sparkey in this view's copy. Set by the server page. */
  pronoun?: SparkeyPronoun;
}

export function GoalsView({
  goals,
  areas,
  pronoun = DEFAULT_SPARKEY_PRONOUN,
}: GoalsViewProps): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const editing = useDialogEntity<GoalWire>();
  const talkingTo = useDialogEntity<GoalWire>();
  const sparkey = getSparkeyPronounForms(pronoun);

  const present = new Set(goals.map((goal) => goal.id));

  // Anything whose parent isn't in this set is a root — see the orphan note.
  const roots = goals.filter(
    (goal) => goal.parentGoalId === null || !present.has(goal.parentGoalId)
  );
  const childrenOf = new Map<string, GoalWire[]>();
  for (const goal of goals) {
    if (goal.parentGoalId && present.has(goal.parentGoalId)) {
      const bucket = childrenOf.get(goal.parentGoalId) ?? [];
      bucket.push(goal);
      childrenOf.set(goal.parentGoalId, bucket);
    }
  }

  const byHorizon = (a: GoalWire, b: GoalWire): number =>
    HORIZON_ORDER.indexOf(a.horizon) - HORIZON_ORDER.indexOf(b.horizon);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          New goal
        </Button>
      </div>

      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description={`Set a goal for something you're aiming for, with a target date if it has one. Tasks and projects linked to a goal get suggested to you sooner, and Sparkey uses your goals as context when ${sparkey.subject} helps you.`}
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Set one
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {[...roots].sort(byHorizon).map((goal) => (
            <GoalNode
              key={goal.id}
              goal={goal}
              childrenOf={childrenOf}
              depth={0}
              onEdit={editing.open}
              onTalk={talkingTo.open}
            />
          ))}
        </ul>
      )}

      <GoalForm open={createOpen} onOpenChange={setCreateOpen} goals={goals} areas={areas} />
      <GoalForm
        open={editing.entity !== null}
        onOpenChange={editing.onOpenChange}
        goals={goals}
        areas={areas}
        {...(editing.entity ? { goal: editing.entity } : {})}
      />
      {talkingTo.entity && (
        <ContextChatDrawer
          open
          onOpenChange={talkingTo.onOpenChange}
          entityType="goal"
          entityId={talkingTo.entity.id}
          entityName={talkingTo.entity.title}
          currentDescription={talkingTo.entity.description}
        />
      )}
    </div>
  );
}

function GoalNode({
  goal,
  childrenOf,
  depth,
  onEdit,
  onTalk,
}: {
  goal: GoalWire;
  childrenOf: Map<string, GoalWire[]>;
  depth: number;
  onEdit: (goal: GoalWire) => void;
  onTalk: (goal: GoalWire) => void;
}): React.ReactElement {
  const children = childrenOf.get(goal.id) ?? [];
  // `null` until mounted — reading the clock during render is impure and would
  // also let the server and the browser disagree about what is overdue.
  const now = useNow();
  const overdue =
    now !== null &&
    goal.targetDate !== null &&
    goal.status === 'active' &&
    new Date(goal.targetDate) < now;

  return (
    <li>
      <div
        className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
        // Indent by depth. Capped so a deep chain cannot push content off screen.
        style={{ marginLeft: `${Math.min(depth, 4) * 1.25}rem` }}
      >
        <span className="font-medium">{goal.title}</span>

        <Badge variant="outline" className="text-[11px]">
          {goal.horizon}
        </Badge>

        {goal.status !== 'active' && (
          <Badge variant="secondary" className="text-[11px]">
            {goal.status}
          </Badge>
        )}

        {goal.targetDate && (
          <span className={overdue ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
            {overdue ? 'was due ' : 'by '}
            <ClientDate date={goal.targetDate} />
          </span>
        )}

        {/* The 0.7 multiplier is real and otherwise invisible — a goal quietly
            pulling less than it used to reads as the ranking being wrong. */}
        {overdue && (
          <span className="text-muted-foreground text-xs">
            counting for less until you move the date or close it
          </span>
        )}

        {goal.archivedAt !== null && (
          <Badge variant="outline" className="text-[11px]">
            archived
          </Badge>
        )}

        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Tell me more about ${goal.title}`}
            onClick={() => onTalk(goal)}
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${goal.title}`}
            onClick={() => onEdit(goal)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          {/* On the node, not on the root only. §13's cascade takes a goal to
              its child goals and projects (and their tasks), so sharing a
              parent and sharing one child are different acts and both are
              things somebody means to do. Putting the control only on roots
              would make the wider of the two the easier one. */}
          <ShareButton compact entityType="goal" entityId={goal.id} title={goal.title} />
          <ArchiveControls
            collection={RESPARKABLE_API.GOALS}
            id={goal.id}
            label={goal.title}
            noun="goal"
            archived={goal.archivedAt !== null}
            compact
          />
        </span>
      </div>

      {children.length > 0 && (
        <ul className="mt-2 space-y-2">
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              childrenOf={childrenOf}
              depth={depth + 1}
              onEdit={onEdit}
              onTalk={onTalk}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
