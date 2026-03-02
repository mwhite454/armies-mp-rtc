import { signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  GameAction,
  GameState,
  HexCoord,
  RoomStatus,
  ServerMessage,
  UnitBuild,
} from "../lib/types.ts";
import { TOTAL_POINTS, MAX_PER_UNIT, getDefaultBuild, randomizeBuild } from "../lib/game-engine.ts";
import { UNIT_TYPES } from "../lib/types.ts";
import type * as Phaser from "phaser";

interface GameIslandProps {
  roomCode: string;
  userId: string;
  playerNum: 1 | 2;
  initialPhase: RoomStatus;
  userName: string;
  userAvatar: string;
}

interface LogLine {
  text: string;
  kind: "sys" | "p1" | "p2";
}

export default function GameIsland(
  { roomCode, userId, playerNum, initialPhase, userName, userAvatar }: GameIslandProps,
) {
  // ── Connection state ──────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const connected = useSignal(false);
  const phase = useSignal<RoomStatus>(initialPhase);
  const opponentName = useSignal<string | null>(null);
  const opponentJoined = useSignal(false);

  // ── Economy ───────────────────────────────────────────────────────────────
  const buildDraft = useSignal<UnitBuild[]>(getDefaultBuild());
  const buildConfirmed = useSignal(false);
  const opponentBuildReady = useSignal(false);
  const buildError = useSignal("");

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const mapCols = useSignal<number>(12);
  const mapRows = useSignal<number>(12);
  const mapColsFromHost = useSignal<number | null>(null);
  const spawnCells = useSignal<{ q: number; r: number }[]>([]);
  const spawnConfirmed = useSignal(false);
  const opponentSpawnReady = useSignal(false);
  const spawnError = useSignal("");

  // ── Phaser refs ────────────────────────────────────────────────────────────
  const phaserRootRef = useRef<HTMLDivElement>(null);
  const phaserGameRef = useRef<Phaser.Game | null>(null);

  // ── Combat ────────────────────────────────────────────────────────────────
  const gameState = useSignal<GameState | null>(null);
  const selectedUnitId = useSignal<string | null>(null);
  const currentAction = useSignal<"move" | "reload" | "fire" | null>(null);
  const isMyTurn = useSignal(false);

  // ── Turn timer ────────────────────────────────────────────────────────────
  const turnDeadline = useSignal<number | null>(null);
  const turnDurationMs = useSignal<number>(60_000);
  const timedOut = useSignal(false);
  const gameOver = useSignal<{ winnerPlayerNum: 1 | 2; winnerId: string } | null>(null);
  const newRoundVoted = useSignal(false);

  // ── Log ───────────────────────────────────────────────────────────────────
  const logLines = useSignal<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Debug panel (host only) ───────────────────────────────────────────────
  const debugEntries = useSignal<string[]>([]);
  const debugOpen = useSignal(false);
  const debugRef = useRef<HTMLDivElement>(null);

  function addLog(text: string, kind: LogLine["kind"] = "sys") {
    logLines.value = [...logLines.value, { text, kind }];
  }

  // ── WebSocket setup ───────────────────────────────────────────────────────
  useEffect(() => {
    function connect() {
      const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${globalThis.location.host}/api/ws/${roomCode}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        connected.value = true;
        addLog("Connected to game server.", "sys");
      };

      ws.onmessage = (evt) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (playerNum === 1) {
          const t = new Date().toTimeString().slice(0, 8);
          debugEntries.value = [...debugEntries.value, `[${t}] IN  ${evt.data}`];
        }
        handleServerMessage(msg);
      };

      ws.onclose = () => {
        connected.value = false;
        addLog("Disconnected. Reconnecting in 3s...", "sys");
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();
    return () => {
      wsRef.current?.close();
    };
  }, []);

  function send(msg: object) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(msg);
      if (playerNum === 1) {
        const t = new Date().toTimeString().slice(0, 8);
        debugEntries.value = [...debugEntries.value, `[${t}] OUT ${data}`];
      }
      ws.send(data);
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────
  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        opponentName.value = msg.opponentName;
        if (msg.opponentName) opponentJoined.value = true;
        if (msg.roomStatus !== "lobby") phase.value = msg.roomStatus;
        mapCols.value = msg.mapCols;
        mapRows.value = msg.mapRows;
        break;

      case "player_joined":
        opponentName.value = msg.name;
        opponentJoined.value = true;
        addLog(`${msg.name} joined the room.`, "sys");
        break;

      case "phase_change":
        phase.value = msg.phase;
        if (msg.phase === "economy") {
          buildConfirmed.value = false;
          opponentBuildReady.value = false;
        }
        if (msg.phase === "spawn") {
          spawnCells.value = [];
          spawnConfirmed.value = false;
          opponentSpawnReady.value = false;
          spawnError.value = "";
        }
        break;

      case "opponent_build_ready":
        opponentBuildReady.value = true;
        addLog("Opponent confirmed their build.", "sys");
        break;

      case "map_size":
        mapColsFromHost.value = msg.mapCols;
        mapCols.value = msg.mapCols;
        mapRows.value = msg.mapRows;
        break;

      case "opponent_spawn_ready":
        opponentSpawnReady.value = true;
        addLog("Opponent placed their units.", "sys");
        break;

      case "game_start":
        gameState.value = msg.state;
        phase.value = "combat";
        isMyTurn.value = msg.state.turn === playerNum;
        gameOver.value = null;
        newRoundVoted.value = false;
        addLog(`--- Round ${msg.state.round} begins! ---`, "sys");
        break;

      case "state_update":
        gameState.value = msg.state;
        isMyTurn.value = msg.state.turn === playerNum;
        selectedUnitId.value = null;
        currentAction.value = null;
        if (msg.logMessage) {
          addLog(
            msg.logMessage,
            msg.actorPlayerNum === playerNum ? "p1" : "p2",
          );
        }
        break;

      case "turn_change":
        if (gameState.value) {
          gameState.value = {
            ...gameState.value,
            turn: msg.currentTurn,
            actionsLeft: 2,
          };
        }
        isMyTurn.value = msg.currentTurn === playerNum;
        selectedUnitId.value = null;
        currentAction.value = null;
        timedOut.value = false;
        addLog(
          msg.currentTurn === playerNum
            ? "--- Your turn ---"
            : "--- Opponent's turn ---",
          "sys",
        );
        break;

      case "turn_timer_start":
        turnDeadline.value = msg.deadline;
        turnDurationMs.value = msg.turnDurationMs;
        timedOut.value = false;
        break;

      case "turn_timeout":
        timedOut.value = true;
        addLog(
          msg.playerNum === playerNum
            ? "⏰ Your turn timed out."
            : "⏰ Opponent timed out.",
          "sys",
        );
        break;

      case "game_over":
        gameOver.value = msg;
        phase.value = "result";
        addLog(
          msg.winnerPlayerNum === playerNum
            ? "🏆 Victory! You eliminated the enemy Leader!"
            : "💀 Defeat. Your Leader was eliminated.",
          "sys",
        );
        break;

      case "new_round_start":
        gameOver.value = null;
        newRoundVoted.value = false;
        break;

      case "error":
        addLog(`⚠️ ${msg.message}`, "sys");
        if (phase.value === "spawn") {
          spawnError.value = msg.message;
          spawnConfirmed.value = false;
        }
        break;

      case "pong":
        break;
    }
  }

  // ── Auto-scroll log ───────────────────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines.value]);

  // ── Phaser lifecycle ──────────────────────────────────────────────────────

  /** Destroy the Phaser game instance if one exists. */
  function destroyPhaser() {
    if (phaserGameRef.current) {
      phaserGameRef.current.destroy(true);
      phaserGameRef.current = null;
    }
  }

  /**
   * Boot the appropriate Phaser scene inside #phaser-root.
   * Must only be called on the client (guarded by typeof window).
   */
  async function bootPhaser(sceneKey: "SpawnScene" | "CombatScene") {
    if (typeof window === "undefined") return;
    destroyPhaser();

    const Phaser = await import("phaser");

    // Dynamic import of the scene class
    const SceneModule = sceneKey === "SpawnScene"
      ? await import("./phaser/SpawnScene.ts")
      : await import("./phaser/CombatScene.ts");
    const SceneClass = SceneModule.default;

    const container = phaserRootRef.current;
    if (!container) return;

    // Clear container
    container.innerHTML = "";

    const initData = {
      cols: mapCols.value,
      rows: mapRows.value,
      playerNum,
    };

    // Approximate initial canvas size
    const hexSize = 32;
    const pad = 40;
    const estimatedW = initData.cols * hexSize * 1.6 + pad * 2;
    const estimatedH = initData.rows * hexSize * 1.5 + pad * 2;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: estimatedW,
      height: estimatedH,
      backgroundColor: "#0a0a1a",
      scene: {
        key: sceneKey,
        // We use the scene's init to forward initData
        preload() {},
        create(this: Phaser.Scene) {
          // Re-construct the actual scene and add it to the manager
          const realScene = new SceneClass();
          this.scene.add(sceneKey + "_real", realScene, true, initData);
          this.scene.remove(sceneKey);  // remove this bootstrap scene

          // Wire registry + events once the real scene's create lifecycle runs
          realScene.events.once("create", () => {
            if (sceneKey === "SpawnScene") {
              // Push initial spawn cells
              game.registry.set("spawnCells", spawnCells.value);
              game.registry.set("mapSize", { cols: mapCols.value, rows: mapRows.value });

              // Scene emits hex_clicked → island handles add/remove
              realScene.events.on("hex_clicked", (coord: HexCoord) => {
                if (spawnConfirmed.value) return;
                const cells = [...spawnCells.value];
                const idx = cells.findIndex((c) => c.q === coord.q && c.r === coord.r);
                if (idx >= 0) cells.splice(idx, 1);
                else if (cells.length < 4) cells.push(coord);
                spawnCells.value = cells;
                spawnError.value = "";
                game.registry.set("spawnCells", cells);
              });
            }

            if (sceneKey === "CombatScene") {
              // Push initial state
              if (gameState.value) game.registry.set("gameState", gameState.value);
              game.registry.set("selectedUnitId", selectedUnitId.value);
              game.registry.set("currentAction", currentAction.value);
              if (turnDeadline.value) game.registry.set("turnDeadline", turnDeadline.value);
              game.registry.set("turnDurationMs", turnDurationMs.value);
              game.registry.set("timedOut", timedOut.value);

              // Scene emits hex_clicked → island dispatches action
              realScene.events.on("hex_clicked", (coord: HexCoord) => {
                const state = gameState.value;
                if (!state || !isMyTurn.value || !selectedUnitId.value || !currentAction.value) return;
                const unit = state.units.find((u) => u.id === selectedUnitId.value);
                if (!unit) return;

                let action: GameAction | null = null;
                if (currentAction.value === "move") {
                  action = { type: "move", unitId: unit.id, q: coord.q, r: coord.r };
                } else if (currentAction.value === "fire") {
                  const target = state.units.find(
                    (t) => t.q === coord.q && t.r === coord.r && t.hp > 0,
                  );
                  if (!target) {
                    addLog("No target at that cell.", "sys");
                    return;
                  }
                  action = { type: "fire", unitId: unit.id, targetId: target.id };
                }
                if (action) send({ type: "action", action });
              });
            }
          });
        },
      },
    });

    phaserGameRef.current = game;
  }

  // ── Boot / destroy Phaser when phase changes ──────────────────────────────
  useEffect(() => {
    if (phase.value === "spawn") {
      bootPhaser("SpawnScene");
    } else if (phase.value === "combat") {
      bootPhaser("CombatScene");
    } else if (phase.value === "result") {
      destroyPhaser();
    }
    return () => destroyPhaser();
  }, [phase.value]);

  // ── Push signal changes into Phaser registry ──────────────────────────────
  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game) return;
    if (phase.value === "spawn") {
      game.registry.set("spawnCells", spawnCells.value);
    }
  }, [spawnCells.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game) return;
    if (phase.value === "spawn") {
      game.registry.set("mapSize", { cols: mapCols.value, rows: mapRows.value });
    }
  }, [mapCols.value, mapRows.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    if (gameState.value) game.registry.set("gameState", gameState.value);
  }, [gameState.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    game.registry.set("selectedUnitId", selectedUnitId.value);
  }, [selectedUnitId.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    game.registry.set("currentAction", currentAction.value);
  }, [currentAction.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    game.registry.set("turnDeadline", turnDeadline.value);
  }, [turnDeadline.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    game.registry.set("turnDurationMs", turnDurationMs.value);
  }, [turnDurationMs.value]);

  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game || phase.value !== "combat") return;
    game.registry.set("timedOut", timedOut.value);
  }, [timedOut.value]);

  function doReload() {
    if (!isMyTurn.value || !selectedUnitId.value) return;
    const unit = gameState.value?.units.find((u) => u.id === selectedUnitId.value);
    if (!unit || unit.loaded) {
      addLog("Unit is already loaded.", "sys");
      return;
    }
    send({ type: "action", action: { type: "reload", unitId: unit.id } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Economy phase: budget helper
  // ─────────────────────────────────────────────────────────────────────────
  function totalUsed(): number {
    return buildDraft.value.reduce(
      (s, u) => s + u.Move + u.Health + u.Damage + u.Range,
      0,
    );
  }

  function confirmBuild() {
    const used = totalUsed();
    if (used !== TOTAL_POINTS) {
      buildError.value = `Must use exactly ${TOTAL_POINTS} points (currently ${used}).`;
      return;
    }
    for (let i = 0; i < 4; i++) {
      const u = buildDraft.value[i];
      const total = u.Move + u.Health + u.Damage + u.Range;
      if (total > MAX_PER_UNIT) {
        buildError.value = `${UNIT_TYPES[i]} has ${total} pts (max ${MAX_PER_UNIT}).`;
        return;
      }
      for (const stat of ["Move", "Health", "Damage", "Range"] as const) {
        if (u[stat] < 1) {
          buildError.value = `${UNIT_TYPES[i]}.${stat} must be ≥1.`;
          return;
        }
      }
    }
    buildError.value = "";
    buildConfirmed.value = true;
    send({ type: "build_ready", build: buildDraft.value });
    addLog("Your build confirmed.", "sys");
  }

  function confirmSpawn() {
    if (spawnCells.value.length !== 4) return;
    spawnConfirmed.value = true;
    send({ type: "spawn_ready", spawn: spawnCells.value });
    addLog("Your spawn confirmed.", "sys");
  }

  // ── Debug panel auto-scroll ───────────────────────────────────────────────
  useEffect(() => {
    if (debugRef.current) {
      debugRef.current.scrollTop = debugRef.current.scrollHeight;
    }
  }, [debugEntries.value]);

  function renderDebugPanel() {
    if (playerNum !== 1) return null;
    return (
      <div class="mt-4 border border-warning/30 rounded bg-base-200">
        <button
          class="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-base-300 transition-colors"
          onClick={() => { debugOpen.value = !debugOpen.value; }}
        >
          <span class="text-xs font-mono text-warning/70">
            🐛 Debug (host only) — {debugEntries.value.length} msgs
          </span>
          <span class="text-xs text-base-content/40">{debugOpen.value ? "▲" : "▼"}</span>
        </button>
        {debugOpen.value && (
          <>
            <div
              ref={debugRef}
              class="font-mono text-xs p-2 h-48 overflow-y-auto bg-base-300 whitespace-pre-wrap break-all"
            >
              {debugEntries.value.length === 0
                ? <span class="text-base-content/30">No messages yet.</span>
                : debugEntries.value.map((e, i) => (
                  <div
                    key={i}
                    class={e.includes(" IN  ") ? "text-success/80" : "text-warning/80"}
                  >
                    {e}
                  </div>
                ))}
            </div>
            <div class="px-3 py-2 flex gap-2">
              <button
                class="btn btn-xs btn-outline btn-warning"
                onClick={() => {
                  navigator.clipboard?.writeText(debugEntries.value.join("\n"));
                }}
              >
                Copy all
              </button>
              <button
                class="btn btn-xs btn-ghost"
                onClick={() => { debugEntries.value = []; }}
              >
                Clear
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (!connected.value) {
    return (
      <div class="flex items-center justify-center py-20 gap-3 text-base-content/50">
        <span class="loading loading-spinner" />
        Connecting to {roomCode}...
      </div>
    );
  }

  // ── Waiting for opponent ──
  if (phase.value === "lobby") {
    return (
      <div class="card bg-base-200 border border-base-300 max-w-md mx-auto mt-8">
        <div class="card-body text-center gap-4">
          <h2 class="text-primary font-bold text-lg">Room: {roomCode}</h2>
          <p class="text-base-content/60 text-sm">
            Share this code or URL with your opponent:
          </p>
          <div class="font-mono text-3xl font-bold text-primary tracking-widest">
            {roomCode}
          </div>
          <p class="text-base-content/40 text-xs">
            {globalThis.location?.href ?? ""}
          </p>
          <span class="loading loading-dots loading-sm" />
          <p class="text-base-content/50 text-sm">Waiting for opponent...</p>
        </div>
        {renderDebugPanel()}
      </div>
    );
  }

  // ── Economy phase ──
  if (phase.value === "economy") {
    const used = totalUsed();
    const remaining = TOTAL_POINTS - used;
    const stats = ["Move", "Health", "Damage", "Range"] as const;

    return (
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <h2 class="text-primary font-bold tracking-widest">BUILD PHASE</h2>
          <div class={`font-mono font-bold ${remaining < 0 ? "text-error" : "text-success"}`}>
            {used}/{TOTAL_POINTS} pts{remaining !== 0 ? ` (${Math.abs(remaining)} ${remaining > 0 ? "left" : "over"})` : " ✓"}
          </div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          {UNIT_TYPES.map((name, i) => {
            const u = buildDraft.value[i];
            const unitTotal = u.Move + u.Health + u.Damage + u.Range;
            return (
              <div key={name} class="card bg-base-200 border border-base-300">
                <div class="card-body p-3 gap-2">
                  <h3 class="font-bold text-warning text-sm">
                    {name === "Leader" ? "👑" : name === "Heavy" ? "🛡️" : name === "Sniper" ? "🎯" : "⚡"}{" "}
                    {name}
                    <span class="text-base-content/40 font-normal ml-1">
                      ({unitTotal}pts)
                    </span>
                  </h3>
                  {stats.map((stat) => (
                    <div key={stat} class="flex items-center gap-2">
                      <label class="text-xs text-base-content/60 w-14">
                        {stat}
                      </label>
                      <input
                        type="number"
                        class="input input-xs input-bordered w-16 font-mono text-center"
                        min={1}
                        max={30}
                        value={u[stat]}
                        disabled={buildConfirmed.value}
                        onInput={(e) => {
                          const v = Math.max(
                            1,
                            parseInt((e.target as HTMLInputElement).value) || 1,
                          );
                          const next = buildDraft.value.map((b, bi) =>
                            bi === i ? { ...b, [stat]: v } : b
                          );
                          buildDraft.value = next;
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {buildError.value && (
          <p class="text-error text-sm font-mono">{buildError.value}</p>
        )}

        <div class="flex gap-3">
          <button
            class="btn btn-outline btn-sm"
            disabled={buildConfirmed.value}
            onClick={() => {
              buildDraft.value = randomizeBuild();
            }}
          >
            🎲 Randomize
          </button>
          <button
            class={`btn btn-primary ${buildConfirmed.value ? "btn-disabled" : ""}`}
            disabled={buildConfirmed.value || remaining !== 0}
            onClick={confirmBuild}
          >
            {buildConfirmed.value ? "Build Confirmed ✓" : "Confirm Build"}
          </button>
        </div>

        {buildConfirmed.value && (
          <div class="flex items-center gap-2 text-base-content/50 text-sm">
            <span class="loading loading-spinner loading-xs" />
            {opponentBuildReady.value
              ? "Both ready — transitioning..."
              : "Waiting for opponent..."}
          </div>
        )}
        {renderDebugPanel()}
      </div>
    );
  }

  // ── Spawn phase ──
  if (phase.value === "spawn") {
    const unitDefs = [
      { name: "Leader", emoji: "👑" },
      { name: "Heavy",  emoji: "🛡️" },
      { name: "Sniper", emoji: "🎯" },
      { name: "Dasher", emoji: "⚡" },
    ] as const;
    const placed = spawnCells.value.length;
    const nextUnit = placed < 4 ? unitDefs[placed] : null;

    return (
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <h2 class="text-primary font-bold tracking-widest">SPAWN PHASE</h2>
          {nextUnit
            ? (
              <span class="text-sm font-mono text-warning">
                Next: {nextUnit.emoji} {nextUnit.name}
              </span>
            )
            : <span class="text-sm font-mono text-success">All units placed ✓</span>}
        </div>

        {playerNum === 1 && (
          <div class="flex items-center gap-3">
            <label class="text-sm text-base-content/60">Map size:</label>
            {([8, 12, 16] as const).map((s) => (
              <button
                key={s}
                class={`btn btn-xs ${mapCols.value === s ? "btn-primary" : "btn-outline"}`}
                disabled={spawnConfirmed.value}
                onClick={() => {
                  mapCols.value = s;
                  mapRows.value = s;
                  send({ type: "map_size", mapCols: s, mapRows: s });
                }}
              >
                {s}×{s}
              </button>
            ))}
          </div>
        )}
        {playerNum === 2 && (
          <p class="text-base-content/50 text-sm">
            Map size: {mapColsFromHost.value ? `${mapColsFromHost.value}×${mapRows.value}` : "waiting for host..."}
          </p>
        )}

        {/* Unit placement order strip */}
        <div class="flex gap-2">
          {unitDefs.map((u, i) => {
            const isPlaced = i < placed;
            const isNext = i === placed;
            return (
              <div
                key={u.name}
                class={`flex-1 rounded border px-2 py-1 text-center text-xs font-mono transition-colors
                  ${isPlaced ? "border-success/50 bg-success/10 text-success" : ""}
                  ${isNext ? "border-warning bg-warning/10 text-warning animate-pulse" : ""}
                  ${!isPlaced && !isNext ? "border-base-300 text-base-content/30" : ""}`}
              >
                <div class="text-base leading-none">{u.emoji}</div>
                <div class="mt-0.5">{isPlaced ? "✓" : isNext ? "next" : "—"}</div>
              </div>
            );
          })}
        </div>

        <p class="text-base-content/50 text-xs font-mono">
          {spawnConfirmed.value
            ? "Spawn confirmed — waiting for opponent..."
            : playerNum === 1
            ? `Click a highlighted cell (left half) to place each unit in order. Undo to re-place.`
            : `Click a highlighted cell (right half) to place each unit in order. Undo to re-place.`}
        </p>

        <div
          ref={phaserRootRef}
          style="border:2px solid #7f7fd5;border-radius:4px;max-width:100%;overflow:hidden"
        />

        {spawnError.value && (
          <p class="text-error text-sm font-mono">⚠️ {spawnError.value}</p>
        )}

        <div class="flex gap-3 items-center flex-wrap">
          <button
            class="btn btn-primary"
            disabled={spawnCells.value.length !== 4 || spawnConfirmed.value}
            onClick={confirmSpawn}
          >
            {spawnConfirmed.value ? "Spawn Confirmed ✓" : "Confirm Spawn"}
          </button>
          {!spawnConfirmed.value && spawnCells.value.length > 0 && (
            <button
              class="btn btn-outline btn-sm"
              onClick={() => {
                spawnCells.value = spawnCells.value.slice(0, -1);
                spawnError.value = "";
              }}
            >
              Undo Last
            </button>
          )}
          {spawnConfirmed.value && (
            <span class="text-base-content/50 text-sm flex items-center gap-2">
              <span class="loading loading-spinner loading-xs" />
              {opponentSpawnReady.value
                ? "Both ready — starting game..."
                : "Waiting for opponent..."}
            </span>
          )}
        </div>
        {renderDebugPanel()}
      </div>
    );
  }

  // ── Combat / Result phase ──
  const state = gameState.value;

  return (
    <div class="flex flex-col gap-3">
      {/* Turn indicator */}
      <div class="flex items-center justify-between">
        <div
          class={`font-bold font-mono text-lg ${isMyTurn.value ? "text-warning" : "text-base-content/40"}`}
        >
          {isMyTurn.value ? "⚡ YOUR TURN" : "⏳ OPPONENT'S TURN"}
        </div>
        {state && (
          <span class="text-base-content/40 text-sm font-mono">
            Actions: {state.actionsLeft}/2 · Round {state.round}
          </span>
        )}
      </div>

      <div class="flex gap-3 flex-wrap">
        {/* Phaser game canvas */}
        <div
          ref={phaserRootRef}
          style="border:2px solid #7f7fd5;border-radius:4px;overflow:hidden"
        />

        {/* HUD */}
        <div class="flex flex-col gap-3 min-w-[200px] flex-1">
          {/* My units */}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3">
              <h3 class="text-primary text-xs font-bold mb-2">
                YOUR UNITS (P{playerNum})
              </h3>
              <div class="flex flex-col gap-1">
                {state?.units
                  .filter((u) => u.player === playerNum)
                  .map((u) => {
                    const hpPct = Math.max(0, u.hp / u.maxHp * 100);
                    const hpColor = hpPct > 50
                      ? "bg-success"
                      : hpPct > 25
                      ? "bg-warning"
                      : "bg-error";
                    const isSelected = u.id === selectedUnitId.value;
                    return (
                      <div
                        key={u.id}
                        class={`rounded p-2 cursor-pointer text-xs border transition-colors
                          ${u.hp <= 0 ? "opacity-40 cursor-not-allowed" : ""}
                          ${isSelected ? "border-warning bg-base-300" : "border-base-300 bg-base-100 hover:border-primary"}`}
                        onClick={() => {
                          if (!isMyTurn.value || u.hp <= 0) return;
                          selectedUnitId.value = isSelected ? null : u.id;
                          currentAction.value = null;
                        }}
                      >
                        <div class="font-bold text-warning">
                          {u.emoji} {u.name}
                        </div>
                        <div class="text-base-content/60 font-mono">
                          HP:{Math.max(0, u.hp)}/{u.maxHp} · Mv:{u.Move} · Dmg:{u.Damage} · Rng:{u.Range}
                          · {u.loaded ? "🔵" : "🔴"}
                        </div>
                        <div class="h-1 bg-base-300 rounded mt-1">
                          <div
                            class={`h-full rounded ${hpColor}`}
                            style={`width:${hpPct}%`}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          {isMyTurn.value && selectedUnitId.value && (
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3 gap-2">
                <h3 class="text-primary text-xs font-bold">ACTIONS</h3>
                <button
                  class={`btn btn-sm w-full ${currentAction.value === "move" ? "btn-warning" : "btn-outline"}`}
                  onClick={() =>
                    currentAction.value = currentAction.value === "move"
                      ? null
                      : "move"}
                >
                  Move
                </button>
                <button
                  class="btn btn-sm btn-outline w-full"
                  onClick={doReload}
                >
                  Reload
                </button>
                <button
                  class={`btn btn-sm w-full ${currentAction.value === "fire" ? "btn-error" : "btn-outline"}`}
                  onClick={() =>
                    currentAction.value = currentAction.value === "fire"
                      ? null
                      : "fire"}
                >
                  {state?.units.find((u) => u.id === selectedUnitId.value)
                      ?.name === "Leader"
                    ? "Heal"
                    : "Fire"}
                </button>
              </div>
            </div>
          )}

          {isMyTurn.value && (
            <button
              class="btn btn-sm btn-neutral"
              onClick={() => send({ type: "end_turn" })}
            >
              End Turn
            </button>
          )}

          {/* Opponent units */}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3">
              <h3 class="text-base-content/50 text-xs font-bold mb-2">
                OPPONENT UNITS (P{playerNum === 1 ? 2 : 1})
              </h3>
              <div class="flex flex-col gap-1">
                {state?.units
                  .filter((u) => u.player !== playerNum)
                  .map((u) => {
                    const hpPct = Math.max(0, u.hp / u.maxHp * 100);
                    const hpColor = hpPct > 50
                      ? "bg-success"
                      : hpPct > 25
                      ? "bg-warning"
                      : "bg-error";
                    return (
                      <div
                        key={u.id}
                        class={`rounded p-2 text-xs border border-base-300 ${u.hp <= 0 ? "opacity-40" : ""}`}
                      >
                        <div class="font-bold text-base-content/70">
                          {u.emoji} {u.name}
                        </div>
                        <div class="text-base-content/40 font-mono">
                          HP:{Math.max(0, u.hp)}/{u.maxHp}
                        </div>
                        <div class="h-1 bg-base-300 rounded mt-1">
                          <div
                            class={`h-full rounded ${hpColor}`}
                            style={`width:${hpPct}%`}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Game log */}
      <div
        ref={logRef}
        class="bg-base-200 border border-base-300 rounded p-2 h-32 overflow-y-auto font-mono text-xs"
      >
        {logLines.value.map((line, i) => (
          <div
            key={i}
            class={line.kind === "p1"
              ? "text-primary"
              : line.kind === "p2"
              ? "text-orange-400"
              : "text-base-content/50"}
          >
            {line.text}
          </div>
        ))}
      </div>

      {/* Game over modal */}
      {gameOver.value && (
        <div class="modal modal-open">
          <div class="modal-box text-center">
            <h2 class="text-4xl font-bold mb-2">
              {gameOver.value.winnerPlayerNum === playerNum
                ? "🏆 VICTORY!"
                : "💀 DEFEAT"}
            </h2>
            <p class="text-base-content/60 mb-6">
              {gameOver.value.winnerPlayerNum === playerNum
                ? "You eliminated the enemy Leader!"
                : "Your Leader was eliminated!"}
            </p>
            {!newRoundVoted.value
              ? (
                <div class="flex gap-3 justify-center">
                  <button
                    class="btn btn-primary"
                    onClick={() => {
                      newRoundVoted.value = true;
                      send({ type: "new_round", rebuild: false });
                    }}
                  >
                    Rematch (keep build)
                  </button>
                  <button
                    class="btn btn-outline"
                    onClick={() => {
                      newRoundVoted.value = true;
                      send({ type: "new_round", rebuild: true });
                    }}
                  >
                    New Build
                  </button>
                </div>
              )
              : (
                <div class="flex items-center justify-center gap-2 text-base-content/50">
                  <span class="loading loading-spinner loading-sm" />
                  Waiting for opponent...
                </div>
              )}
            <div class="modal-action justify-center">
              <a href="/lobby" class="btn btn-ghost btn-sm">Back to Lobby</a>
            </div>
          </div>
        </div>
      )}
      {renderDebugPanel()}
    </div>
  );
}
