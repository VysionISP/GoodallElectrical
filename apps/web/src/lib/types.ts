export type AgentName =
  | "director"
  | "operations_ai"
  | "estimator_ai"
  | "finance_ai"
  | "debtor_ai"
  | "lead_hunter"
  | "research_ai"
  | "sales_ai";

export type AgentTaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "idle";
export type Room = "jobs" | "estimating" | "finance" | "director" | "leads" | "approvals" | "core";

export interface AgentTask {
  id: string;
  agent: AgentName;
  task_type: string;
  room: Room | null;
  entity_type: string | null;
  entity_id: string | null;
  status: AgentTaskStatus;
  progress: number;
  message: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read: number;
  created_at: string;
}

export interface JobListItem {
  id: string;
  job_number: string | null;
  title: string | null;
  status: string | null;
  customer_name: string | null;
  quoted_amount: number | null;
  actual_cost: number | null;
  invoiced_amount: number | null;
  paid_amount: number | null;
  outstanding_amount: number | null;
  forecast_margin: number | null;
  financial_provenance: Record<string, string>;
  source: "fergus" | "manual";
}

export interface DirectorMessage {
  id: string;
  role: "owner" | "director";
  content: string;
  extracted_data: string | null;
  created_at: string;
}

export interface AiQuestion {
  id: string;
  agent: string;
  entity_type: string | null;
  entity_id: string | null;
  question: string;
  status: "open" | "answered" | "dismissed";
  job_number?: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  status: "pending" | "approved" | "rejected";
  requested_by: string | null;
  created_at: string;
}

export interface IntegrationSummary {
  provider: "fergus" | "xero" | "openai" | "smtp" | "google_places";
  status: "not_configured" | "connected" | "error";
  credentialHint: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  configured: boolean;
}
