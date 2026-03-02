/**
 * In-memory room state and WebSocket connection registry.
 * Paired with Deno KV for durable state persistence.
 */
import type {
  GameState,
  HexCoord,
  RoomStatus,
  ServerMessage,
  UnitBuild,
} from "./types.ts";

export interface ActiveRoom {
  code: string;
  sockets: Map<string, WebSocket>; // userId -> socket
  playerNums: Map<string, 1 | 2>; // userId -> playerNum
  phase: RoomStatus;
  gameState: GameState | null;
  actionsLeftThisTurn: number;
  builds: Map<string, UnitBuild[]>;
  spawns: Map<string, HexCoord[]>;
  mapCols: number;
  mapRows: number;
  hostUserId: string;
  newRoundVotes: Map<string, boolean>; // userId -> rebuild?
  turnTimerId: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, ActiveRoom>();

export function getRoom(code: string): ActiveRoom | undefined {
  return rooms.get(code);
}

export function getOrCreateRoom(
  code: string,
  hostUserId: string,
): ActiveRoom {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      sockets: new Map(),
      playerNums: new Map(),
      phase: "lobby",
      gameState: null,
      actionsLeftThisTurn: 2,
      builds: new Map(),
      spawns: new Map(),
      mapCols: 12,
      mapRows: 12,
      hostUserId,
      newRoundVotes: new Map(),
      turnTimerId: null,
    };
    rooms.set(code, room);
  }
  return room;
}

export function registerSocket(
  room: ActiveRoom,
  userId: string,
  socket: WebSocket,
): void {
  room.sockets.set(userId, socket);
}

export function unregisterSocket(room: ActiveRoom, userId: string): void {
  room.sockets.delete(userId);
  if (room.sockets.size === 0) {
    rooms.delete(room.code);
  }
}

export function broadcast(
  room: ActiveRoom,
  message: ServerMessage,
  excludeUserId?: string,
): void {
  const json = JSON.stringify(message);
  for (const [userId, socket] of room.sockets) {
    if (userId === excludeUserId) continue;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(json);
    }
  }
}

export function broadcastToAll(room: ActiveRoom, message: ServerMessage): void {
  broadcast(room, message);
}

export function sendToUser(
  room: ActiveRoom,
  userId: string,
  message: ServerMessage,
): void {
  const socket = room.sockets.get(userId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function generateRoomCode(): string {
  // Exclude visually confusing chars: 0/O, 1/I/L
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
