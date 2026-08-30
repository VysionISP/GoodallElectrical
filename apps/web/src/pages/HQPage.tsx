import { useEffect, useState } from "react";
import RoomMap from "../components/RoomMap.js";
import { api } from "../lib/api.js";
import type { Approval, JobListItem, Notification } from "../lib/types.js";

export default function HQPage() {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    api.get<{ jobs: JobListItem[] }>("/jobs").then((r) => setJobs(r.jobs)).catch(() => {});
    api.get<{ approvals: Approval[] }>("/approvals?status=pending").then((r) => setApprovals(r.approvals)).catch(() => {});
    api.get<{ notifications: Notification[] }>("/notifications?unread=true").then((r) => setNotifications(r.notifications)).catch(() => {});
  }, []);

  const activeJobs = jobs.filter((j) => j.status && !["completed", "cancelled"].includes(j.status)).length;
  const overdue = jobs.reduce((sum, j) => sum + (j.outstanding_amount ?? 0), 0);

  return (
    <div>
      <div className="page-title">Headquarters</div>
      <div className="page-sub">
        Live view of every AI worker. Positions and status here reflect real agent_tasks rows -- nothing here is
        simulated.
      </div>

      <div className="hq-grid">
        <div className="hq-stats">
          <StatCard label="Active jobs" value={jobs.length ? String(activeJobs) : "—"} />
          <StatCard label="Pending approvals" value={String(approvals.length)} accent={approvals.length > 0 ? "warn" : undefined} />
          <StatCard label="Unread notifications" value={String(notifications.length)} accent={notifications.length > 0 ? "info" : undefined} />
          <StatCard label="Outstanding (known jobs)" value={jobs.length ? formatMoney(overdue) : "—"} />
        </div>

        <RoomMap />
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: "warn" | "info" }) {
  return (
    <div className="card hq-stat">
      <div className="hq-stat-label">{label}</div>
      <div className={`hq-stat-value ${accent ? `hq-stat-${accent}` : ""}`}>{value}</div>
    </div>
  );
}

function formatMoney(n: number) {
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
}
