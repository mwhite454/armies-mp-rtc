/**
 * CombatScene — Phaser 3 Scene for the combat (and result) phases.
 *
 * Renders: hex grid, unit containers (circle + emoji + HP bar),
 * move/fire range overlays, and a turn timer bar.
 * Reacts to GameState changes pushed through `scene.registry`.
 */
import * as Phaser from "phaser";
import { hexToPixel, hexRange, hexDimensions } from "../lib/hex-pixels.ts";
import type { GameState, HexCoord, Unit } from "../lib/types.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const HEX_SIZE = 32;
const PAD = 40;

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexPoints(cx: number, cy: number, size: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    pts.push(new Phaser.Geom.Point(
      cx + size * Math.cos(angle),
      cy + size * Math.sin(angle),
    ));
  }
  return pts;
}

// ── Scene ──────────────────────────────────────────────────────────────────────

export default class CombatScene extends Phaser.Scene {
  private cols = 12;
  private rows = 12;
  private playerNum: 1 | 2 = 1;
  private hexSize = HEX_SIZE;

  // Graphics layers
  private gridGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;

  // Unit display containers keyed by unit.id
  private unitContainers = new Map<string, Phaser.GameObjects.Container>();

  // Timer bar
  private timerBarBg!: Phaser.GameObjects.Graphics;
  private timerBarFill!: Phaser.GameObjects.Graphics;
  private timerFlashing = false;

  // Locally-tracked selection (pushed from island via registry)
  private selectedUnitId: string | null = null;
  private currentAction: "move" | "reload" | "fire" | null = null;

  constructor() {
    super({ key: "CombatScene" });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(data: { cols: number; rows: number; playerNum: 1 | 2 }) {
    this.cols = data.cols;
    this.rows = data.rows;
    this.playerNum = data.playerNum;
  }

  create() {
    this.gridGfx = this.add.graphics();
    this.overlayGfx = this.add.graphics();

    // Timer bar setup (at the very top of the scene)
    this.timerBarBg = this.add.graphics();
    this.timerBarFill = this.add.graphics();

    this.drawGrid();
    this.drawTimerBackground();

    // ── Clicks ───────────────────────────────────────────────────────────────
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.handleClick(pointer.worldX, pointer.worldY);
    });

    // ── Registry listeners ───────────────────────────────────────────────────
    this.registry.events.on("changedata-gameState", (_: unknown, state: GameState) => {
      const dimensionsChanged = state.mapCols !== this.cols || state.mapRows !== this.rows;
      this.cols = state.mapCols;
      this.rows = state.mapRows;
      if (dimensionsChanged) {
        const { w, h } = this.canvasSize();
        this.scale.resize(w, h);
        this.drawGrid();
        this.drawTimerBackground();
      }
      this.refreshUnits(state);
      this.refreshOverlays(state);
    });

    this.registry.events.on("changedata-selectedUnitId", (_: unknown, id: string | null) => {
      this.selectedUnitId = id;
      const state = this.registry.get("gameState") as GameState | undefined;
      if (state) this.refreshOverlays(state);
    });

    this.registry.events.on("changedata-currentAction", (_: unknown, action: "move" | "reload" | "fire" | null) => {
      this.currentAction = action;
      const state = this.registry.get("gameState") as GameState | undefined;
      if (state) this.refreshOverlays(state);
    });

    this.registry.events.on("changedata-timedOut", (_: unknown, val: boolean) => {
      this.timerFlashing = val;
    });

    // Bootstrap from existing registry values
    const initState = this.registry.get("gameState") as GameState | undefined;
    if (initState) {
      this.cols = initState.mapCols;
      this.rows = initState.mapRows;
      this.refreshUnits(initState);
    }
    this.selectedUnitId = this.registry.get("selectedUnitId") as string | null ?? null;
    this.currentAction = this.registry.get("currentAction") as "move" | "fire" | null ?? null;
  }

  // ── Update (runs every frame) ──────────────────────────────────────────────

  override update(_time: number, _delta: number) {
    this.drawTimerFill();
  }

  // ── Grid ───────────────────────────────────────────────────────────────────

  private hexCenter(q: number, r: number): { x: number; y: number } {
    const { px, py } = hexToPixel(q, r, this.hexSize);
    return { x: px + PAD, y: py + PAD };
  }

  private canvasSize(): { w: number; h: number } {
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

        const shade = (q + r) % 2 === 0 ? 0x0a0a1a : 0x0f0f22;
        gfx.fillStyle(shade, 1);
        gfx.fillPoints(pts, true);

        gfx.lineStyle(1, 0x1a1a3e, 1);
        gfx.strokePoints(pts, true);
      }
    }
  }

  // ── Range overlays ─────────────────────────────────────────────────────────

  private refreshOverlays(state: GameState) {
    const gfx = this.overlayGfx;
    gfx.clear();

    if (!this.selectedUnitId || !this.currentAction) return;
    const unit = state.units.find((u) => u.id === this.selectedUnitId);
    if (!unit || unit.hp <= 0) return;

    const range = this.currentAction === "move" ? unit.Move : unit.Range;
    const color = this.currentAction === "move" ? 0x7f7fd5 : 0xf97316;
    const alpha = 0.25;

    const cells = hexRange(
      { q: unit.q, r: unit.r },
      range,
      this.cols,
      this.rows,
    );

    for (const cell of cells) {
      const { x, y } = this.hexCenter(cell.q, cell.r);
      const pts = hexPoints(x, y, this.hexSize);
      gfx.fillStyle(color, alpha);
      gfx.fillPoints(pts, true);
    }
  }

  // ── Unit rendering ─────────────────────────────────────────────────────────

  private refreshUnits(state: GameState) {
    // Remove old containers that no longer exist
    for (const [id, container] of this.unitContainers) {
      if (!state.units.find((u) => u.id === id)) {
        container.destroy();
        this.unitContainers.delete(id);
      }
    }

    for (const unit of state.units) {
      let container = this.unitContainers.get(unit.id);
      if (!container) {
        container = this.createUnitContainer(unit);
        this.unitContainers.set(unit.id, container);
      }
      this.updateUnitContainer(container, unit);
    }
  }

  private createUnitContainer(unit: Unit): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0);
    container.setData("unitId", unit.id);

    // Background circle
    const circle = this.add.graphics();
    container.add(circle);
    container.setData("circle", circle);

    // Emoji text
    const emoji = this.add.text(0, 0, unit.emoji, {
      fontSize: `${this.hexSize * 0.7}px`,
      fontFamily: "serif",
    }).setOrigin(0.5, 0.5);
    container.add(emoji);
    container.setData("emoji", emoji);

    // HP bar background
    const hpBg = this.add.graphics();
    container.add(hpBg);
    container.setData("hpBg", hpBg);

    // HP bar fill
    const hpFill = this.add.graphics();
    container.add(hpFill);
    container.setData("hpFill", hpFill);

    // Player dot
    const dot = this.add.graphics();
    container.add(dot);
    container.setData("dot", dot);

    return container;
  }

  private updateUnitContainer(container: Phaser.GameObjects.Container, unit: Unit) {
    const { x, y } = this.hexCenter(unit.q, unit.r);
    container.setPosition(x, y);

    const dead = unit.hp <= 0;
    container.setAlpha(dead ? 0.25 : 1);

    // ── Circle ──
    const circle = container.getData("circle") as Phaser.GameObjects.Graphics;
    circle.clear();

    const fillColor = unit.player === this.playerNum ? 0x1a2a5e : 0x3a1a1a;
    const unitColorNum = Phaser.Display.Color.HexStringToColor(unit.color).color;
    const isSelected = unit.id === this.selectedUnitId;

    circle.fillStyle(fillColor, 1);
    circle.fillCircle(0, 0, this.hexSize * 0.38);
    circle.lineStyle(isSelected ? 3 : 1.5, unitColorNum, 1);
    circle.strokeCircle(0, 0, this.hexSize * 0.38);

    // ── HP bar ──
    const barW = this.hexSize * 1.3;
    const barH = 4;
    const bx = -barW / 2;
    const by = this.hexSize * 0.38 + 3;

    const hpBg = container.getData("hpBg") as Phaser.GameObjects.Graphics;
    hpBg.clear();
    if (unit.hp > 0) {
      hpBg.fillStyle(0x333333, 1);
      hpBg.fillRect(bx, by, barW, barH);
    }

    const hpFill = container.getData("hpFill") as Phaser.GameObjects.Graphics;
    hpFill.clear();
    if (unit.hp > 0) {
      const pct = Math.max(0, unit.hp / unit.maxHp);
      const hpColor = pct > 0.5 ? 0x86efac : pct > 0.25 ? 0xfbbf24 : 0xf87171;
      hpFill.fillStyle(hpColor, 1);
      hpFill.fillRect(bx, by, barW * pct, barH);
    }

    // ── Player dot ──
    const dot = container.getData("dot") as Phaser.GameObjects.Graphics;
    dot.clear();
    const dotColor = unit.player === 1 ? 0x7f7fd5 : 0xf97316;
    dot.fillStyle(dotColor, 1);
    dot.fillCircle(this.hexSize * 0.32, -(this.hexSize * 0.32), 3);
  }

  // ── Turn timer bar ─────────────────────────────────────────────────────────

  private drawTimerBackground() {
    const { w } = this.canvasSize();
    this.timerBarBg.clear();
    this.timerBarBg.fillStyle(0x1a1a3e, 1);
    this.timerBarBg.fillRect(PAD, 4, w - PAD * 2, 6);
  }

  private drawTimerFill() {
    const deadline = this.registry.get("turnDeadline") as number | null;
    const { w } = this.canvasSize();
    const barW = w - PAD * 2;

    this.timerBarFill.clear();

    if (!deadline) return;

    const now = Date.now();
    const configuredDuration = this.registry.get("turnDurationMs") as number | null;
    const totalMs = typeof configuredDuration === "number" && configuredDuration > 0
      ? configuredDuration
      : 60_000; // default to 60s to match server if not provided
    const remaining = Math.max(0, deadline - now);
    const pct = Math.min(1, remaining / totalMs);

    // Flash red when timed out
    let color = 0x7f7fd5;
    let alpha = 1;
    if (this.timerFlashing) {
      color = 0xf87171;
      alpha = Math.sin(now / 150) * 0.3 + 0.7;
    } else if (pct < 0.25) {
      color = 0xf87171;
    } else if (pct < 0.5) {
      color = 0xfbbf24;
    }

    this.timerBarFill.fillStyle(color, alpha);
    this.timerBarFill.fillRect(PAD, 4, barW * pct, 6);
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

    if (bestDist > this.hexSize * this.hexSize) return;

    this.events.emit("hex_clicked", { q: bestQ, r: bestR } as HexCoord);
  }
}
