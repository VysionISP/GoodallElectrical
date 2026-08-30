import "dotenv/config";
import express from "express";
import cors from "cors";
import { runMigrations } from "./db/migrate.js";

import integrationsRouter from "./routes/integrations.js";
import jobsRouter from "./routes/jobs.js";
import quotesRouter from "./routes/quotes.js";
import invoicesRouter from "./routes/invoices.js";
import approvalsRouter from "./routes/approvals.js";
import agentTasksRouter from "./routes/agentTasks.js";
import notificationsRouter from "./routes/notifications.js";
import auditLogRouter from "./routes/auditLog.js";
import directorRouter from "./routes/director.js";

// Idempotent -- safe on an empty DB, a partially migrated DB, or an
// up-to-date DB. This is the fix for the historical
// `{"error":"no such table: agent_tasks"}` failure class: migrations now
// always run before the server starts accepting requests.
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  console.log(`[db] applied migrations: ${migrationResult.applied.join(", ")}`);
}
console.log(`[db] ${migrationResult.alreadyCurrent.length} migration(s) already current`);

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

app.use(cors({ origin: WEB_ORIGIN }));
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/integrations", integrationsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/quotes", quotesRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/agent-tasks", agentTasksRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/audit-log", auditLogRouter);
app.use("/api/director", directorRouter);

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", path: req.path });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: err?.message ?? String(err) });
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});
