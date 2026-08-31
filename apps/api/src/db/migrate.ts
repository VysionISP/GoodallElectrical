// MUST come before importing connection.js, which reads DATABASE_PATH at
// import time. Without this, `npm run migrate` migrated the DEFAULT database
// rather than the one .env points the running app at -- so migrations could
// silently be applied to a different file than the app actually uses.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Idempotent migration runner.
 *
 * Every applied migration filename is recorded in `_migrations`. On startup
 * (and via `npm run migrate`) we scan the migrations directory, skip
 * anything already recorded, and apply the rest in filename order inside a
 * transaction each. This is the fix for the class of bug where the app code
 * assumes a table (e.g. `agent_tasks`) exists because a new migration file
 * was added, but nothing actually ran it against the live database.
 *
 * Safe to run on an empty database, a partially-migrated database, or a
 * fully up-to-date database. Never drops or deletes existing data.
 */
export function runMigrations(): { applied: string[]; alreadyCurrent: string[] } {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const already = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
  );

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return { applied: [], alreadyCurrent: [] };
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  const alreadyCurrent: string[] = [];

  const recordApplied = db.prepare("INSERT INTO _migrations (name) VALUES (?)");

  for (const file of files) {
    if (already.has(file)) {
      alreadyCurrent.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const runInTransaction = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(file);
    });
    runInTransaction();
    applied.push(file);
  }

  return { applied, alreadyCurrent };
}

// Allow `tsx src/db/migrate.ts` / `npm run migrate` to run this standalone.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = runMigrations();
  console.log(`Migrations applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}`);
  console.log(`Already current: ${result.alreadyCurrent.length}`);
}
