/**
 * Pure server-side game logic — no DOM dependencies.
 * Ported from src/tactical-game.html.
 */
import type { GameAction, GameState, HexCoord, Unit, UnitBuild } from "./types.ts";
import { UNIT_COLORS, UNIT_EMOJIS, UNIT_TYPES } from "./types.ts";

// ─── Hex Math (flat-top axial) ─────────────────────────────────────────────────────

/** Axial hex distance between two flat-top hexes. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Six flat-top axial neighbor offsets. */
export const HEX_NEIGHBORS: HexCoord[] = [
  { q: 1, r: 0 },
  { q: -1, r: 0 },
  { q: 0, r: 1 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
  { q: -1, r: 1 },
];

/** All hex coords reachable within `range` steps (BFS, ignoring unit collisions). */
export function hexReachable(
  origin: HexCoord,
  range: number,
  mapCols: number,
  mapRows: number,
): HexCoord[] {
  const visited = new Set<string>();
  const result: HexCoord[] = [];
  const queue: HexCoord[] = [origin];
  visited.add(`${origin.q},${origin.r}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of HEX_NEIGHBORS) {
      const nq = cur.q + nb.q;
      const nr = cur.r + nb.r;
      const key = `${nq},${nr}`;
      if (visited.has(key)) continue;
      if (nq < 0 || nq >= mapCols || nr < 0 || nr >= mapRows) continue;
      if (hexDistance(origin, { q: nq, r: nr }) > range) continue;
      visited.add(key);
      result.push({ q: nq, r: nr });
      queue.push({ q: nq, r: nr });
    }
  }
  return result;
}

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
  spawnCells: HexCoord[],
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
    q: spawnCells[i].q,
    r: spawnCells[i].r,
    loaded: true,
  }));
}

// ─── Spawn Validation ─────────────────────────────────────────────────────────

export function isInSpawnZone(
  q: number,
  _r: number,
  mapCols: number,
  playerNum: 1 | 2,
): boolean {
  const half = Math.floor(mapCols / 2);
  return playerNum === 1 ? q < half : q >= mapCols - half;
}

export function validateSpawn(
  cells: HexCoord[],
  mapCols: number,
  mapRows: number,
  playerNum: 1 | 2,
): string[] {
  const errors: string[] = [];
  if (cells.length !== 4) {
    errors.push(`Must place exactly 4 units (got ${cells.length}).`);
  }

  const seen = new Set<string>();
  cells.forEach((cell) => {
    const key = `${cell.q},${cell.r}`;
    if (seen.has(key)) errors.push(`Duplicate cell (${cell.q},${cell.r}).`);
    else seen.add(key);

    if (!isInSpawnZone(cell.q, cell.r, mapCols, playerNum)) {
      errors.push(`Cell (${cell.q},${cell.r}) is outside your spawn zone.`);
    }
    if (cell.q < 0 || cell.q >= mapCols || cell.r < 0 || cell.r >= mapRows) {
      errors.push(`Cell (${cell.q},${cell.r}) is out of bounds.`);
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
      const dist = hexDistance({ q: unit.q, r: unit.r }, { q: action.q, r: action.r });
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
      if (
        action.q < 0 || action.q >= newState.mapCols ||
        action.r < 0 || action.r >= newState.mapRows
      ) {
        return { newState: state, logMessage: "", error: "OUT_OF_BOUNDS" };
      }
      const occupied = newState.units.some(
        (o) => o.id !== unit.id && o.hp > 0 && o.q === action.q && o.r === action.r,
      );
      if (occupied) {
        return { newState: state, logMessage: "", error: "CELL_OCCUPIED" };
      }
      unit.q = action.q;
      unit.r = action.r;
      newState.actionsLeft--;
      return {
        newState,
        logMessage: `${unit.name} moved to (${unit.q},${unit.r}).`,
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
      const dist = hexDistance({ q: unit.q, r: unit.r }, { q: target.q, r: target.r });
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
