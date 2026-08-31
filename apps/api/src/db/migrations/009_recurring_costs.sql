-- Structured recurring costs (wages, super, fixed overheads, regular
-- material spend) the owner enters directly as amount + frequency, rather
-- than free text an LLM would have to parse for a number that ends up in
-- a financial forecast. Starts empty; the cashflow forecast is honest
-- about $0 meaning "nothing entered yet", not "no costs exist".

CREATE TABLE IF NOT EXISTS recurring_costs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('wages', 'super', 'fixed', 'materials', 'other')),
  amount REAL NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
