# Phase 57: joining, which is not the same as being invited

**Scoped 2026-09-25.** The specification is [`plan.md`](./plan.md) §23.11, and it
stays the specification. The route is [`release-9-plan.md`](./release-9-plan.md)'s
Branch 4. This document is the design: what the phase decides, where it departs
from either of those and why, and what it deliberately does not do. Where this
document and §23.11 disagree, §23.11 wins and this document is wrong.

Acceptance: test 13i, and "a pending member resolves to no scope at all".

## What phase 46 already left for this phase

- `ResparkableGroup.maxMembers` (default 50), landed and read by nothing.
- `ResparkableGroupMember.joinedAt` nullable, with every reader already treating
  `null` as "not in": `resolveGroupSpaceScope`, `resolveGroupMembership`,
  `countAdmins`, `listMemberContacts`, succession, erasure, the switcher.
- `acceptInviteAndJoin` already admits a pending row when an invitation arrives
  for somebody who asked to join.

So the phase adds the link, the redemption, the approval, and the cap. The
"pending resolves to nothing" half of 13i is already true, and this phase adds
the tests that hold it.

## Decision 1: a fourth table, with no person on it

`ResparkableGroupJoinLink`: `groupId` (cascades from the group), `tokenHash
@unique`, `tokenPrefix`, `role`, `approval`, `maxUses`, `useCount`, `expiresAt`,
`revokedAt`, `createdAt`.

**No `createdByUserId`.** §23.11 does not ask for it, every admin sees and can
revoke every link, and "who minted this" is an audit question that phase 58's
`ResparkableGroupAuditEntry` answers for every admin action at once. Leaving it
off means the table holds no reference to a person, so it needs no hand-written
FK, no drift probe, no Art. 15 section and no erasure hook. It is declared
`excluded` from the subject export with that reason, and non-transferable in
`transfer/policy.ts` for the invite's reason: the digest is a live credential for
a group the far side has never heard of.

A joiner's membership row takes `invitedByUserId: null`. Nobody invited them;
they held a link.

## Decision 2: the role is fixed at mint and can never be `admin`

Refused at the boundary (`role: z.enum(['member', 'viewer'])`, so `admin` is a
400 at the mint route) and again in the service, so a caller that skips the
schema still cannot mint one. There is no route that changes a link's role
afterwards; a different role is a different link.

## Decision 3: approval defaults by role, and the admin may override

`approval` is `open` or `request`. The default is `request` for `member` and
`open` for `viewer`, which is §23.11's "request is the default for any link
conferring more than viewer". The admin may choose either for either role.

## Decision 4: redemption is one transaction behind a row lock

Checking the cap and then inserting is a race: thirty people opening an open link
in the same minute would all see 49 members and all get in. So redemption takes
`SELECT ... FOR NO KEY UPDATE` on the group row (strong enough to serialise the lockers, weak enough not to block foreign-key inserts), then, in order:

1. The link is live (`isShareActive`, not revoked, uses left), else `unknown`.
2. An existing joined row answers `already_member`; an existing pending row
   answers `already_requested` for a link that needs an admin, and is let in by
   a link that joins straight away (Decision 5a). **The first two consume no
   use.** This is what makes
   "the same account cannot redeem twice" true without a second table: the
   membership unique already holds one row per person per group.
3. Joined members at or over `maxMembers` answers `group_full`, and stamps
   `joinRefusedFullAt` on the group (Decision 6).
4. The use is consumed by compare-and-set (`useCount < maxUses` in the `where`),
   and a loss is `unknown`.
5. The membership row is written: `joinedAt: now` for `open`, `joinedAt: null`
   and `requestedAt: now` for `request`.

Every failure that is about the token (malformed, unknown, expired, revoked, used
up) is one answer, `unknown`, for the reason every token path in this tier gives:
anything distinguishable is an oracle about which links once existed. A request
that fails because the group is full says so, because the holder of a live link
is somebody the admin chose to let knock.

## Decision 5: approving, rejecting, withdrawing

- **Approve** (admin): the same lock, the cap re-checked, then `joinedAt` stamped
  on a row that is still pending. A request approved into a full group is refused
  with `group_full`, and the admin can raise the cap first.
- **Reject** (admin): the pending row is deleted. Nothing is left behind, as
  §23.11 asks.
- **Withdraw** (the person who asked): the same delete, through the existing
  `DELETE /members/[own id]`.
- **A pending row's role cannot be changed.** The link fixed it; the only way to
  a different role is to approve and then change it as a member.

`removeMember` had a latent bug this phase would have made reachable: it counted
only joined members for "last member out", so an admin rejecting the only pending
request in a group where they were the only joined member took the "last member"
branch and **deleted the group**. A pending target now short-circuits to a plain
delete before any of that logic runs.

## Decision 5a: somebody waiting who is then invited, or sent an instant link (decided 2026-09-25)

Priya clicks a link that needs an admin to let her in, so she is waiting. Before
anyone answers, an admin invites her by email, or sends her a link that joins
straight away. **She is let in, at the role the newer invitation or link names.**
An admin choosing her is a later and more deliberate act than the link she first
clicked. Another link that needs an admin changes nothing: she is already waiting.

## Decision 5b: turning somebody down gives their place on the link back (decided 2026-09-25)

A request uses one of its link's places when it is filed. If it is turned down
or withdrawn, the place is returned, so strangers holding a forwarded link cannot
use up every place and leave the people it was meant for locked out.
`ResparkableGroupMember.joinLinkId` records which link a waiting request came
through (`SetNull` if the link goes); the delete and the refund are one
transaction. A request that ends in the person getting in, by approval, by
invitation or by an instant link, keeps its use spent.

Erasing the person asking returns the place too (decided 2026-09-26, from the
PR gates). The cascade removes their pending row without going through the
delete above, so `settleGroupsAfterErasure` gives the uses back first, inside
the erasure transaction (`returnJoinLinkUsesForErasure`).

Revoking a link leaves the requests already filed through it waiting (decided
2026-09-26). Revoking stops new people; the admin still decides on each person
who already asked, and nobody gets in without that decision.

## Decision 5c: admins see a requester's name, not their address (decided 2026-09-25)

Deciding whether to let somebody in is blind if all the admin sees is an account
id. `GET /groups/[id]` gives admins the account name of each person asking to
join (`findAccountNames`), and never the email address. Joined members are
unchanged: ids, as before.

## Decision 6: "tells the admin" is in-app, not email

§23.13 says exactly three events earn an email, and a full group turning somebody
away is not one of them. `ResparkableGroup.joinRefusedFullAt` is stamped on each
refusal and shown to admins on the group page ("Somebody was turned away because
the group is full"), and cleared when an admin changes `maxMembers`. A pending
request is also in-app only: the admin sees it in the Requests list. The
"your membership changed" email to an approved joiner is one of phase 58's three
templates and lands there.

## Decision 7: the cap governs links, not invitations

An invitation is an admin naming one person, and the admin can see the count
beside the invite box. The cap exists because an open link is a mailing list
with a shared vector index; it governs redemption and approval, which are the
link's two ways in. Invitations are unchanged.

## Decision 8: two rate-limit tiers, both daily, both on the session user

- `resparkable-join-link`: 20/day on `POST /groups/[id]/join-links`. The rule
  skips other methods, so an admin loading the list does not spend it (the rule
  falls through to the section's 100/min).
- `resparkable-join`: 30/day on `POST /groups/join`, the redemption. The token is
  a path a signed-in stranger presents, and 192 bits is the real defence; the cap
  is so that a loop cannot make the attempt at all.

The join page is a client page that POSTs, like the invite page, so the cap
lands on the API and there is no server-side redemption for it to miss.

## What this phase does not do

- **A public group directory.** Declined in §23.11, not deferred.
- **Emails** for requests, approvals or refusals (Decision 6).
- **An audit log** of link minting and approvals. Phase 58.
- **Capping invitations** (Decision 7).
