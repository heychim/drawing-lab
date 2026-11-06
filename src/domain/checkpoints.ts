import {
  createInitialEngineState,
  deriveDocumentState,
  reduceOperations,
  type EngineState,
} from "./engine.js";
import { STROKE_TOOLS, type DrawingDocument, type DrawingTool } from "./types.js";

export const CHECKPOINT_INTERVAL = 350;
export const CHECKPOINT_VERSION = 1;

type CheckpointDrawable = {
  operationIndex: number;
  active: boolean;
};

type CheckpointState = {
  tool: DrawingTool;
  color: string;
  brushSize: number;
  drawables: CheckpointDrawable[];
  redoStack: number[];
  completed: boolean;
};

export type RenderCheckpoint = {
  version: typeof CHECKPOINT_VERSION;
  revision: number;
  canonicalHash: string;
  stateHash: string;
  state: CheckpointState;
};

export type CheckpointRestoreResult = {
  state: EngineState;
  usedCheckpointRevision: number | null;
  rebuiltFromCanonical: boolean;
};

function hashText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function snapshotState(state: EngineState): CheckpointState {
  return {
    tool: state.tool,
    color: state.color,
    brushSize: state.brushSize,
    drawables: state.drawables.map(({ operationIndex, active }) => ({ operationIndex, active })),
    redoStack: [...state.redoStack],
    completed: state.completed,
  };
}

function createCheckpoint(
  document: DrawingDocument,
  revision: number,
  state: EngineState,
): RenderCheckpoint {
  const snapshot = snapshotState(state);
  return {
    version: CHECKPOINT_VERSION,
    revision,
    canonicalHash: hashText(JSON.stringify(document.operations.slice(0, revision))),
    stateHash: hashText(JSON.stringify(snapshot)),
    state: snapshot,
  };
}

export function createRenderCheckpoints(document: DrawingDocument): RenderCheckpoint[] {
  const checkpoints: RenderCheckpoint[] = [];
  let state = createInitialEngineState();
  let previousRevision = 0;

  for (
    let revision = CHECKPOINT_INTERVAL;
    revision <= document.operations.length;
    revision += CHECKPOINT_INTERVAL
  ) {
    state = reduceOperations(
      document.operations.slice(previousRevision, revision),
      state,
      previousRevision,
      false,
    );
    checkpoints.push(createCheckpoint(document, revision, state));
    previousRevision = revision;
  }
  return checkpoints;
}

function hydrateCheckpoint(
  document: DrawingDocument,
  checkpoint: RenderCheckpoint,
): EngineState | null {
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    !Number.isInteger(checkpoint.revision) ||
    checkpoint.revision < CHECKPOINT_INTERVAL ||
    checkpoint.revision % CHECKPOINT_INTERVAL !== 0 ||
    checkpoint.revision > document.operations.length ||
    checkpoint.canonicalHash !== hashText(JSON.stringify(document.operations.slice(0, checkpoint.revision))) ||
    checkpoint.stateHash !== hashText(JSON.stringify(checkpoint.state))
  ) {
    return null;
  }

  const snapshot = checkpoint.state;
  if (
    !snapshot ||
    !(snapshot.tool === "eraser" || STROKE_TOOLS.includes(snapshot.tool)) ||
    typeof snapshot.color !== "string" ||
    !Number.isInteger(snapshot.brushSize) ||
    typeof snapshot.completed !== "boolean" ||
    !Array.isArray(snapshot.drawables) ||
    !Array.isArray(snapshot.redoStack)
  ) {
    return null;
  }

  const seen = new Set<number>();
  const drawables: EngineState["drawables"] = [];
  for (const entry of snapshot.drawables) {
    if (
      !entry ||
      !Number.isInteger(entry.operationIndex) ||
      entry.operationIndex < 0 ||
      entry.operationIndex >= checkpoint.revision ||
      typeof entry.active !== "boolean" ||
      seen.has(entry.operationIndex)
    ) {
      return null;
    }
    const operation = document.operations[entry.operationIndex];
    if (operation.type !== "stroke" && operation.type !== "erase") return null;
    seen.add(entry.operationIndex);
    drawables.push({ operationIndex: entry.operationIndex, operation, active: entry.active });
  }

  if (
    snapshot.redoStack.some((operationIndex) =>
      !Number.isInteger(operationIndex) ||
      !seen.has(operationIndex) ||
      drawables.find((entry) => entry.operationIndex === operationIndex)?.active !== false,
    )
  ) {
    return null;
  }

  return {
    tool: snapshot.tool,
    color: snapshot.color,
    brushSize: snapshot.brushSize,
    drawables,
    redoStack: [...snapshot.redoStack],
    completed: snapshot.completed,
  };
}

export function restoreDocumentState(
  document: DrawingDocument,
  checkpoints: readonly RenderCheckpoint[],
): CheckpointRestoreResult {
  const candidates = [...checkpoints]
    .filter((checkpoint) => checkpoint.revision <= document.operations.length)
    .sort((left, right) => right.revision - left.revision);

  for (const checkpoint of candidates) {
    const checkpointState = hydrateCheckpoint(document, checkpoint);
    if (!checkpointState) continue;
    return {
      state: reduceOperations(
        document.operations.slice(checkpoint.revision),
        checkpointState,
        checkpoint.revision,
        false,
      ),
      usedCheckpointRevision: checkpoint.revision,
      rebuiltFromCanonical: false,
    };
  }

  return {
    state: deriveDocumentState(document),
    usedCheckpointRevision: null,
    rebuiltFromCanonical: true,
  };
}

export class RenderCheckpointCache {
  private readonly entries = new Map<string, {
    currentRevision: number;
    checkpoints: RenderCheckpoint[];
  }>();

  refresh(document: DrawingDocument) {
    const cached = this.entries.get(document.id);
    if (cached?.currentRevision === document.currentRevision) return cached.checkpoints;
    const checkpoints = createRenderCheckpoints(document);
    this.entries.set(document.id, { currentRevision: document.currentRevision, checkpoints });
    return checkpoints;
  }

  restore(document: DrawingDocument) {
    return restoreDocumentState(document, this.entries.get(document.id)?.checkpoints ?? []);
  }

  get(documentId: string) {
    return [...(this.entries.get(documentId)?.checkpoints ?? [])];
  }

  clear(documentId?: string) {
    if (documentId === undefined) this.entries.clear();
    else this.entries.delete(documentId);
  }
}
