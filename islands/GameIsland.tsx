import { signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  GameAction,
  GameState,
  RoomStatus,
  ServerMessage,
  UnitBuild,
} from "../lib/types.ts";
import { TOTAL_POINTS, MAX_PER_UNIT, getDefaultBuild, randomizeBuild } from "../lib/game-engine.ts";
import { UNIT_TYPES } from "../lib/types.ts";

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
  const mapSize = useSignal<8 | 12 | 16>(12);
  const mapSizeFromHost = useSignal<8 | 12 | 16 | null>(null);
  const spawnPlacements = useSignal<Array<{ x: number; y: number } | null>>([null, null, null, null]);
  const draggingUnit = useSignal<number | null>(null);
  const hoverCell = useSignal<{ x: number; y: number } | null>(null);
  const spawnConfirmed = useSignal(false);
  const opponentSpawnReady = useSignal(false);
  const spawnError = useSignal("");

  // ── Combat ────────────────────────────────────────────────────────────────
  const gameState = useSignal<GameState | null>(null);
  const selectedUnitId = useSignal<string | null>(null);
  const currentAction = useSignal<"move" | "reload" | "fire" | null>(null);
  const isMyTurn = useSignal(false);
  const gameCanvasRef = useRef<HTMLCanvasElement>(null);

  // ── Result ────────────────────────────────────────────────────────────────
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
        mapSize.value = msg.mapSize;
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
          spawnPlacements.value = [null, null, null, null];
          draggingUnit.value = null;
          hoverCell.value = null;
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
        mapSizeFromHost.value = msg.size;
        mapSize.value = msg.size;
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
        addLog(
          msg.currentTurn === playerNum
            ? "--- Your turn ---"
            : "--- Opponent's turn ---",
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

  // ── Spawn canvas rendering ────────────────────────────────────────────────
  useEffect(() => {
    if (phase.value !== "spawn") return;
    renderSpawn();
  }, [phase.value, spawnPlacements.value, hoverCell.value, draggingUnit.value, mapSize.value]);

  // ── Game canvas rendering ─────────────────────────────────────────────────
  useEffect(() => {
    if (phase.value !== "combat" && phase.value !== "result") return;
    renderGame();
  }, [gameState.value, selectedUnitId.value, currentAction.value]);

  // ─────────────────────────────────────────────────────────────────────────
  // Canvas functions (ported from tactical-game.html)
  // ─────────────────────────────────────────────────────────────────────────

  function getCellSize(size: number) {
    return Math.min(48, Math.floor(520 / size));
  }

  function isInSpawnZone(x: number, y: number) {
    const half = Math.floor(mapSize.value / 2);
    return playerNum === 1 ? x < half : x >= mapSize.value - half;
  }

  const UNIT_DEFS = [
    { name: "Leader", emoji: "👑", color: "#fbbf24" },
    { name: "Heavy",  emoji: "🛡️", color: "#ef4444" },
    { name: "Sniper", emoji: "🎯", color: "#a855f7" },
    { name: "Dasher", emoji: "⚡", color: "#22c55e" },
  ] as const;

  function renderSpawn() {
    const canvas = gameCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sz = mapSize.value;
    const cs = getCellSize(sz);
    canvas.width = sz * cs;
    canvas.height = sz * cs;
    const half = Math.floor(sz / 2);

    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        // Base checkerboard (same as combat)
        ctx.fillStyle = (x + y) % 2 === 0 ? "#0a0a1a" : "#0f0f22";
        ctx.fillRect(x * cs, y * cs, cs, cs);

        // Spawn zone overlay / non-spawn dimming
        if (isInSpawnZone(x, y)) {
          ctx.fillStyle = "rgba(127,127,213,0.15)";
          ctx.fillRect(x * cs, y * cs, cs, cs);
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(x * cs, y * cs, cs, cs);
        }

        // Hover highlight during drag
        const hover = hoverCell.value;
        if (draggingUnit.value !== null && hover && hover.x === x && hover.y === y) {
          ctx.fillStyle = isInSpawnZone(x, y)
            ? "rgba(127,127,213,0.5)"
            : "rgba(239,68,68,0.3)";
          ctx.fillRect(x * cs, y * cs, cs, cs);
        }

        ctx.strokeStyle = "#1a1a3e";
        ctx.strokeRect(x * cs, y * cs, cs, cs);
      }
    }

    // Zone divider line
    const zoneX = half * cs;
    ctx.strokeStyle = "#7f7fd5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(zoneX, 0);
    ctx.lineTo(zoneX, sz * cs);
    ctx.stroke();
    ctx.lineWidth = 1;

    // Placed units (combat-style circles)
    spawnPlacements.value.forEach((placement, i) => {
      if (!placement) return;
      const { x, y } = placement;
      const def = UNIT_DEFS[i];
      const cx = x * cs + cs / 2;
      const cy = y * cs + cs / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, cs * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = "#1a2a5e";
      ctx.fill();
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.font = `${cs * 0.45}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.emoji, cx, cy);
    });
  }

  function getCellFromEvent(e: MouseEvent | DragEvent): { x: number; y: number } | null {
    const canvas = gameCanvasRef.current;
    if (!canvas) return null;
    const sz = mapSize.value;
    const rect = canvas.getBoundingClientRect();
    const cs = rect.width / sz;
    const x = Math.floor((e.clientX - rect.left) / cs);
    const y = Math.floor((e.clientY - rect.top) / cs);
    if (x < 0 || x >= sz || y < 0 || y >= sz) return null;
    return { x, y };
  }

  function onCanvasDragOver(e: DragEvent) {
    e.preventDefault();
    hoverCell.value = getCellFromEvent(e);
  }

  function onCanvasDragLeave() {
    hoverCell.value = null;
  }

  function onCanvasDrop(e: DragEvent) {
    e.preventDefault();
    const cell = getCellFromEvent(e);
    const unitIdx = draggingUnit.value;
    if (cell === null || unitIdx === null) return;
    if (!isInSpawnZone(cell.x, cell.y)) {
      spawnError.value = "Must place in your spawn zone.";
      draggingUnit.value = null;
      hoverCell.value = null;
      return;
    }
    const occupied = spawnPlacements.value.some(
      (p, i) => i !== unitIdx && p?.x === cell.x && p?.y === cell.y,
    );
    if (occupied) {
      spawnError.value = "That cell is already occupied.";
      draggingUnit.value = null;
      hoverCell.value = null;
      return;
    }
    const next = [...spawnPlacements.value];
    next[unitIdx] = cell;
    spawnPlacements.value = next;
    spawnError.value = "";
    draggingUnit.value = null;
    hoverCell.value = null;
  }

  function onSpawnCanvasClick(e: MouseEvent) {
    if (spawnConfirmed.value) return;
    const cell = getCellFromEvent(e);
    if (!cell) return;
    const idx = spawnPlacements.value.findIndex(
      (p) => p?.x === cell.x && p?.y === cell.y,
    );
    if (idx >= 0) {
      const next = [...spawnPlacements.value];
      next[idx] = null;
      spawnPlacements.value = next;
    }
  }

  function renderGame() {
    const canvas = gameCanvasRef.current;
    const state = gameState.value;
    if (!canvas || !state) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sz = state.mapSize;
    const cs = getCellSize(sz);
    canvas.width = sz * cs;
    canvas.height = sz * cs;

    // Grid
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#0a0a1a" : "#0f0f22";
        ctx.fillRect(x * cs, y * cs, cs, cs);
        ctx.strokeStyle = "#1a1a3e";
        ctx.strokeRect(x * cs, y * cs, cs, cs);
      }
    }

    const selUnit = state.units.find((u) => u.id === selectedUnitId.value);

    // Move range overlay
    if (selUnit && currentAction.value === "move") {
      for (let dy = -selUnit.Move; dy <= selUnit.Move; dy++) {
        for (let dx = -selUnit.Move; dx <= selUnit.Move; dx++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist > 0 && dist <= selUnit.Move) {
            const nx = selUnit.x + dx, ny = selUnit.y + dy;
            if (nx >= 0 && nx < sz && ny >= 0 && ny < sz) {
              ctx.fillStyle = "rgba(127,127,213,.25)";
              ctx.fillRect(nx * cs, ny * cs, cs, cs);
            }
          }
        }
      }
    }

    // Fire range overlay
    if (selUnit && currentAction.value === "fire") {
      for (let dy = -selUnit.Range; dy <= selUnit.Range; dy++) {
        for (let dx = -selUnit.Range; dx <= selUnit.Range; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= selUnit.Range) {
            const nx = selUnit.x + dx, ny = selUnit.y + dy;
            if (nx >= 0 && nx < sz && ny >= 0 && ny < sz) {
              ctx.fillStyle = "rgba(249,115,22,.2)";
              ctx.fillRect(nx * cs, ny * cs, cs, cs);
            }
          }
        }
      }
    }

    // Units
    state.units.forEach((u) => {
      const x = u.x * cs, y = u.y * cs;
      if (u.hp <= 0) ctx.globalAlpha = 0.25;

      ctx.beginPath();
      ctx.arc(x + cs / 2, y + cs / 2, cs * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = u.player === playerNum ? "#1a2a5e" : "#3a1a1a";
      ctx.fill();
      ctx.strokeStyle = u.color;
      ctx.lineWidth = u.id === selectedUnitId.value ? 3 : 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.font = `${cs * 0.45}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(u.emoji, x + cs / 2, y + cs / 2);

      if (u.hp > 0) {
        const barW = cs - 6, barH = 4;
        const bx = x + 3, by = y + cs - 7;
        ctx.fillStyle = "#333";
        ctx.fillRect(bx, by, barW, barH);
        const pct = Math.max(0, u.hp / u.maxHp);
        ctx.fillStyle = pct > 0.5 ? "#86efac" : pct > 0.25 ? "#fbbf24" : "#f87171";
        ctx.fillRect(bx, by, barW * pct, barH);
      }

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x + cs - 6, y + 6, 3, 0, Math.PI * 2);
      ctx.fillStyle = u.player === 1 ? "#7f7fd5" : "#f97316";
      ctx.fill();
    });
  }

  function onGameCanvasClick(e: MouseEvent) {
    const state = gameState.value;
    if (!state || !isMyTurn.value || !selectedUnitId.value || !currentAction.value) return;
    const canvas = gameCanvasRef.current;
    if (!canvas) return;
    const cs = getCellSize(state.mapSize);
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / cs);
    const y = Math.floor((e.clientY - rect.top) / cs);

    const unit = state.units.find((u) => u.id === selectedUnitId.value);
    if (!unit) return;

    let action: GameAction | null = null;

    if (currentAction.value === "move") {
      action = { type: "move", unitId: unit.id, x, y };
    } else if (currentAction.value === "fire") {
      const target = state.units.find(
        (t) => t.x === x && t.y === y && t.hp > 0,
      );
      if (!target) {
        addLog("No target at that cell.", "sys");
        return;
      }
      action = { type: "fire", unitId: unit.id, targetId: target.id };
    }

    if (action) {
      send({ type: "action", action });
    }
  }

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
    const placements = spawnPlacements.value;
    if (placements.some((p) => p === null)) {
      spawnError.value = "Place all 4 units before confirming.";
      return;
    }
    spawnConfirmed.value = true;
    send({ type: "spawn_ready", spawn: placements as { x: number; y: number }[] });
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
    const allPlaced = spawnPlacements.value.every((p) => p !== null);

    return (
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <h2 class="text-primary font-bold tracking-widest">SPAWN PHASE</h2>
          {allPlaced
            ? <span class="text-sm font-mono text-success">All units placed ✓</span>
            : <span class="text-sm font-mono text-warning">
                {spawnPlacements.value.filter((p) => p !== null).length}/4 placed
              </span>}
        </div>

        {playerNum === 1 && (
          <div class="flex items-center gap-3">
            <label class="text-sm text-base-content/60">Map size:</label>
            {([8, 12, 16] as const).map((s) => (
              <button
                key={s}
                class={`btn btn-xs ${mapSize.value === s ? "btn-primary" : "btn-outline"}`}
                disabled={spawnConfirmed.value}
                onClick={() => {
                  spawnPlacements.value = [null, null, null, null];
                  mapSize.value = s;
                  send({ type: "map_size", size: s });
                }}
              >
                {s}×{s}
              </button>
            ))}
          </div>
        )}
        {playerNum === 2 && (
          <p class="text-base-content/50 text-sm">
            Map size: {mapSizeFromHost.value ?? "waiting for host..."}
          </p>
        )}

        {/* Unit tray — drag cards onto the board */}
        <div class="flex gap-2 p-3 bg-base-200 rounded-lg">
          {UNIT_DEFS.map((u, i) => {
            const isPlaced = spawnPlacements.value[i] !== null;
            return (
              <div
                key={u.name}
                draggable={!isPlaced && !spawnConfirmed.value}
                class={`flex-1 flex flex-col items-center gap-1 py-2 px-1 rounded border select-none transition-all
                  ${isPlaced
                    ? "border-success/50 bg-success/10 opacity-50 cursor-default"
                    : spawnConfirmed.value
                    ? "border-base-300 opacity-40 cursor-default"
                    : "border-base-300 bg-base-100 hover:bg-base-300 hover:border-primary cursor-grab"}
                  ${draggingUnit.value === i ? "opacity-30 scale-95" : ""}`}
                onDragStart={(e: DragEvent) => {
                  draggingUnit.value = i;
                  e.dataTransfer?.setData("text/plain", String(i));
                }}
                onDragEnd={() => {
                  draggingUnit.value = null;
                  hoverCell.value = null;
                }}
              >
                <span class="text-xl leading-none">{u.emoji}</span>
                <span class="text-xs font-mono text-base-content/70">{u.name}</span>
                <span class={`text-xs ${isPlaced ? "text-success" : "text-base-content/30"}`}>
                  {isPlaced ? "✓" : "drag"}
                </span>
              </div>
            );
          })}
        </div>

        <p class="text-base-content/50 text-xs font-mono">
          {spawnConfirmed.value
            ? "Spawn confirmed — waiting for opponent..."
            : "Drag units from the tray onto your highlighted spawn zone. Click a placed unit on the board to remove it."}
        </p>

        <canvas
          ref={gameCanvasRef}
          style="cursor:crosshair;border-radius:4px;max-width:100%"
          onDragOver={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={onCanvasDrop}
          onClick={onSpawnCanvasClick}
        />

        {spawnError.value && (
          <p class="text-error text-sm font-mono">⚠️ {spawnError.value}</p>
        )}

        <div class="flex gap-3 items-center flex-wrap">
          <button
            class="btn btn-primary"
            disabled={!allPlaced || spawnConfirmed.value}
            onClick={confirmSpawn}
          >
            {spawnConfirmed.value ? "Spawn Confirmed ✓" : "Confirm Spawn"}
          </button>
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
        {/* Game canvas */}
        <div>
          <canvas
            ref={gameCanvasRef}
            style="border:2px solid #7f7fd5;border-radius:4px;cursor:crosshair"
            onClick={onGameCanvasClick}
          />
        </div>

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
