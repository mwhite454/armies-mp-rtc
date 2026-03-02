import { define } from "../../utils.ts";
import { getRoom, listOpenRooms, saveRoom } from "../../lib/kv.ts";
import { generateRoomCode } from "../../lib/room-manager.ts";
import type { RoomRecord } from "../../lib/types.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.state.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const rooms = await listOpenRooms();
    return Response.json(rooms);
  },

  async POST(ctx) {
    if (!ctx.state.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Generate unique room code
    let code = generateRoomCode();
    while (await getRoom(code)) {
      code = generateRoomCode();
    }

    const room: RoomRecord = {
      code,
      status: "lobby",
      hostUserId: ctx.state.user.id,
      guestUserId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      gameState: null,
      playerBuilds: {},
      playerSpawns: {},
      mapCols: 12,
      mapRows: 12,
      playerSlots: { [ctx.state.user.id]: 1 },
      winnerId: null,
      round: 1,
    };

    await saveRoom(room);
    return Response.json({ code });
  },
});
