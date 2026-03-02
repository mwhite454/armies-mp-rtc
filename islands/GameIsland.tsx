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
import { hexToPixel, pixelToHex, gridPixelSize } from "../lib/hex-pixels.ts";
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
  const mapCols = useSignal(12);
  const mapRows = useSignal(12);
  const mapColsFromHost = useSignal<number | null>(null);
  const spawnCanvasRef = useRef<HTMLCanvasElement>(null);
  const spawnPlacements = useSignal<Array<HexCoord | null>>([null, null, null, null]);
  const draggingUnit = useSignal<number | null>(null);
  const hoverCell = useSignal<HexCoord | null>(null);
  const spawnConfirmed = useSignal(false);
  const opponentSpawnReady = useSignal(false);
  const spawnError = useSignal("");

  // ── Combat ────────────────────────────────────────────────────────────────
  const gameState = useSignal<GameState | null>(null);
  const selectedUnitId = useSignal<string | null>(null);
  const currentAction = useSignal<"move" | "reload" | "fire" | null>(null);
  const isMyTurn = useSignal(false);
  const phaserRootRef = useRef<HTMLDivElement>(null);
  const phaserGameRef = useRef<Phaser.Game | null>(null);

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

  // ── Phaser game instance ──────────────────────────────────────────────────
  const phaserGameRef = useRef<{ destroy(removeCanvas: boolean): void } | null>(null);

  function addLog(text: string, kind: LogLine["kind"] = "sys") {
    logLines.value = [...logLines.value, { text, kind }];
  }

  // ── Phaser combat scene lifecycle ─────────────────────────────────────────
  useEffect(() => {
    if (phase.value !== "combat" && phase.value !== "result") return;
    if (phaserGameRef.current) return; // already initialised
    const root = phaserRootRef.current;
    if (!root) return;

    let destroyed = false;

    (async () => {
      // Dynamic import keeps Phaser out of the SSR bundle
      const Phaser = (await import("phaser")).default ?? await import("phaser");
      const { default: CombatScene } = await import("../phaser/CombatScene.ts");

      if (destroyed) return;

      const cols = mapCols.value;
      const rows = mapRows.value;
      const hexSize = 32;
      const PAD = 40;
      // Approximate canvas dims (matches CombatScene.canvasSize logic)
      const lastPx = hexToPixel(cols - 1, rows - 1, hexSize);
      const estW = lastPx.px + PAD * 2 + hexSize;
      const estH = lastPx.py + PAD * 2 + hexSize;

      const game = new Phaser.Game({
        type: Phaser.AUTO,
        width: estW,
        height: estH,
        parent: root,
        backgroundColor: "#0a0a1a",
        scene: [CombatScene],
        scale: { mode: Phaser.Scale.NONE },
      });
      phaserGameRef.current = game;

      // Wait for the scene to be ready, then push initial state
      game.events.once("ready", () => {
        if (destroyed) return;
        const scene = game.scene.getScene("CombatScene");
        if (!scene) return;

        // Push initial registry values
        scene.registry.set("gameState", gameState.value);
        scene.registry.set("selectedUnitId", selectedUnitId.value);
        scene.registry.set("currentAction", currentAction.value);
        scene.registry.set("turnDeadline", turnDeadline.value);
        scene.registry.set("turnDurationMs", turnDurationMs.value);
        scene.registry.set("timedOut", timedOut.value);

        // Listen for hex clicks from CombatScene
        scene.events.on("hex_clicked", (coord: HexCoord) => {
          if (!isMyTurn.value || !selectedUnitId.value) return;
          const state = gameState.value;
          if (!state) return;

          if (currentAction.value === "move") {
            send({
              type: "action",
              action: { type: "move", unitId: selectedUnitId.value, q: coord.q, r: coord.r },
            });
          } else if (currentAction.value === "fire") {
            const target = state.units.find(
              (u) => u.q === coord.q && u.r === coord.r && u.player !== playerNum && u.hp > 0,
            );
            if (target) {
              send({
                type: "action",
                action: { type: "fire", unitId: selectedUnitId.value, targetId: target.id },
              });
            }
          } else {
            // No action selected — clicking a hex selects our unit on it
            const ownUnit = state.units.find(
              (u) => u.q === coord.q && u.r === coord.r && u.player === playerNum && u.hp > 0,
            );
            if (ownUnit) {
              selectedUnitId.value = selectedUnitId.value === ownUnit.id ? null : ownUnit.id;
              currentAction.value = null;
            }
          }
        });

        // Start the scene with init data
        scene.scene.restart({ cols, rows, playerNum });
      });
    })();

    return () => {
      destroyed = true;
      if (phaserGameRef.current) {
        phaserGameRef.current.destroy(true);
        phaserGameRef.current = null;
      }
    };
  }, [phase.value]);

  // ── Sync signals → Phaser registry ────────────────────────────────────────
  useEffect(() => {
    const game = phaserGameRef.current as { scene: { getScene(key: string): { registry: { set(key: string, val: unknown): void } } | null } } | null;
    if (!game) return;
    const scene = game.scene.getScene("CombatScene");
    if (!scene) return;
    scene.registry.set("gameState", gameState.value);
  }, [gameState.value]);

  useEffect(() => {
    const game = phaserGameRef.current as { scene: { getScene(key: string): { registry: { set(key: string, val: unknown): void } } | null } } | null;
    if (!game) return;
    const scene = game.scene.getScene("CombatScene");
    if (!scene) return;
    scene.registry.set("selectedUnitId", selectedUnitId.value);
  }, [selectedUnitId.value]);

  useEffect(() => {
    const game = phaserGameRef.current as { scene: { getScene(key: string): { registry: { set(key: string, val: unknown): void } } | null } } | null;
    if (!game) return;
    const scene = game.scene.getScene("CombatScene");
    if (!scene) return;
    scene.registry.set("currentAction", currentAction.value);
  }, [currentAction.value]);

  useEffect(() => {
    const game = phaserGameRef.current as { scene: { getScene(key: string): { registry: { set(key: string, val: unknown): void } } | null } } | null;
    if (!game) return;
    const scene = game.scene.getScene("CombatScene");
    if (!scene) return;
    scene.registry.set("turnDeadline", turnDeadline.value);
    scene.registry.set("turnDurationMs", turnDurationMs.value);
  }, [turnDeadline.value, turnDurationMs.value]);

  useEffect(() => {
    const game = phaserGameRef.current as { scene: { getScene(key: string): { registry: { set(key: string, val: unknown): void } } | null } } | null;
    if (!game) return;
    const scene = game.scene.getScene("CombatScene");
    if (!scene) return;
    scene.registry.set("timedOut", timedOut.value);
  }, [timedOut.value]);

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

  // ── Spawn canvas rendering ────────────────────────────────────────────────
  useEffect(() => {
    if (phase.value !== "spawn") return;
    renderSpawn();
  }, [phase.value, spawnPlacements.value, hoverCell.value, draggingUnit.value, mapCols.value, mapRows.value]);

  // ── Phaser game initialization (combat phase) ────────────────────────────
  useEffect(() => {
    if (phase.value !== "combat" && phase.value !== "result") return;
    if (phaserGameRef.current) return; // already initialised
    const parent = phaserRootRef.current;
    if (!parent) return;

    // Dynamic import so Phaser only loads client-side
    (async () => {
      const [PhaserMod, { default: CombatScene }] = await Promise.all([
        import("phaser"),
        import("../phaser/CombatScene.ts"),
      ]);
      const Phaser = PhaserMod.default ?? PhaserMod;
      const cols = gameState.value?.mapCols ?? mapCols.value;
      const rows = gameState.value?.mapRows ?? mapRows.value;

      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent,
        backgroundColor: "#0a0a1a",
        width: 800,
        height: 600,
        scene: [CombatScene],
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
        },
        input: { activePointers: 1 },
      });

      phaserGameRef.current = game;

      // Seed registry so the scene has data as soon as it creates
      if (gameState.value) game.registry.set("gameState", gameState.value);
      game.registry.set("selectedUnitId", selectedUnitId.value);
      game.registry.set("currentAction", currentAction.value);
      game.registry.set("turnDeadline", turnDeadline.value);
      game.registry.set("turnDurationMs", turnDurationMs.value);
      game.registry.set("timedOut", timedOut.value);

      // Start the combat scene with map dimensions + player info
      game.scene.start("CombatScene", { cols, rows, playerNum });

      // Forward hex clicks from Phaser back up to the island
      game.events.on("hex_clicked", (coord: HexCoord) => {
        handleHexClick(coord);
      });
    })();

    return () => {
      phaserGameRef.current?.destroy(true);
      phaserGameRef.current = null;
    };
  }, [phase.value]);

  // ── Sync signals into Phaser registry ────────────────────────────────────
  useEffect(() => {
    const game = phaserGameRef.current;
    if (!game) return;
    if (gameState.value) game.registry.set("gameState", gameState.value);
    game.registry.set("selectedUnitId", selectedUnitId.value);
    game.registry.set("currentAction", currentAction.value);
    game.registry.set("turnDeadline", turnDeadline.value);
    game.registry.set("turnDurationMs", turnDurationMs.value);
    game.registry.set("timedOut", timedOut.value);
  }, [gameState.value, selectedUnitId.value, currentAction.value, turnDeadline.value, turnDurationMs.value, timedOut.value]);

  // ─────────────────────────────────────────────────────────────────────────
  // Spawn canvas helpers
  // ─────────────────────────────────────────────────────────────────────────

  function isInSpawnZone(q: number, _r: number) {
    const half = Math.floor(mapCols.value / 2);
    return playerNum === 1 ? q < half : q >= mapCols.value - half;
  }

  function getHexSize(cols: number, rows: number): number {
    const { width: fw, height: fh } = gridPixelSize(cols, rows, 1);
    return Math.max(12, Math.floor(Math.min(520 / fw, 520 / fh)));
  }

  const UNIT_DEFS = [
    { name: "Leader", emoji: "👑", color: "#fbbf24" },
    { name: "Heavy",  emoji: "🛡️", color: "#ef4444" },
    { name: "Sniper", emoji: "🎯", color: "#a855f7" },
    { name: "Dasher", emoji: "⚡", color: "#22c55e" },
  ] as const;

  function drawHex(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    fill: string,
    stroke: string,
    lineWidth = 1,
  ) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const angle = (Math.PI / 3) * k;
      const vx = cx + size * Math.cos(angle);
      const vy = cy + size * Math.sin(angle);
      if (k === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function renderSpawn() {
    const canvas = spawnCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cols = mapCols.value;
    const rows = mapRows.value;
    const hexSize = getHexSize(cols, rows);
    const { width, height } = gridPixelSize(cols, rows, hexSize);
    canvas.width = width;
    canvas.height = height;

    // Background
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, width, height);

    const half = Math.floor(cols / 2);
    const hover = hoverCell.value;

    for (let q = 0; q < cols; q++) {
      for (let r = 0; r < rows; r++) {
        const { px, py } = hexToPixel(q, r, hexSize);
        const cx = px + hexSize;
        const cy = py + hexSize;
        const inZone = isInSpawnZone(q, r);
        const isHover = draggingUnit.value !== null && hover?.q === q && hover?.r === r;

        const base = (q + r) % 2 === 0 ? "#0a0a1a" : "#0f0f22";
        const overlay = isHover && inZone  ? "rgba(127,127,213,0.6)"
          : isHover && !inZone            ? "rgba(239,68,68,0.4)"
          : inZone                        ? "rgba(127,127,213,0.18)"
          :                                 "rgba(0,0,0,0.40)";

        // Draw base then overlay in two passes
        drawHex(ctx, cx, cy, hexSize - 1, base, "#1a1a3e");
        if (overlay !== "rgba(0,0,0,0.40)") {
          ctx.globalAlpha = 1;
          drawHex(ctx, cx, cy, hexSize - 1, overlay, "transparent");
        } else {
          ctx.globalAlpha = 0.4;
          drawHex(ctx, cx, cy, hexSize - 1, "#000", "transparent");
          ctx.globalAlpha = 1;
        }
      }
    }

    // Zone divider (dashed vertical line between zones)
    const xA = hexToPixel(half - 1, 0, hexSize).px + hexSize + hexSize * Math.cos(0);
    const xB = hexToPixel(half, 0, hexSize).px + hexSize - hexSize;
    const divX = (xA + xB) / 2;
    ctx.strokeStyle = "#7f7fd5";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(divX, 0);
    ctx.lineTo(divX, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // Placed units (combat-style circles)
    spawnPlacements.value.forEach((placement, i) => {
      if (!placement) return;
      const { px, py } = hexToPixel(placement.q, placement.r, hexSize);
      const cx = px + hexSize;
      const cy = py + hexSize;
      const def = UNIT_DEFS[i];
      const r = hexSize * 0.48;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#1a2a5e";
      ctx.fill();
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.font = `${hexSize * 0.5}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.emoji, cx, cy);
    });
  }

  function getCellFromEvent(e: MouseEvent | DragEvent): HexCoord | null {
    const canvas = spawnCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const hexSize = getHexSize(mapCols.value, mapRows.value);
    const px = (e.clientX - rect.left) * scaleX - hexSize;
    const py = (e.clientY - rect.top) * scaleY - hexSize;
    const { q, r } = pixelToHex(px, py, hexSize);
    if (q < 0 || q >= mapCols.value || r < 0 || r >= mapRows.value) return null;
    return { q, r };
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
    if (!isInSpawnZone(cell.q, cell.r)) {
      spawnError.value = "Must place in your spawn zone.";
      draggingUnit.value = null;
      hoverCell.value = null;
      return;
    }
    const occupied = spawnPlacements.value.some(
      (p, i) => i !== unitIdx && p?.q === cell.q && p?.r === cell.r,
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
      (p) => p?.q === cell.q && p?.r === cell.r,
    );
    if (idx >= 0) {
      const next = [...spawnPlacements.value];
      next[idx] = null;
      spawnPlacements.value = next;
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

  function handleHexClick(coord: HexCoord) {
    if (!isMyTurn.value || !gameState.value) return;
    const state = gameState.value;

    // If no unit selected, select unit at the clicked hex (if ours)
    if (!selectedUnitId.value) {
      const unit = state.units.find(
        (u) => u.q === coord.q && u.r === coord.r && u.player === playerNum && u.hp > 0,
      );
      if (unit) {
        selectedUnitId.value = unit.id;
        currentAction.value = null;
      }
      return;
    }

    const selUnit = state.units.find((u) => u.id === selectedUnitId.value);
    if (!selUnit) return;

    if (currentAction.value === "move") {
      send({
        type: "action",
        action: { type: "move", unitId: selUnit.id, q: coord.q, r: coord.r },
      });
    } else if (currentAction.value === "fire") {
      // Find enemy at coord
      const target = state.units.find(
        (u) => u.q === coord.q && u.r === coord.r && u.player !== playerNum && u.hp > 0,
      );
      if (target) {
        send({
          type: "action",
          action: { type: "fire", unitId: selUnit.id, targetId: target.id },
        });
      }
    } else {
      // No action mode — try selecting a different own unit or deselect
      const clicked = state.units.find(
        (u) => u.q === coord.q && u.r === coord.r && u.player === playerNum && u.hp > 0,
      );
      if (clicked) {
        selectedUnitId.value = clicked.id;
      } else {
        selectedUnitId.value = null;
      }
      currentAction.value = null;
    }
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
    send({ type: "spawn_ready", spawn: placements as HexCoord[] });
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
                class={`btn btn-xs ${mapCols.value === s ? "btn-primary" : "btn-outline"}`}
                disabled={spawnConfirmed.value}
                onClick={() => {
                  spawnPlacements.value = [null, null, null, null];
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
          ref={spawnCanvasRef}
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
