export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 750;
export const DEFAULT_BACKGROUND = "#FFF9ED";

export const DRAWING_LIMITS = {
  operations: 1500,
  points: 60_000,
  serializedBytes: 2 * 1024 * 1024,
} as const;

export type DrawingTool = "pencil" | "brush" | "eraser";

export type Point = {
  x: number;
  y: number;
};

export type SelectToolOperation = {
  type: "select_tool";
  tool: DrawingTool;
};

export type SetColorOperation = {
  type: "set_color";
  color: string;
};

export type SetBrushSizeOperation = {
  type: "set_brush_size";
  brushSize: number;
};

export type StrokeOperation = {
  type: "stroke";
  points: Point[];
  tValues: number[];
  semanticId: string;
  tool: "pencil" | "brush";
  color: string;
  brushSize: number;
};

export type EraseOperation = {
  type: "erase";
  points: Point[];
  tValues: number[];
  semanticId: string;
  tool: "eraser";
  brushSize: number;
};

export type UndoOperation = { type: "undo" };
export type RedoOperation = { type: "redo" };
export type CompleteOperation = { type: "complete" };

export type DrawingOperation =
  | SelectToolOperation
  | SetColorOperation
  | SetBrushSizeOperation
  | StrokeOperation
  | EraseOperation
  | UndoOperation
  | RedoOperation
  | CompleteOperation;

export type AgentDrawingPayload = {
  schemaVersion: "0.1";
  documentAction: "new_drawing" | "continue_current";
  documentId?: string;
  title?: string;
  operations: DrawingOperation[];
};

export type DrawingDocument = {
  id: string;
  title: string;
  status: "active" | "completed";
  canvas: {
    width: typeof CANVAS_WIDTH;
    height: typeof CANVAS_HEIGHT;
    background: string;
  };
  operations: DrawingOperation[];
  currentRevision: number;
  latestPlaybackRange: {
    from: number;
    to: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };
