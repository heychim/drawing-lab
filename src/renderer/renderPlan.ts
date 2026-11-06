import {
  deriveDocumentState,
  type DrawableOperation,
  type EngineState,
} from "../domain/engine.js";
import type { DrawingDocument } from "../domain/types.js";
import {
  commandsAtProgress,
  createDerivedPath,
  type DerivedPath,
  type RenderCommand,
} from "./curvePath.js";

export const CANONICAL_CANVAS_WIDTH = 1000;
export const CANONICAL_CANVAS_HEIGHT = 750;

export type RenderPlanStroke = {
  operationIndex: number;
  type: "stroke" | "erase";
  tool: DrawableOperation["tool"];
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  commands: RenderCommand[];
  passes?: RenderPlanPass[];
};

export type RenderPlanPass = {
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  offsetX: number;
  offsetY: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineDash: number[];
  lineDashOffset: number;
};

export type RenderPlan = {
  width: number;
  height: number;
  background: string;
  strokes: RenderPlanStroke[];
};

export type FinalRenderPlan = RenderPlan & {
  sourceDocumentId: string;
  sourceRevision: number;
  sourceOperationCount: number;
};

const derivedPathCache = new WeakMap<DrawableOperation, DerivedPath>();

function getDerivedPath(operation: DrawableOperation) {
  const cached = derivedPathCache.get(operation);
  if (cached) return cached;
  const path = createDerivedPath(operation.points, operation.tValues);
  derivedPathCache.set(operation, path);
  return path;
}

function hashSemanticId(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pass(
  strokeStyle: string,
  lineWidth: number,
  globalAlpha: number,
  options: Partial<Omit<RenderPlanPass, "strokeStyle" | "lineWidth" | "globalAlpha">> = {},
): RenderPlanPass {
  return {
    strokeStyle,
    lineWidth: Math.max(0.5, lineWidth),
    globalAlpha,
    offsetX: options.offsetX ?? 0,
    offsetY: options.offsetY ?? 0,
    lineCap: options.lineCap ?? "round",
    lineJoin: options.lineJoin ?? "round",
    lineDash: options.lineDash ?? [],
    lineDashOffset: options.lineDashOffset ?? 0,
  };
}

function createArtBrushPasses(operation: DrawableOperation): RenderPlanPass[] | undefined {
  if (operation.type !== "stroke") return undefined;
  const { tool, color, brushSize, semanticId } = operation;
  if (tool === "graphite") {
    const phase = (hashSemanticId(semanticId) % 31) / 10;
    return [
      pass(color, brushSize * 0.64, 0.34, {
        offsetX: -0.45,
        offsetY: 0.3,
        lineDash: [3.2, 1.35],
        lineCap: "butt",
        lineDashOffset: phase,
      }),
      pass(color, brushSize * 0.38, 0.58, {
        offsetX: 0.35,
        offsetY: -0.25,
        lineDash: [1.15, 2.1],
        lineCap: "butt",
        lineDashOffset: -phase * 0.7,
      }),
      pass(color, brushSize * 0.2, 0.5, {
        lineDash: [5.5, 0.9],
        lineDashOffset: phase * 0.35,
      }),
    ];
  }
  if (tool === "watercolor") {
    return [
      pass(color, brushSize * 1.55, 0.09, { offsetX: -0.8, offsetY: 0.65 }),
      pass(color, brushSize * 1.28, 0.12, { offsetX: 0.65, offsetY: -0.55 }),
      pass(color, brushSize * 1.02, 0.17, { offsetX: -0.25, offsetY: -0.15 }),
      pass(color, brushSize * 0.62, 0.2, { offsetX: 0.3, offsetY: 0.2 }),
    ];
  }
  if (tool === "marker") {
    return [
      pass(color, brushSize * 1.08, 0.28, {
        offsetX: 0.45,
        offsetY: 0.4,
        lineCap: "square",
        lineJoin: "bevel",
      }),
      pass(color, brushSize, 0.64, { lineCap: "square", lineJoin: "bevel" }),
      pass("#FFFFFF", brushSize * 0.36, 0.12, {
        offsetX: -0.35,
        offsetY: -0.35,
        lineCap: "square",
        lineJoin: "bevel",
      }),
    ];
  }
  return undefined;
}

function createStroke(
  operation: DrawableOperation,
  operationIndex: number,
  background: string,
  progress: number,
): RenderPlanStroke | null {
  const commands = commandsAtProgress(getDerivedPath(operation), progress);
  if (commands.length < 2) return null;
  const stroke: RenderPlanStroke = {
    operationIndex,
    type: operation.type,
    tool: operation.tool,
    strokeStyle: operation.type === "erase" ? background : operation.color,
    lineWidth: operation.brushSize,
    globalAlpha:
      operation.type === "stroke" && operation.tool === "pencil" ? 0.92 : 1,
    commands,
  };
  const passes = createArtBrushPasses(operation);
  if (passes) stroke.passes = passes;
  return stroke;
}

export function createRenderPlan(
  background: string,
  engine: EngineState,
  transient: { operation: DrawableOperation; progress: number } | null = null,
): RenderPlan {
  const strokes = engine.drawables.flatMap((entry) => {
    if (!entry.active) return [];
    const stroke = createStroke(entry.operation, entry.operationIndex, background, 1);
    return stroke ? [stroke] : [];
  });
  if (transient) {
    const stroke = createStroke(transient.operation, -1, background, transient.progress);
    if (stroke) strokes.push(stroke);
  }
  return {
    width: CANONICAL_CANVAS_WIDTH,
    height: CANONICAL_CANVAS_HEIGHT,
    background,
    strokes,
  };
}

export function createFinalRenderPlan(document: DrawingDocument): FinalRenderPlan {
  return {
    ...createRenderPlan(document.canvas.background, deriveDocumentState(document)),
    sourceDocumentId: document.id,
    sourceRevision: document.currentRevision,
    sourceOperationCount: document.operations.length,
  };
}

export function paintRenderPlanToCanvas(
  context: CanvasRenderingContext2D,
  plan: RenderPlan,
) {
  context.fillStyle = plan.background;
  context.fillRect(0, 0, plan.width, plan.height);
  for (const stroke of plan.strokes) {
    const passes = stroke.passes ?? [pass(
      stroke.strokeStyle,
      stroke.lineWidth,
      stroke.globalAlpha,
    )];
    for (const renderPass of passes) {
      context.save();
      context.translate(renderPass.offsetX, renderPass.offsetY);
      context.beginPath();
      const first = stroke.commands[0];
      context.moveTo(first.point.x, first.point.y);
      for (const command of stroke.commands.slice(1)) {
        if (command.type === "line") {
          context.lineTo(command.point.x, command.point.y);
        } else if (command.type === "cubic") {
          context.bezierCurveTo(
            command.control1.x,
            command.control1.y,
            command.control2.x,
            command.control2.y,
            command.point.x,
            command.point.y,
          );
        }
      }
      context.lineCap = renderPass.lineCap;
      context.lineJoin = renderPass.lineJoin;
      context.lineWidth = renderPass.lineWidth;
      context.strokeStyle = renderPass.strokeStyle;
      context.globalAlpha = renderPass.globalAlpha;
      context.setLineDash(renderPass.lineDash);
      context.lineDashOffset = renderPass.lineDashOffset;
      context.stroke();
      context.restore();
    }
  }
}
