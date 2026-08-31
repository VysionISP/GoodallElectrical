-- Debtor AI reminder drafts, approval-gated the same way quotes/invoices
-- are. Deliberately does NOT touch the `approvals` table's entity_type
-- CHECK constraint: SQLite requires dropping and recreating a table to
-- change a CHECK constraint, and empirically (tested directly) that
-- cascades an implicit DELETE through approval_events' ON DELETE CASCADE
-- foreign key first -- wiping the entire approval audit trail as a side
-- effect. Not worth that risk for a cosmetic label; debtor reminders use
-- entity_type = 'other' in approvals, which the existing CHECK already
-- allows and requireApproval() doesn't care about the specific label.

CREATE TABLE IF NOT EXISTS debtor_reminders (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  draft_subject TEXT,
  draft_body TEXT,
  status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'pending_approval', 'approved', 'sent')),
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_debtor_reminders_invoice ON debtor_reminders(invoice_id);
