import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { RoomRecord } from "../lib/types.ts";

interface LobbyIslandProps {
  initialRooms: RoomRecord[];
  userId: string;
}

export default function LobbyIsland({ initialRooms, userId }: LobbyIslandProps) {
  const rooms = useSignal<RoomRecord[]>(initialRooms);
  const joinCode = useSignal("");
  const creating = useSignal(false);
  const error = useSignal("");

  // Poll open rooms every 5 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/rooms");
        if (res.ok) rooms.value = await res.json();
      } catch {
        // ignore network errors during polling
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  async function createRoom() {
    creating.value = true;
    error.value = "";
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error("Failed to create room");
      const { code } = await res.json();
      globalThis.location.href = `/game/${code}`;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Unknown error";
      creating.value = false;
    }
  }

  function joinRoom(code: string) {
    globalThis.location.href = `/game/${code.toUpperCase()}`;
  }

  return (
    <div class="flex flex-col gap-6">
      {/* Create + Join by Code */}
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body gap-4">
          <div class="flex flex-col sm:flex-row gap-3">
            <button
              class={`btn btn-primary flex-1 ${creating.value ? "loading" : ""}`}
              onClick={createRoom}
              disabled={creating.value}
            >
              {creating.value ? "Creating..." : "Create New Game"}
            </button>
            <div class="flex gap-2 flex-1">
              <input
                type="text"
                class="input input-bordered flex-1 font-mono uppercase"
                placeholder="Enter room code"
                maxLength={6}
                value={joinCode.value}
                onInput={(e) =>
                  joinCode.value = (e.target as HTMLInputElement).value
                    .toUpperCase()}
              />
              <button
                class="btn btn-outline btn-primary"
                onClick={() => joinCode.value && joinRoom(joinCode.value)}
                disabled={joinCode.value.length !== 6}
              >
                Join
              </button>
            </div>
          </div>
          {error.value && (
            <p class="text-error text-sm font-mono">{error.value}</p>
          )}
        </div>
      </div>

      {/* Open Rooms */}
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body">
          <h2 class="card-title text-sm text-primary mb-2">
            Open Rooms
            <span class="badge badge-neutral ml-2">
              {rooms.value.length}
            </span>
          </h2>
          {rooms.value.length === 0
            ? (
              <p class="text-base-content/40 text-sm font-mono py-4 text-center">
                No open rooms. Create one to get started!
              </p>
            )
            : (
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Host</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.value.map((room) => (
                      <tr key={room.code}>
                        <td class="font-mono font-bold text-primary">
                          {room.code}
                        </td>
                        <td class="text-sm text-base-content/70">
                          {room.hostUserId === userId ? "You" : "Opponent"}
                        </td>
                        <td>
                          <span class="badge badge-success badge-sm">
                            Waiting
                          </span>
                        </td>
                        <td>
                          {room.hostUserId !== userId && (
                            <button
                              class="btn btn-xs btn-primary"
                              onClick={() => joinRoom(room.code)}
                            >
                              Join
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
