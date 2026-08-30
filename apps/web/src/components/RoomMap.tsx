import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import type { AgentName, AgentTask, Room } from "../lib/types.js";
import { AGENT_HOME_ROOM, CORE_X, LOWER_HALL_Y, ROOMS, UPPER_HALL_Y, agentRoomPosition, getPath } from "../lib/navGraph.js";
import "./RoomMap.css";

const ALL_AGENTS: AgentName[] = [
  "director",
  "operations_ai",
  "estimator_ai",
  "finance_ai",
  "debtor_ai",
  "lead_hunter",
  "research_ai",
  "sales_ai",
];

const AGENT_LABEL: Record<AgentName, string> = {
  director: "Director",
  operations_ai: "Operations AI",
  estimator_ai: "Estimator AI",
  finance_ai: "Finance AI",
  debtor_ai: "Debtor AI",
  lead_hunter: "Lead Hunter",
  research_ai: "Research AI",
  sales_ai: "Sales AI",
};

interface WorkerState {
  position: { x: number; y: number };
  queue: { x: number; y: number }[];
  lastRoom: Room;
  status: AgentTask["status"];
  message: string | null;
  taskType: string | null;
}

function initialWorkerState(agent: AgentName): WorkerState {
  const home = AGENT_HOME_ROOM[agent];
  return {
    position: agentRoomPosition(agent, home),
    queue: [],
    lastRoom: home,
    status: "idle",
    message: null,
    taskType: null,
  };
}

export default function RoomMap() {
  const [workers, setWorkers] = useState<Record<AgentName, WorkerState>>(() => {
    const initial = {} as Record<AgentName, WorkerState>;
    for (const a of ALL_AGENTS) initial[a] = initialWorkerState(a);
    return initial;
  });
  const workersRef = useRef(workers);
  workersRef.current = workers;

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const { tasks } = await api.get<{ tasks: AgentTask[] }>("/agent-tasks");
        if (cancelled) return;
        setWorkers((prev) => {
          const next = { ...prev };
          for (const agent of ALL_AGENTS) {
            const latest = tasks.find((t) => t.agent === agent);
            const targetRoom: Room = latest?.status === "completed" || !latest ? AGENT_HOME_ROOM[agent] : latest.room ?? AGENT_HOME_ROOM[agent];
            const current = next[agent];
            const status: AgentTask["status"] = latest ? latest.status : "idle";
            if (targetRoom !== current.lastRoom && current.queue.length === 0) {
              const path = getPath(current.lastRoom, targetRoom);
              path[path.length - 1] = agentRoomPosition(agent, targetRoom);
              next[agent] = { ...current, queue: path, lastRoom: targetRoom, status, message: latest?.message ?? null, taskType: latest?.task_type ?? null };
            } else {
              next[agent] = { ...current, status, message: latest?.message ?? null, taskType: latest?.task_type ?? null };
            }
          }
          return next;
        });
      } catch {
        // API not reachable -- leave workers where they are.
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Advance each worker one waypoint at a time so movement always follows
  // the corridor graph instead of jumping straight through walls.
  useEffect(() => {
    const stepper = setInterval(() => {
      setWorkers((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const agent of ALL_AGENTS) {
          const w = next[agent];
          if (w.queue.length > 0) {
            const [nextPoint, ...rest] = w.queue;
            next[agent] = { ...w, position: nextPoint, queue: rest };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 420);
    return () => clearInterval(stepper);
  }, []);

  return (
    <div className="room-map-wrap">
      <svg viewBox="0 0 1000 660" className="room-map-svg" role="img" aria-label="Virtual headquarters floor plan">
        {/* Floor */}
        <rect x={0} y={0} width={1000} height={660} className="rm-ground" />

        {/* Corridors */}
        <rect x={80} y={UPPER_HALL_Y - 20} width={840} height={40} className="rm-corridor" />
        <rect x={80} y={LOWER_HALL_Y - 20} width={870} height={40} className="rm-corridor" />
        <rect x={CORE_X - 20} y={UPPER_HALL_Y - 20} width={40} height={LOWER_HALL_Y - UPPER_HALL_Y + 40} className="rm-corridor" />
        <text x={890} y={UPPER_HALL_Y - 28} className="rm-corridor-label">
          MAIN HALL
        </text>

        {/* AI Core hub */}
        <circle cx={CORE_X} cy={(UPPER_HALL_Y + LOWER_HALL_Y) / 2} r={34} className="rm-core" />
        <text x={CORE_X} y={(UPPER_HALL_Y + LOWER_HALL_Y) / 2 + 4} textAnchor="middle" className="rm-core-label">
          AI CORE
        </text>

        {/* Rooms */}
        {ROOMS.map((room) => (
          <RoomShape key={room.key} room={room} />
        ))}

        {/* Workers */}
        {ALL_AGENTS.map((agent) => (
          <WorkerMarker key={agent} agent={agent} label={AGENT_LABEL[agent]} state={workers[agent]} />
        ))}
      </svg>
    </div>
  );
}

function RoomShape({ room }: { room: (typeof ROOMS)[number] }) {
  const doorWidth = 44;
  const doorX = room.x + room.w / 2 - doorWidth / 2;
  const doorY = room.hall === "upper" ? room.y + room.h - 3 : room.y;

  return (
    <g>
      <rect x={room.x} y={room.y} width={room.w} height={room.h} rx={6} className="rm-room" />
      {/* Desks/equipment decoration */}
      {Array.from({ length: 3 }).map((_, i) => (
        <rect key={i} x={room.x + 20 + i * 70} y={room.y + room.h - 46} width={46} height={26} rx={3} className="rm-desk" />
      ))}
      {/* Door opening cut into the wall, aligned with the corridor */}
      <rect x={doorX} y={doorY} width={doorWidth} height={6} className="rm-door" />
      <text x={room.x + room.w / 2} y={room.y + 22} textAnchor="middle" className="rm-room-label">
        {room.label}
      </text>
    </g>
  );
}

function WorkerMarker({ agent, label, state }: { agent: AgentName; label: string; state: WorkerState }) {
  const colorClass = `rm-worker-${statusColor(state.status)}`;
  return (
    <g transform={`translate(${state.position.x}, ${state.position.y})`} className="rm-worker">
      <circle r={11} className={colorClass} />
      <circle r={11} className={`rm-worker-pulse ${colorClass}`} />
      <text y={-16} textAnchor="middle" className="rm-worker-label">
        {label}
      </text>
      {state.status !== "idle" && (
        <text y={24} textAnchor="middle" className="rm-worker-status">
          {statusText(state)}
        </text>
      )}
    </g>
  );
}

function statusColor(status: AgentTask["status"]) {
  if (status === "failed") return "danger";
  if (status === "waiting") return "warn";
  if (status === "completed") return "ok";
  if (status === "running") return "info";
  return "idle";
}

function statusText(state: WorkerState) {
  if (state.status === "waiting") return "WAITING";
  if (state.status === "running") return state.message ?? "WORKING";
  if (state.status === "failed") return "FAILED";
  if (state.status === "completed") return "DONE";
  return "";
}
