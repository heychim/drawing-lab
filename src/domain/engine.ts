import type {
  DrawingDocument,
  DrawingOperation,
  DrawingTool,
  EraseOperation,
  StrokeOperation,
} from "./types.js";

export type DrawableOperation = StrokeOperation | EraseOperation;

export type DrawableEntry = {
  operationIndex: number;
  operation: DrawableOperation;
  active: boolean;
};

export type EngineState = {
  tool: DrawingTool;
  color: string;
  brushSize: number;
  drawables: DrawableEntry[];
  redoStack: number[];
  completed: boolean;
};

export const createInitialEngineState = (): EngineState => ({
  tool: "pencil",
  color: "#6B4F4F",
  brushSize: 3,
  drawables: [],
  redoStack: [],
  completed: false,
});

const semanticError = (message: string, operationIndex: number) =>
  new Error(`operations[${operationIndex}]: ${message}`);

export function applyOperation(
  state: EngineState,
  operation: DrawingOperation,
  operationIndex: number,
  strict = true,
): EngineState {
  if (state.completed && strict) {
    throw semanticError("operations cannot follow complete", operationIndex);
  }

  switch (operation.type) {
    case "select_tool":
      return { ...state, tool: operation.tool };
    case "set_color":
      return { ...state, color: operation.color };
    case "set_brush_size":
      return { ...state, brushSize: operation.brushSize };
    case "stroke": {
      if (strict && state.tool !== operation.tool) {
        throw semanticError(
          `stroke tool ${operation.tool} does not match selected tool ${state.tool}`,
          operationIndex,
        );
      }
      if (strict && state.color !== operation.color) {
        throw semanticError(
          `stroke color ${operation.color} does not match current color ${state.color}`,
          operationIndex,
        );
      }
      if (strict && state.brushSize !== operation.brushSize) {
        throw semanticError(
          `stroke brushSize ${operation.brushSize} does not match current brushSize ${state.brushSize}`,
          operationIndex,
        );
      }
      return {
        ...state,
        drawables: [
          ...state.drawables,
          { operationIndex, operation, active: true },
        ],
        redoStack: [],
      };
    }
    case "erase": {
      if (strict && state.tool !== "eraser") {
        throw semanticError("erase requires the eraser tool to be selected", operationIndex);
      }
      if (strict && state.brushSize !== operation.brushSize) {
        throw semanticError(
          `erase brushSize ${operation.brushSize} does not match current brushSize ${state.brushSize}`,
          operationIndex,
        );
      }
      return {
        ...state,
        drawables: [
          ...state.drawables,
          { operationIndex, operation, active: true },
        ],
        redoStack: [],
      };
    }
    case "undo": {
      const target = [...state.drawables].reverse().find((entry) => entry.active);
      if (!target) {
        if (strict) throw semanticError("nothing is available to undo", operationIndex);
        return state;
      }
      return {
        ...state,
        drawables: state.drawables.map((entry) =>
          entry.operationIndex === target.operationIndex
            ? { ...entry, active: false }
            : entry,
        ),
        redoStack: [...state.redoStack, target.operationIndex],
      };
    }
    case "redo": {
      const targetIndex = state.redoStack.at(-1);
      if (targetIndex === undefined) {
        if (strict) throw semanticError("nothing is available to redo", operationIndex);
        return state;
      }
      return {
        ...state,
        drawables: state.drawables.map((entry) =>
          entry.operationIndex === targetIndex ? { ...entry, active: true } : entry,
        ),
        redoStack: state.redoStack.slice(0, -1),
      };
    }
    case "complete":
      return { ...state, completed: true };
  }
}

export function reduceOperations(
  operations: DrawingOperation[],
  initialState = createInitialEngineState(),
  startIndex = 0,
  strict = true,
): EngineState {
  return operations.reduce(
    (state, operation, index) =>
      applyOperation(state, operation, startIndex + index, strict),
    initialState,
  );
}

export function deriveDocumentState(document: DrawingDocument): EngineState {
  return reduceOperations(document.operations, createInitialEngineState(), 0, false);
}
