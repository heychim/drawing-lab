import { createDerivedPath, type PathSegment } from "../renderer/curvePath.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, type ValidationResult } from "./types.js";

// Input adapter, not a renderer. Independently implemented normal offsets and
// Douglas–Peucker reduction; no upstream code copied. See THIRD_PARTY_NOTICES.
export const CENTERLINE_MAX_STATIONS = 12;
export const CENTERLINE_MAX_WIDTH = 240;
const SAMPLES_PER_SEGMENT = 12;
const BOUNDARY_TOLERANCE = 0.25;
type XY = [number, number];
type Station = [number, number, number];
type Sample = { x: number; y: number; tx: number; ty: number; nx: number; ny: number; radius: number };
const invalid = (message: string) => ({ ok: false as const, errors: [message] });

function sampleSegment(segment: PathSegment, t: number) {
  const u = 1 - t;
  const { start, end } = segment;
  if (segment.type === "line") {
    return { x: u * start.x + t * end.x, y: u * start.y + t * end.y,
      dx: end.x - start.x, dy: end.y - start.y };
  }
  const { control1: b, control2: c } = segment;
  const position = (key: "x" | "y") => u ** 3 * start[key] + 3 * u * u * t * b[key] +
    3 * u * t * t * c[key] + t ** 3 * end[key];
  const tangent = (key: "x" | "y") => 3 * u * u * (b[key] - start[key]) +
    6 * u * t * (c[key] - b[key]) + 3 * t * t * (end[key] - c[key]);
  return { x: position("x"), y: position("y"), dx: tangent("x"), dy: tangent("y") };
}

function segmentDistance(point: XY, start: XY, end: XY) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - start[0] - projection * dx, point[1] - start[1] - projection * dy);
}

function simplifyBoundary(points: XY[]): XY[] {
  const last = points.length;
  const ring = [...points, points[0]];
  const keep = new Set([0, last]);
  // Preserve the paint field's origin, bounding box and furthest point. Removing
  // these could move pigment/texture or change the existing fill reveal radius.
  const extrema = [0, 0, 0, 0, 0];
  for (let i = 1; i < last; i++) {
    if (points[i][0] < points[extrema[0]][0]) extrema[0] = i;
    if (points[i][0] > points[extrema[1]][0]) extrema[1] = i;
    if (points[i][1] < points[extrema[2]][1]) extrema[2] = i;
    if (points[i][1] > points[extrema[3]][1]) extrema[3] = i;
    if (Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]) >
        Math.hypot(points[extrema[4]][0] - points[0][0], points[extrema[4]][1] - points[0][1])) extrema[4] = i;
  }
  for (const index of extrema) keep.add(index);
  const anchors = [...keep].sort((a, b) => a - b);
  const pending = anchors.slice(1).map((end, index) => [anchors[index], end]);
  while (pending.length) {
    const [start, end] = pending.pop()!;
    let furthest = -1, distance = BOUNDARY_TOLERANCE;
    for (let i = start + 1; i < end; i++) {
      const current = segmentDistance(ring[i], ring[start], ring[end]);
      if (current > distance) { distance = current; furthest = i; }
    }
    if (furthest !== -1) {
      keep.add(furthest);
      pending.push([start, furthest], [furthest, end]);
    }
  }
  return [...keep].filter(index => index < last).sort((a, b) => a - b).map(index => points[index]);
}

// Called only for a fill tool. Metadata and the expanded perimeter must still
// pass the existing canonical validator before applying or publishing anything.
export function expandCenterlinePath(path: Record<string, unknown>): ValidationResult<XY[]> {
  if (Object.keys(path).some(key => !["id", "spine", "caps", "grain"].includes(key))) {
    return invalid("spine paths accept only id, spine, caps and optional grain; do not mix xy/t/smooth/corners");
  }
  if (!Array.isArray(path.spine) || path.spine.length < 2 || path.spine.length > CENTERLINE_MAX_STATIONS) {
    return invalid("spine must have 2–12 [x,y,fullWidth] stations");
  }
  if (!Array.isArray(path.caps) || path.caps.length !== 2 ||
      !Array.from(path.caps).every(cap => cap === "flat" || cap === "round")) {
    return invalid("caps must specify flat or round for both start and end");
  }
  for (const [i, station] of path.spine.entries()) {
    if (!Array.isArray(station) || station.length !== 3 || ![station[0], station[1], station[2]].every(Number.isFinite)) {
      return invalid("each spine station must be finite [x,y,fullWidth]");
    }
    const [x, y, width] = station;
    if (x < 0 || x > CANVAS_WIDTH || y < 0 || y > CANVAS_HEIGHT || width < 0 || width > CENTERLINE_MAX_WIDTH) {
      return invalid("spine coordinates must be within 1000×750; fullWidth must be 0–240");
    }
    if (width === 0 && i > 0 && i < path.spine.length - 1) return invalid("only spine endpoints may have zero width");
    const previous = path.spine[i - 1];
    if (previous && previous[0] === x && previous[1] === y) return invalid("consecutive spine centers must differ");
  }
  const spine = path.spine as Station[];
  if (spine.every(station => station[2] === 0)) return invalid("spine shape must have area");
  const centers = spine.map(([x, y]) => ({ x, y }));
  const curve = createDerivedPath(centers, centers.map((_, i) => i / (centers.length - 1)));
  const stations: Sample[] = [];
  for (const [i, segment] of curve.segments.entries()) {
    for (let j = i === 0 ? 0 : 1; j <= SAMPLES_PER_SEGMENT; j++) {
      const t = j / SAMPLES_PER_SEGMENT;
      const point = sampleSegment(segment, t);
      const speed = Math.hypot(point.dx, point.dy);
      if (speed < 0.000001) return invalid("spine reverses at a zero tangent; split the shape into separate paths");
      const blend = t * t * (3 - 2 * t);
      const width = spine[i][2] * (1 - blend) + spine[i + 1][2] * blend;
      stations.push({ x: point.x, y: point.y, tx: point.dx / speed, ty: point.dy / speed,
        nx: -point.dy / speed, ny: point.dx / speed, radius: width / 2 });
    }
  }
  const xy: XY[] = [];
  function append(x: number, y: number) {
    const point: XY = [Number(x.toFixed(2)), Number(y.toFixed(2))];
    if (!xy.length || point.some((value, i) => value !== xy[xy.length - 1][i])) xy.push(point);
  }
  function cap(station: Sample, sign: 1 | -1) {
    if ((path.caps as string[])[sign === 1 ? 1 : 0] !== "round") return;
    for (let i = 1; i < SAMPLES_PER_SEGMENT; i++) {
      const angle = Math.PI * i / SAMPLES_PER_SEGMENT;
      append(station.x + sign * station.radius * (station.nx * Math.cos(angle) + station.tx * Math.sin(angle)),
        station.y + sign * station.radius * (station.ny * Math.cos(angle) + station.ty * Math.sin(angle)));
    }
  }
  for (const point of stations) append(point.x + point.nx * point.radius, point.y + point.ny * point.radius);
  cap(stations[stations.length - 1], 1);
  for (const point of [...stations].reverse()) append(point.x - point.nx * point.radius, point.y - point.ny * point.radius);
  cap(stations[0], -1);
  if (xy.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || x > CANVAS_WIDTH || y < 0 || y > CANVAS_HEIGHT)) {
    return invalid("expanded spine boundary leaves the canonical canvas");
  }
  if (xy[0].every((value, i) => value === xy[xy.length - 1][i])) xy.pop();
  const boundary = simplifyBoundary(xy);
  if (boundary.length < 3) return invalid("spine expansion collapsed the filled region");
  return { ok: true, value: boundary };
}
