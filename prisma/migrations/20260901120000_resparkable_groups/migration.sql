-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable groups (Release 9, phase 46): a principal that owns a workspace.
--
-- Purely additive. Three new tables, no existing table altered, no row
-- rewritten. Phase 45 did all the structural work: `spaceId` is already the key
-- on the parent and all 23 satellites, `kind` already distinguishes a group
-- space from a personal one, and probe B12 already makes "a group space has no
-- owner" a database rule. This migration only adds the tables that say who may
-- open one.
--
-- ## The cascade directions, which are the whole design
--
--   group    → space   ON DELETE CASCADE   deleting the SPACE removes the group
--   member   → group   ON DELETE CASCADE
--   invite   → group   ON DELETE CASCADE
--   member   → "user"  ON DELETE CASCADE   hand-written, probe B13
--   invite   → "user"  ON DELETE SET NULL  hand-written, probe B13
--
-- The first line is the one worth reading twice. Deleting a space deletes its
-- group, never the reverse, which makes phase 48's group deletion a single
-- DELETE of the space row that the existing D1 cascade follows through all 23
-- satellites. Nothing new to order, and no way to leave an orphan group.
--
-- Erasure reaches none of these tables through the space, because a group space
-- has `ownerUserId IS NULL` (B12) and is therefore not reachable by the personal
-- cascade at all. That is §23.6 working: one member closing their account must
-- not take a shared workspace with them. What erasure DOES reach is the member
-- row itself, through the hand-written key below, which is the correct and
-- opposite result: losing your account removes your memberships, not the groups.
--
-- ⚠️ Prisma will emit a DROP for both hand-written FKs on every future
-- schema-diff run: `User` lives in a Sunrise-owned schema file and Resparkable
-- must not add a relation field there, so Prisma cannot see them. Probe B13
-- asserts both, by ON DELETE action and not by mere existence. Run
-- `npm run db:drift-check` after every `migrate dev`. Non-negotiable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The group ───────────────────────────────────────────────────────────────
CREATE TABLE "framework_resparkable_group" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    -- Globally unique: a group is addressable by name, and two "Study Group B"
    -- rows in one deployment make a link ambiguous.
    "slug" VARCHAR(64) NOT NULL,
    "description" TEXT,
    -- The workspace this group owns. Deliberately NOT unique, for the reason
    -- `ownerUserId` is not (§24.1): the constraint that forbids a second
    -- workspace is the one that would need a migration over 23 tables to
    -- remove. "One group, one space" is a service rule until §23.14 q6.
    "spaceId" TEXT NOT NULL,
    -- The member cap (§23.11). NOTHING READS THIS IN PHASE 46. It is here
    -- because adding it in phase 57 would mean a second migration on this table
    -- for one integer.
    "maxMembers" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_group_pkey" PRIMARY KEY ("id")
);

-- ── Membership: the only thing a group scope is minted from ─────────────────
CREATE TABLE "framework_resparkable_group_member" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    -- The member. Hand-written FK below, ON DELETE CASCADE.
    "userId" TEXT NOT NULL,
    -- admin | member | viewer. Three of SpaceRole's four values; `owner` never
    -- appears on a group space (§23.2).
    "role" VARCHAR(16) NOT NULL DEFAULT 'member',
    "invitedByUserId" TEXT,
    -- NULL means pending approval, not "joined at an unknown time" (§23.11).
    -- A pending row resolves to no scope at all. Phase 46 always writes a value,
    -- because the only route in is accepting an invite.
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_group_member_pkey" PRIMARY KEY ("id")
);

-- ── The invitation, which grants nothing until it is accepted ───────────────
--
-- A third table where §23.3 specifies two, and the reason is that a grant is
-- live before acceptance while this is not. Folding it into the membership row
-- needs a nullable "userId", which silently voids the unique below, because
-- NULLs do not collide in a Postgres unique index.
CREATE TABLE "framework_resparkable_group_invite" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    -- Lower-cased at the boundary, matching `granteeEmail` on a grant.
    "email" VARCHAR(320) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'member',
    "invitedByUserId" TEXT,
    -- sha256 of a 192-bit token. Until acceptance this digest is the only thing
    -- between a stranger and a group's whole brain, which is why it is hashed
    -- at rest and why accepting still requires the named mailbox's session.
    "inviteTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_group_invite_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "framework_resparkable_group_slug_key"
    ON "framework_resparkable_group"("slug");

-- "which group owns this space?": the read every scope resolution makes.
CREATE INDEX "framework_resparkable_group_spaceId_idx"
    ON "framework_resparkable_group"("spaceId");

-- "which groups is this actor in?": the switcher, and every group request path.
CREATE INDEX "framework_resparkable_group_member_userId_idx"
    ON "framework_resparkable_group_member"("userId");

-- One membership per person per group. Two live rows with different roles would
-- make "what can Priya do here" a question with two answers.
CREATE UNIQUE INDEX "framework_resparkable_group_member_groupId_userId_key"
    ON "framework_resparkable_group_member"("groupId", "userId");

CREATE UNIQUE INDEX "framework_resparkable_group_invite_inviteTokenHash_key"
    ON "framework_resparkable_group_invite"("inviteTokenHash");

-- The invitee's read: "what am I invited to?", by address.
CREATE INDEX "framework_resparkable_group_invite_email_idx"
    ON "framework_resparkable_group_invite"("email");

CREATE UNIQUE INDEX "framework_resparkable_group_invite_groupId_email_key"
    ON "framework_resparkable_group_invite"("groupId", "email");

-- ── Foreign keys Prisma can model ───────────────────────────────────────────
ALTER TABLE "framework_resparkable_group"
    ADD CONSTRAINT "framework_resparkable_group_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "framework_resparkable_space"("spaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_member"
    ADD CONSTRAINT "framework_resparkable_group_member_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "framework_resparkable_group"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_invite"
    ADD CONSTRAINT "framework_resparkable_group_invite_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "framework_resparkable_group"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Foreign keys Prisma CANNOT model (probe B13) ────────────────────────────
--
-- Both point at `"user"`, which lives in a Sunrise-owned schema file. Prisma
-- emits a DROP for each on every future schema-diff run and neither failure is
-- loud: the first would leave memberships belonging to erased accounts, the
-- second would break an erasure outright.
--
-- The two actions differ on purpose. A member's row IS their membership, so it
-- goes with them. An inviter's name on somebody else's invitation is
-- attribution, so it nulls out and the invitation stands: the inviter closing
-- their account must not silently withdraw an invitation the invitee is about
-- to accept.
ALTER TABLE "framework_resparkable_group_member"
    ADD CONSTRAINT "framework_resparkable_group_member_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_member"
    ADD CONSTRAINT "framework_resparkable_group_member_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_invite"
    ADD CONSTRAINT "framework_resparkable_group_invite_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
