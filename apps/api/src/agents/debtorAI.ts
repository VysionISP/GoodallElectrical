import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { getActiveChatClient, chatJson } from "../integrations/llm.js";
import { createAgentTask, updateAgentTask } from "../lib/agentTasks.js";
import { recordAudit } from "../lib/audit.js";

export function listOverdueInvoices() {
  const db = getDb();
  return db
    .prepare(
      `SELECT i.*, c.name as customer_name, c.email as customer_email,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) as days_overdue
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.status = 'overdue'
       ORDER BY days_overdue DESC`
    )
    .all();
}

const REMINDER_SCHEMA = {
  name: "debtor_reminder",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string" },
      body: {
        type: "string",
        description: "Plain-text payment reminder email. Polite but clear about the amount and how overdue it is. No threats, no placeholders.",
      },
    },
    required: ["subject", "body"],
  },
} as const;

/** Drafts one payment reminder. DRAFT ONLY -- section 16's approval firewall applies exactly like quotes/invoices. */
export async function draftDebtorReminder(invoiceId: string): Promise<{ taskId: string; reminderId: string }> {
  const db = getDb();
  const invoice = db
    .prepare(
      `SELECT i.*, c.name as customer_name,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) as days_overdue
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`
    )
    .get(invoiceId) as any;
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { code: "NOT_FOUND" });

  const chat = getActiveChatClient();
  if (!chat) {
    throw Object.assign(new Error("No AI provider is configured. Add an OpenAI or OpenRouter API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }

  const taskId = createAgentTask({
    agent: "debtor_ai",
    taskType: "draft_reminder",
    room: "finance",
    entityType: "invoice",
    entityId: invoiceId,
    message: `Drafting reminder for ${invoice.invoice_number ?? invoiceId}`,
  });

  try {
    const raw = await chatJson(chat, {
      schema: REMINDER_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "You are Debtor AI for Goodall Electrical, an electrical contracting company. Draft a payment " +
            "reminder email for an overdue invoice. Professional and firm but not aggressive -- this is usually " +
            "a first or second reminder, not a final notice. State the invoice number, amount owing, and how many " +
            "days overdue it is using only the real figures given. This is a DRAFT ONLY and will never be sent " +
            "without the owner's approval.",
        },
        {
          role: "user",
          content: JSON.stringify({
            customerName: invoice.customer_name,
            invoiceNumber: invoice.invoice_number,
            amountDue: invoice.amount_due,
            daysOverdue: invoice.days_overdue,
            dueDate: invoice.due_date,
          }),
        },
      ],
    });

    const parsed = JSON.parse(raw) as { subject: string; body: string };
    const now = nowIso();
    const reminderId = newId("reminder");
    db.prepare(
      `INSERT INTO debtor_reminders (id, invoice_id, draft_subject, draft_body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'drafted', ?, ?)`
    ).run(reminderId, invoiceId, parsed.subject, parsed.body, now, now);

    updateAgentTask(taskId, { status: "completed", progress: 100, message: "Draft ready" });
    recordAudit({ actor: "debtor_ai", action: "reminder_drafted", entityType: "invoice", entityId: invoiceId, details: { reminderId } });
    return { taskId, reminderId };
  } catch (err: any) {
    updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
    throw err;
  }
}
