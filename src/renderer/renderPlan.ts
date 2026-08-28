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

function createStroke(
  operation: DrawableOperation,
  operationIndex: number,
  background: string,
  progress: number,
): RenderPlanStroke | null {
  const commands = commandsAtProgress(getDerivedPath(operation), progress);
  if (commands.length < 2) return null;
  return {
    operationIndex,
    type: operation.type,
    tool: operation.tool,
    strokeStyle: operation.type === "erase" ? background : operation.color,
    lineWidth: operation.brushSize,
    globalAlpha:
      operation.type === "stroke" && operation.tool === "pencil" ? 0.92 : 1,
    commands,
  };
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
    context.save();
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
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.lineWidth;
    context.strokeStyle = stroke.strokeStyle;
    context.globalAlpha = stroke.globalAlpha;
    context.stroke();
    context.restore();
  }
}
