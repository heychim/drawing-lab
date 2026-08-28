import type { Point } from "../domain/types.js";

export type CubicSegment = {
  type: "cubic";
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
  tStart: number;
  tEnd: number;
};

export type LineSegment = {
  type: "line";
  start: Point;
  end: Point;
  tStart: number;
  tEnd: number;
};

export type PathSegment = CubicSegment | LineSegment;

export type DerivedPath = {
  interpolation: "bezier" | "polyline";
  start: Point;
  segments: PathSegment[];
  fallbackReason?: string;
};

export type RenderCommand =
  | { type: "move"; point: Point }
  | { type: "line"; point: Point }
  | { type: "cubic"; control1: Point; control2: Point; point: Point };

const copyPoint = (point: Point): Point => ({ x: point.x, y: point.y });
const isFinitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);

function validateFitInput(points: Point[], tValues: number[]) {
  if (points.length < 2) return "at least two points are required";
  if (points.length !== tValues.length) return "points and tValues lengths differ";
  if (!points.every(isFinitePoint)) return "points contain non-finite coordinates";
  if (!tValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    return "tValues must be finite progression values from 0 to 1";
  }
  if (tValues[0] !== 0 || tValues.at(-1) !== 1) return "tValues must span 0 to 1";
  for (let index = 1; index < tValues.length; index += 1) {
    if (tValues[index] <= tValues[index - 1]) return "tValues must be strictly increasing";
  }
  return null;
}

function fallbackPolyline(points: Point[], reason: string): DerivedPath {
  const safePoints = points.every(isFinitePoint) ? points.map(copyPoint) : [];
  const start = safePoints[0] ?? { x: 0, y: 0 };
  const denominator = Math.max(1, safePoints.length - 1);
  return {
    interpolation: "polyline",
    start,
    fallbackReason: reason,
    segments: safePoints.slice(1).map((end, index) => ({
      type: "line",
      start: safePoints[index],
      end,
      tStart: index / denominator,
      tEnd: (index + 1) / denominator,
    })),
  };
}

function tangentAt(points: Point[], tValues: number[], index: number): Point {
  const lastIndex = points.length - 1;
  const isClosed =
    points.length > 3 &&
    distance(points[0], points[lastIndex]) < 0.0001;

  if (isClosed && (index === 0 || index === lastIndex)) {
    const span = (tValues[1] - tValues[0]) + (tValues[lastIndex] - tValues[lastIndex - 1]);
    return {
      x: (points[1].x - points[lastIndex - 1].x) / span,
      y: (points[1].y - points[lastIndex - 1].y) / span,
    };
  }
  if (index === 0) {
    const span = tValues[1] - tValues[0];
    return {
      x: (points[1].x - points[0].x) / span,
      y: (points[1].y - points[0].y) / span,
    };
  }
  if (index === lastIndex) {
    const span = tValues[lastIndex] - tValues[lastIndex - 1];
    return {
      x: (points[lastIndex].x - points[lastIndex - 1].x) / span,
      y: (points[lastIndex].y - points[lastIndex - 1].y) / span,
    };
  }
  const span = tValues[index + 1] - tValues[index - 1];
  return {
    x: (points[index + 1].x - points[index - 1].x) / span,
    y: (points[index + 1].y - points[index - 1].y) / span,
  };
}

function boundedControl(anchor: Point, candidate: Point, maxDistance: number): Point {
  const length = distance(anchor, candidate);
  if (length <= maxDistance || length === 0) return candidate;
  const scale = maxDistance / length;
  return {
    x: anchor.x + (candidate.x - anchor.x) * scale,
    y: anchor.y + (candidate.y - anchor.y) * scale,
  };
}

function fitBezier(points: Point[], tValues: number[]): DerivedPath {
  const tangents = points.map((_, index) => tangentAt(points, tValues, index));
  const segments: CubicSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = copyPoint(points[index]);
    const end = copyPoint(points[index + 1]);
    const tStart = tValues[index];
    const tEnd = tValues[index + 1];
    const tSpan = tEnd - tStart;
    const segmentLength = distance(start, end);
    const controlLimit = Math.max(segmentLength, 0.0001);
    const control1 = boundedControl(start, {
      x: start.x + tangents[index].x * tSpan / 3,
      y: start.y + tangents[index].y * tSpan / 3,
    }, controlLimit);
    const control2 = boundedControl(end, {
      x: end.x - tangents[index + 1].x * tSpan / 3,
      y: end.y - tangents[index + 1].y * tSpan / 3,
    }, controlLimit);
    if (![control1, control2].every(isFinitePoint)) {
      throw new Error("fitted control point is non-finite");
    }
    segments.push({ type: "cubic", start, control1, control2, end, tStart, tEnd });
  }

  return { interpolation: "bezier", start: copyPoint(points[0]), segments };
}

export function createDerivedPath(points: Point[], tValues: number[]): DerivedPath {
  const validationError = validateFitInput(points, tValues);
  if (validationError) return fallbackPolyline(points, validationError);
  if (points.length === 2) return fallbackPolyline(points, "two-point stroke is already linear");
  try {
    return fitBezier(points, tValues);
  } catch (error) {
    return fallbackPolyline(
      points,
      error instanceof Error ? error.message : "unknown curve fitting failure",
    );
  }
}

const lerp = (from: Point, to: Point, progress: number): Point => ({
  x: from.x + (to.x - from.x) * progress,
  y: from.y + (to.y - from.y) * progress,
});

function partialCubic(segment: CubicSegment, progress: number) {
  const ab = lerp(segment.start, segment.control1, progress);
  const bc = lerp(segment.control1, segment.control2, progress);
  const cd = lerp(segment.control2, segment.end, progress);
  const abc = lerp(ab, bc, progress);
  const bcd = lerp(bc, cd, progress);
  return {
    control1: ab,
    control2: abc,
    end: lerp(abc, bcd, progress),
  };
}

export function commandsAtProgress(path: DerivedPath, progress: number): RenderCommand[] {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const commands: RenderCommand[] = [{ type: "move", point: copyPoint(path.start) }];

  for (const segment of path.segments) {
    if (clampedProgress >= segment.tEnd) {
      commands.push(segment.type === "line"
        ? { type: "line", point: copyPoint(segment.end) }
        : {
            type: "cubic",
            control1: copyPoint(segment.control1),
            control2: copyPoint(segment.control2),
            point: copyPoint(segment.end),
          });
      continue;
    }
    if (clampedProgress <= segment.tStart) break;
    const localProgress = (clampedProgress - segment.tStart) / (segment.tEnd - segment.tStart);
    if (segment.type === "line") {
      commands.push({ type: "line", point: lerp(segment.start, segment.end, localProgress) });
    } else {
      const partial = partialCubic(segment, localProgress);
      commands.push({
        type: "cubic",
        control1: partial.control1,
        control2: partial.control2,
        point: partial.end,
      });
    }
    break;
  }

  return commands;
}
