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

**Scaffolded but NOT verified against a live account** (no Fergus/Xero credentials
were available in this environment):
- `apps/api/src/integrations/fergus.ts` — endpoint paths and response field names
  are best-effort, not confirmed against a real payload. **Before trusting this
  for a real sync**: configure real credentials, call the sync, log the raw
  response for one real job (e.g. ELEC-3256), and correct `mapFergusJob` to match
  what Fergus actually returns. Everything downstream only depends on the
  normalized shape this function produces, so that's the one place to fix.
- `apps/api/src/integrations/xero.ts` — the OAuth flow itself follows Xero's
  published spec, but `mapXeroInvoice`'s field names likewise need checking
  against a real Accounting API response.
- Google Places / lead generation, sales outreach drafting, and the deeper
  financial scenario-modelling / labour-forecast confidence engine from the brief
  are not built yet — the schema has room for them (`leads`, `lead_research`,
  `sales_outreach`, `job_context.confidence`) but the agent logic doesn't exist.

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
