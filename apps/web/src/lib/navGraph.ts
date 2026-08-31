import type { AgentName, Room } from "./types.js";

export interface RoomDef {
  key: Room;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hall: "upper" | "lower";
}

export const UPPER_HALL_Y = 220;
export const LOWER_HALL_Y = 440;
export const CORE_X = 500;

export const ROOMS: RoomDef[] = [
  { key: "leads", label: "LEAD RADAR", x: 40, y: 40, w: 280, h: 160, hall: "upper" },
  { key: "estimating", label: "ESTIMATING LAB", x: 680, y: 40, w: 280, h: 160, hall: "upper" },
  { key: "approvals", label: "APPROVALS", x: 40, y: 460, w: 200, h: 150, hall: "lower" },
  { key: "jobs", label: "JOBS FLOOR", x: 270, y: 460, w: 200, h: 150, hall: "lower" },
  { key: "director", label: "DIRECTOR", x: 500, y: 460, w: 200, h: 150, hall: "lower" },
  { key: "finance", label: "FINANCE VAULT", x: 730, y: 460, w: 230, h: 150, hall: "lower" },
];

export function roomByKey(key: Room | null | undefined): RoomDef {
  return ROOMS.find((r) => r.key === key) ?? ROOMS.find((r) => r.key === "director")!;
}

export function roomCenter(room: RoomDef) {
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
}

/** The point where a room's door meets its corridor -- corridor travel must pass through this point. */
export function doorPoint(room: RoomDef) {
  const cx = room.x + room.w / 2;
  return room.hall === "upper" ? { x: cx, y: UPPER_HALL_Y } : { x: cx, y: LOWER_HALL_Y };
}

export const AGENT_HOME_ROOM: Record<AgentName, Room> = {
  director: "director",
  operations_ai: "jobs",
  estimator_ai: "estimating",
  finance_ai: "finance",
  debtor_ai: "finance",
  lead_hunter: "leads",
  research_ai: "leads",
  sales_ai: "leads",
};

/**
 * Multiple agents can share a room (e.g. Finance AI + Debtor AI both work
 * out of the Finance Vault). Without an offset they'd render exactly on
 * top of each other with overlapping labels, so each agent gets a fixed
 * horizontal slot within whichever room it's currently standing in.
 */
const HOME_GROUPS: Partial<Record<Room, AgentName[]>> = {};
for (const [agent, room] of Object.entries(AGENT_HOME_ROOM) as [AgentName, Room][]) {
  (HOME_GROUPS[room] ??= []).push(agent);
}

export const AGENT_SLOT_OFFSET: Record<AgentName, { dx: number; dy: number }> = (() => {
  const offsets = {} as Record<AgentName, { dx: number; dy: number }>;
  for (const room of Object.keys(HOME_GROUPS) as Room[]) {
    const agents = HOME_GROUPS[room]!;
    agents.forEach((agent, i) => {
      offsets[agent] = { dx: (i - (agents.length - 1) / 2) * 56, dy: 8 };
    });
  }
  return offsets;
})();

/**
 * The point an agent should rest at once it arrives in `room`, offset so
 * co-located agents don't overlap.
 *
 * Pass `slot` with the room's live occupancy. The fixed per-agent offsets
 * below are derived from each agent's HOME room, so a visitor -- the
 * Director reviewing in the Jobs Floor, say -- carried its home offset into
 * a room it doesn't live in and landed on top of a resident, printing
 * labels over each other. Slots computed from who is actually standing in
 * the room can't collide that way.
 */
export function agentRoomPosition(agent: AgentName, room: Room, slot?: { index: number; total: number }) {
  const center = roomCenter(roomByKey(room));
  if (slot && slot.total > 1) {
    return { x: center.x + (slot.index - (slot.total - 1) / 2) * 62, y: center.y + 8 };
  }
  if (slot && slot.total === 1) return { x: center.x, y: center.y + 8 };
  const offset = AGENT_SLOT_OFFSET[agent] ?? { dx: 0, dy: 0 };
  return { x: center.x + offset.dx, y: center.y + offset.dy };
}

/**
 * Defined navigation-node pathfinding (section 11: "no random CSS movement
 * across arbitrary coordinates"). Every hop stays on a corridor or inside
 * a room; crossing between the upper and lower room groups always routes
 * through the AI Core corridor at CORE_X, never diagonally through a wall.
 */
export function getPath(fromKey: Room, toKey: Room): { x: number; y: number }[] {
  const from = roomByKey(fromKey);
  const to = roomByKey(toKey);
  if (from.key === to.key) return [roomCenter(to)];

  const fromDoor = doorPoint(from);
  const toDoor = doorPoint(to);
  const points = [roomCenter(from), fromDoor];

  if (from.hall !== to.hall) {
    points.push({ x: CORE_X, y: fromDoor.y });
    points.push({ x: CORE_X, y: toDoor.y });
    points.push({ x: toDoor.x, y: toDoor.y });
  } else {
    points.push({ x: toDoor.x, y: fromDoor.y });
  }

  points.push(toDoor);
  points.push(roomCenter(to));
  return points;
}
