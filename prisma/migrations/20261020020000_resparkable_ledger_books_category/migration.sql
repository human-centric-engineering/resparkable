-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable ledger: the books' category, written with the row (phase 62).
--
--   framework_resparkable_credit_ledger_entry.booksCategory
--     What a row is in a group's books, or 'none' for the side of a two-sided
--     move the books do not count. Both person columns on the ledger are
--     SetNull, so once a member is erased the two sides of their moves look
--     alike and the books could no longer be read off them. Nullable: rows
--     from before phase 62 are classified from their kind, which was
--     unambiguous before members had balances of their own.
--
-- Purely additive. Hand-written for the reason every group migration gives.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_credit_ledger_entry" ADD COLUMN "booksCategory" VARCHAR(16);
