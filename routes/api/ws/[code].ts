import { getSessionUser } from "../../../lib/auth.ts";
import { getRoom as getKvRoom, saveGameHistory, saveRoom, updateUserStats } from "../../../lib/kv.ts";
import { define } from "../../../utils.ts";
import {
  applyAction,
  buildUnitsFromSpawn,
  checkWinCondition,
  validateBuild,
  validateSpawn,
} from "../../../lib/game-engine.ts";
import {
  broadcast,
  broadcastToAll,
  generateRoomCode as _unused,
  getOrCreateRoom,
  getRoom,
  registerSocket,
  sendToUser,
  unregisterSocket,
} from "../../../lib/room-manager.ts";
import type {
  ActiveRoom,
} from "../../../lib/room-manager.ts";
import type {
  ClientMessage,
  GameState,
  RoomRecord,
  UnitBuild,
} from "../../../lib/types.ts";

const TURN_TIMER_MS = 60_000;

function startTurnTimer(
  room: ActiveRoom,
  kvRoom: RoomRecord,
  currentTurn: 1 | 2,
): void {
  clearTurnTimer(room);
  const deadline = Date.now() + TURN_TIMER_MS;
  broadcastToAll(room, { type: "turn_timer_start", deadline });

  room.turnTimerId = setTimeout(async () => {
    if (!room.gameState || room.gameState.turn !== currentTurn) return;

    // Auto end-turn
    const nextTurn = (currentTurn === 1 ? 2 : 1) as 1 | 2;
    broadcastToAll(room, { type: "turn_timeout", playerNum: currentTurn });

    room.gameState = { ...room.gameState, turn: nextTurn, actionsLeft: 2 };
    kvRoom.gameState = room.gameState;
    await saveRoom(kvRoom);

    broadcastToAll(room, { type: "turn_change", currentTurn: nextTurn });
    startTurnTimer(room, kvRoom, nextTurn);
  }, TURN_TIMER_MS);
}

function clearTurnTimer(room: ActiveRoom): void {
  if (room.turnTimerId !== null) {
    clearTimeout(room.turnTimerId);
    room.turnTimerId = null;
  }
}

export const handler = define.handlers({
  async GET(ctx): Promise<Response> {
    const code = ctx.params.code.toUpperCase();

    // Authenticate user from session cookie
    const user = await getSessionUser(ctx.req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Look up KV room record
    const kvRoom = await getKvRoom(code);
    if (!kvRoom) {
      return new Response("Room not found", { status: 404 });
    }

    // Check if user is allowed in this room
    const isHost = kvRoom.hostUserId === user.id;
    const isGuest = kvRoom.guestUserId === user.id;
    const isRoomOpen = kvRoom.status === "lobby" && !kvRoom.guestUserId;

    if (!isHost && !isGuest && !isRoomOpen) {
      return new Response("Room is full or you are not a member", {
        status: 403,
      });
    }

    // Upgrade to WebSocket
    const { socket, response } = Deno.upgradeWebSocket(ctx.req);

    // If new guest joining, update KV room
    if (!isHost && !isGuest && isRoomOpen) {
      kvRoom.guestUserId = user.id;
      kvRoom.playerSlots[user.id] = 2;
      kvRoom.updatedAt = Date.now();
      await saveRoom(kvRoom);
    }

    // Get or create in-memory room
    const room = getOrCreateRoom(code, kvRoom.hostUserId);

    // Restore map dimensions from KV (handles reconnect after server restart)
    room.mapCols = kvRoom.mapCols ?? 12;
    room.mapRows = kvRoom.mapRows ?? 12;

    // Assign player number
    const playerNum = (kvRoom.playerSlots[user.id] ?? (isHost ? 1 : 2)) as
      | 1
      | 2;
    room.playerNums.set(user.id, playerNum);

    socket.onopen = async () => {
      registerSocket(room, user.id, socket);

      // Restore game state from KV if reconnecting mid-game
      if (kvRoom.gameState && !room.gameState) {
        room.gameState = kvRoom.gameState;
        room.phase = kvRoom.status;
      }

      // Find opponent info
      const opponentId = playerNum === 1
        ? kvRoom.guestUserId
        : kvRoom.hostUserId;
      const opponentInRoom = opponentId
        ? room.sockets.has(opponentId)
        : false;
      let opponentName: string | null = null;
      let opponentAvatar: string | null = null;
      if (opponentId) {
        const { getUser } = await import("../../../lib/kv.ts");
        const opp = await getUser(opponentId);
        opponentName = opp?.name ?? null;
        opponentAvatar = opp?.avatarUrl ?? null;
      }

      sendToUser(room, user.id, {
        type: "welcome",
        userId: user.id,
        playerNum,
        roomCode: code,
        roomStatus: room.phase,
        opponentName,
        opponentAvatar,
        mapCols: room.mapCols,
        mapRows: room.mapRows,
      });

      // Notify opponent that this player connected
      if (opponentId && opponentInRoom) {
        broadcast(room, {
          type: "player_joined",
          userId: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
        }, user.id);

        // If both now connected and in lobby, move to economy
        if (room.phase === "lobby" && room.sockets.size === 2) {
          room.phase = "economy";
          kvRoom.status = "economy";
          await saveRoom(kvRoom);
          broadcastToAll(room, { type: "phase_change", phase: "economy" });
        }
      }

      // If reconnecting to active game, re-send game state
      if (room.gameState && room.phase === "combat") {
        sendToUser(room, user.id, {
          type: "game_start",
          state: room.gameState,
        });
      }
    };

    socket.onmessage = async (event) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "ping":
          sendToUser(room, user.id, { type: "pong" });
          break;

        case "build_ready": {
          const errors = validateBuild(msg.build);
          if (errors.length) {
            sendToUser(room, user.id, {
              type: "error",
              code: "INVALID_BUILD",
              message: errors[0],
            });
            return;
          }
          room.builds.set(user.id, msg.build);
          kvRoom.playerBuilds[user.id] = msg.build;

          // Notify opponent
          broadcast(room, { type: "opponent_build_ready" }, user.id);

          // Check if both ready
          if (room.builds.size === 2) {
            room.phase = "spawn";
            kvRoom.status = "spawn";
            await saveRoom(kvRoom);
            broadcastToAll(room, { type: "phase_change", phase: "spawn" });
          }
          break;
        }

        case "map_size": {
          if (playerNum !== 1) return; // only host sets map size
          room.mapCols = msg.mapCols;
          room.mapRows = msg.mapRows;
          kvRoom.mapCols = msg.mapCols;
          kvRoom.mapRows = msg.mapRows;
          await saveRoom(kvRoom);
          broadcast(room, { type: "map_size", mapCols: msg.mapCols, mapRows: msg.mapRows }, user.id);
          break;
        }

        case "spawn_ready": {
          const errors = validateSpawn(msg.spawn, room.mapCols, room.mapRows, playerNum);
          if (errors.length) {
            sendToUser(room, user.id, {
              type: "error",
              code: "INVALID_SPAWN",
              message: errors[0],
            });
            return;
          }
          room.spawns.set(user.id, msg.spawn);
          kvRoom.playerSpawns[user.id] = msg.spawn;

          broadcast(room, { type: "opponent_spawn_ready" }, user.id);

          // Check if both spawns ready
          if (room.spawns.size === 2) {
            await buildAndStartGame(room, kvRoom);
          }
          break;
        }

        case "action": {
          if (!room.gameState) return;

          const result = applyAction(room.gameState, msg.action, playerNum);
          if (result.error) {
            sendToUser(room, user.id, {
              type: "error",
              code: result.error,
              message: result.error,
            });
            return;
          }

          room.gameState = result.newState;
          kvRoom.gameState = result.newState;
          kvRoom.updatedAt = Date.now();
          await saveRoom(kvRoom);

          broadcastToAll(room, {
            type: "state_update",
            state: result.newState,
            logMessage: result.logMessage,
            actorPlayerNum: playerNum,
          });

          // Check win condition
          const winner = checkWinCondition(result.newState);
          if (winner) {
            room.phase = "result";
            kvRoom.status = "result";
            const winnerId = winner === 1 ? kvRoom.hostUserId : (kvRoom.guestUserId ?? kvRoom.hostUserId);
            kvRoom.winnerId = winnerId;
            await saveRoom(kvRoom);

            broadcastToAll(room, {
              type: "game_over",
              winnerPlayerNum: winner,
              winnerId,
            });

            await recordGameResult(kvRoom, winner);
          }
          break;
        }

        case "end_turn": {
          if (!room.gameState) return;
          if (room.gameState.turn !== playerNum) {
            sendToUser(room, user.id, {
              type: "error",
              code: "NOT_YOUR_TURN",
              message: "Not your turn.",
            });
            return;
          }

          clearTurnTimer(room);
          const nextTurn = (room.gameState.turn === 1 ? 2 : 1) as 1 | 2;
          room.gameState = {
            ...room.gameState,
            turn: nextTurn,
            actionsLeft: 2,
          };
          kvRoom.gameState = room.gameState;
          await saveRoom(kvRoom);

          broadcastToAll(room, { type: "turn_change", currentTurn: nextTurn });
          startTurnTimer(room, kvRoom, nextTurn);
          break;
        }

        case "new_round": {
          room.newRoundVotes.set(user.id, msg.rebuild);

          // Check if both voted
          if (room.newRoundVotes.size === 2) {
            const rebuild = Array.from(room.newRoundVotes.values()).some((v) => v);
            room.newRoundVotes.clear();

            if (rebuild) {
              room.builds.clear();
              room.spawns.clear();
              room.gameState = null;
              room.phase = "economy";
              kvRoom.playerBuilds = {};
              kvRoom.playerSpawns = {};
              kvRoom.gameState = null;
              kvRoom.status = "economy";
              kvRoom.round = (kvRoom.round ?? 1) + 1;
              kvRoom.winnerId = null;
              await saveRoom(kvRoom);
              broadcastToAll(room, { type: "new_round_start", rebuild: true });
              broadcastToAll(room, { type: "phase_change", phase: "economy" });
            } else {
              // Keep builds, redo spawns
              room.spawns.clear();
              room.gameState = null;
              room.phase = "spawn";
              kvRoom.playerSpawns = {};
              kvRoom.gameState = null;
              kvRoom.status = "spawn";
              kvRoom.round = (kvRoom.round ?? 1) + 1;
              kvRoom.winnerId = null;
              await saveRoom(kvRoom);
              broadcastToAll(room, { type: "new_round_start", rebuild: false });
              broadcastToAll(room, { type: "phase_change", phase: "spawn" });
            }
          }
          break;
        }
      }
    };

    socket.onclose = () => {
      unregisterSocket(room, user.id);
      if (room.sockets.size === 0) {
        clearTurnTimer(room);
      }
    };

    return response;
  },
});

async function buildAndStartGame(
  room: ReturnType<typeof getOrCreateRoom>,
  kvRoom: RoomRecord,
): Promise<void> {
  const hostId = kvRoom.hostUserId;
  const guestId = kvRoom.guestUserId!;

  const p1Build = room.builds.get(hostId) as UnitBuild[];
  const p2Build = room.builds.get(guestId) as UnitBuild[];
  const p1Spawn = room.spawns.get(hostId)!;
  const p2Spawn = room.spawns.get(guestId)!;

  const p1Units = buildUnitsFromSpawn(1, p1Spawn, p1Build);
  const p2Units = buildUnitsFromSpawn(2, p2Spawn, p2Build);

  const gameState: GameState = {
    mapCols: room.mapCols,
    mapRows: room.mapRows,
    turn: 1,
    actionsLeft: 2,
    units: [...p1Units, ...p2Units],
    round: kvRoom.round ?? 1,
  };

  room.gameState = gameState;
  room.phase = "combat";
  kvRoom.gameState = gameState;
  kvRoom.status = "combat";
  kvRoom.updatedAt = Date.now();
  await saveRoom(kvRoom);

  broadcastToAll(room, { type: "game_start", state: gameState });
  startTurnTimer(room, kvRoom, 1);
}

async function recordGameResult(
  kvRoom: RoomRecord,
  winnerPlayerNum: 1 | 2,
): Promise<void> {
  const winnerId = kvRoom.winnerId!;
  const loserId = winnerPlayerNum === 1
    ? (kvRoom.guestUserId ?? "")
    : kvRoom.hostUserId;

  if (!loserId) return;

  const gameId = `${kvRoom.code}_${Date.now()}`;

  await Promise.all([
    updateUserStats(winnerId, "win"),
    updateUserStats(loserId, "loss"),
    saveGameHistory(winnerId, {
      gameId,
      opponent: loserId,
      result: "win",
      mapSize: kvRoom.mapCols,
      rounds: kvRoom.round ?? 1,
      playedAt: Date.now(),
    }),
    saveGameHistory(loserId, {
      gameId,
      opponent: winnerId,
      result: "loss",
      mapSize: kvRoom.mapCols,
      rounds: kvRoom.round ?? 1,
      playedAt: Date.now(),
    }),
  ]);
}
