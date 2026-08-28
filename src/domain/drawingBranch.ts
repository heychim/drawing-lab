import type {
  DrawingDocument,
  DrawingOperation,
  ValidationResult,
} from "./types.js";
import { applyPayload, validateStoredDocument } from "./validation.js";

export type DrawingBranchInput = {
  title: string;
  operations: DrawingOperation[];
};

export type DrawingBranchOptions = {
  id?: string;
  now?: string;
};

export function createDrawingBranch(
  sourceInput: unknown,
  input: DrawingBranchInput,
  options: DrawingBranchOptions = {},
): ValidationResult<DrawingDocument> {
  const sourceValidation = validateStoredDocument(sourceInput);
  if (!sourceValidation.ok) return sourceValidation;
  const source = sourceValidation.value;
  const baseOperations = source.operations.at(-1)?.type === "complete"
    ? source.operations.slice(0, -1)
    : [...source.operations];

  const base = applyPayload({
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: input.title,
    operations: baseOperations,
  }, undefined, options);
  if (!base.ok) return base;

  return applyPayload({
    schemaVersion: "0.1",
    documentAction: "continue_current",
    documentId: base.value.id,
    operations: input.operations,
  }, base.value, options);
}
