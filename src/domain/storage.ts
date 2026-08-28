import type { DrawingDocument } from "./types.js";
import { validateStoredDocument } from "./validation.js";

export type DrawingLibrary = {
  currentId: string | null;
  documents: DrawingDocument[];
};

export interface DrawingRepository {
  load(): DrawingLibrary | null;
  save(library: DrawingLibrary): void;
}

const STORAGE_KEY = "drawing-lab:v1a:library";

export function normalizeDrawingLibrary(library: DrawingLibrary): DrawingLibrary {
  const documents: DrawingDocument[] = [];
  const indexById = new Map<string, number>();

  for (const document of library.documents) {
    const existingIndex = indexById.get(document.id);
    if (existingIndex === undefined) {
      indexById.set(document.id, documents.length);
      documents.push(document);
      continue;
    }
    if (document.currentRevision > documents[existingIndex].currentRevision) {
      documents[existingIndex] = document;
    }
  }

  return { currentId: library.currentId, documents };
}

export function upsertDrawingDocument(
  library: DrawingLibrary,
  document: DrawingDocument,
): DrawingLibrary {
  return normalizeDrawingLibrary({
    currentId: document.id,
    documents: [document, ...library.documents],
  });
}

export function removeDrawingDocument(
  library: DrawingLibrary,
  documentId: string,
): DrawingLibrary {
  const documents = library.documents.filter((document) => document.id !== documentId);
  return {
    currentId: library.currentId === documentId ? documents[0]?.id ?? null : library.currentId,
    documents,
  };
}

export class LocalDrawingRepository implements DrawingRepository {
  load(): DrawingLibrary | null {
    const serialized = window.localStorage.getItem(STORAGE_KEY);
    if (!serialized) return null;
    try {
      const input: unknown = JSON.parse(serialized);
      if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
      const record = input as Record<string, unknown>;
      if (
        Object.keys(record).some((key) => key !== "currentId" && key !== "documents") ||
        !(record.currentId === null || typeof record.currentId === "string") ||
        !Array.isArray(record.documents)
      ) {
        return null;
      }
      const documents: DrawingDocument[] = [];
      for (const document of record.documents) {
        const validation = validateStoredDocument(document);
        if (!validation.ok) return null;
        documents.push(validation.value);
      }
      if (
        record.currentId !== null &&
        !documents.some((document) => document.id === record.currentId)
      ) {
        return null;
      }
      return normalizeDrawingLibrary({ currentId: record.currentId, documents });
    } catch {
      return null;
    }
  }

  save(library: DrawingLibrary) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeDrawingLibrary(library)));
  }
}
