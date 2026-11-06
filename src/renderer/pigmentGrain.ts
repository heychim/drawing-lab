// One small repeating paper tile per medium, shared by every painted region.
// Wash settles in uneven pits; heavier paint catches the ridges of the paper.
export type Medium = "wash_fill" | "gouache_fill";
export const GRAIN_TILE_SIZE = 96;
type GrainLayer = { color: string; alpha: number; d: string };
const tiles = new Map<Medium, GrainLayer[]>();

export function pigmentGrain(medium: Medium) {
  const cached = tiles.get(medium);
  if (cached) return cached;
  const wash = medium === "wash_fill";
  let seed = wash ? 811 : 191;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const layers = [
    { color: "#53473D", alpha: wash ? 0.14 : 0.085, d: "" },
    { color: "#FFF9ED", alpha: wash ? 0.33 : 0.24, d: "" },
  ];
  for (const [index, layer] of layers.entries()) {
    const count = wash ? 240 : 150;
    for (let i = 0; i < count; i++) {
      const x = random() * GRAIN_TILE_SIZE, y = random() * GRAIN_TILE_SIZE;
      const length = wash ? 0.5 + random() * 2.4 : 1 + random() ** 2 * (index ? 12 : 8);
      const height = 0.5 + random() * (wash ? 1.8 : 1.2);
      const slope = wash ? height * 0.4 : -length * 0.22;
      const mark = `l${length.toFixed(1)} ${slope.toFixed(1)}l${(-length * 0.8).toFixed(1)} ${(height - slope).toFixed(1)}Z`;
      // Wrap marks crossing a seam so there is no grid of truncated ends.
      for (const dx of x + length > GRAIN_TILE_SIZE ? [0, -GRAIN_TILE_SIZE] : [0]) {
        const offsets = [0];
        if (y + slope < 0) offsets.push(GRAIN_TILE_SIZE);
        if (y + height > GRAIN_TILE_SIZE) offsets.push(-GRAIN_TILE_SIZE);
        for (const dy of offsets) layer.d += `M${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}${mark}`;
      }
    }
  }
  tiles.set(medium, layers);
  return layers;
}

const patterns = new Map<Medium, CanvasPattern>();

export function pigmentPattern(ctx: CanvasRenderingContext2D, medium: Medium) {
  const existing = patterns.get(medium);
  if (existing) return existing;
  const tile = document.createElement("canvas");
  tile.width = tile.height = GRAIN_TILE_SIZE;
  const ink = tile.getContext("2d")!;
  for (const layer of pigmentGrain(medium)) {
    ink.fillStyle = layer.color;
    ink.globalAlpha = layer.alpha;
    ink.fill(new Path2D(layer.d));
  }
  const pattern = ctx.createPattern(tile, "repeat")!;
  patterns.set(medium, pattern);
  return pattern;
}
