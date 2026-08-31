# Goodall Electrical — AI Business Operating System

A self-hosted AI business operating system for an electrical contracting company: a
virtual AI headquarters where logical AI agents (Director, Operations, Estimator,
Finance, Debtor, Lead Hunter, Research, Sales) work against real Fergus/Xero data,
ask the owner for what they don't know, and require explicit owner approval before
anything is sent to a customer.

## Status

This repository was bootstrapped from scratch on 2026-08-30. There was no prior
codebase to inherit — the GitHub repo was empty when work started, so this is a
from-scratch build of the foundation described in the product brief, not a bugfix
of an existing app. See "What's real vs. scaffolding" below before wiring up live
credentials.

## Stack

```
apps/web   React + TypeScript + Vite            (http://localhost:5173)
apps/api   Node + TypeScript + Express + SQLite  (http://localhost:8787)
```

SQLite (via `better-sqlite3`) is the current datastore. All access goes through
plain SQL in `apps/api/src/routes` / `apps/api/src/integrations` — there's no ORM
lock-in, so migrating to Postgres later means swapping the connection layer
(`apps/api/src/db/connection.ts`) and translating the migration SQL, not a rewrite.

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env
# generate a credential encryption key and put it in apps/api/.env:
openssl rand -base64 32   # -> CREDENTIAL_ENCRYPTION_KEY=

npm run migrate --workspace apps/api   # idempotent -- safe to re-run any time
npm run dev                            # starts both API (8787) and web (5173)
```

Open http://localhost:5173. Configure Fergus/Xero/OpenAI under **Integrations** —
credentials are encrypted at rest (AES-256-GCM) and never returned to the browser,
only a masked hint.

## Database migrations

`apps/api/src/db/migrations/*.sql` are numbered, idempotent, and tracked in a
`_migrations` table. `npm run migrate --workspace apps/api` (or just starting the
API — it runs migrations on boot) is always safe to run against an empty database,
a partially-migrated one, or a fully current one. It never drops data. This is the
fix for the `{"error":"no such table: agent_tasks"}` class of bug described in the
original brief: schema and runtime code can no longer drift apart silently.

Schema covers every entity from the brief: customers, contacts, jobs, job_phases,
job_context, job_financials, quotes, quote_items, invoices, payments,
bank_transactions, leads, lead_research, sales_outreach, employees, labour_costs,
business_memory, customer_memory, job_memory, ai_questions, ai_answers,
agent_tasks, agent_events, notifications, approvals, approval_events,
integrations, integration_syncs, director_messages, audit_log.

## What's real vs. scaffolding

**Solid and tested end-to-end in this environment:**
- Migrations (idempotent, verified against a fresh DB and a re-run).
- Encrypted credential storage.
- The approval firewall — verified live: `POST /api/quotes/:id/send` returns
  `403 QUOTE_NOT_APPROVED` before approval and `200` after, enforced in
  middleware (`apps/api/src/lib/approvalFirewall.ts`), not just a hidden button.
  Same pattern for invoices (`INVOICE_NOT_APPROVED`).
- Agent task engine + the HQ visualization reading real `agent_tasks` rows (no
  client-side fake movement — worker position/status comes from polling the API).
- Director chat: gracefully reports "OpenAI isn't configured" rather than
  fabricating a response when no key is set; with a key configured it extracts
  structured job facts into `job_context` with a KNOWN/INFERRED/owner-provided
  provenance model.
- Never-fabricate-financial-data behavior: Jobs Floor renders `null` as "Not
  available", never `$0`; provenance tags show LIVE FROM FERGUS / LIVE FROM XERO /
  OWNER PROVIDED / AI INFERRED.
- `apps/api/src/integrations/fergus.ts` — rewritten against Fergus's real published
  OpenAPI spec (fetched from https://api.fergus.com/docs), not guessed. Base URL is
  `https://api.fergus.com` with no path prefix; auth is a Bearer Personal Access
  Token; a Job has no inline financials or phases (separate
  `/jobs/{id}/financialSummary` and `/jobs/{id}/phases` calls), no `title` field
  (mapped from `description`/`longDescription`), and no single "paid" figure
  (summed from `totalPaid` across `/customerInvoices?jobId={id}`). 429s are
  retried once honoring `retry-after`, per the documented rate limit (100
  req/min/company). This has NOT yet been exercised against a live Fergus
  account/real data in this environment, only validated to match the spec and to
  build/compile — the next real test is running a sync against an actual company
  and confirming ELEC-3256-style jobs come back with the expected fields.

**Scaffolded but NOT verified against a live account:**
- `apps/api/src/integrations/xero.ts` — the OAuth flow itself follows Xero's
  published spec, but `mapXeroInvoice`'s field names haven't been checked against
  a real Accounting API response (no Xero docs or credentials were available when
  this was written — same rule as above applies before trusting it).
- `apps/api/src/integrations/googlePlaces.ts` — written against well-established
  knowledge of the Places API (New) Text Search endpoint (this environment's
  network policy also blocked fetching Google's live docs), not a freshly
  inspected payload. Unlike Fergus, Places is metered/billed per request — the
  first real search is also the first real test of `mapPlace`, and it costs
  money. Also worth knowing: the API only returns phone/website/address, never
  an email address, so outreach can't be sent until an owner adds a contact
  email manually (`PATCH /api/leads/:id`) or Research AI finds one on the site.

## Lead generation pipeline

Lead Hunter → Research AI → Sales AI, matching section 18-19 of the brief, with
the same approval firewall as quotes/invoices:

1. **Lead Hunter** (`POST /api/leads/search`, `apps/api/src/agents/leadHunter.ts`)
   runs a Google Places text search and upserts results into `leads`, deduped by
   `(source, source_ref)` so re-running a search doesn't create duplicates.
2. **Research AI** (`POST /api/leads/:id/research`,
   `apps/api/src/agents/researchAI.ts`) uses OpenAI, grounded only in the lead's
   name/address/Google category types and (best-effort) the business's own
   website text, to score fit and explain why — never inventing facts it wasn't
   given. Writes to `lead_research` and updates the lead's `status`/`lead_score`.
3. **Sales AI** (`POST /api/leads/:id/draft-outreach`,
   `apps/api/src/agents/salesAI.ts`) drafts a personalized email into
   `sales_outreach` with `status = 'drafted'`. It is never sent automatically.
4. Sending requires `POST /api/leads/outreach/:id/submit-for-approval` (opens an
   `approvals` row) and then an owner decision via `POST /api/approvals/:id/decide`
   — exactly the quote/invoice pattern. `POST /api/leads/outreach/:id/send` is
   wrapped in the same `requireApproval` middleware and returns
   `403 OUTREACH_NOT_APPROVED` before that, `400 NO_CONTACT_EMAIL` if the lead has
   no email on file, and `400 SMTP_NOT_CONFIGURED` if Email (SMTP) isn't set up —
   it never fabricates a "sent" status when nothing was actually delivered.

Frontend: **Lead Radar** page (search + list), lead detail page (research,
contact-email editing, draft/submit/send). Lead Hunter, Research AI and Sales AI
already had HQ nav-graph positions (Lead Radar room) from the original build, so
their agent_tasks now animate there for real.

**Business Profile** (`/business-profile`, `apps/api/src/routes/businessMemory.ts`)
is the owner-facing CRUD UI for `business_memory` — services offered, service
area, pricing rules, jobs excluded. Research AI already read this table for lead
scoring; this is what actually lets an owner populate it instead of it staying
empty forever.

**Automatic area sweep** (`POST /api/leads/sweep`,
`runAreaSweep` in `leadHunter.ts`): instead of typing search queries one at a
time, this generates several Google Places queries from the "services" +
"service_area" Business Profile entries (via the same OpenAI call as
`suggest-queries`) and runs all of them in one pass, capped at 8 queries per
sweep since each is a billed request. One query failing doesn't abort the rest —
failures are collected and reported, not silently dropped. Requires both
`services` and (ideally) `service_area` entries to exist first; fails fast with a
clear message otherwise rather than guessing a location.

Also fixed while building this: Google Places Text Search can return the
locality/suburb/postcode itself as a result alongside real businesses (e.g.
searching near "Sale VIC" returned "Sale" itself as a "lead"). `isLikelyBusiness()`
in `googlePlaces.ts` filters out results whose only Places types are
administrative/geographic (locality, postal_code, route, etc.).

## Non-negotiables this build respects

- No quote or invoice can be sent without an `approved` row in `approvals` —
  enforced server-side.
- Every consequential action writes to `audit_log`.
- Financial fields are `null`, never `0`, when a source doesn't supply them.
- Integration credentials never round-trip to the browser in plaintext.
- Migrations are idempotent and never destructive.

## Next steps for whoever continues this

1. Get real Fergus + Xero credentials into a dev environment, run a sync, and fix
   `mapFergusJob` / `mapXeroInvoice` against the real payloads.
2. Build out Lead Hunter / Research AI / Sales AI (Google Places search, outreach
   drafting into `sales_outreach`, approval-gated sending).
3. Build the labour-forecast confidence engine described in section 8 of the
   original brief (`job_context` already has a `confidence` column to support it).
4. Add owner authentication (currently every actor is implicitly "owner" — there's
   no login yet, which is fine for a single-user local dev instance but not for
   anything multi-user or internet-facing).
5. Swap SQLite for Postgres + a real task queue (Redis/BullMQ) when moving past a
   single-process deployment — the migration SQL and repository-style access
   functions were written to make that swap mechanical rather than a rewrite.
