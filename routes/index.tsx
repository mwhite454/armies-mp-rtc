import { define } from "../utils.ts";
import { Navbar } from "../components/Navbar.tsx";
import { getLeaderboard } from "../lib/kv.ts";

export default define.page(async function Home(ctx) {
  const user = ctx.state.user;
  const leaderboard = await getLeaderboard(10);

  return (
    <div class="min-h-screen bg-base-100">
      <Navbar user={user} />
      <main class="max-w-4xl mx-auto px-4 py-12">
        {/* Hero */}
        <div class="hero py-16">
          <div class="hero-content text-center">
            <div>
              <h1 class="text-5xl font-bold text-primary tracking-widest mb-4">
                TACTICAL GRID
              </h1>
              <p class="text-base-content/70 text-lg mb-2">
                Turn-based tactical combat. 4 units. 2 players. One winner.
              </p>
              <p class="text-base-content/50 text-sm mb-8 font-mono">
                Build your squad · Deploy on the map · Outmaneuver your opponent
              </p>
              {user
                ? (
                  <a href="/lobby" class="btn btn-primary btn-lg">
                    Enter Lobby
                  </a>
                )
                : (
                  <a href="/login" class="btn btn-primary btn-lg">
                    Sign in with Google to Play
                  </a>
                )}
            </div>
          </div>
        </div>

        {/* Game rules summary */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body">
              <h2 class="card-title text-primary text-sm">⚔️ BUILD PHASE</h2>
              <p class="text-sm text-base-content/70">
                Distribute 40 stat points across your 4 units — Leader, Heavy,
                Sniper, Dasher. Max 30 per unit. Min 1 per stat.
              </p>
            </div>
          </div>
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body">
              <h2 class="card-title text-primary text-sm">🗺️ SPAWN PHASE</h2>
              <p class="text-sm text-base-content/70">
                Choose map size and place your units on your half of the grid.
                Position matters — plan your opening.
              </p>
            </div>
          </div>
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body">
              <h2 class="card-title text-primary text-sm">🎯 COMBAT</h2>
              <p class="text-sm text-base-content/70">
                2 actions per turn: Move, Reload, or Fire. Heal with your
                Leader. Win by eliminating the enemy Leader.
              </p>
            </div>
          </div>
        </div>

        {/* Leaderboard */}
        {leaderboard.length > 0 && (
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body">
              <h2 class="card-title text-primary">🏆 Leaderboard</h2>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Player</th>
                      <th class="text-right">ELO</th>
                      <th class="text-right">W</th>
                      <th class="text-right">L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((entry, i) => (
                      <tr key={entry.userId}>
                        <td class="text-base-content/50">{i + 1}</td>
                        <td>
                          <div class="flex items-center gap-2">
                            <div class="avatar">
                              <div class="w-6 rounded-full">
                                <img
                                  src={entry.avatarUrl}
                                  alt={entry.name}
                                  referrerpolicy="no-referrer"
                                />
                              </div>
                            </div>
                            {entry.name}
                          </div>
                        </td>
                        <td class="text-right font-mono font-bold text-primary">
                          {entry.elo}
                        </td>
                        <td class="text-right text-success">{entry.wins}</td>
                        <td class="text-right text-error">{entry.losses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
});
