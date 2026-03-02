/**
 * SpawnScene — Phaser 3 Scene for the spawn phase.
 *
 * Draws a flat-top hex grid, tints spawn zones per player,
 * and emits click events for unit placement.
 */
import * as Phaser from "phaser";
import { hexToPixel, hexDimensions } from "../../lib/hex-pixels.ts";
import type { HexCoord } from "../../lib/types.ts";
import { UNIT_EMOJIS, UNIT_TYPES } from "../../lib/types.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const HEX_SIZE = 32; // circumradius
const PAD = 40;       // canvas padding

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a flat-top hex polygon path (6 vertices) centred at (cx, cy). */
function hexPoints(cx: number, cy: number, size: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);          // flat-top: starts at 0°
    pts.push(new Phaser.Geom.Point(
      cx + size * Math.cos(angle),
      cy + size * Math.sin(angle),
    ));
  }
  return pts;
}

function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

// ── Scene ──────────────────────────────────────────────────────────────────────

export default class SpawnScene extends Phaser.Scene {
  private cols = 12;
  private rows = 12;
  private playerNum: 1 | 2 = 1;
  private hexSize = HEX_SIZE;

  /** Graphics layer for the grid background. */
  private gridGfx!: Phaser.GameObjects.Graphics;
  /** Graphics layer for the spawn zone overlay. */
  private zoneGfx!: Phaser.GameObjects.Graphics;
  /** Container holding placed-unit markers. */
  private markerContainer!: Phaser.GameObjects.Container;
  /** Label showing which zone belongs to the player. */
  private zoneLabel!: Phaser.GameObjects.Text;

  /** Currently placed spawn cells (updated via registry). */
  private placedCells: HexCoord[] = [];

  constructor() {
    super({ key: "SpawnScene" });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(data: { cols: number; rows: number; playerNum: 1 | 2 }) {
    this.cols = data.cols;
    this.rows = data.rows;
    this.playerNum = data.playerNum;
  }

  create() {
    this.gridGfx = this.add.graphics();
    this.zoneGfx = this.add.graphics();
    this.markerContainer = this.add.container(0, 0);

    this.zoneLabel = this.add.text(0, 0, "", {
      fontFamily: "Courier New, monospace",
      fontSize: "11px",
      color: "#7f7fd5",
    });

    this.drawGrid();
    this.drawZoneOverlay();
    this.positionZoneLabel();

    // Listen for pointer clicks
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.handleClick(pointer.worldX, pointer.worldY);
    });

    // React to external state changes pushed through the registry
    this.registry.events.on("changedata-spawnCells", (_: unknown, cells: HexCoord[]) => {
      this.placedCells = cells;
      this.drawMarkers();
    });
    this.registry.events.on("changedata-mapSize", (_: unknown, size: { cols: number; rows: number }) => {
      this.cols = size.cols;
      this.rows = size.rows;
      this.resizeAndRedraw();
    });

    // Initialise from registry if already set
    const initCells = this.registry.get("spawnCells") as HexCoord[] | undefined;
    if (initCells) {
      this.placedCells = initCells;
      this.drawMarkers();
    }
  }

  // ── Grid drawing ───────────────────────────────────────────────────────────

  /** Pixel position of hex centre (offset by PAD so nothing clips). */
  private hexCenter(q: number, r: number): { x: number; y: number } {
    const { px, py } = hexToPixel(q, r, this.hexSize);
    return { x: px + PAD, y: py + PAD };
  }

  private canvasSize(): { w: number; h: number } {
    // Approximate bounding box: last hex centre + hex dims + padding
    const last = this.hexCenter(this.cols - 1, this.rows - 1);
    const { w: hw, h: hh } = hexDimensions(this.hexSize);
    return { w: last.x + hw / 2 + PAD, h: last.y + hh / 2 + PAD };
  }

  private drawGrid() {
    const gfx = this.gridGfx;
    gfx.clear();

    for (let r = 0; r < this.rows; r++) {
      for (let q = 0; q < this.cols; q++) {
        const { x, y } = this.hexCenter(q, r);
        const pts = hexPoints(x, y, this.hexSize);

        gfx.fillStyle(0x0a0a1a, 1);
        gfx.fillPoints(pts, true);

        gfx.lineStyle(1, 0x1a1a3e, 1);
        gfx.strokePoints(pts, true);
      }
    }
  }

  private drawZoneOverlay() {
    const gfx = this.zoneGfx;
    gfx.clear();

    const half = Math.floor(this.cols / 2);

    for (let r = 0; r < this.rows; r++) {
      for (let q = 0; q < this.cols; q++) {
        const inZone = this.playerNum === 1 ? q < half : q >= this.cols - half;
        if (!inZone) continue;

        const { x, y } = this.hexCenter(q, r);
        const pts = hexPoints(x, y, this.hexSize);
        gfx.fillStyle(0x7f7fd5, 0.2);
        gfx.fillPoints(pts, true);
      }
    }
  }

  private positionZoneLabel() {
    if (this.playerNum === 1) {
      this.zoneLabel.setText("← Your spawn zone");
      this.zoneLabel.setPosition(PAD, 6);
    } else {
      this.zoneLabel.setText("Your spawn zone →");
      const { w } = this.canvasSize();
      this.zoneLabel.setPosition(w - PAD - this.zoneLabel.width, 6);
    }
  }

  // ── Placed-unit markers ────────────────────────────────────────────────────

  private drawMarkers() {
    this.markerContainer.removeAll(true);

    this.placedCells.forEach((cell, i) => {
      const { x, y } = this.hexCenter(cell.q, cell.r);
      const pts = hexPoints(x, y, this.hexSize * 0.88);

      // Filled hex highlight
      const gfx = this.add.graphics();
      gfx.fillStyle(0x7f7fd5, 0.7);
      gfx.fillPoints(pts, true);
      this.markerContainer.add(gfx);

      // Emoji label
      const emoji = UNIT_EMOJIS[UNIT_TYPES[i]];
      const txt = this.add.text(x, y, emoji, {
        fontSize: `${this.hexSize * 0.8}px`,
        fontFamily: "serif",
      }).setOrigin(0.5, 0.5);
      this.markerContainer.add(txt);
    });
  }

  // ── Click handling ─────────────────────────────────────────────────────────

  private handleClick(worldX: number, worldY: number) {
    // Find closest hex
    let bestQ = -1, bestR = -1, bestDist = Infinity;
    for (let r = 0; r < this.rows; r++) {
      for (let q = 0; q < this.cols; q++) {
        const { x, y } = this.hexCenter(q, r);
        const dx = worldX - x;
        const dy = worldY - y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestQ = q;
          bestR = r;
        }
      }
    }

    // Ignore clicks outside any hex
    if (bestDist > this.hexSize * this.hexSize) return;

    // Must be in spawn zone
    const half = Math.floor(this.cols / 2);
    const inZone = this.playerNum === 1 ? bestQ < half : bestQ >= this.cols - half;
    if (!inZone) return;

    // Emit event — the island decides whether to add/remove the cell
    this.events.emit("hex_clicked", { q: bestQ, r: bestR } as HexCoord);
  }

  // ── Resize helper (when host changes map size) ────────────────────────────

  private resizeAndRedraw() {
    const { w, h } = this.canvasSize();
    this.scale.resize(w, h);
    this.drawGrid();
    this.drawZoneOverlay();
    this.positionZoneLabel();
    this.drawMarkers();
  }
}
