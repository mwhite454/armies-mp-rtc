// ─── User / Auth ────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string; // Google "sub" claim
  email: string;
  name: string;
  avatarUrl: string;
  createdAt: number;
  wins: number;
  losses: number;
  elo: number;
}

// ─── Game Core ───────────────────────────────────────────────────────────────

export type UnitType = "Leader" | "Heavy" | "Sniper" | "Dasher";
export const UNIT_EMOJIS: Record<UnitType, string> = {
  Leader: "👑",
  Heavy: "🛡️",
  Sniper: "🎯",
  Dasher: "⚡",
};
export const UNIT_COLORS: Record<UnitType, string> = {
  Leader: "#fbbf24",
  Heavy: "#f87171",
  Sniper: "#a78bfa",
  Dasher: "#34d399",
};
export const UNIT_TYPES: UnitType[] = ["Leader", "Heavy", "Sniper", "Dasher"];

export interface UnitBuild {
  Move: number;
  Health: number;
  Damage: number;
  Range: number;
}

export interface Unit {
  id: string; // e.g. "p1_0"
  player: 1 | 2;
  name: UnitType;
  emoji: string;
  color: string;
  Move: number;
  Health: number;
  Damage: number;
  Range: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  loaded: boolean;
}

export interface GameState {
  mapSize: 8 | 12 | 16;
  turn: 1 | 2; // whose turn
  actionsLeft: number; // 0-2
  units: Unit[];
  round: number;
}

// ─── Room ────────────────────────────────────────────────────────────────────

export type RoomStatus =
  | "lobby"
  | "economy"
  | "spawn"
  | "combat"
  | "result";

export interface RoomRecord {
  code: string;
  status: RoomStatus;
  hostUserId: string;
  guestUserId: string | null;
  createdAt: number;
  updatedAt: number;
  gameState: GameState | null;
  playerBuilds: Partial<Record<string, UnitBuild[]>>;
  playerSpawns: Partial<Record<string, { x: number; y: number }[]>>;
  mapSize: 8 | 12 | 16;
  playerSlots: Partial<Record<string, 1 | 2>>;
  winnerId: string | null;
  round: number;
}

// ─── Game History ─────────────────────────────────────────────────────────────

export interface GameHistoryRecord {
  gameId: string;
  opponent: string;
  result: "win" | "loss";
  mapSize: number;
  rounds: number;
  playedAt: number;
}

// ─── Game Actions ─────────────────────────────────────────────────────────────

export interface MoveAction {
  type: "move";
  unitId: string;
  x: number;
  y: number;
}

export interface ReloadAction {
  type: "reload";
  unitId: string;
}

export interface FireAction {
  type: "fire";
  unitId: string;
  targetId: string;
}

export type GameAction = MoveAction | ReloadAction | FireAction;

// ─── WebSocket Messages ───────────────────────────────────────────────────────

// Client → Server
export type ClientMessage =
  | { type: "join_room"; code: string }
  | { type: "build_ready"; build: UnitBuild[] }
  | { type: "map_size"; size: 8 | 12 | 16 }
  | { type: "spawn_ready"; spawn: { x: number; y: number }[] }
  | { type: "action"; action: GameAction }
  | { type: "end_turn" }
  | { type: "new_round"; rebuild: boolean }
  | { type: "ping" };

// Server → Client
export type ServerMessage =
  | {
    type: "welcome";
    userId: string;
    playerNum: 1 | 2;
    roomCode: string;
    roomStatus: RoomStatus;
    opponentName: string | null;
    opponentAvatar: string | null;
    mapSize: 8 | 12 | 16;
  }
  | { type: "player_joined"; userId: string; name: string; avatarUrl: string }
  | { type: "phase_change"; phase: RoomStatus }
  | { type: "opponent_build_ready" }
  | { type: "map_size"; size: 8 | 12 | 16 }
  | { type: "opponent_spawn_ready" }
  | { type: "game_start"; state: GameState }
  | {
    type: "state_update";
    state: GameState;
    logMessage: string;
    actorPlayerNum: 1 | 2;
  }
  | { type: "turn_change"; currentTurn: 1 | 2 }
  | { type: "game_over"; winnerPlayerNum: 1 | 2; winnerId: string }
  | { type: "new_round_start"; rebuild: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };
