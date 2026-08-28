import {
  createInitialEngineState,
  deriveDocumentState,
  reduceOperations,
  type EngineState,
} from "./engine.js";
import type { PlaybackFrame } from "./playback.js";
import type { DrawingDocument } from "./types.js";

export function hasReplayableLatestRange(document: DrawingDocument) {
  const { from, to } = document.latestPlaybackRange;
  return from > 0 && from < to && to === document.operations.length;
}

export function createReadyPlaybackFrame(
  document: DrawingDocument,
  engine: EngineState = deriveDocumentState(document),
): PlaybackFrame {
  return {
    engine,
    status: "ready",
    operationIndex: document.operations.length - 1,
    transient: null,
    actionPulse: null,
  };
}

export function createStartingPlaybackFrame(
  document: DrawingDocument,
  mode: "latest" | "full",
): PlaybackFrame {
  const from = mode === "full" ? 0 : document.latestPlaybackRange.from;
  return {
    engine: reduceOperations(
      document.operations.slice(0, from),
      createInitialEngineState(),
      0,
      false,
    ),
    status: "playing",
    operationIndex: from - 1,
    transient: null,
    actionPulse: null,
  };
}
