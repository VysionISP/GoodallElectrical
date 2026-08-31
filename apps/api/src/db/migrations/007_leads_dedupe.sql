-- Lead Hunter re-runs the same search periodically; without a stable
-- external reference, every run would create duplicate lead rows for the
-- same business. source_ref holds the source's own id (e.g. a Google
-- Places place id) so search results can be upserted idempotently, the
-- same pattern jobs use with fergus_job_id.

ALTER TABLE leads ADD COLUMN source_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_source_ref ON leads(source, source_ref) WHERE source_ref IS NOT NULL;
