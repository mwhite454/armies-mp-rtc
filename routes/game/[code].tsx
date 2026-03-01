import { define } from "../../utils.ts";
import { Navbar } from "../../components/Navbar.tsx";
import { getRoom } from "../../lib/kv.ts";
import GameIsland from "../../islands/GameIsland.tsx";

export default define.page(async function GamePage(ctx) {
  const user = ctx.state.user!;
  const code = ctx.params.code.toUpperCase();

  const room = await getRoom(code);
  if (!room) {
    return (
      <div class="min-h-screen bg-base-100 flex items-center justify-center">
        <div class="text-center">
          <p class="text-error text-xl mb-4">Room not found: {code}</p>
          <a href="/lobby" class="btn btn-primary">Back to Lobby</a>
        </div>
      </div>
    );
  }

  // Verify user is host, guest, or room is open
  const isHost = room.hostUserId === user.id;
  const isGuest = room.guestUserId === user.id;
  const isOpen = room.status === "lobby" && !room.guestUserId;

  if (!isHost && !isGuest && !isOpen) {
    return (
      <div class="min-h-screen bg-base-100 flex items-center justify-center">
        <div class="text-center">
          <p class="text-error text-xl mb-4">Room is full.</p>
          <a href="/lobby" class="btn btn-primary">Back to Lobby</a>
        </div>
      </div>
    );
  }

  const playerNum = isHost ? 1 : 2;

  return (
    <div class="min-h-screen bg-base-100">
      <Navbar user={user} />
      <main class="max-w-5xl mx-auto px-2 py-4">
        <GameIsland
          roomCode={code}
          userId={user.id}
          playerNum={playerNum as 1 | 2}
          initialPhase={room.status}
          userName={user.name}
          userAvatar={user.avatarUrl}
        />
      </main>
    </div>
  );
});
