-- Soft delete for offers (2026-11-01)
--
-- `DELETE /tenant/blogger/offers/:id` used to remove the row AND orphan the pages it
-- had generated. One misclick destroyed a paid asset with no way back, and the
-- tenant could not even tell what they had removed.
--
-- Now delete sets `deleted_at` and everything public filters it out. The row — and
-- the referral link attached to it — survives, so the action is reversible and the
-- portal can offer a Deleted view.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN opportunities.deleted_at IS
  'set when a tenant deletes an offer; hidden from public pages, restorable from the portal';

-- Public queries ask "not deleted" on every hub render.
CREATE INDEX IF NOT EXISTS idx_opportunities_deleted_at
  ON opportunities (deleted_at)
  WHERE deleted_at IS NOT NULL;
