import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/goodall.db";

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let db: Database.Database | null = null;

/**
 * Single shared connection. Kept behind a getter (rather than opened at
 * import time) so tests/tools can set DATABASE_PATH before first use.
 */
export function getDb(): Database.Database {
  if (db) return db;
  ensureDir(DATABASE_PATH);
  db = new Database(DATABASE_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}
