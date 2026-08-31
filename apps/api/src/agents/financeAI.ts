import { getDb } from "../db/connection.js";
import { getIntegrationConfig } from "../integrations/store.js";

const FORECAST_WINDOWS = [7, 14, 30, 60, 90] as const;
export type ForecastWindow = (typeof FORECAST_WINDOWS)[number];

function dailyRate(amount: number, frequency: "weekly" | "fortnightly" | "monthly"): number {
  if (frequency === "weekly") return amount / 7;
  if (frequency === "fortnightly") return amount / 14;
  return amount / 30.4; // average month length
}

export interface ForecastWindowResult {
  days: ForecastWindow;
  expectedReceipts: number;
  payables: number;
  recurringCosts: { wages: number; super: number; fixed: number; materials: number; other: number; total: number };
  forecastCash: number | null; // null if current cash itself is unknown
}

export interface CashflowForecast {
  currentCash: number | null;
  cashPositionAt: string | null;
  xeroConfigured: boolean;
  hasRecurringCosts: boolean;
  windows: ForecastWindowResult[];
}

/**
 * Builds a real cashflow forecast from synced data -- current cash (Xero
 * BankSummary), outstanding receivables (invoices), payables (bills), and
 * whatever recurring costs the owner has actually entered. Never invents
 * a wages/super/fixed-cost figure: if nothing has been entered under
 * Recurring Costs, those lines are genuinely $0 and `hasRecurringCosts`
 * says so, so the caller can be honest that the forecast is incomplete
 * rather than presenting it as a full picture.
 */
export function computeCashflowForecast(): CashflowForecast {
  const db = getDb();
  const xeroConfig = getIntegrationConfig("xero");
  const currentCash = typeof xeroConfig?.cashPosition === "number" ? xeroConfig.cashPosition : null;
  const cashPositionAt = typeof xeroConfig?.cashPositionAt === "string" ? xeroConfig.cashPositionAt : null;

  const recurringCosts = db
    .prepare("SELECT category, amount, frequency FROM recurring_costs WHERE active = 1")
    .all() as { category: string; amount: number; frequency: "weekly" | "fortnightly" | "monthly" }[];
  const dailyByCategory: Record<string, number> = { wages: 0, super: 0, fixed: 0, materials: 0, other: 0 };
  for (const c of recurringCosts) {
    dailyByCategory[c.category] = (dailyByCategory[c.category] ?? 0) + dailyRate(c.amount, c.frequency);
  }

  const today = new Date();
  const windows: ForecastWindowResult[] = FORECAST_WINDOWS.map((days) => {
    const cutoff = new Date(today.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const receipts = db
      .prepare(
        `SELECT COALESCE(SUM(amount_due), 0) as total FROM invoices
         WHERE status NOT IN ('paid', 'voided', 'draft') AND amount_due > 0 AND due_date IS NOT NULL AND due_date <= ?`
      )
      .get(cutoff) as { total: number };

    const payables = db
      .prepare(
        `SELECT COALESCE(SUM(amount_due), 0) as total FROM bills
         WHERE status NOT IN ('PAID', 'VOIDED', 'DRAFT') AND amount_due > 0 AND due_date IS NOT NULL AND due_date <= ?`
      )
      .get(cutoff) as { total: number };

    const costs = {
      wages: round2(dailyByCategory.wages * days),
      super: round2(dailyByCategory.super * days),
      fixed: round2(dailyByCategory.fixed * days),
      materials: round2(dailyByCategory.materials * days),
      other: round2(dailyByCategory.other * days),
      total: 0,
    };
    costs.total = round2(costs.wages + costs.super + costs.fixed + costs.materials + costs.other);

    const forecastCash =
      currentCash === null ? null : round2(currentCash + receipts.total - payables.total - costs.total);

    return {
      days,
      expectedReceipts: round2(receipts.total),
      payables: round2(payables.total),
      recurringCosts: costs,
      forecastCash,
    };
  });

  return {
    currentCash,
    cashPositionAt,
    xeroConfigured: xeroConfig !== null,
    hasRecurringCosts: recurringCosts.length > 0,
    windows,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
