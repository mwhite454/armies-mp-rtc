import type { GameHistoryRecord, RoomRecord, UserRecord } from "./types.ts";

let _kv: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function getUser(userId: string): Promise<UserRecord | null> {
  const kv = await getKv();
  const entry = await kv.get<UserRecord>(["users", userId]);
  return entry.value;
}

export async function upsertUser(
  user:
    & Omit<UserRecord, "wins" | "losses" | "elo" | "createdAt">
    & Partial<Pick<UserRecord, "wins" | "losses" | "elo" | "createdAt">>,
): Promise<UserRecord> {
  const kv = await getKv();
  const existing = await getUser(user.id);
  const record: UserRecord = {
    wins: 0,
    losses: 0,
    elo: 1000,
    createdAt: Date.now(),
    ...existing,
    ...user,
  };
  await kv.set(["users", record.id], record);
  return record;
}

export async function updateUserStats(
  userId: string,
  result: "win" | "loss",
): Promise<void> {
  const kv = await getKv();
  const user = await getUser(userId);
  if (!user) return;

  const eloChange = result === "win" ? 25 : -25;
  const updated: UserRecord = {
    ...user,
    wins: user.wins + (result === "win" ? 1 : 0),
    losses: user.losses + (result === "loss" ? 1 : 0),
    elo: Math.max(500, user.elo + eloChange),
  };
  await kv.set(["users", userId], updated);

  // Update leaderboard index (inverted elo for descending order)
  const invertedElo = Number.MAX_SAFE_INTEGER - updated.elo;
  await kv.set(["leaderboard", invertedElo, userId], {
    userId,
    elo: updated.elo,
    wins: updated.wins,
    losses: updated.losses,
    name: updated.name,
    avatarUrl: updated.avatarUrl,
  });
}

// ─── Rooms ────────────────────────────────────────────────────────────────────

const ROOM_TTL_MS = 86_400_000; // 24 hours

export async function getRoom(code: string): Promise<RoomRecord | null> {
  const kv = await getKv();
  const entry = await kv.get<RoomRecord>(["rooms", code]);
  return entry.value;
}

export async function saveRoom(room: RoomRecord): Promise<void> {
  const kv = await getKv();
  await kv.set(["rooms", room.code], room, { expireIn: ROOM_TTL_MS });
}

export async function listOpenRooms(): Promise<RoomRecord[]> {
  const kv = await getKv();
  const rooms: RoomRecord[] = [];
  const iter = kv.list<RoomRecord>({ prefix: ["rooms"] });
  for await (const entry of iter) {
    if (entry.value.status === "lobby" && !entry.value.guestUserId) {
      rooms.push(entry.value);
    }
  }
  return rooms;
}

// ─── Game History ─────────────────────────────────────────────────────────────

export async function saveGameHistory(
  userId: string,
  record: GameHistoryRecord,
): Promise<void> {
  const kv = await getKv();
  await kv.set(["game_history", userId, record.gameId], record);
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  userId: string;
  elo: number;
  wins: number;
  losses: number;
  name: string;
  avatarUrl: string;
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  const kv = await getKv();
  const entries: LeaderboardEntry[] = [];
  const iter = kv.list<LeaderboardEntry>({ prefix: ["leaderboard"] }, {
    limit,
  });
  for await (const entry of iter) {
    entries.push(entry.value);
  }
  return entries;
}
