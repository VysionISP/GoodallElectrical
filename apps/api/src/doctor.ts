// MUST come before anything that reads process.env (db/connection.ts reads
// DATABASE_PATH at import time). Without this, doctor would silently open
// the DEFAULT database rather than the one .env points the running app at,
// and then cheerfully report every table as empty.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { listIntegrations } from "./integrations/store.js";
import { getActiveAiProvider } from "./integrations/llm.js";

/**
 * `npm run doctor` -- prints what this install ACTUALLY has in it, so a
 * "it hardly works" report can be turned into a specific list of failures
 * instead of guesswork. Everything here is read from the real local
 * database and real integration rows.
 *
 * Deliberately never prints a decrypted credential: only whether one is
 * configured, plus the already-masked hint the API itself exposes. The
 * output is meant to be safe to paste into a chat.
 */

function heading(text: string) {
  console.log(`\n=== ${text} ===`);
}

function count(sql: string, ...params: unknown[]): number {
  try {
    const row = getDb().prepare(sql).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (err: any) {
    return -1; // table missing entirely -- migrations didn't run
  }
}

export function runDoctor() {
  console.log("Goodall Electrical -- install diagnostic");
  console.log(new Date().toISOString());

  heading("Environment");
  const envFile = path.resolve(process.cwd(), ".env");
  console.log(`Working directory    : ${process.cwd()}`);
  console.log(`.env file            : ${fs.existsSync(envFile) ? envFile : `NOT FOUND at ${envFile}`}`);
  console.log(`DATABASE_PATH        : ${process.env.DATABASE_PATH ?? "./data/goodall.db (default -- not set in .env)"}`);

  // The single most misleading failure mode: reading a different database
  // than the running app writes to, and reporting "0 jobs" from an empty
  // file that was created on the spot. Show the resolved path and size so
  // a mismatch is obvious instead of silent.
  const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/goodall.db");
  const dbExists = fs.existsSync(dbPath);
  console.log(`Database resolves to : ${dbPath}`);
  console.log(
    `Database file        : ${
      dbExists ? `exists, ${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB` : "DOES NOT EXIST YET (a new empty one will be created)"
    }`
  );
  console.log(`CREDENTIAL_ENCRYPTION_KEY set: ${process.env.CREDENTIAL_ENCRYPTION_KEY ? "yes" : "NO -- integrations cannot be read or saved"}`);
  console.log(`OPENAI_MODEL         : ${process.env.OPENAI_MODEL ?? "gpt-4o-mini (default)"}`);
  console.log(`Node                 : ${process.version}`);

  heading("Migrations");
  try {
    const result = runMigrations();
    console.log(`Applied just now     : ${result.applied.length ? result.applied.join(", ") : "(none -- already current)"}`);
    console.log(`Already current      : ${result.alreadyCurrent.length}`);
  } catch (err: any) {
    console.log(`MIGRATIONS FAILED    : ${err?.message ?? err}`);
    return;
  }

  heading("Integrations");
  let activeProvider = "unknown";
  try {
    activeProvider = getActiveAiProvider();
  } catch (err: any) {
    console.log(`Could not read active AI provider: ${err?.message ?? err}`);
  }
  console.log(`Active AI provider   : ${activeProvider}`);
  try {
    for (const intg of listIntegrations()) {
      const bits = [
        `configured=${intg.configured ? "yes" : "no"}`,
        `status=${intg.status}`,
        intg.lastSyncAt ? `lastSync=${intg.lastSyncAt}` : "lastSync=never",
      ];
      console.log(`  ${intg.provider.padEnd(15)} ${bits.join("  ")}`);
      if (intg.lastError) console.log(`      last error: ${intg.lastError}`);
    }
  } catch (err: any) {
    console.log(`Could not list integrations: ${err?.message ?? err}`);
    console.log("(If this says the key is wrong, credentials were saved under a DIFFERENT CREDENTIAL_ENCRYPTION_KEY and must be re-entered.)");
  }

  heading("What's actually in the database");
  const rows: [string, number][] = [
    ["jobs (total)", count("SELECT COUNT(*) as c FROM jobs")],
    ["  from Fergus", count("SELECT COUNT(*) as c FROM jobs WHERE source = 'fergus'")],
    ["  with a customer", count("SELECT COUNT(*) as c FROM jobs WHERE customer_id IS NOT NULL")],
    ["  with financials", count("SELECT COUNT(*) as c FROM job_financials")],
    ["customers", count("SELECT COUNT(*) as c FROM customers")],
    ["invoices (total)", count("SELECT COUNT(*) as c FROM invoices")],
    ["  from Xero", count("SELECT COUNT(*) as c FROM invoices WHERE source = 'xero'")],
    ["  overdue", count("SELECT COUNT(*) as c FROM invoices WHERE status = 'overdue'")],
    ["bills (payables)", count("SELECT COUNT(*) as c FROM bills")],
    ["bank transactions", count("SELECT COUNT(*) as c FROM bank_transactions")],
    ["quotes", count("SELECT COUNT(*) as c FROM quotes")],
    ["leads", count("SELECT COUNT(*) as c FROM leads")],
    ["business memory facts", count("SELECT COUNT(*) as c FROM business_memory WHERE active = 1")],
    ["recurring costs", count("SELECT COUNT(*) as c FROM recurring_costs")],
    ["open questions", count("SELECT COUNT(*) as c FROM ai_questions WHERE status = 'open'")],
    ["pending approvals", count("SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'")],
    ["director messages", count("SELECT COUNT(*) as c FROM director_messages")],
  ];
  for (const [label, n] of rows) {
    console.log(`  ${label.padEnd(24)} ${n < 0 ? "TABLE MISSING" : n}`);
  }

  heading("Failed background work (most recent 10)");
  try {
    const failed = getDb()
      .prepare("SELECT agent, task_type, error, created_at FROM agent_tasks WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10")
      .all() as { agent: string; task_type: string; error: string | null; created_at: string }[];
    if (failed.length === 0) console.log("  (none)");
    for (const t of failed) {
      console.log(`  ${t.created_at}  ${t.agent}/${t.task_type}`);
      console.log(`      ${t.error ?? "(no error recorded)"}`);
    }
  } catch (err: any) {
    console.log(`  could not read agent_tasks: ${err?.message ?? err}`);
  }

  heading("Failure events logged by agents (most recent 10)");
  try {
    const events = getDb()
      .prepare("SELECT agent, event_type, message, created_at FROM agent_events WHERE event_type LIKE '%fail%' ORDER BY created_at DESC LIMIT 10")
      .all() as { agent: string; event_type: string; message: string | null; created_at: string }[];
    if (events.length === 0) console.log("  (none)");
    for (const e of events) {
      console.log(`  ${e.created_at}  ${e.agent}/${e.event_type}`);
      console.log(`      ${e.message ?? "(no message)"}`);
    }
  } catch (err: any) {
    console.log(`  could not read agent_events: ${err?.message ?? err}`);
  }

  heading("Most recent sync attempts");
  try {
    const syncs = getDb()
      .prepare("SELECT provider, status, records_synced, error, started_at, finished_at FROM integration_syncs ORDER BY started_at DESC LIMIT 10")
      .all() as any[];
    if (syncs.length === 0) console.log("  (none -- no sync has ever been run)");
    for (const s of syncs) {
      console.log(`  ${s.started_at}  ${s.provider}  ${s.status}  records=${s.records_synced}${s.finished_at ? "" : "  (never finished)"}`);
      if (s.error) console.log(`      ${s.error}`);
    }
  } catch (err: any) {
    console.log(`  could not read integration_syncs: ${err?.message ?? err}`);
  }

  console.log("\nDone. Paste this whole output back to get the failures fixed.\n");
}

runDoctor();
