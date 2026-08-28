import { DRAWING_LIMITS, type DrawingDocument } from "./types.js";

export const AGENT_CONTEXT_SEMANTIC_ID_LIMIT = 64;

export type AgentSemanticIndexEntry = {
  semanticId: string;
  operationIndex: number;
  operationType: "stroke" | "erase";
};

export type AgentContext = {
  drawingId: string;
  status: DrawingDocument["status"];
  canvas: DrawingDocument["canvas"];
  operationCount: number;
  semanticIndex: {
    entries: AgentSemanticIndexEntry[];
    totalUnique: number;
    truncated: boolean;
  };
  remainingOperationsBudget: number;
  remainingPointsBudget: number;
  remainingCoreByteBudget: number;
};

function countPoints(document: DrawingDocument) {
  return document.operations.reduce(
    (total, operation) => total +
      (operation.type === "stroke" || operation.type === "erase" ? operation.points.length : 0),
    0,
  );
}

function canonicalByteLength(document: DrawingDocument) {
  return new TextEncoder().encode(JSON.stringify(document)).length;
}

export function createAgentContext(document: DrawingDocument): AgentContext {
  const latestBySemanticId = new Map<string, AgentSemanticIndexEntry>();
  document.operations.forEach((operation, operationIndex) => {
    if (operation.type !== "stroke" && operation.type !== "erase") return;
    latestBySemanticId.set(operation.semanticId, {
      semanticId: operation.semanticId,
      operationIndex,
      operationType: operation.type,
    });
  });
  const allEntries = [...latestBySemanticId.values()]
    .sort((left, right) => right.operationIndex - left.operationIndex);
  const canContinue = document.status === "active";

  return {
    drawingId: document.id,
    status: document.status,
    canvas: { ...document.canvas },
    operationCount: document.operations.length,
    semanticIndex: {
      entries: allEntries.slice(0, AGENT_CONTEXT_SEMANTIC_ID_LIMIT),
      totalUnique: allEntries.length,
      truncated: allEntries.length > AGENT_CONTEXT_SEMANTIC_ID_LIMIT,
    },
    remainingOperationsBudget: canContinue
      ? Math.max(0, DRAWING_LIMITS.operations - document.operations.length)
      : 0,
    remainingPointsBudget: canContinue
      ? Math.max(0, DRAWING_LIMITS.points - countPoints(document))
      : 0,
    remainingCoreByteBudget: canContinue
      ? Math.max(0, DRAWING_LIMITS.serializedBytes - canonicalByteLength(document))
      : 0,
  };
}
