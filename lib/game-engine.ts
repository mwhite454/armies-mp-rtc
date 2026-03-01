/**
 * Pure server-side game logic — no DOM dependencies.
 * Ported from src/tactical-game.html.
 */
import type { GameAction, GameState, Unit, UnitBuild } from "./types.ts";
import { UNIT_COLORS, UNIT_EMOJIS, UNIT_TYPES } from "./types.ts";

export const TOTAL_POINTS = 40;
export const MAX_PER_UNIT = 30;

// ─── Build Validation ─────────────────────────────────────────────────────────

export function validateBuild(build: UnitBuild[]): string[] {
  const errors: string[] = [];
  if (build.length !== 4) {
    errors.push("Build must contain exactly 4 units.");
    return errors;
  }

  const totalUsed = build.reduce(
    (sum, u) => sum + u.Move + u.Health + u.Damage + u.Range,
    0,
  );
  if (totalUsed !== TOTAL_POINTS) {
    errors.push(
      `Must use exactly ${TOTAL_POINTS} points (currently ${totalUsed}).`,
    );
  }

  build.forEach((u, i) => {
    const unitTotal = u.Move + u.Health + u.Damage + u.Range;
    const unitName = UNIT_TYPES[i];
    if (unitTotal > MAX_PER_UNIT) {
      errors.push(`${unitName} has ${unitTotal} pts (max ${MAX_PER_UNIT}).`);
    }
    (["Move", "Health", "Damage", "Range"] as const).forEach((stat) => {
      if (u[stat] < 1) errors.push(`${unitName}.${stat} must be ≥1.`);
    });
  });

  return errors;
}

export function getDefaultBuild(): UnitBuild[] {
  return UNIT_TYPES.map(() => ({ Move: 2, Health: 4, Damage: 2, Range: 2 }));
}

// ─── Unit Construction ────────────────────────────────────────────────────────

export function buildUnitsFromSpawn(
  playerNum: 1 | 2,
  spawnCells: { x: number; y: number }[],
  build: UnitBuild[],
): Unit[] {
  return UNIT_TYPES.map((name, i) => ({
    id: `p${playerNum}_${i}`,
    player: playerNum,
    name,
    emoji: UNIT_EMOJIS[name],
    color: UNIT_COLORS[name],
    Move: build[i].Move,
    Health: build[i].Health,
    Damage: build[i].Damage,
    Range: build[i].Range,
    hp: build[i].Health,
    maxHp: build[i].Health,
    x: spawnCells[i].x,
    y: spawnCells[i].y,
    loaded: true,
  }));
}

// ─── Spawn Validation ─────────────────────────────────────────────────────────

export function isInSpawnZone(
  x: number,
  y: number,
  mapSize: number,
  playerNum: 1 | 2,
): boolean {
  const half = Math.floor(mapSize / 2);
  return playerNum === 1 ? x < half : x >= mapSize - half;
}

export function validateSpawn(
  cells: { x: number; y: number }[],
  mapSize: number,
  playerNum: 1 | 2,
): string[] {
  const errors: string[] = [];
  if (cells.length !== 4) {
    errors.push(`Must place exactly 4 units (got ${cells.length}).`);
  }

  const seen = new Set<string>();
  cells.forEach((cell) => {
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) errors.push(`Duplicate cell (${cell.x},${cell.y}).`);
    else seen.add(key);

    if (!isInSpawnZone(cell.x, cell.y, mapSize, playerNum)) {
      errors.push(
        `Cell (${cell.x},${cell.y}) is outside your spawn zone.`,
      );
    }
    if (
      cell.x < 0 || cell.x >= mapSize || cell.y < 0 || cell.y >= mapSize
    ) {
      errors.push(`Cell (${cell.x},${cell.y}) is out of bounds.`);
    }
  });

  return errors;
}

// ─── Win Condition ────────────────────────────────────────────────────────────

export function checkWinCondition(state: GameState): 1 | 2 | null {
  const p1Leader = state.units.find((u) => u.player === 1 && u.name === "Leader");
  const p2Leader = state.units.find((u) => u.player === 2 && u.name === "Leader");
  if (p1Leader && p1Leader.hp <= 0) return 2;
  if (p2Leader && p2Leader.hp <= 0) return 1;
  return null;
}

// ─── Action Application (server-authoritative) ───────────────────────────────

export interface ActionResult {
  newState: GameState;
  logMessage: string;
  error?: string;
}

export function applyAction(
  state: GameState,
  action: GameAction,
  actingPlayerNum: 1 | 2,
): ActionResult {
  // Deep clone state to avoid mutation
  const newState: GameState = JSON.parse(JSON.stringify(state));

  // Validate it's this player's turn
  if (newState.turn !== actingPlayerNum) {
    return {
      newState: state,
      logMessage: "",
      error: "NOT_YOUR_TURN",
    };
  }

  if (newState.actionsLeft <= 0) {
    return {
      newState: state,
      logMessage: "",
      error: "NO_ACTIONS_LEFT",
    };
  }

  const unit = newState.units.find((u) => u.id === action.unitId);
  if (!unit) {
    return { newState: state, logMessage: "", error: "UNIT_NOT_FOUND" };
  }
  if (unit.player !== actingPlayerNum) {
    return { newState: state, logMessage: "", error: "NOT_YOUR_UNIT" };
  }
  if (unit.hp <= 0) {
    return { newState: state, logMessage: "", error: "UNIT_IS_DEAD" };
  }

  switch (action.type) {
    case "move": {
      const dist = Math.abs(action.x - unit.x) + Math.abs(action.y - unit.y);
      if (dist === 0) {
        return { newState: state, logMessage: "", error: "INVALID_MOVE" };
      }
      if (dist > unit.Move) {
        return {
          newState: state,
          logMessage: "",
          error: `OUT_OF_RANGE: max ${unit.Move}`,
        };
      }
      if (action.x < 0 || action.x >= newState.mapSize || action.y < 0 || action.y >= newState.mapSize) {
        return { newState: state, logMessage: "", error: "OUT_OF_BOUNDS" };
      }
      const occupied = newState.units.some(
        (o) => o.id !== unit.id && o.hp > 0 && o.x === action.x && o.y === action.y,
      );
      if (occupied) {
        return { newState: state, logMessage: "", error: "CELL_OCCUPIED" };
      }
      unit.x = action.x;
      unit.y = action.y;
      newState.actionsLeft--;
      return {
        newState,
        logMessage: `${unit.name} moved to (${unit.x},${unit.y}).`,
      };
    }

    case "reload": {
      if (unit.loaded) {
        return { newState: state, logMessage: "", error: "ALREADY_LOADED" };
      }
      unit.loaded = true;
      newState.actionsLeft--;
      return { newState, logMessage: `${unit.name} reloaded.` };
    }

    case "fire": {
      if (!unit.loaded) {
        return { newState: state, logMessage: "", error: "NOT_LOADED" };
      }
      const target = newState.units.find((t) => t.id === action.targetId);
      if (!target) {
        return { newState: state, logMessage: "", error: "TARGET_NOT_FOUND" };
      }
      if (target.hp <= 0) {
        return { newState: state, logMessage: "", error: "TARGET_IS_DEAD" };
      }
      const dist = Math.abs(target.x - unit.x) + Math.abs(target.y - unit.y);
      if (dist > unit.Range) {
        return {
          newState: state,
          logMessage: "",
          error: `OUT_OF_RANGE: max ${unit.Range}`,
        };
      }

      unit.loaded = false;
      newState.actionsLeft--;

      if (unit.name === "Leader") {
        // Leader heals allies
        if (target.player !== actingPlayerNum) {
          return {
            newState: state,
            logMessage: "",
            error: "LEADER_HEALS_ALLIES_ONLY",
          };
        }
        target.hp = Math.min(target.maxHp, target.hp + unit.Damage);
        return {
          newState,
          logMessage:
            `${unit.name} healed ${target.name} for ${unit.Damage}HP. (HP:${target.hp}/${target.maxHp})`,
        };
      } else {
        // Other units attack enemies
        if (target.player === actingPlayerNum) {
          return {
            newState: state,
            logMessage: "",
            error: "CANNOT_ATTACK_OWN_UNIT",
          };
        }
        target.hp -= unit.Damage;
        return {
          newState,
          logMessage:
            `${unit.name} hit ${target.name} for ${unit.Damage} damage. (HP:${Math.max(0, target.hp)})`,
        };
      }
    }
  }
}

// ─── Random Build ─────────────────────────────────────────────────────────────

export function randomizeBuild(): UnitBuild[] {
  const build: UnitBuild[] = UNIT_TYPES.map(() => ({
    Move: 1,
    Health: 1,
    Damage: 1,
    Range: 1,
  }));
  let remaining = TOTAL_POINTS - 16; // 16 already spent (4×4×1)
  const stats = ["Move", "Health", "Damage", "Range"] as const;

  for (let iter = 0; iter < 10000 && remaining > 0; iter++) {
    const ui = Math.floor(Math.random() * 4);
    const si = stats[Math.floor(Math.random() * 4)];
    const unitTotal = build[ui].Move + build[ui].Health + build[ui].Damage +
      build[ui].Range;
    if (unitTotal < MAX_PER_UNIT) {
      build[ui][si]++;
      remaining--;
    }
  }
  return build;
}
