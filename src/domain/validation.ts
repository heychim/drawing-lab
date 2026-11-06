import { reduceOperations } from "./engine.js";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_BACKGROUND,
  DRAWING_LIMITS,
  type AgentDrawingPayload,
  type DrawingDocument,
  type DrawingOperation,
  type DrawingTool,
  type EraseOperation,
  type Point,
  type StrokeTool,
  type StrokeOperation,
  type ValidationResult,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

const OPERATION_TYPES = new Set([
  "select_tool",
  "set_color",
  "set_brush_size",
  "stroke",
  "erase",
  "undo",
  "redo",
  "complete",
]);
const STROKE_TOOLS = ["pencil", "brush", "graphite", "watercolor", "marker"] as const;
const TOOLS = new Set([...STROKE_TOOLS, "eraser"]);
const isStrokeTool = (value: unknown): value is StrokeTool =>
  typeof value === "string" && (STROKE_TOOLS as readonly string[]).includes(value);
const HEX_COLOR = /^#[0-9A-F]{6}$/;
const SEMANTIC_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requireExactKeys(
  value: UnknownRecord,
  allowed: string[],
  required: string[],
  path: string,
  errors: string[],
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
}

function readColor(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    errors.push(`${path} must be an uppercase #RRGGBB color`);
    return null;
  }
  return value;
}

function readBrushSize(value: unknown, path: string, errors: string[]): number | null {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 64) {
    errors.push(`${path} must be an integer from 1 to 64`);
    return null;
  }
  return value as number;
}

function readPath(
  value: UnknownRecord,
  path: string,
  errors: string[],
): { points: Point[]; tValues: number[]; semanticId: string } | null {
  const points: Point[] = [];
  if (!Array.isArray(value.points) || value.points.length < 2) {
    errors.push(`${path}.points must contain at least 2 points`);
  } else {
    value.points.forEach((point, pointIndex) => {
      const pointPath = `${path}.points[${pointIndex}]`;
      if (!isRecord(point)) {
        errors.push(`${pointPath} must be an object`);
        return;
      }
      requireExactKeys(point, ["x", "y"], ["x", "y"], pointPath, errors);
      const x = point.x;
      const y = point.y;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > CANVAS_WIDTH) {
        errors.push(`${pointPath}.x must be a finite number from 0 to ${CANVAS_WIDTH}`);
      }
      if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > CANVAS_HEIGHT) {
        errors.push(`${pointPath}.y must be a finite number from 0 to ${CANVAS_HEIGHT}`);
      }
      if (
        typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= CANVAS_WIDTH &&
        typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= CANVAS_HEIGHT
      ) {
        points.push({ x, y });
      }
    });
  }

  const tValues: number[] = [];
  if (!Array.isArray(value.tValues)) {
    errors.push(`${path}.tValues must be an array`);
  } else {
    if (Array.isArray(value.points) && value.tValues.length !== value.points.length) {
      errors.push(`${path}.points and ${path}.tValues must have equal lengths`);
    }
    value.tValues.forEach((entry, index) => {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
        errors.push(`${path}.tValues[${index}] must be a finite number from 0 to 1`);
      } else {
        tValues.push(entry);
      }
    });
    if (value.tValues.length >= 2) {
      if (value.tValues[0] !== 0) errors.push(`${path}.tValues must start at 0`);
      if (value.tValues.at(-1) !== 1) errors.push(`${path}.tValues must end at 1`);
      for (let index = 1; index < value.tValues.length; index += 1) {
        if (
          typeof value.tValues[index - 1] === "number" &&
          typeof value.tValues[index] === "number" &&
          (value.tValues[index] as number) <= (value.tValues[index - 1] as number)
        ) {
          errors.push(`${path}.tValues must be strictly increasing`);
          break;
        }
      }
    }
  }

  const semanticId = value.semanticId;
  if (typeof semanticId !== "string" || !SEMANTIC_ID.test(semanticId)) {
    errors.push(`${path}.semanticId must match ${SEMANTIC_ID}`);
  }

  if (errors.some((error) => error.startsWith(path))) return null;
  return { points, tValues, semanticId: semanticId as string };
}

function readOperation(value: unknown, index: number, errors: string[]): DrawingOperation | null {
  const path = `operations[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (typeof value.type !== "string" || !OPERATION_TYPES.has(value.type)) {
    errors.push(`${path}.type is not a supported operation`);
    return null;
  }

  switch (value.type) {
    case "select_tool": {
      requireExactKeys(value, ["type", "tool"], ["type", "tool"], path, errors);
      if (typeof value.tool !== "string" || !TOOLS.has(value.tool)) {
        errors.push(`${path}.tool must be pencil, brush, graphite, watercolor, marker, or eraser`);
        return null;
      }
      return { type: "select_tool", tool: value.tool as DrawingTool };
    }
    case "set_color": {
      requireExactKeys(value, ["type", "color"], ["type", "color"], path, errors);
      const color = readColor(value.color, `${path}.color`, errors);
      return color ? { type: "set_color", color } : null;
    }
    case "set_brush_size": {
      requireExactKeys(value, ["type", "brushSize"], ["type", "brushSize"], path, errors);
      const brushSize = readBrushSize(value.brushSize, `${path}.brushSize`, errors);
      return brushSize ? { type: "set_brush_size", brushSize } : null;
    }
    case "stroke": {
      requireExactKeys(
        value,
        ["type", "points", "tValues", "semanticId", "tool", "color", "brushSize"],
        ["type", "points", "tValues", "semanticId", "tool", "color", "brushSize"],
        path,
        errors,
      );
      const geometry = readPath(value, path, errors);
      const color = readColor(value.color, `${path}.color`, errors);
      const brushSize = readBrushSize(value.brushSize, `${path}.brushSize`, errors);
      if (!isStrokeTool(value.tool)) {
        errors.push(`${path}.tool must be pencil, brush, graphite, watercolor, or marker`);
      }
      if (!geometry || !color || !brushSize || !isStrokeTool(value.tool)) {
        return null;
      }
      return { type: "stroke", ...geometry, tool: value.tool, color, brushSize } as StrokeOperation;
    }
    case "erase": {
      requireExactKeys(
        value,
        ["type", "points", "tValues", "semanticId", "tool", "brushSize"],
        ["type", "points", "tValues", "semanticId", "tool", "brushSize"],
        path,
        errors,
      );
      const geometry = readPath(value, path, errors);
      const brushSize = readBrushSize(value.brushSize, `${path}.brushSize`, errors);
      if (value.tool !== "eraser") errors.push(`${path}.tool must be eraser`);
      if (!geometry || !brushSize || value.tool !== "eraser") return null;
      return { type: "erase", ...geometry, tool: "eraser", brushSize } as EraseOperation;
    }
    case "undo":
    case "redo":
    case "complete":
      requireExactKeys(value, ["type"], ["type"], path, errors);
      return { type: value.type };
  }
  errors.push(`${path}.type is not a supported operation`);
  return null;
}

export function validatePayload(input: unknown): ValidationResult<AgentDrawingPayload> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["payload must be an object"] };
  requireExactKeys(
    input,
    ["schemaVersion", "documentAction", "documentId", "title", "operations"],
    ["schemaVersion", "documentAction", "operations"],
    "payload",
    errors,
  );
  if (input.schemaVersion !== "0.1") errors.push("payload.schemaVersion must be 0.1");
  if (input.documentAction !== "new_drawing" && input.documentAction !== "continue_current") {
    errors.push("payload.documentAction must be new_drawing or continue_current");
  }
  if (input.documentAction === "continue_current") {
    if (typeof input.documentId !== "string" || input.documentId.length < 1 || input.documentId.length > 120) {
      errors.push("payload.documentId is required for continue_current");
    }
    if ("title" in input) errors.push("payload.title is not allowed for continue_current");
  }
  if (input.documentAction === "new_drawing" && "documentId" in input) {
    errors.push("payload.documentId is not allowed for new_drawing");
  }
  if ("title" in input && (typeof input.title !== "string" || input.title.length < 1 || input.title.length > 80)) {
    errors.push("payload.title must be 1 to 80 characters");
  }
  const operations: DrawingOperation[] = [];
  if (!Array.isArray(input.operations)) {
    errors.push("payload.operations must be an array");
  } else {
    if (input.operations.length > DRAWING_LIMITS.operations) {
      errors.push(`payload.operations exceeds ${DRAWING_LIMITS.operations}`);
    }
    input.operations.forEach((operation, index) => {
      const parsed = readOperation(operation, index, errors);
      if (parsed) operations.push(parsed);
    });
    const completeIndex = input.operations.findIndex(
      (operation) => isRecord(operation) && operation.type === "complete",
    );
    if (completeIndex >= 0 && completeIndex !== input.operations.length - 1) {
      errors.push("complete must be the final operation");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: "0.1",
      documentAction: input.documentAction as AgentDrawingPayload["documentAction"],
      ...(typeof input.documentId === "string" ? { documentId: input.documentId } : {}),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      operations,
    },
  };
}

const countPoints = (operations: DrawingOperation[]) =>
  operations.reduce(
    (total, operation) =>
      total + (operation.type === "stroke" || operation.type === "erase" ? operation.points.length : 0),
    0,
  );

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function applyPayload(
  payloadInput: unknown,
  currentDocument?: DrawingDocument,
  options: { id?: string; now?: string } = {},
): ValidationResult<DrawingDocument> {
  const validation = validatePayload(payloadInput);
  if (!validation.ok) return validation;
  const payload = validation.value;
  const now = options.now ?? new Date().toISOString();

  if (payload.documentAction === "continue_current") {
    if (!currentDocument || currentDocument.id !== payload.documentId) {
      return { ok: false, errors: ["continue_current documentId does not match the current document"] };
    }
    if (currentDocument.status !== "active") {
      return { ok: false, errors: ["completed documents cannot be continued"] };
    }
  }

  const baseOperations = payload.documentAction === "continue_current" ? currentDocument!.operations : [];
  const operations = [...baseOperations, ...payload.operations];
  if (operations.length > DRAWING_LIMITS.operations) {
    return { ok: false, errors: [`document exceeds ${DRAWING_LIMITS.operations} operations`] };
  }
  const points = countPoints(operations);
  if (points > DRAWING_LIMITS.points) {
    return { ok: false, errors: [`document exceeds ${DRAWING_LIMITS.points} points`] };
  }

  try {
    reduceOperations(operations);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "semantic validation failed"] };
  }

  const id = payload.documentAction === "continue_current"
    ? currentDocument!.id
    : options.id ?? crypto.randomUUID();
  const createdAt = payload.documentAction === "continue_current" ? currentDocument!.createdAt : now;
  const from = baseOperations.length;
  const reachesStructuralLimit =
    operations.length === DRAWING_LIMITS.operations || points === DRAWING_LIMITS.points;
  const containsComplete = operations.some((operation) => operation.type === "complete");
  let document: DrawingDocument = {
    id,
    title: payload.documentAction === "continue_current"
      ? currentDocument!.title
      : payload.title ?? "Untitled drawing",
    status: containsComplete || reachesStructuralLimit ? "completed" : "active",
    canvas: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      background: DEFAULT_BACKGROUND,
    },
    operations,
    currentRevision: operations.length,
    latestPlaybackRange: { from, to: operations.length },
    createdAt,
    updatedAt: now,
  };
  if (document.status === "active") {
    const sealedDocument = { ...document, status: "completed" as const };
    const sealedBytes = byteLength(sealedDocument);
    if (sealedBytes > DRAWING_LIMITS.serializedBytes) {
      return { ok: false, errors: [`document exceeds ${DRAWING_LIMITS.serializedBytes} serialized bytes`] };
    }
    if (sealedBytes === DRAWING_LIMITS.serializedBytes) document = sealedDocument;
  } else if (byteLength(document) > DRAWING_LIMITS.serializedBytes) {
    return { ok: false, errors: [`document exceeds ${DRAWING_LIMITS.serializedBytes} serialized bytes`] };
  }
  return { ok: true, value: document };
}

export function validateStoredDocument(input: unknown): ValidationResult<DrawingDocument> {
  if (!isRecord(input)) return { ok: false, errors: ["stored document must be an object"] };
  const required = [
    "id", "title", "status", "canvas", "operations", "currentRevision",
    "latestPlaybackRange", "createdAt", "updatedAt",
  ];
  const errors: string[] = [];
  requireExactKeys(input, required, required, "document", errors);
  if (
    typeof input.id !== "string" || input.id.length < 1 || input.id.length > 120 ||
    typeof input.title !== "string" || input.title.length < 1 || input.title.length > 80
  ) errors.push("document identity is invalid");
  if (input.status !== "active" && input.status !== "completed") errors.push("document.status is invalid");
  if (!isRecord(input.canvas)) {
    errors.push("document.canvas must be the canonical 1000x750 canvas");
  } else {
    requireExactKeys(
      input.canvas,
      ["width", "height", "background"],
      ["width", "height", "background"],
      "document.canvas",
      errors,
    );
    if (
      input.canvas.width !== CANVAS_WIDTH || input.canvas.height !== CANVAS_HEIGHT ||
      typeof input.canvas.background !== "string" || !HEX_COLOR.test(input.canvas.background)
    ) errors.push("document.canvas must be the canonical 1000x750 canvas");
  }
  if (!Array.isArray(input.operations)) errors.push("document.operations must be an array");
  if (!Number.isInteger(input.currentRevision) || input.currentRevision !== (Array.isArray(input.operations) ? input.operations.length : -1)) {
    errors.push("document.currentRevision must equal operations.length");
  }
  if (!isRecord(input.latestPlaybackRange)) {
    errors.push("document.latestPlaybackRange is invalid");
  } else {
    requireExactKeys(
      input.latestPlaybackRange,
      ["from", "to"],
      ["from", "to"],
      "document.latestPlaybackRange",
      errors,
    );
  }
  if (
    typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt)) ||
    typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))
  ) errors.push("document timestamps are invalid");
  if (errors.length > 0) return { ok: false, errors };

  const payload = validatePayload({
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: input.title,
    operations: input.operations,
  });
  if (!payload.ok) return payload;
  let completedByHistory = false;
  try {
    completedByHistory = reduceOperations(payload.value.operations).completed;
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "stored document is invalid"] };
  }
  if (byteLength(input) > DRAWING_LIMITS.serializedBytes || countPoints(payload.value.operations) > DRAWING_LIMITS.points) {
    return { ok: false, errors: ["stored document exceeds canonical limits"] };
  }
  const range = input.latestPlaybackRange as UnknownRecord;
  if (
    !Number.isInteger(range.from) || !Number.isInteger(range.to) ||
    (range.from as number) < 0 || (range.to as number) < (range.from as number) ||
    (range.to as number) > payload.value.operations.length
  ) {
    return { ok: false, errors: ["document.latestPlaybackRange is out of bounds"] };
  }
  const isAtLimit =
    payload.value.operations.length === DRAWING_LIMITS.operations ||
    countPoints(payload.value.operations) === DRAWING_LIMITS.points ||
    byteLength(input) === DRAWING_LIMITS.serializedBytes;
  if ((completedByHistory || isAtLimit) !== (input.status === "completed")) {
    return { ok: false, errors: ["document.status does not match its canonical history"] };
  }
  return { ok: true, value: input as unknown as DrawingDocument };
}
