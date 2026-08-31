import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import type { AgentTask, AiQuestion, Approval, DirectorMessage, Notification } from "../lib/types.js";
import "./DirectorWidget.css";

type Tab = "chat" | "needs-you" | "activity";

export default function DirectorWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<DirectorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [questions, setQuestions] = useState<AiQuestion[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activityNotifs, setActivityNotifs] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // What's actually waiting on the owner: open questions, pending
  // approvals, and unread problems (sync failures and the like). The API
  // already excludes notifications that merely mirror a question or an
  // approval, so nothing here is counted twice.
  const needsYouCount = questions.length + approvals.length;
  const badgeCount = needsYouCount + unreadCount;

  async function answerQuestion(q: AiQuestion) {
    const answer = answerDrafts[q.id]?.trim();
    if (!answer) return;
    setAnswering(q.id);
    try {
      // Route the answer through the Director's chat pipeline so it gets
      // extracted into structured job_context, not just recorded as raw
      // text -- an answer to "is this night work?" should actually update
      // what the Director knows about the job, not just close the question.
      const context = q.job_number ? `Re: ${q.job_number} -- ${q.question}` : `Re: ${q.question}`;
      await api.post("/director/chat", { message: `${context}\nAnswer: ${answer}` });
      // Belt-and-suspenders: the chat extraction only auto-resolves a
      // question if its wording happens to match the extracted fact's key,
      // which isn't guaranteed. Explicitly mark this specific question
      // answered too, so it reliably clears from Needs You either way.
      await api.post(`/director/questions/${q.id}/answer`, { answer, answeredBy: "owner" });
      setAnswerDrafts((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      await refreshBadges();
      setTab("chat");
      const fresh = await api.get<{ messages: DirectorMessage[] }>("/director/messages");
      setMessages(fresh.messages);
    } catch (err: any) {
      alert(`Couldn't send that answer: ${err.message}`);
    } finally {
      setAnswering(null);
    }
  }

  async function refreshBadges() {
    try {
      const notif = await api.get<{ unreadCount: number }>("/notifications?unread=true");
      const needsYou = await api.get<{ questions: AiQuestion[]; approvals: Approval[] }>("/director/needs-you");
      setUnreadCount(notif.unreadCount);
      setQuestions(needsYou.questions);
      setApprovals(needsYou.approvals);
    } catch {
      // Backend not reachable yet -- badges just stay at their last value.
    }
  }

  useEffect(() => {
    refreshBadges();
    const interval = setInterval(refreshBadges, 8000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (tab === "chat") {
      api.get<{ messages: DirectorMessage[] }>("/director/messages").then((r) => setMessages(r.messages));
    } else if (tab === "activity") {
      api
        .get<{ tasks: AgentTask[]; notifications: Notification[] }>("/director/activity")
        .then((r) => {
          setTasks(r.tasks);
          setActivityNotifs(r.notifications);
        });
      // Viewing Activity is how unread notifications get acknowledged --
      // without this the FAB badge counted them forever with no way to
      // clear it, even though they were visible right here.
      if (unreadCount > 0) {
        api.post("/notifications/read-all").then(() => setUnreadCount(0));
      }
    }
  }, [open, tab]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "owner", content: text, extracted_data: null, created_at: new Date().toISOString() },
    ]);
    try {
      const result = await api.post<{ reply: string }>("/director/chat", { message: text });
      const fresh = await api.get<{ messages: DirectorMessage[] }>("/director/messages");
      setMessages(fresh.messages);
      void result;
      refreshBadges();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "director",
          content: `Something went wrong talking to the Director: ${err.message}`,
          extracted_data: null,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="director-widget">
      {open && (
        <div className="director-panel">
          <div className="director-panel-header">
            <div>
              <strong>AI DIRECTOR</strong>
              <span className="director-live-dot" /> LIVE
            </div>
            <button className="director-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="director-tabs">
            <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
              Chat
            </button>
            <button className={tab === "needs-you" ? "active" : ""} onClick={() => setTab("needs-you")}>
              Needs You{needsYouCount > 0 ? ` (${needsYouCount})` : ""}
            </button>
            <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
              Activity{unreadCount > 0 ? ` (${unreadCount})` : ""}
            </button>
          </div>

          {tab === "chat" && (
            <>
              <div className="director-messages" ref={scrollRef}>
                {messages.length === 0 && (
                  <div className="director-empty">
                    Ask the Director about jobs, quotes, cashflow, or tell it something about a job -- e.g.
                    "ELEC-3256 is two electricians for two nights, shutdown Tuesday 3:30am."
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`director-msg director-msg-${m.role}`}>
                    <div className="director-msg-role">{m.role === "owner" ? "You" : "Director"}</div>
                    <div className="director-msg-content">{m.content}</div>
                  </div>
                ))}
                {sending && <div className="director-msg director-msg-director director-typing">Thinking…</div>}
              </div>
              <div className="director-input">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder="Message Director..."
                  disabled={sending}
                />
                <button className="btn" onClick={sendMessage} disabled={sending || !draft.trim()}>
                  ➤
                </button>
              </div>
            </>
          )}

          {tab === "needs-you" && (
            <div className="director-list">
              {needsYouCount === 0 && <div className="director-empty">Nothing needs you right now.</div>}
              {questions.map((q) => (
                <div key={q.id} className="director-list-item director-question">
                  <span className="pill pill-warn">Question</span>
                  <div style={{ flex: 1 }}>
                    <div>{q.question}</div>
                    {q.job_number && <div className="director-list-meta">{q.job_number}</div>}
                    <div className="director-answer-row">
                      <input
                        placeholder="Type your answer..."
                        value={answerDrafts[q.id] ?? ""}
                        onChange={(e) => setAnswerDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && answerQuestion(q)}
                        disabled={answering === q.id}
                      />
                      <button
                        className="btn"
                        disabled={answering === q.id || !answerDrafts[q.id]?.trim()}
                        onClick={() => answerQuestion(q)}
                      >
                        {answering === q.id ? "…" : "Reply"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {approvals.map((a) => (
                <div key={a.id} className="director-list-item">
                  <span className="pill pill-danger">Approval</span>
                  <div>
                    <div>
                      {a.entity_type} · {a.action}
                    </div>
                    <div className="director-list-meta">{a.entity_id}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "activity" && (
            <div className="director-list">
              {tasks.slice(0, 15).map((t) => (
                <div key={t.id} className="director-list-item">
                  <span className={`pill pill-${statusPill(t.status)}`}>{t.status}</span>
                  <div>
                    <div>
                      {t.agent} · {t.task_type}
                    </div>
                    <div className="director-list-meta">{t.message ?? t.room ?? ""}</div>
                    {/* A failed task's reason was recorded but never shown, so
                        every failure looked identical and undiagnosable. */}
                    {t.status === "failed" && t.error && (
                      <div className="director-list-meta" style={{ color: "var(--danger)", wordBreak: "break-word" }}>
                        {t.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {activityNotifs.slice(0, 10).map((n) => (
                <div key={n.id} className="director-list-item">
                  <span className={`pill pill-${severityPill(n.severity)}`}>{n.severity}</span>
                  <div>
                    <div>{n.title}</div>
                    <div className="director-list-meta">{n.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <button className="director-fab" onClick={() => setOpen((v) => !v)}>
        {badgeCount > 0 && <span className="director-fab-badge">{badgeCount}</span>}
        <span className="director-fab-dot" />
        AI
      </button>
    </div>
  );
}

function statusPill(status: string) {
  if (status === "failed") return "danger";
  if (status === "waiting") return "warn";
  if (status === "completed") return "ok";
  if (status === "running") return "info";
  return "muted";
}

function severityPill(severity: string) {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warn";
  return "info";
}
