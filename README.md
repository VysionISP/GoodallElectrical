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
administrative/geographic (locality, postal_code, route, etc.). A second filter,
`isCompetitor()`, excludes results Google itself types as `electrician` -- a lead
search should find customers, not other electrical contractors.

## How the AI actually works

Asked directly: does it call ChatGPT via the API, and are there multiple agents
running in the background with their own memory? Honest answer, no framework
name involved:

- **Yes, it's the real OpenAI API** (`openai` npm package,
  `apps/api/src/integrations/openai.ts`), the same underlying models behind
  ChatGPT, called over HTTPS with the API key you enter under Integrations.
  Every "AI" response in this app -- Director replies, background reviews,
  labour forecasts, lead research, quote drafting -- is a direct
  `client.chat.completions.create()` call from the Node/Express backend. There
  is no separate AI service, no LangChain/AutoGPT-style framework, no
  "Hermes" -- just HTTP requests this server makes.
- **There is one backend process, not multiple running agents.** "Director",
  "Operations AI", "Estimator AI", "Finance AI", "Debtor AI", "Lead Hunter",
  "Research AI", "Sales AI" are names for different TypeScript functions with
  different system prompts and different jobs (`apps/api/src/agents/*.ts`) --
  not separate processes, containers, or long-running loops each with their
  own state. They only run when something calls them: an HTTP request from
  the frontend, or the one background timer in `index.ts`.
- **No agent has its own persistent memory or "skills" in the autonomous-agent
  sense.** Every OpenAI call is stateless -- it has no memory of the previous
  call at all. What makes responses feel informed is that before each call,
  the backend builds a fresh JSON snapshot of real data from SQLite
  (`buildDirectorContext()` in `directorContext.ts`: active jobs, open quotes,
  overdue receivables, business_memory, cashflow forecast, recent chat
  history) and stuffs it into that one request's prompt. The database --
  `business_memory`, `job_context`, `director_messages`, `ai_questions` -- is
  the actual memory. The model itself remembers nothing between requests.
  "Skills" are just which system prompt and which DB tables a given function
  reads and writes.
- **The only thing that runs unprompted, without the owner opening the app,**
  is the `setInterval` in `apps/api/src/index.ts` calling
  `runBackgroundReview()` every 30 minutes (plus once 10 seconds after
  startup). That function is what raises new questions, posts proactive
  briefings, and now posts spontaneous check-ins (below). It only runs while
  this one Node process is alive -- `npm run dev` on a laptop is not a 24/7
  deployment; closing the laptop stops it, same as any other server process
  that isn't hosted somewhere that stays up.

## Hermes models via OpenRouter, as a second AI provider

Direct request: run the agents on NousResearch's Hermes models instead of (or
alongside) OpenAI. OpenAI itself doesn't host Hermes, so this reaches it
through [OpenRouter](https://openrouter.ai), which exposes an OpenAI-compatible
API OpenRouter also hosts other providers (Together AI, Fireworks) the same
way, but OpenRouter needed the least new code since this app already speaks
the OpenAI SDK's request shape.

- **Added alongside OpenAI, not instead of it** -- both stay configured
  independently under Integrations, and a single "AI provider" switch there
  (`GET`/`PUT /api/integrations/ai-provider`, backed by a new `app_settings`
  table) decides which one every agent's calls actually go through: Director,
  Operations, Estimator, Finance, Debtor, Lead Hunter, Research, and Sales all
  read the same switch (`getActiveChatClient()` in `apps/api/src/integrations/llm.ts`),
  so flipping it changes all of them at once rather than needing per-agent
  configuration. Flipping back to OpenAI is instant and doesn't touch the
  OpenRouter key you saved.
- **Real, open concern, flagged rather than hidden**: this app's entire
  "never fabricate" guarantee rests on OpenAI's strict `json_schema` structured
  outputs mode -- every agent depends on the model returning exactly the shape
  asked for, or not returning at all. Whether every Hermes model on OpenRouter
  honours that mode the same way OpenAI does was **not verifiable from this
  build environment** -- outbound network access to openrouter.ai is blocked
  here, so this could not be tested against the real service with a real key.
  Built defensively instead of assuming it works:
  - `chatJson()` in `llm.ts` requests strict `json_schema` mode first. If the
    active provider is OpenAI, a failure there is treated as a real error, same
    as before this change -- nothing about the OpenAI path changed behaviorally.
  - For any other provider, a rejected strict-mode request falls back once to
    plain `json_object` mode with the schema spelled out in the prompt text,
    strips a markdown code fence if the model wrapped its answer in one, then
    checks every field the schema marks `required` actually came back before
    trusting the result. If a field is missing, it throws with a clear message
    naming the provider, model, and missing field(s) -- it does not hand the
    caller a partially-fabricated object.
  - **Verified with real HTTP round-trips against local fake OpenAI-compatible
    servers standing in for OpenRouter** (since a real key/live test wasn't
    available here): one server rejects strict `json_schema` with a 400 and
    accepts `json_object`, confirming the fallback actually fires and returns
    correct data; a second returns well-formed JSON that's missing the
    required field, confirming `chatJson` throws instead of silently accepting
    it; a third mimics real OpenAI's strict-mode success to confirm that path
    is unchanged. **What's still unverified**: whether real Hermes models
    served by OpenRouter behave like either fake server, or something else
    entirely (e.g. an error shape this fallback doesn't recognize) -- that
    needs a real OpenRouter API key and a real test, which whoever deploys
    this should do before relying on it for real business data.
- **A real bug was caught and fixed while wiring the `/api/integrations/ai-provider`
  route**: Express matches routes in registration order, and the existing
  generic `PUT /:provider` route (used for saving any integration's
  credentials) was registered before the new `/ai-provider` route, so it
  swallowed requests to `/ai-provider` and rejected them as an unknown
  provider named "ai-provider". Caught by an actual `curl` smoke test against
  the running server, not by reading the code -- fixed by moving the specific
  route above the generic one.
- **The `integrations.provider` CHECK constraint had to be widened** to accept
  `'openrouter'`; SQLite can't `ALTER` a `CHECK` constraint directly, so
  migration `011_openrouter_and_settings.sql` rebuilds the table (copy into a
  new table, drop the old one, rename). Checked first that nothing has a
  foreign key referencing `integrations(id)` -- unlike the documented
  near-miss with `approvals`/`approval_events`, there's no cascade-delete risk
  here. Verified against a database seeded to look like a real pre-existing
  deployment (migrations 001-010 applied, a real encrypted OpenAI credential
  row already saved) that the row survives the rebuild byte-for-byte, and that
  the `CHECK` constraint is still actually enforced afterward (an invalid
  provider name is still rejected), not silently dropped.

## The Director now runs unprompted, not just when you message it

Two real gaps, both from direct feedback: the owner shouldn't have to visit a
settings page to tell the AI what services the business offers, and nothing was
ever running unless the owner sent a chat message first.

- **Director chat now extracts general business facts, not just job facts**
  (`businessFacts` in the structured-output schema, `apps/api/src/agents/director.ts`).
  Tell the Director in conversation "we do switchboard upgrades and EV chargers,
  we work within 80km of Sale VIC" and it saves that into `business_memory`
  itself -- the Business Profile page still exists for reviewing/editing, but
  it's no longer the only way in.
- **A background review now runs on its own** (`apps/api/src/agents/backgroundReview.ts`),
  on server startup and every 30 minutes while the API process is running:
  - If there's no "services" business memory yet, it raises an open
    `ai_question` unprompted -- verified live, appearing in "Needs You" with
    zero owner action taken beforehand.
  - It reviews up to 5 recently-synced Fergus jobs per cycle that have never
    been looked at (tracked via a `_ai_reviewed` job_context marker so the same
    job isn't re-processed, and re-billed against the OpenAI key, every cycle)
    and raises real operational questions when relevant (crew size, night work,
    shutdown timing, etc.) -- this is the "Operations AI asks about the job"
    behavior from section 7 of the original brief, which existed in the schema
    but had no actual logic behind it until now.
  - Honest limitation: this only runs while the API process itself is running.
    `npm run dev` on a laptop is not a 24/7 deployment -- genuinely autonomous
    overnight review needs this hosted somewhere that stays up, which is future
    work, not something to pretend already exists.
- **When a review finds something new, the Director now says so in the chat
  itself, unprompted** (`postProactiveBriefing()` in `backgroundReview.ts`). This
  is a direct fix for "it doesn't act like a human" feedback: previously
  everything the background pass found only surfaced as silent cards under
  "Needs You", so the Director never actually spoke first -- it just sat there
  until the owner clicked in and decoded a pile of form fields. Now, when a
  cycle raises real questions, it composes ONE natural first-person message
  (via OpenAI, with real numbers -- active job count, overdue receivables --
  given to it, never invented) and posts it into `director_messages` as if it
  had walked in and said "here's what I found," and it shows up automatically
  when the owner opens the default Chat tab. A quiet cycle (nothing new,
  already-open questions don't count again) posts nothing -- verified with a
  real seeded SQLite DB: first run posts one briefing message and raises one
  question, an immediate second run with nothing new raises zero questions and
  posts zero additional messages. Without an OpenAI key configured it still
  speaks up with a plainer templated version rather than staying silent.
- **It now also speaks up for no reason at all -- "we want it to just start
  randomly talking to us"** (`maybePostSpontaneousCheckin()` in
  `backgroundReview.ts`). On a cycle where nothing needs the owner's input, it
  has a 40% chance of posting a short, casual "just checking in" message
  (real numbers only -- active jobs, open quotes -- never invented), gated so
  it can't fire again until at least 90 minutes since the last thing it said
  of any kind. The combination of a floor plus a coin flip each eligible
  cycle is deliberate: a fixed timer would feel scheduled, not alive.
  Verified by running the background pass in a tight loop against a real
  seeded DB: over 30 rapid cycles (no time actually elapsed) it spoke exactly
  once, then the 90-minute floor correctly blocked every further attempt;
  backdating the last message past the floor and re-running let it speak
  again, landing at 7/15 (~47%), consistent with the 40% target. No OpenAI
  key configured still gets a plain templated check-in rather than silence;
  if composing the message fails, it skips that cycle rather than forcing a
  generic fallback into the chat.

## Financial planning (Finance AI, Estimator AI, Debtor AI)

Previously entirely missing -- this was the honest answer when asked "is this
platform anywhere near done": no cashflow model, no P&L, no labour confidence
engine, no quote PDFs, no debtor workflow existed. All of the below is built and
verified with real computed numbers (hand-checked math, actual PDF text
extraction, live 403→approve→200 firewall runs), not just "it compiles":

- **Real bug found and fixed while building this**: `mapXeroInvoice` was writing
  Xero's raw status strings (`AUTHORISED`, `PAID`, ...) straight into
  `invoices.status`, which has a strict lowercase CHECK constraint
  (`draft`/`pending_approval`/.../`overdue`/`void`). **Every real Xero invoice
  sync would have failed outright** the first time it hit a non-matching status.
  `mapXeroStatusToInvoiceStatus()` in `xero.ts` now translates Xero's status into
  ours, deriving `overdue`/`part_paid` from real due dates and amounts rather
  than trusting a status Xero doesn't actually provide. Covered by a small
  standalone test (6 cases, all passing) since this is exactly the kind of
  silent breakage that shouldn't ship unverified twice.
- **Xero sync now also pulls bills (payables) and bank transactions**
  (`apps/api/src/integrations/xero.ts`, `xeroSync.ts`), plus a best-effort read
  of the `Reports/BankSummary` current cash position, cached on the integration
  row with a timestamp. Like the rest of the Xero integration, `BankSummary`'s
  exact response shape is unverified against a live tenant -- it fails closed
  (returns `null`, never a guessed number) rather than mis-parsing into a wrong
  cash figure.
- **Cashflow forecast** (`apps/api/src/agents/financeAI.ts`,
  `GET /api/finance/forecast`, `/finance` page): current cash + expected
  receipts (real outstanding invoices) − payables (real bills) − recurring costs
  across 7/14/30/60/90-day windows, matching section 20 of the brief. Recurring
  costs (wages/super/fixed/materials) are **structured owner input**
  (`recurring_costs` table, `/finance` page), not LLM-parsed free text --
  financial deductions are numbers a human typed in, not a guess. Verified by
  hand-computing every window against seeded data; all five matched exactly,
  including the fortnightly/weekly-to-daily rounding.
- **Scenario modeling** ("can we afford another electrician") is the Director
  chat, not a separate feature -- `buildDirectorContext()` now includes the real
  forecast, and the system prompt instructs it to say plainly when
  `currentCash` is null (Xero not read yet) or `hasRecurringCosts` is false
  (forecast is incomplete) instead of presenting a partial picture as whole.
- **Labour-forecast confidence engine** (`apps/api/src/agents/estimatorAI.ts`,
  `GET /api/jobs/:id/labour-forecast`, shown on the job detail page) -- section 8
  of the brief. Confidence is a mechanical `knownCount/7` over the same
  operational facts Operations AI asks about (crew size, night work, shutdown,
  etc), not an LLM's self-rated confidence. The hour range itself needs OpenAI;
  without it, `expectedHoursLow/High` are `null` and the UI says so, never a
  fabricated number.
- **Quote PDFs** (`apps/api/src/lib/quotePdf.ts`, `GET /api/quotes/:id/pdf?variant=`)
  -- section 17. Verified by actually extracting text from both generated PDFs:
  the `customer` variant (the default) contains zero occurrences of cost,
  margin, or profit; the `owner` variant has the full internal P&L and approval
  trail. This isn't a flag that could leak the wrong data by mistake -- the
  customer code path physically never writes those fields.
- **Debtor AI** (`apps/api/src/agents/debtorAI.ts`, `apps/api/src/routes/debtors.ts`,
  `/debtors` page) drafts payment reminders for real overdue invoices and gates
  sending through the identical approval-firewall pattern as quotes/invoices --
  verified live: 403 before approval, approved via `/api/approvals/:id/decide`,
  then an honest `400 SMTP_NOT_CONFIGURED` rather than a fabricated "sent"
  status, since no SMTP was configured in this environment. Debtor reminders use
  `entity_type: 'other'` in the `approvals` table rather than adding a new enum
  value -- SQLite can't alter a CHECK constraint without dropping and recreating
  the table, and that was tested directly here and found to cascade-delete every
  row in `approval_events` (the audit trail) via its `ON DELETE CASCADE` foreign
  key. Not worth that risk for a cosmetic label.

**Known minor inconsistency, not yet reconciled**: the job detail page's
"Missing information" panel (only facts with an explicit `unknown`/
`needs_owner_input` job_context row) and the labour forecast's "Missing" list
(any of the 7 driving facts with no known/inferred row at all, including facts
that were simply never asked about) use slightly different definitions of
"missing". Both are individually honest, just not unified yet.

## Non-negotiables this build respects

- No quote or invoice can be sent without an `approved` row in `approvals` —
  enforced server-side.
- Every consequential action writes to `audit_log`.
- Financial fields are `null`, never `0`, when a source doesn't supply them.
- Integration credentials never round-trip to the browser in plaintext.
- Migrations are idempotent and never destructive.

## Next steps for whoever continues this

1. Get real Fergus + Xero credentials into a dev environment, run a sync, and fix
   `mapFergusJob` / `mapXeroInvoice` / `getCashPosition`'s BankSummary parsing
   against the real payloads -- everything downstream (forecast, job financials)
   is only as correct as these mappings.
2. Add owner authentication (currently every actor is implicitly "owner" — there's
   no login yet, which is fine for a single-user local dev instance but not for
   anything multi-user or internet-facing).
3. Swap SQLite for Postgres + a real task queue (Redis/BullMQ) when moving past a
   single-process deployment — the migration SQL and repository-style access
   functions were written to make that swap mechanical rather than a rewrite.
   This is also what "the Director runs 24/7" actually needs -- the background
   review only runs while this one Node process is alive.
4. Reconcile the two "missing information" definitions noted above.
5. P&L reporting proper (currently only a per-window cashflow forecast exists,
   not a Xero-sourced profit & loss statement).
