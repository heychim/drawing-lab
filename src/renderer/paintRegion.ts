import type { Point, StrokeOperation } from "../domain/types.js";
import { pigmentPattern, type Medium } from "./pigmentGrain.js";

// All geometry is in canvas units. Both backends consume the same pigment
// field, paper marks and rim; none of them are added to the drawing history.
type PigmentField = { x: number; y: number; radius: number; stops: [number, number][] };
type RegionPaint = {
  medium: Medium;
  boundary: string;
  field: PigmentField;
  marks: string;
  markColor: string;
  markAlpha: number;
  rimWidth: number;
  rimAlpha: number;
  origin: Point;
  extent: number;
};
export type PaintRegion = { paint: RegionPaint; revealRadius?: number };
const cache = new WeakMap<StrokeOperation, RegionPaint>();

function mixPigment(op: StrokeOperation, seed: number): RegionPaint {
  const wash = op.tool === "wash_fill";
  const origin = op.points[0];
  let left = origin.x, right = left, top = origin.y, bottom = top, extent = 0;
  for (const p of op.points) {
    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
    extent = Math.max(extent, Math.hypot(p.x - origin.x, p.y - origin.y));
  }
  const width = right - left, height = bottom - top;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const field: PigmentField = {
    x: left + width * (0.22 + random() * 0.54),
    y: top + height * (0.18 + random() * 0.5),
    radius: Math.max(1, Math.hypot(width, height) * 0.72),
    // Opacity bytes. Wet paint leaves a light bloom, then a denser tide.
    stops: wash ? [[0, 49], [0.34, 88], [0.66, 146], [1, 95]]
                : [[0, 248], [0.58, 238], [1, 252]],
  };
  const marks: string[] = [];
  const count = Math.min(24, Math.ceil(width * height / 820));
  for (let i = 0; i < count; i++) {
    const x = left + width * random(), y = top + height * random();
    // Broad, low-contrast variations supplement the fine paper tooth. They
    // are clipped to the artist's contour even on thin or concave regions.
    const length = Math.min(width, (wash ? width * 0.34 : 5 + op.brushSize * 2) * (0.5 + random()));
    const depth = Math.min(height, (wash ? height * 0.12 : 2 + op.brushSize * 0.13) * (0.4 + random()));
    const coord = (u: number, v: number) => `${(x + u * length).toFixed(1)} ${(y + v * depth).toFixed(1)}`;
    marks.push(`M${coord(-0.5, 0)}Q${coord(-0.12, -0.9)} ${coord(0.5, -0.4)}Q${coord(0.18, 0.65)} ${coord(-0.5, 0)}Z`);
  }
  return {
    medium: wash ? "wash_fill" : "gouache_fill",
    boundary: "M" + op.points.map(p => `${p.x} ${p.y}`).join("L") + "Z",
    field, marks: marks.join(""), origin, extent,
    markColor: wash ? op.color : "#FFFFFF",
    markAlpha: 0.065,
    rimWidth: wash ? 1.6 + op.brushSize * 0.14 : 0,
    rimAlpha: wash ? 0.17 : 0,
  };
}

export function paintRegionAt(op: StrokeOperation, progress: number, seed: number): PaintRegion {
  let paint = cache.get(op);
  if (!paint) {
    paint = mixPigment(op, seed);
    cache.set(op, paint);
  }
  if (progress >= 1) return { paint };
  // A wash spreads from the first vertex. Respect custom timing without
  // changing the silhouette or re-seeding marks between frames.
  const i = op.tValues.findIndex(t => t > progress);
  const part = (progress - op.tValues[i - 1]) / (op.tValues[i] - op.tValues[i - 1]);
  return { paint, revealRadius: paint.extent * ((i - 1 + part) / (op.tValues.length - 1)) };
}

const canvasPaths = new WeakMap<RegionPaint, { boundary: Path2D; marks: Path2D }>();

export function paintRegionToCanvas(ctx: CanvasRenderingContext2D, region: PaintRegion, color: string) {
  const p = region.paint;
  let paths = canvasPaths.get(p);
  if (!paths) {
    paths = { boundary: new Path2D(p.boundary), marks: new Path2D(p.marks) };
    canvasPaths.set(p, paths);
  }
  ctx.save();
  if (region.revealRadius !== undefined) {
    ctx.beginPath();
    ctx.arc(p.origin.x, p.origin.y, region.revealRadius, 0, 2 * Math.PI);
    ctx.clip();
  }
  ctx.clip(paths.boundary, "evenodd");
  const { x, y, radius, stops } = p.field;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  for (const [at, alpha] of stops) gradient.addColorStop(at, color + alpha.toString(16).padStart(2, "0"));
  ctx.fillStyle = gradient;
  // Fill the clipped bounds once; tracing the boundary twice darkens its fringe.
  ctx.fillRect(p.origin.x - p.extent, p.origin.y - p.extent, 2 * p.extent, 2 * p.extent);
  ctx.fillStyle = pigmentPattern(ctx, p.medium);
  ctx.fillRect(p.origin.x - p.extent, p.origin.y - p.extent, 2 * p.extent, 2 * p.extent);
  ctx.fillStyle = p.markColor;
  ctx.globalAlpha = p.markAlpha;
  ctx.fill(paths.marks);
  if (p.rimWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = p.rimWidth;
    ctx.lineJoin = "round";
    ctx.globalAlpha = p.rimAlpha;
    ctx.stroke(paths.boundary);
  }
  ctx.restore();
}
