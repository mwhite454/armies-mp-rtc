/**
 * Client-side only — flat-top axial hex coordinate ↔ pixel conversions.
 * DO NOT import in server-side code.
 *
 * Flat-top layout:
 *   px = size * (3/2) * q
 *   py = size * (√3/2 * q  +  √3 * r)
 *
 * `size` is the hex circumradius (center to corner).
 */

import type { HexCoord } from "./types.ts";

// ─── Pixel conversion ─────────────────────────────────────────────────────────

export function hexToPixel(
  q: number,
  r: number,
  size: number,
): { px: number; py: number } {
  return {
    px: size * (3 / 2) * q,
    py: size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
  };
}

export function pixelToHex(px: number, py: number, size: number): HexCoord {
  const q = (2 / 3) * px / size;
  const r = (-1 / 3) * px / size + (Math.sqrt(3) / 3) * py / size;
  return axialRound(q, r);
}

/** Round fractional axial coords to the nearest integer hex. */
function axialRound(fq: number, fr: number): HexCoord {
  // Convert to cube, round, convert back
  const fs = -fq - fr;
  let rq = Math.round(fq);
  let rr = Math.round(fr);
  const rs = Math.round(fs);
  const dq = Math.abs(rq - fq);
  const dr = Math.abs(rr - fr);
  const ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }
  return { q: rq, r: rr };
}

// ─── Neighbor / range helpers ─────────────────────────────────────────────────

/** Six flat-top axial neighbor offsets. */
export const HEX_NEIGHBOR_OFFSETS: HexCoord[] = [
  { q: 1, r: 0 },
  { q: -1, r: 0 },
  { q: 0, r: 1 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
  { q: -1, r: 1 },
];

export function hexNeighbors(q: number, r: number): HexCoord[] {
  return HEX_NEIGHBOR_OFFSETS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

/**
 * All hex coords within `range` steps of `origin` that lie within the
 * [0, mapCols) × [0, mapRows) grid, excluding the origin itself.
 * Uses BFS (no obstacle avoidance — use server-side `hexReachable` for that).
 */
export function hexRange(
  origin: HexCoord,
  range: number,
  mapCols: number,
  mapRows: number,
): HexCoord[] {
  const visited = new Set<string>([`${origin.q},${origin.r}`]);
  const result: HexCoord[] = [];
  const queue: HexCoord[] = [origin];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of HEX_NEIGHBOR_OFFSETS) {
      const nq = cur.q + nb.q;
      const nr = cur.r + nb.r;
      const key = `${nq},${nr}`;
      if (visited.has(key)) continue;
      if (nq < 0 || nq >= mapCols || nr < 0 || nr >= mapRows) continue;
      const dist = (Math.abs(nq - origin.q) + Math.abs(nr - origin.r) +
        Math.abs((nq + nr) - (origin.q + origin.r))) / 2;
      if (dist > range) continue;
      visited.add(key);
      result.push({ q: nq, r: nr });
      queue.push({ q: nq, r: nr });
    }
  }
  return result;
}

/** Flat-top hex width and height from circumradius `size`. */
export function hexDimensions(size: number): { w: number; h: number } {
  return { w: 2 * size, h: Math.sqrt(3) * size };
}

/**
 * The pixel bounding-box required to display a mapCols × mapRows flat-top hex grid.
 * Includes a half-hex offset row for the staggered layout.
 */
export function gridPixelSize(
  mapCols: number,
  mapRows: number,
  size: number,
): { width: number; height: number } {
  const { w, h } = hexDimensions(size);
  return {
    width: Math.ceil(w * (3 / 4) * mapCols + w * (1 / 4) + size),
    height: Math.ceil(h * mapRows + h / 2 + size),
  };
}
