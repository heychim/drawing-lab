import {
  applyOperation,
  createInitialEngineState,
  reduceOperations,
  type DrawableOperation,
  type EngineState,
} from "./engine.js";
import type { DrawingDocument } from "./types.js";

export type PlaybackStatus = "ready" | "playing";
export type ActionPulse = "undo" | "redo" | null;

export type PlaybackFrame = {
  engine: EngineState;
  status: PlaybackStatus;
  operationIndex: number;
  transient: { operation: DrawableOperation; progress: number } | null;
  actionPulse: ActionPulse;
};

const delay = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const pathLength = (operation: DrawableOperation) =>
  operation.points.slice(1).reduce((total, point, index) => {
    const previous = operation.points[index];
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);

async function animateDrawable(
  operation: DrawableOperation,
  state: EngineState,
  operationIndex: number,
  onFrame: (frame: PlaybackFrame) => void,
  signal: AbortSignal,
) {
  const duration = Math.min(950, Math.max(180, pathLength(operation) * 1.35));
  const startedAt = performance.now();

  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      if (signal.aborted) return resolve();
      const progress = Math.min(1, (now - startedAt) / duration);
      onFrame({
        engine: state,
        status: "playing",
        operationIndex,
        transient: { operation, progress },
        actionPulse: null,
      });
      if (progress >= 1) return resolve();
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

export async function playDocument(
  document: DrawingDocument,
  mode: "latest" | "full",
  onFrame: (frame: PlaybackFrame) => void,
  signal: AbortSignal,
) {
  const from = mode === "full" ? 0 : document.latestPlaybackRange.from;
  const to = mode === "full" ? document.operations.length : document.latestPlaybackRange.to;
  let state = reduceOperations(
    document.operations.slice(0, from),
    createInitialEngineState(),
    0,
    false,
  );

  onFrame({
    engine: state,
    status: "playing",
    operationIndex: from - 1,
    transient: null,
    actionPulse: null,
  });

  for (let index = from; index < to; index += 1) {
    if (signal.aborted) return;
    const operation = document.operations[index];
    if (operation.type === "stroke" || operation.type === "erase") {
      await animateDrawable(operation, state, index, onFrame, signal);
      if (signal.aborted) return;
    }
    state = applyOperation(state, operation, index, false);
    const actionPulse = operation.type === "undo" || operation.type === "redo"
      ? operation.type
      : null;
    onFrame({
      engine: state,
      status: "playing",
      operationIndex: index,
      transient: null,
      actionPulse,
    });
    await delay(actionPulse ? 230 : operation.type === "stroke" || operation.type === "erase" ? 70 : 105, signal);
  }

  if (!signal.aborted) {
    onFrame({
      engine: state,
      status: "ready",
      operationIndex: Math.max(-1, to - 1),
      transient: null,
      actionPulse: null,
    });
  }
}
