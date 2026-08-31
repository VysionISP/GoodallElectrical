import { useEffect, useState } from "react";
import RoomMap from "../components/RoomMap.js";
import { api } from "../lib/api.js";
import type { AgentTask, Approval, JobListItem, Notification } from "../lib/types.js";

export default function HQPage() {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);

  useEffect(() => {
    api.get<{ jobs: JobListItem[] }>("/jobs").then((r) => setJobs(r.jobs)).catch(() => {});
    api.get<{ approvals: Approval[] }>("/approvals?status=pending").then((r) => setApprovals(r.approvals)).catch(() => {});
    api.get<{ notifications: Notification[] }>("/notifications?unread=true").then((r) => setNotifications(r.notifications)).catch(() => {});

    // An idle map is ambiguous: it looks identical whether the agents are
    // between jobs or switched off entirely (no API key). Say which.
    function loadTasks() {
      api.get<{ tasks: AgentTask[] }>("/agent-tasks").then((r) => setTasks(r.tasks)).catch(() => {});
    }
    loadTasks();
    const interval = setInterval(loadTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  const activeJobs = jobs.filter((j) => j.status && !["completed", "cancelled"].includes(j.status)).length;
  // `?? 0` here was reading 102 jobs with no financial data as a confident
  // $0 -- exactly the "a missing value must never render as zero" rule this
  // build is meant to hold. Only jobs that actually carry a number count,
  // and if none do, the tile says so instead of inventing a total.
  const jobsWithOutstanding = jobs.filter((j) => typeof j.outstanding_amount === "number");
  const outstanding = jobsWithOutstanding.reduce((sum, j) => sum + (j.outstanding_amount as number), 0);

  return (
    <div>
      <div className="page-title">Headquarters</div>
      <div className="page-sub">
        Live view of every AI worker. Positions and status here reflect real agent_tasks rows -- nothing here is
        simulated.
      </div>

      <ActivityBanner tasks={tasks} />

      <div className="hq-grid">
        <div className="hq-stats">
          <StatCard label="Active jobs" value={jobs.length ? String(activeJobs) : "—"} />
          <StatCard label="Pending approvals" value={String(approvals.length)} accent={approvals.length > 0 ? "warn" : undefined} />
          <StatCard label="Unread notifications" value={String(notifications.length)} accent={notifications.length > 0 ? "info" : undefined} />
          <StatCard
            label={
              jobsWithOutstanding.length > 0
                ? `Outstanding (${jobsWithOutstanding.length} of ${jobs.length} jobs)`
                : "Outstanding"
            }
            value={jobsWithOutstanding.length > 0 ? formatMoney(outstanding) : "Not available"}
          />
        </div>

        <RoomMap />
      </div>
    </div>
  );
}

/**
 * A still map means one of two very different things -- agents idle between
 * jobs, or no agent has ever run because there's no API key. Distinguishing
 * them from real rows saves staring at a floor plan wondering which.
 */
function ActivityBanner({ tasks }: { tasks: AgentTask[] | null }) {
  if (tasks === null) return null;

  if (tasks.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <strong>No agent has run yet.</strong>{" "}
        <span style={{ color: "var(--text-dim)" }}>
          Nothing will move here until one does. Most often that means no AI provider key is saved -- check
          Integrations. Talking to the Director, or running a Fergus sync, also puts a worker on the map.
        </span>
      </div>
    );
  }

  const running = tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting");
  const newest = tasks[0];
  const lastAt = newest.finished_at ?? newest.updated_at;
  const minutesAgo = lastAt ? Math.round((Date.now() - new Date(lastAt).getTime()) / 60000) : null;

  return (
    <div className="card" style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span className={`pill ${running.length > 0 ? "pill-info" : "pill-muted"}`}>
        {running.length > 0 ? `${running.length} working now` : "All idle"}
      </span>
      <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Last activity: {newest.agent} · {newest.task_type}
        {minutesAgo !== null && ` · ${minutesAgo < 1 ? "just now" : `${minutesAgo} min ago`}`}
        {newest.message ? ` — ${newest.message}` : ""}
      </span>
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
