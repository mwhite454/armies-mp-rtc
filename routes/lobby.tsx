import { define } from "../utils.ts";
import { Navbar } from "../components/Navbar.tsx";
import { listOpenRooms } from "../lib/kv.ts";
import LobbyIsland from "../islands/LobbyIsland.tsx";

export default define.page(async function LobbyPage(ctx) {
  const user = ctx.state.user!;
  const rooms = await listOpenRooms();

  return (
    <div class="min-h-screen bg-base-100">
      <Navbar user={user} />
      <main class="max-w-3xl mx-auto px-4 py-8">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-2xl font-bold text-primary tracking-widest">
            ⚔️ LOBBY
          </h1>
          <span class="text-base-content/50 text-sm font-mono">
            {user.name}
          </span>
        </div>
        <LobbyIsland initialRooms={rooms} userId={user.id} />
      </main>
    </div>
  );
});
