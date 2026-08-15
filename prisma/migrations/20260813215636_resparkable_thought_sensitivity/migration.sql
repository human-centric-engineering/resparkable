-- AlterTable
-- The Prisma-generated diff also emitted DROP statements for the six
-- drift-guarded raw-SQL objects (see the ⚠️ PRISMA-SCHEMA DRIFT WARNING at the
-- top of prisma/schema/framework-resparkable.prisma) plus the hand-written
-- ResparkableSpace → user FK. Stripped per that file's own instruction: this
-- migration is additive only.
ALTER TABLE "framework_resparkable_thought" ADD COLUMN     "sensitivity" VARCHAR(16) NOT NULL DEFAULT 'private';
