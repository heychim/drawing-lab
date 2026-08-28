import { readFileSync } from "node:fs";
import {
  CHECKPOINT_INTERVAL,
  CHECKPOINT_VERSION,
  RenderCheckpointCache,
  createRenderCheckpoints,
  restoreDocumentState,
  type RenderCheckpoint,
} from "../src/domain/checkpoints.js";
import {
  AGENT_CONTEXT_SEMANTIC_ID_LIMIT,
  createAgentContext,
} from "../src/domain/agentContext.js";
import { deriveDocumentState } from "../src/domain/engine.js";
import {
  DRAWING_FRAGMENT_PREFIX,
  createFragmentResult,
  decodeDrawingFragment,
} from "../src/domain/fragmentHandoff.js";
import {
  HOSTED_HANDOFF_CANONICAL_BYTES,
  canonicalDocumentByteLength,
  getHostedHandoffEligibility,
} from "../src/domain/hostedPolicy.js";
import {
  InMemoryRelayClient,
  RelayClientError,
  type RelayClient,
} from "../src/domain/relayClient.js";
import {
  decryptRelayDrawingDocument,
  encryptDrawingDocumentForRelay,
} from "../src/domain/relayCrypto.js";
import {
  RELAY_AES_ALGORITHM,
  RELAY_CIPHERTEXT_HARD_CAP_BYTES,
  RELAY_COMPRESSION,
  RELAY_ENVELOPE_VERSION,
  RELAY_REQUEST_HARD_CAP_BYTES,
  RELAY_TTL_MS,
  base64UrlToBytes,
  bytesToBase64Url,
  validateRelayEnvelope,
  type RelayCiphertextEnvelope,
} from "../src/domain/relayEnvelope.js";
import {
  createEncryptedRelayResult,
  parseRelayResultUrl,
  restoreEncryptedRelayResult,
} from "../src/domain/relayHandoff.js";
import { createRelayWorker } from "../src/domain/relayWorker.js";
import { playDocument, type PlaybackFrame } from "../src/domain/playback.js";
import {
  createStartingPlaybackFrame,
  createReadyPlaybackFrame,
  hasReplayableLatestRange,
} from "../src/domain/playbackControls.js";
import {
  LocalDrawingRepository,
  normalizeDrawingLibrary,
  removeDrawingDocument,
  type DrawingLibrary,
  upsertDrawingDocument,
} from "../src/domain/storage.js";
import { createDrawingBranch } from "../src/domain/drawingBranch.js";
import {
  DRAWING_LIMITS,
  type AgentDrawingPayload,
  type DrawingDocument,
  type DrawingOperation,
} from "../src/domain/types.js";
import { applyPayload, validatePayload, validateStoredDocument } from "../src/domain/validation.js";
import { commandsAtProgress, createDerivedPath } from "../src/renderer/curvePath.js";
import { createMemoryWorkerEnvironment } from "./relay-worker-mock.js";

import { runMcpTests } from "./mcp-tests.js";
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
}

function expectRejected(input: unknown, errorFragment: string) {
  const result = validatePayload(input);
  assert(!result.ok, `expected rejection containing ${errorFragment}`);
  assert(
    !result.ok && result.errors.some((error) => error.includes(errorFragment)),
    `missing validation error: ${errorFragment}`,
  );
}

const baseOperations: AgentDrawingPayload["operations"] = [
  { type: "select_tool", tool: "pencil" },
  { type: "set_color", color: "#6B4F4F" },
  { type: "set_brush_size", brushSize: 8 },
  {
    type: "stroke",
    semanticId: "test_line",
    tool: "pencil",
    color: "#6B4F4F",
    brushSize: 8,
    points: [{ x: 20, y: 30 }, { x: 80, y: 90 }],
    tValues: [0, 1],
  },
];

const validPayload: AgentDrawingPayload = {
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Validator fixture",
  operations: baseOperations,
};

const created = applyPayload(validPayload, undefined, {
  id: "test-document",
  now: "2026-08-26T00:00:00.000Z",
});
assert(created.ok, "valid payload creates a document");
assert(created.ok && created.value.canvas.width === 1000 && created.value.canvas.height === 750, "canonical canvas is 1000x750");
assert(created.ok && !hasReplayableLatestRange(created.value), "a new drawing range starting at zero is not presented as Latest Replay");

if (created.ok) {
  const canonicalBeforeRendering = JSON.stringify(created.value);
  const canonicalStroke = created.value.operations.find((operation) => operation.type === "stroke");
  assert(canonicalStroke?.type === "stroke", "renderer fixture contains a canonical stroke");
  if (canonicalStroke?.type === "stroke") {
    const derived = createDerivedPath(canonicalStroke.points, canonicalStroke.tValues);
    commandsAtProgress(derived, 0.5);
  }
  assert(JSON.stringify(created.value) === canonicalBeforeRendering, "derived rendering does not mutate DrawingDocument canonical data");
}

const curvePoints = [
  { x: 40, y: 120 },
  { x: 130, y: 45 },
  { x: 230, y: 155 },
  { x: 340, y: 80 },
];
const curveTValues = [0, 0.28, 0.68, 1];
const curveInputSnapshot = JSON.stringify({ points: curvePoints, tValues: curveTValues });
const curvedPath = createDerivedPath(curvePoints, curveTValues);
assert(curvedPath.interpolation === "bezier", "three or more valid points produce cubic Bezier segments");
assert(curvedPath.segments.length === curvePoints.length - 1, "Bezier interpreter preserves every sampled point boundary");
assert(JSON.stringify({ points: curvePoints, tValues: curveTValues }) === curveInputSnapshot, "curve fitting leaves input points and tValues unchanged");

const partialCurve = commandsAtProgress(curvedPath, 0.42);
const fullCurve = commandsAtProgress(curvedPath, 1);
const partialEnd = partialCurve.at(-1)?.point;
const fullEnd = fullCurve.at(-1)?.point;
assert(partialCurve.some((command) => command.type === "cubic"), "partial replay renders a cubic prefix");
assert(
  partialEnd !== undefined && fullEnd !== undefined &&
  (partialEnd.x !== fullEnd.x || partialEnd.y !== fullEnd.y),
  "partial replay does not reveal the full curve instantly",
);

const fallbackPath = createDerivedPath(curvePoints, [0, 0.5, 1]);
assert(fallbackPath.interpolation === "polyline", "curve fitting failure falls back to polyline");
assert(fallbackPath.fallbackReason?.includes("lengths differ"), "polyline fallback exposes a concrete reason");
assert(fallbackPath.segments.every((segment) => segment.type === "line"), "fallback retains drawable line segments");

const eraseDerivedPath = createDerivedPath(curvePoints, curveTValues);
assert(eraseDerivedPath.interpolation === "bezier", "erase geometry can use the same derived curve path as stroke");

expectRejected({
  ...validPayload,
  operations: [{ ...baseOperations[3], tValues: [0] }],
}, "equal lengths");

expectRejected({
  ...validPayload,
  operations: [{ ...baseOperations[3], points: [{ x: -1, y: 30 }, { x: 80, y: 90 }] }],
}, "from 0 to 1000");

expectRejected({
  ...validPayload,
  operations: [{ type: "teleport", x: 5 }],
}, "not a supported operation");

expectRejected({
  ...validPayload,
  operations: [{ ...baseOperations[3], html: "<script />" }],
}, "is not allowed");

const current = created.ok ? created.value : undefined;
const snapshot = JSON.stringify(current);
const invalidContinue = applyPayload({
  schemaVersion: "0.1",
  documentAction: "continue_current",
  documentId: "test-document",
  operations: [{ type: "undo", unexpected: true }],
}, current);
assert(!invalidContinue.ok, "invalid continue batch is rejected");
assert(JSON.stringify(current) === snapshot, "rejected continue batch leaves the existing document unchanged");

const continued = applyPayload({
  schemaVersion: "0.1",
  documentAction: "continue_current",
  documentId: "test-document",
  operations: [{ type: "undo" }, { type: "redo" }],
}, current, { now: "2026-08-26T00:01:00.000Z" });
assert(continued.ok, "continue_current appends to the same document");
assert(continued.ok && continued.value.latestPlaybackRange.from === baseOperations.length, "latest playback range starts at the append boundary");
assert(continued.ok && deriveDocumentState(continued.value).drawables[0].active, "redo restores the undone stroke");

const impossibleUndo = applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  operations: [{ type: "undo" }],
});
assert(!impossibleUndo.ok, "undo with no drawable history fails semantic validation");

const wrongTool = applyPayload({
  ...validPayload,
  operations: [{ ...baseOperations[3], tool: "brush" }],
});
assert(!wrongTool.ok, "stroke tool must match selected tool state");

const completed = applyPayload({
  ...validPayload,
  operations: [...baseOperations, { type: "complete" }],
}, undefined, { id: "completed-document" });
assert(completed.ok && completed.value.status === "completed", "complete closes a document");
const continueCompleted = applyPayload({
  schemaVersion: "0.1",
  documentAction: "continue_current",
  documentId: "completed-document",
  operations: [],
}, completed.ok ? completed.value : undefined);
assert(!continueCompleted.ok, "completed documents cannot be continued");

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem(key: string) { return memory.get(key) ?? null; },
      setItem(key: string, value: string) { memory.set(key, value); },
    },
    setTimeout(callback: () => void) { callback(); return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback: FrameRequestCallback) {
      callback(performance.now() + 1000);
      return 1;
    },
  },
});

const replayStatePayload: AgentDrawingPayload = {
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Replay state synchronization",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#F08FA8" },
    { type: "set_brush_size", brushSize: 8 },
    {
      type: "stroke",
      semanticId: "replay-state-pencil",
      tool: "pencil",
      color: "#F08FA8",
      brushSize: 8,
      points: [{ x: 100, y: 120 }, { x: 220, y: 180 }],
      tValues: [0, 1],
    },
    { type: "set_color", color: "#83BBD2" },
    { type: "select_tool", tool: "brush" },
    { type: "set_brush_size", brushSize: 20 },
    {
      type: "stroke",
      semanticId: "replay-state-brush-blue",
      tool: "brush",
      color: "#83BBD2",
      brushSize: 20,
      points: [{ x: 280, y: 220 }, { x: 410, y: 300 }],
      tValues: [0, 1],
    },
    { type: "set_color", color: "#6FAE78" },
    {
      type: "stroke",
      semanticId: "replay-state-brush-green",
      tool: "brush",
      color: "#6FAE78",
      brushSize: 20,
      points: [{ x: 470, y: 340 }, { x: 620, y: 420 }],
      tValues: [0, 1],
    },
    { type: "complete" },
  ],
};
const replayStateDocument = applyPayload(replayStatePayload, undefined, {
  id: "replay-state-document",
  now: "2026-08-28T03:00:00.000Z",
});
assert(replayStateDocument.ok, "replay UI state fixture passes canonical validation");
if (!replayStateDocument.ok) throw new Error("FAIL: replay UI state fixture was rejected");
const replayStateFrames: PlaybackFrame[] = [];
const replayStateSignal = {
  aborted: false,
  addEventListener() {},
} as unknown as AbortSignal;
await playDocument(
  replayStateDocument.value,
  "full",
  (playbackFrame) => replayStateFrames.push(playbackFrame),
  replayStateSignal,
);
const settledFrameAt = (operationIndex: number) => replayStateFrames.find(
  (playbackFrame) => playbackFrame.operationIndex === operationIndex && playbackFrame.transient === null,
);
assert(settledFrameAt(1)?.engine.color === "#F08FA8", "Replay exposes the first set_color state before the first stroke");
assert(settledFrameAt(2)?.engine.brushSize === 8, "Replay exposes the first set_brush_size state before the first stroke");
assert(settledFrameAt(4)?.engine.color === "#83BBD2", "Replay exposes the second set_color state in operation order");
assert(settledFrameAt(5)?.engine.tool === "brush", "Replay exposes the Pencil to Brush tool switch in operation order");
assert(settledFrameAt(6)?.engine.brushSize === 20, "Replay exposes the second set_brush_size state before the brush stroke");
assert(settledFrameAt(8)?.engine.color === "#6FAE78", "Replay exposes the third set_color state in operation order");
const transientFor = (semanticId: string) => replayStateFrames.find(
  (playbackFrame) => playbackFrame.transient?.operation.semanticId === semanticId,
);
const pencilTransient = transientFor("replay-state-pencil");
assert(
  pencilTransient?.engine.tool === "pencil" &&
    pencilTransient.engine.color === "#F08FA8" &&
    pencilTransient.engine.brushSize === 8,
  "first Canvas stroke is animated with the already-applied Pencil/color/size UI state",
);
const blueBrushTransient = transientFor("replay-state-brush-blue");
assert(
  blueBrushTransient?.engine.tool === "brush" &&
    blueBrushTransient.engine.color === "#83BBD2" &&
    blueBrushTransient.engine.brushSize === 20,
  "second Canvas stroke is animated with the already-applied Brush/color/size UI state",
);
const greenBrushTransient = transientFor("replay-state-brush-green");
assert(
  greenBrushTransient?.engine.tool === "brush" && greenBrushTransient.engine.color === "#6FAE78",
  "third Canvas stroke follows the third color change without predicting it early",
);
const replayStateFinal = deriveDocumentState(replayStateDocument.value);
assert(
  JSON.stringify(replayStateFrames.at(-1)?.engine) === JSON.stringify(replayStateFinal),
  "natural Full Replay leaves tool/color/brushSize at the canonical final EngineState",
);
assert(
  JSON.stringify(createReadyPlaybackFrame(replayStateDocument.value).engine) === JSON.stringify(replayStateFinal),
  "Skip synchronizes tool/color/brushSize directly to the canonical final EngineState",
);
const firstFullFrame = createStartingPlaybackFrame(replayStateDocument.value, "full");
assert(firstFullFrame.status === "playing", "the first Full Replay render exposes playing immediately");
assert(firstFullFrame.operationIndex === -1, "the first Full Replay starts before operation zero");
if (continued.ok) {
  const firstLatestFrame = createStartingPlaybackFrame(continued.value, "latest");
  assert(firstLatestFrame.status === "playing", "the first Latest Replay render exposes playing immediately");
  assert(
    firstLatestFrame.operationIndex === continued.value.latestPlaybackRange.from - 1,
    "the first Latest Replay starts at the real append boundary",
  );
}
for (let replayAttempt = 0; replayAttempt < 3; replayAttempt += 1) {
  const startingFrame = createStartingPlaybackFrame(replayStateDocument.value, "full");
  const skippedFrame = createReadyPlaybackFrame(replayStateDocument.value);
  assert(startingFrame.status === "playing", `Full Replay attempt ${replayAttempt + 1} exposes Skip immediately`);
  assert(
    JSON.stringify(skippedFrame.engine) === JSON.stringify(replayStateFinal),
    `Full Replay attempt ${replayAttempt + 1} Skip reaches the final EngineState`,
  );
}

const repository = new LocalDrawingRepository();
if (created.ok && continued.ok) {
  let library: DrawingLibrary = { currentId: created.value.id, documents: [created.value] };
  library = upsertDrawingDocument(library, created.value);
  library = upsertDrawingDocument(library, created.value);
  repository.save(library);
  assert(repository.load()?.documents.length === 1, "saving the same DrawingDocument three times keeps one local item");

  library = upsertDrawingDocument(library, continued.value);
  assert(library.documents.length === 1, "a higher revision updates the same local card instead of appending");
  assert(library.documents[0].currentRevision === continued.value.currentRevision, "same-id upsert retains the highest revision");
  repository.save(library);
  const restored = repository.load();
  assert(restored?.currentId === continued.value.id, "local repository restores the current document after refresh");
  assert(restored?.documents.length === 1, "refresh preserves the same-id deduplicated local library");

  const sameTitleA = applyPayload({ ...validPayload, title: "同名画作" }, undefined, { id: "same-title-a" });
  const sameTitleB = applyPayload({ ...validPayload, title: "同名画作" }, undefined, { id: "same-title-b" });
  assert(sameTitleA.ok && sameTitleB.ok, "same-title local fixtures validate");
  if (sameTitleA.ok && sameTitleB.ok) {
    const sameTitleLibrary = upsertDrawingDocument(
      upsertDrawingDocument({ currentId: null, documents: [] }, sameTitleA.value),
      sameTitleB.value,
    );
    assert(sameTitleLibrary.documents.length === 2, "different DrawingDocument ids with the same title stay separate");
    assert(
      sameTitleLibrary.documents.filter((document) => document.id === sameTitleLibrary.currentId).length === 1,
      "selected state resolves to exactly one current DrawingDocument id",
    );
    const afterSelectedDelete = removeDrawingDocument(sameTitleLibrary, sameTitleB.value.id);
    assert(afterSelectedDelete.currentId === sameTitleA.value.id, "deleting selected local item transfers currentId to the opened remaining work");
    assert(
      afterSelectedDelete.documents.filter((document) => document.id === afterSelectedDelete.currentId).length === 1,
      "selected highlight remains unique after deleting the current item",
    );
  }

  const completedSource = applyPayload({
    ...validPayload,
    title: "续画源作品",
    operations: [...baseOperations, { type: "complete" }],
  }, undefined, { id: "branch-source" });
  assert(completedSource.ok, "completed branch source validates");
  if (completedSource.ok) {
    const branch = createDrawingBranch(completedSource.value, {
      title: "续画分支",
      operations: [{ type: "set_color", color: "#F08FA8" }, { type: "complete" }],
    }, { id: "branch-result" });
    assert(branch.ok, "continued branch produces a separate valid DrawingDocument");
    if (branch.ok) {
      const branchLibrary = upsertDrawingDocument(
        upsertDrawingDocument({ currentId: null, documents: [] }, completedSource.value),
        branch.value,
      );
      assert(branchLibrary.documents.length === 2, "source A and continued branch B remain independent local works");
      assert(branch.value.id !== completedSource.value.id, "continued branch uses a new DrawingDocument id");
    }
  }

  const historicalDuplicates = normalizeDrawingLibrary({
    currentId: continued.value.id,
    documents: [created.value, continued.value],
  });
  assert(historicalDuplicates.documents.length === 1, "historical duplicate records with the same id are safely collapsed");
  assert(
    historicalDuplicates.documents[0].currentRevision === continued.value.currentRevision,
    "historical same-id cleanup keeps the highest revision",
  );

  const storageKey = [...memory.keys()][0];
  memory.set(storageKey, JSON.stringify({ currentId: continued.value.id, documents: [{ ...continued.value, injected: true }] }));
  assert(repository.load() === null, "corrupted local data fails closed");
}

const appCopy = readFileSync("src/App.tsx", "utf8");
assert(!/本土|译文|手写 JSON 示例/u.test(appCopy), "user-facing copy contains no known machine-translated labels");
assert(appCopy.includes("示例画作"), "sample drawer uses a natural Chinese product label");

expectRejected({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  operations: Array.from({ length: DRAWING_LIMITS.operations + 1 }, () => ({ type: "select_tool", tool: "pencil" })),
}, `exceeds ${DRAWING_LIMITS.operations}`);

const atOperationLimit = applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  operations: Array.from({ length: DRAWING_LIMITS.operations }, () => ({ type: "select_tool", tool: "pencil" })),
});
assert(atOperationLimit.ok && atOperationLimit.value.status === "completed", "reaching the operation limit seals the document");

const tooManyPointCount = DRAWING_LIMITS.points + 1;
const tooManyPoints = Array.from({ length: tooManyPointCount }, (_, index) => ({
  x: (index % 999) + 0.125,
  y: (index % 749) + 0.25,
}));
const tooManyTValues = Array.from({ length: tooManyPointCount }, (_, index) => index / (tooManyPointCount - 1));
const pointLimitResult = applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 3 },
    {
      type: "stroke",
      semanticId: "oversized_path",
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 3,
      points: tooManyPoints,
      tValues: tooManyTValues,
    },
  ],
});
assert(!pointLimitResult.ok && pointLimitResult.errors.some((error) => error.includes(`${DRAWING_LIMITS.points} points`)), "point limit rejects the whole payload");

const largePathLength = 50_000;
const largePoints = Array.from({ length: largePathLength }, (_, index) => ({
  x: 123.12345678901234 + (index % 2),
  y: 456.12345678901234 + (index % 2),
}));
const largeTValues = Array.from({ length: largePathLength }, (_, index) => index / (largePathLength - 1));
const serializedLimitResult = applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 3 },
    {
      type: "stroke",
      semanticId: "serialized_limit_path",
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 3,
      points: largePoints,
      tValues: largeTValues,
    },
  ],
});
assert(
  !serializedLimitResult.ok && serializedLimitResult.errors.some((error) => error.includes("serialized bytes")),
  "serialized 2 MB limit rejects the whole payload",
);

function readDrawingJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const codexThemes = [
  { path: "drawings/codex/current.drawing.json", id: "codex-sleeping-cat", title: "Codex · Sleepy Cat" },
  { path: "drawings/codex/nature-scene.drawing.json", id: "codex-sunny-valley", title: "Codex · Sunny Valley" },
  { path: "drawings/codex/doodle-note.drawing.json", id: "codex-hello-doodle", title: "Codex · HELLO Doodle" },
] as const;
const manualExampleOperations = [
  readDrawingJson("src/examples/simple-shapes.drawing.json"),
  readDrawingJson("src/examples/doodle-lettering.drawing.json"),
].map((input) => {
  const validation = validatePayload(input);
  if (!validation.ok) throw new Error("FAIL: existing manual example no longer validates");
  return JSON.stringify(validation.value.operations);
});

const codexDocuments = codexThemes.map((theme, themeIndex) => {
  const input = readDrawingJson(theme.path);
  const payloadValidation = validatePayload(input);
  assert(payloadValidation.ok, `${theme.title} Codex payload passes the existing validator`);
  const result = applyPayload(input, undefined, {
    id: theme.id,
    now: `2026-08-26T01:0${themeIndex}:00.000Z`,
  });
  assert(result.ok, `${theme.title} becomes a canonical DrawingDocument`);
  assert(result.ok && result.value.title === theme.title, `${theme.title} retains its Codex-authored identity`);
  if (!payloadValidation.ok || !result.ok) throw new Error(`FAIL: unable to inspect ${theme.title}`);

  const operations = payloadValidation.value.operations;
  assert(
    manualExampleOperations.every((manualOperations) => manualOperations !== JSON.stringify(operations)),
    `${theme.title} does not reuse an existing hand-written example operation list`,
  );
  const drawables = operations.filter((operation) => operation.type === "stroke" || operation.type === "erase");
  const semanticIds = new Set(drawables.map((operation) => operation.semanticId));
  const colors = new Set(operations.flatMap((operation) =>
    operation.type === "set_color" ? [operation.color] : [],
  ));
  const brushSizes = new Set(operations.flatMap((operation) =>
    operation.type === "set_brush_size" ? [operation.brushSize] : [],
  ));
  const tools = new Set(operations.flatMap((operation) =>
    operation.type === "select_tool" ? [operation.tool] : [],
  ));
  assert(drawables.length > 0, `${theme.title} contains real stroke operations`);
  assert(semanticIds.size >= 2, `${theme.title} uses multiple semanticIds`);
  assert(colors.size >= 2, `${theme.title} uses at least two colors`);
  assert(brushSizes.size >= 2, `${theme.title} changes brush size`);
  assert(tools.size >= 2, `${theme.title} changes drawing tool`);

  const canonicalSnapshot = JSON.stringify(result.value);
  const derivedPaths = drawables.map((operation) => {
    const path = createDerivedPath(operation.points, operation.tValues);
    commandsAtProgress(path, 0.45);
    commandsAtProgress(path, 1);
    return path;
  });
  assert(derivedPaths.some((path) => path.interpolation === "bezier"), `${theme.title} uses the existing curve renderer`);
  assert(JSON.stringify(result.value) === canonicalSnapshot, `${theme.title} canonical data is unchanged by rendering`);
  assert(
    deriveDocumentState(result.value).drawables.length === drawables.length,
    `${theme.title} is executed by the existing Drawing Engine`,
  );
  return result.value;
});

const catDocument = codexDocuments[0];
const invalidCodexInput = readDrawingJson("drawings/codex/invalid-mismatched-path.drawing.json");
const catBeforeInvalidInput = JSON.stringify(catDocument);
const invalidCodexResult = applyPayload(invalidCodexInput, catDocument);
assert(!invalidCodexResult.ok, "invalid Codex payload is rejected");
assert(
  !invalidCodexResult.ok && invalidCodexResult.errors.some((error) => error.includes("equal lengths")),
  "invalid Codex payload reports its points/tValues mismatch",
);
assert(JSON.stringify(catDocument) === catBeforeInvalidInput, "invalid Codex payload leaves the current DrawingDocument unchanged");

const catContinuationInput = readDrawingJson("drawings/codex/sleeping-cat-continue-moon.drawing.json");
const catBaseOperationCount = catDocument.operations.length;
const catBaseSnapshot = JSON.stringify(catDocument);
const catContinuation = applyPayload(catContinuationInput, catDocument, {
  now: "2026-08-26T01:10:00.000Z",
});
assert(catContinuation.ok, "Codex continue_current batch is accepted");
assert(catContinuation.ok && catContinuation.value.id === catDocument.id, "continue_current keeps the same DrawingDocument id");
assert(
  catContinuation.ok && JSON.stringify(catContinuation.value.operations.slice(0, catBaseOperationCount)) === JSON.stringify(catDocument.operations),
  "continue_current preserves the existing canonical operation prefix",
);
assert(
  catContinuation.ok && catContinuation.value.latestPlaybackRange.from === catBaseOperationCount &&
    catContinuation.value.latestPlaybackRange.to === catContinuation.value.operations.length,
  "continue_current records exactly the appended latest playback range",
);
assert(JSON.stringify(catDocument) === catBaseSnapshot, "continue_current does not mutate its source DrawingDocument");

if (catContinuation.ok) {
  const continuationSnapshot = JSON.stringify(catContinuation.value);
  const latestFrames: PlaybackFrame[] = [];
  await playDocument(
    catContinuation.value,
    "latest",
    (frame) => latestFrames.push(frame),
    new AbortController().signal,
  );
  const latestFrom = catContinuation.value.latestPlaybackRange.from;
  const latestTo = catContinuation.value.latestPlaybackRange.to;
  const appendedSemanticIds = new Set(
    catContinuation.value.operations.slice(latestFrom, latestTo).flatMap((operation) =>
      operation.type === "stroke" || operation.type === "erase" ? [operation.semanticId] : [],
    ),
  );
  const replayedSemanticIds = latestFrames.flatMap((frame) =>
    frame.transient ? [frame.transient.operation.semanticId] : [],
  );
  assert(latestFrames[0]?.operationIndex === latestFrom - 1, "Latest Replay starts immediately before the appended range");
  assert(
    latestFrames.every((frame) => frame.operationIndex >= latestFrom - 1 && frame.operationIndex < latestTo),
    "Latest Replay never executes an operation outside the appended range",
  );
  assert(
    replayedSemanticIds.length > 0 && replayedSemanticIds.every((semanticId) => appendedSemanticIds.has(semanticId)),
    "Latest Replay animates only newly appended Codex strokes",
  );
  assert(latestFrames.at(-1)?.operationIndex === latestTo - 1, "Latest Replay ends at the appended range boundary");
  assert(JSON.stringify(catContinuation.value) === continuationSnapshot, "Latest Replay does not mutate canonical DrawingDocument data");
  assert(hasReplayableLatestRange(catContinuation.value), "a genuine continue_current append exposes Latest Replay");

  const latestSkipController = new AbortController();
  const skippedLatestFrames: PlaybackFrame[] = [];
  await playDocument(
    catContinuation.value,
    "latest",
    (playbackFrame) => {
      if (skippedLatestFrames.length === 0 && playbackFrame.status === "playing") {
        latestSkipController.abort();
        skippedLatestFrames.push(createReadyPlaybackFrame(catContinuation.value));
      }
    },
    latestSkipController.signal,
  );
  assert(skippedLatestFrames[0]?.status === "ready", "Latest Replay skip returns the UI playback state to ready");
  assert(
    JSON.stringify(skippedLatestFrames[0]?.engine) === JSON.stringify(latestFrames.at(-1)?.engine),
    "Latest Replay skip reaches the same final EngineState as natural completion",
  );
  assert(JSON.stringify(catContinuation.value) === continuationSnapshot, "Latest Replay skip does not mutate canonical history");
}

function requireDocument(
  result: ReturnType<typeof applyPayload>,
  message: string,
): DrawingDocument {
  assert(result.ok, message);
  if (!result.ok) throw new Error(`FAIL: ${message}`);
  return result.value;
}

function continueWith(
  document: DrawingDocument,
  operations: DrawingOperation[],
  now: string,
) {
  return applyPayload({
    schemaVersion: "0.1",
    documentAction: "continue_current",
    documentId: document.id,
    operations,
  }, document, { now });
}

function assertSealedDocumentRejectsAppend(document: DrawingDocument, label: string) {
  const snapshot = JSON.stringify(document);
  const rejected = continueWith(
    document,
    [{ type: "select_tool", tool: "pencil" }],
    "2026-08-26T03:59:00.000Z",
  );
  assert(!rejected.ok, `${label} sealed document rejects continue_current`);
  assert(
    !rejected.ok && rejected.errors.some((error) => error.includes("completed documents cannot be continued")),
    `${label} sealed document exposes a clear rejection reason`,
  );
  assert(JSON.stringify(document) === snapshot, `${label} rejected append leaves canonical data unchanged`);
}

const operationLimitBase = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Operation limit closeout",
  operations: Array.from(
    { length: DRAWING_LIMITS.operations - 2 },
    (): DrawingOperation => ({ type: "select_tool", tool: "pencil" }),
  ),
}, undefined, {
  id: "operation-limit-closeout",
  now: "2026-08-26T03:00:00.000Z",
}), "operation limit base document is valid below the limit");
const operationLimitSafe = requireDocument(continueWith(
  operationLimitBase,
  [{ type: "select_tool", tool: "pencil" }],
  "2026-08-26T03:01:00.000Z",
), "operation limit allows a legal append below the limit");
assert(operationLimitSafe.status === "active", "operation limit document remains active at 1499 operations");
const operationPreSealSnapshot = JSON.stringify(operationLimitSafe);
const operationLimitSealed = requireDocument(continueWith(
  operationLimitSafe,
  [{ type: "select_tool", tool: "pencil" }],
  "2026-08-26T03:02:00.000Z",
), "operation limit accepts the complete operation that reaches the limit");
assert(operationLimitSealed.operations.length === DRAWING_LIMITS.operations, "operation limit seals at exactly 1500 operations");
assert(operationLimitSealed.status === "completed", "operation limit marks the document completed");
assert(
  JSON.stringify(operationLimitSealed.operations.slice(0, -1)) === JSON.stringify(operationLimitSafe.operations),
  "operation limit preserves canonical history and appends one whole operation",
);
assert(JSON.stringify(operationLimitSafe) === operationPreSealSnapshot, "operation limit sealing does not mutate its source document");
assertSealedDocumentRejectsAppend(operationLimitSealed, "operation limit");

const compactPointCount = DRAWING_LIMITS.points - 4;
const compactPoints = Array.from({ length: compactPointCount }, () => ({ x: 0, y: 0 }));
const compactTValues = Array.from(
  { length: compactPointCount },
  (_, index) => index === compactPointCount - 1 ? 1 : index / 100_000,
);
const pointLimitBase = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Point limit closeout",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 3 },
    {
      type: "stroke", semanticId: "point_limit_base", tool: "pencil", color: "#6B4F4F", brushSize: 3,
      points: compactPoints, tValues: compactTValues,
    },
  ],
}, undefined, {
  id: "point-limit-closeout",
  now: "2026-08-26T03:10:00.000Z",
}), "point limit base document is valid below the limit");
const pointLimitSafe = requireDocument(continueWith(pointLimitBase, [{
  type: "stroke", semanticId: "point_limit_safe", tool: "pencil", color: "#6B4F4F", brushSize: 3,
  points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], tValues: [0, 1],
}], "2026-08-26T03:11:00.000Z"), "point limit allows a legal whole stroke below the limit");
assert(pointLimitSafe.status === "active", "point limit document remains active at 59998 points");
const pointPreSealSnapshot = JSON.stringify(pointLimitSafe);
const pointLimitSealed = requireDocument(continueWith(pointLimitSafe, [{
  type: "stroke", semanticId: "point_limit_seal", tool: "pencil", color: "#6B4F4F", brushSize: 3,
  points: [{ x: 3, y: 3 }, { x: 4, y: 4 }], tValues: [0, 1],
}], "2026-08-26T03:12:00.000Z"), "point limit accepts the complete stroke that reaches the limit");
assert(pointLimitSealed.status === "completed", "point limit marks the document completed");
const pointLimitFinalOperation = pointLimitSealed.operations.at(-1);
assert(
  pointLimitFinalOperation?.type === "stroke" && pointLimitFinalOperation.points.length === 2,
  "point limit stores the final stroke atomically without partial points",
);
assert(
  JSON.stringify(pointLimitSealed.operations.slice(0, -1)) === JSON.stringify(pointLimitSafe.operations),
  "point limit preserves the complete canonical history prefix",
);
assert(JSON.stringify(pointLimitSafe) === pointPreSealSnapshot, "point limit sealing does not mutate its source document");
assertSealedDocumentRejectsAppend(pointLimitSealed, "point limit");

const serializedPointCount = 38_196;
const serializedPoints = Array.from({ length: serializedPointCount }, (_, index) => ({
  x: 123.12345678901234 + (index % 2),
  y: 456.12345678901234 + (index % 2),
}));
const serializedTValues = Array.from(
  { length: serializedPointCount },
  (_, index) => index === serializedPointCount - 1 ? 1 : index / 100_000,
);
const serializedLimitBase = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Size fixture",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 3 },
    {
      type: "stroke", semanticId: "s".repeat(42), tool: "pencil", color: "#6B4F4F", brushSize: 3,
      points: serializedPoints, tValues: serializedTValues,
    },
  ],
}, undefined, {
  id: "serialized-limit",
  now: "2026-08-26T02:00:00.000Z",
}), "serialized-size base document is valid below the limit");
const serializedLimitSafe = requireDocument(continueWith(
  serializedLimitBase,
  [{ type: "select_tool", tool: "pencil" }],
  "2026-08-26T02:01:00.000Z",
), "serialized-size limit allows a legal append below the limit");
assert(serializedLimitSafe.status === "active", "serialized-size document remains active before 2 MB");
const serializedPreSealSnapshot = JSON.stringify(serializedLimitSafe);
const serializedLimitSealed = requireDocument(continueWith(
  serializedLimitSafe,
  [{ type: "select_tool", tool: "pencil" }],
  "2026-08-26T02:02:00.000Z",
), "serialized-size limit accepts the operation that reaches the sealed 2 MB boundary");
assert(serializedLimitSealed.status === "completed", "serialized-size limit marks the document completed");
assert(
  new TextEncoder().encode(JSON.stringify(serializedLimitSealed)).length === DRAWING_LIMITS.serializedBytes,
  "serialized-size sealed document is exactly 2 MB including completed status",
);
assert(validateStoredDocument(serializedLimitSealed).ok, "serialized-size sealed document remains valid canonical storage data");
assert(
  JSON.stringify(serializedLimitSealed.operations.slice(0, -1)) === JSON.stringify(serializedLimitSafe.operations),
  "serialized-size limit preserves the complete canonical history prefix",
);
assert(JSON.stringify(serializedLimitSafe) === serializedPreSealSnapshot, "serialized-size sealing does not mutate its source document");
assertSealedDocumentRejectsAppend(serializedLimitSealed, "serialized-size limit");

const simultaneousBaseOperations: DrawingOperation[] = [
  { type: "select_tool", tool: "pencil" },
  { type: "set_color", color: "#6B4F4F" },
  { type: "set_brush_size", brushSize: 3 },
  {
    type: "stroke", semanticId: "simultaneous_base", tool: "pencil", color: "#6B4F4F", brushSize: 3,
    points: [...compactPoints, { x: 0, y: 0 }, { x: 0, y: 0 }],
    tValues: Array.from(
      { length: DRAWING_LIMITS.points - 2 },
      (_, index) => index === DRAWING_LIMITS.points - 3 ? 1 : index / 100_000,
    ),
  },
  ...Array.from(
    { length: DRAWING_LIMITS.operations - 5 },
    (): DrawingOperation => ({ type: "select_tool", tool: "pencil" }),
  ),
];
const simultaneousLimitBase = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Simultaneous limit closeout",
  operations: simultaneousBaseOperations,
}, undefined, {
  id: "simultaneous-limit-closeout",
  now: "2026-08-26T03:20:00.000Z",
}), "simultaneous-limit base remains below every limit");
assert(simultaneousLimitBase.operations.length === DRAWING_LIMITS.operations - 1, "simultaneous fixture starts at 1499 operations");
const simultaneousSnapshot = JSON.stringify(simultaneousLimitBase);
const simultaneousRejected = continueWith(simultaneousLimitBase, [{
  type: "stroke", semanticId: "simultaneous_overflow", tool: "pencil", color: "#6B4F4F", brushSize: 3,
  points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], tValues: [0, 0.5, 1],
}], "2026-08-26T03:21:00.000Z");
assert(!simultaneousRejected.ok, "a batch hitting operation limit while exceeding point limit fails closed");
assert(
  !simultaneousRejected.ok && simultaneousRejected.errors.some((error) => error.includes(`${DRAWING_LIMITS.points} points`)),
  "multi-limit conflict deterministically reports the exceeded point limit",
);
assert(JSON.stringify(simultaneousLimitBase) === simultaneousSnapshot, "multi-limit rejection applies no operation and no partial points");

const checkpointPrefix: DrawingOperation[] = [
  { type: "select_tool", tool: "pencil" },
  { type: "set_color", color: "#6B4F4F" },
  { type: "set_brush_size", brushSize: 8 },
  {
    type: "stroke", semanticId: "checkpoint_stroke", tool: "pencil", color: "#6B4F4F", brushSize: 8,
    points: [{ x: 20, y: 30 }, { x: 80, y: 90 }, { x: 150, y: 50 }], tValues: [0, 0.5, 1],
  },
];
assert(CHECKPOINT_INTERVAL >= 300 && CHECKPOINT_INTERVAL <= 400, "checkpoint interval stays within the PRD 300-400 operation window");
while (checkpointPrefix.length < CHECKPOINT_INTERVAL - 1) {
  checkpointPrefix.push({ type: "select_tool", tool: "pencil" });
}
const belowCheckpointDocument = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Checkpoint below threshold",
  operations: checkpointPrefix,
}, undefined, {
  id: "checkpoint-below",
  now: "2026-08-26T04:00:00.000Z",
}), "checkpoint fixture below threshold is valid");
assert(createRenderCheckpoints(belowCheckpointDocument).length === 0, "no checkpoint is created before 350 operations");

const firstCheckpointOperations = [...checkpointPrefix, { type: "undo" } as DrawingOperation];
const firstCheckpointDocument = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Checkpoint closeout",
  operations: firstCheckpointOperations,
}, undefined, {
  id: "checkpoint-closeout",
  now: "2026-08-26T04:01:00.000Z",
}), "first checkpoint fixture is valid at 350 operations");
const firstCheckpoints = createRenderCheckpoints(firstCheckpointDocument);
assert(firstCheckpoints.length === 1 && firstCheckpoints[0].revision === 350, "first checkpoint is created at revision 350");

const checkpointContinuation: DrawingOperation[] = [{ type: "redo" }];
while (checkpointContinuation.length < CHECKPOINT_INTERVAL) {
  checkpointContinuation.push({ type: "select_tool", tool: "pencil" });
}
const secondCheckpointDocument = requireDocument(continueWith(
  firstCheckpointDocument,
  checkpointContinuation,
  "2026-08-26T04:02:00.000Z",
), "checkpoint fixture continues to the next threshold");
const canonicalBeforeCheckpoints = JSON.stringify(secondCheckpointDocument);
const latestPlaybackRangeBeforeCheckpoints = JSON.stringify(secondCheckpointDocument.latestPlaybackRange);
const assertLatestPlaybackRangeUnchanged = (stage: string) => assert(
  JSON.stringify(secondCheckpointDocument.latestPlaybackRange) === latestPlaybackRangeBeforeCheckpoints,
  `checkpoint ${stage} leaves latestPlaybackRange unchanged`,
);
const checkpoints = createRenderCheckpoints(secondCheckpointDocument);
assert(
  checkpoints.length === 2 && checkpoints[0].revision === 350 && checkpoints[1].revision === 700,
  "subsequent checkpoint is created at revision 700",
);
assertLatestPlaybackRangeUnchanged("create");
assert(
  !JSON.stringify(checkpoints).includes("checkpoint_stroke"),
  "checkpoint stores drawable indexes without duplicating semanticId history",
);
const canonicalState = deriveDocumentState(secondCheckpointDocument);
const checkpointRestore = restoreDocumentState(secondCheckpointDocument, checkpoints);
assert(checkpointRestore.usedCheckpointRevision === 700, "restore uses the newest valid checkpoint");
assert(JSON.stringify(checkpointRestore.state) === JSON.stringify(canonicalState), "checkpoint restore preserves undo/redo and final engine state");
assertLatestPlaybackRangeUnchanged("restore");
assert(JSON.stringify(secondCheckpointDocument) === canonicalBeforeCheckpoints, "checkpoint creation and restore do not mutate canonical operations");

const checkpointCache = new RenderCheckpointCache();
checkpointCache.refresh(secondCheckpointDocument);
assert(checkpointCache.get(secondCheckpointDocument.id).length === 2, "checkpoint cache retains both derived checkpoints");
checkpointCache.clear(secondCheckpointDocument.id);
assert(checkpointCache.get(secondCheckpointDocument.id).length === 0, "checkpoint cache can be safely cleared");
const clearedRestore = checkpointCache.restore(secondCheckpointDocument);
assertLatestPlaybackRangeUnchanged("clear and canonical rebuild");
assert(clearedRestore.rebuiltFromCanonical, "cleared checkpoint cache rebuilds from canonical history");
assert(JSON.stringify(clearedRestore.state) === JSON.stringify(canonicalState), "cleared checkpoint rebuild reaches the canonical final state");

const corruptVersion = structuredClone(checkpoints[1]) as RenderCheckpoint;
(corruptVersion as { version: number }).version = CHECKPOINT_VERSION + 1;
const corruptVersionRestore = restoreDocumentState(secondCheckpointDocument, [corruptVersion]);
assert(corruptVersionRestore.rebuiltFromCanonical, "version-mismatched checkpoint is ignored");
assert(JSON.stringify(corruptVersionRestore.state) === JSON.stringify(canonicalState), "version mismatch safely rebuilds canonical state");
assertLatestPlaybackRangeUnchanged("version-mismatch fallback");
const corruptState = structuredClone(checkpoints[1]);
corruptState.state.brushSize = 64;
const corruptStateRestore = restoreDocumentState(secondCheckpointDocument, [corruptState]);
assert(corruptStateRestore.rebuiltFromCanonical, "checkpoint with a damaged state hash is ignored");
assert(JSON.stringify(corruptStateRestore.state) === JSON.stringify(canonicalState), "damaged checkpoint cannot pollute the final state");
assertLatestPlaybackRangeUnchanged("corrupt-state fallback");

const fullReplayFrames: PlaybackFrame[] = [];
const uninterruptedSignal = {
  aborted: false,
  addEventListener() {},
} as unknown as AbortSignal;
await playDocument(
  secondCheckpointDocument,
  "full",
  (frame) => fullReplayFrames.push(frame),
  uninterruptedSignal,
);
assert(
  JSON.stringify(fullReplayFrames.at(-1)?.engine) === JSON.stringify(canonicalState),
  "Full Replay from canonical operations reaches the same final state as checkpoint restore",
);
const fullSkipController = new AbortController();
const skippedFullFrames: PlaybackFrame[] = [];
await playDocument(
  secondCheckpointDocument,
  "full",
  (playbackFrame) => {
    if (skippedFullFrames.length === 0 && playbackFrame.status === "playing") {
      fullSkipController.abort();
      skippedFullFrames.push(createReadyPlaybackFrame(secondCheckpointDocument));
    }
  },
  fullSkipController.signal,
);
assert(skippedFullFrames[0]?.status === "ready", "Full Replay skip returns the UI playback state to ready");
assert(
  JSON.stringify(skippedFullFrames[0]?.engine) === JSON.stringify(fullReplayFrames.at(-1)?.engine),
  "Full Replay skip reaches the same final EngineState as natural completion",
);
assert(
  JSON.stringify(secondCheckpointDocument) === canonicalBeforeCheckpoints,
  "checkpoint use and Full Replay preserve operations, latestPlaybackRange, and canonical ordering",
);

const publicSchema = JSON.parse(readFileSync("public/drawing-schema.json", "utf8")) as {
  title?: unknown;
  "x-drawing-lab-rules"?: { coreCanonicalBytes?: unknown; hostedHandoffCanonicalBytes?: unknown };
};
assert(publicSchema.title === "Drawing Lab AgentDrawingPayload 0.1", "public AgentDrawingPayload schema is valid JSON");
assert(
  publicSchema["x-drawing-lab-rules"]?.coreCanonicalBytes === DRAWING_LIMITS.serializedBytes &&
    publicSchema["x-drawing-lab-rules"]?.hostedHandoffCanonicalBytes === HOSTED_HANDOFF_CANONICAL_BYTES,
  "public schema records distinct Core and Hosted byte policies",
);

for (const [index, document] of codexDocuments.entries()) {
  const before = JSON.stringify(document);
  const encoded = await createFragmentResult(document);
  assert(encoded.status === "ready", `Codex work ${index + 1} fits the self-contained Fragment fast path`);
  if (encoded.status !== "ready") throw new Error(`FAIL: Codex work ${index + 1} fragment was not created`);
  const decoded = await decodeDrawingFragment(encoded.fragment);
  assert(decoded.ok, `Codex work ${index + 1} fragment decodes through stored-document validation`);
  assert(decoded.ok && JSON.stringify(decoded.value) === before, `Codex work ${index + 1} fragment round-trip is canonical-equivalent`);
  assert(JSON.stringify(document) === before, `Codex work ${index + 1} fragment transport does not mutate its canonical source`);
}

const fragmentFixture = await createFragmentResult(codexDocuments[0]);
if (fragmentFixture.status !== "ready") throw new Error("FAIL: fragment corruption fixture was not created");
const truncatedFragment = fragmentFixture.fragment.slice(0, -8);
const truncatedResult = await decodeDrawingFragment(truncatedFragment);
assert(!truncatedResult.ok, "truncated fragment fails closed");
const fragmentBody = fragmentFixture.fragment.slice(DRAWING_FRAGMENT_PREFIX.length);
const corruptAt = Math.floor(fragmentBody.length / 2);
const corruptCharacter = fragmentBody[corruptAt] === "A" ? "B" : "A";
const corruptFragment = DRAWING_FRAGMENT_PREFIX + fragmentBody.slice(0, corruptAt) + corruptCharacter + fragmentBody.slice(corruptAt + 1);
const corruptResult = await decodeDrawingFragment(corruptFragment);
assert(!corruptResult.ok, "corrupt fragment fails closed");

async function gzipUnknown(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return DRAWING_FRAGMENT_PREFIX + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const nonDocumentFragment = await gzipUnknown({ message: "not a DrawingDocument" });
const nonDocumentResult = await decodeDrawingFragment(nonDocumentFragment);
assert(!nonDocumentResult.ok, "non-DrawingDocument fragment fails closed after gunzip and JSON parse");

const restoredForReplay = await decodeDrawingFragment(fragmentFixture.fragment);
assert(restoredForReplay.ok, "Full Replay fragment fixture restores successfully");
if (!restoredForReplay.ok) throw new Error("FAIL: Full Replay fragment fixture did not restore");
const restoredReplayFrames: PlaybackFrame[] = [];
await playDocument(
  restoredForReplay.value,
  "full",
  (playbackFrame) => restoredReplayFrames.push(playbackFrame),
  uninterruptedSignal,
);
assert(
  JSON.stringify(restoredReplayFrames.at(-1)?.engine) === JSON.stringify(deriveDocumentState(codexDocuments[0])),
  "fragment-restored Full Replay reaches the same final engine state as the original document",
);

const agentContextOperations: DrawingOperation[] = [
  { type: "select_tool", tool: "pencil" },
  { type: "set_color", color: "#6B4F4F" },
  { type: "set_brush_size", brushSize: 4 },
  ...Array.from({ length: AGENT_CONTEXT_SEMANTIC_ID_LIMIT + 6 }, (_, index): DrawingOperation => ({
    type: "stroke",
    semanticId: `context-mark-${index}`,
    tool: "pencil",
    color: "#6B4F4F",
    brushSize: 4,
    points: [{ x: index + 10, y: 100 }, { x: index + 11, y: 101 }],
    tValues: [0, 1],
  })),
];
const agentContextDocument = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Agent context bounds",
  operations: agentContextOperations,
}, undefined, { id: "agent-context-bounds", now: "2026-08-26T05:00:00.000Z" }), "Agent Context fixture is valid");
const boundedContext = createAgentContext(agentContextDocument);
assert(boundedContext.semanticIndex.entries.length === AGENT_CONTEXT_SEMANTIC_ID_LIMIT, "Agent Context semantic index is bounded");
assert(boundedContext.semanticIndex.truncated && boundedContext.semanticIndex.totalUnique === AGENT_CONTEXT_SEMANTIC_ID_LIMIT + 6, "Agent Context reports semantic index truncation and total count");
assert(!Object.hasOwn(boundedContext, "operations") && !JSON.stringify(boundedContext).includes('"operations"'), "Agent Context does not copy complete operations history");
assert(
  boundedContext.remainingOperationsBudget === DRAWING_LIMITS.operations - agentContextDocument.operations.length &&
    boundedContext.remainingPointsBudget === DRAWING_LIMITS.points - (AGENT_CONTEXT_SEMANTIC_ID_LIMIT + 6) * 2 &&
    boundedContext.remainingCoreByteBudget === DRAWING_LIMITS.serializedBytes - canonicalDocumentByteLength(agentContextDocument),
  "Agent Context exposes exact remaining Core budgets",
);

const hostedBoundaryPointCount = 30_000;
const hostedBoundaryPoints = Array.from({ length: hostedBoundaryPointCount }, (_, index) => ({
  x: (index % 999) + 0.123456,
  y: (index % 749) + 0.654321,
}));
const hostedBoundaryTValues = Array.from(
  { length: hostedBoundaryPointCount },
  (_, index) => index / (hostedBoundaryPointCount - 1),
);
const hostedBoundaryDocument = requireDocument(applyPayload({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Hosted policy boundary",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 3 },
    {
      type: "stroke",
      semanticId: "hosted-boundary-stroke",
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 3,
      points: hostedBoundaryPoints,
      tValues: hostedBoundaryTValues,
    },
  ],
}, undefined, { id: "hosted-policy-boundary", now: "2026-08-26T05:10:00.000Z" }), "document above Hosted cap remains valid under Core cap");
const hostedBoundaryBytes = canonicalDocumentByteLength(hostedBoundaryDocument);
assert(
  hostedBoundaryBytes > HOSTED_HANDOFF_CANONICAL_BYTES && hostedBoundaryBytes <= DRAWING_LIMITS.serializedBytes,
  "Hosted boundary fixture is over 1 MiB and within the 2 MiB Core limit",
);
assert(validateStoredDocument(hostedBoundaryDocument).ok, "Core stored-document validator accepts the over-1-MiB document");
assert(getHostedHandoffEligibility(hostedBoundaryDocument).status === "hosted_unavailable", "Hosted transport independently rejects the over-1-MiB document");
assert((await createFragmentResult(hostedBoundaryDocument)).status === "hosted_unavailable", "self-contained Hosted handoff refuses documents above 1 MiB");
assert(!(await encryptDrawingDocumentForRelay(hostedBoundaryDocument)).ok, "encrypted relay independently refuses documents above the 1 MiB Hosted cap");

const forcedThresholdResult = await createFragmentResult(codexDocuments[0], 8);
assert(forcedThresholdResult.status === "relay_required", "fragment threshold overflow returns relay_required only");
assert(
  forcedThresholdResult.status === "relay_required" && !("fragment" in forcedThresholdResult),
  "relay_required does not expose a partial result or implement a relay",
);

function bytesAsArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function gzipBytesForRelayTest(bytes: Uint8Array) {
  const stream = new Blob([bytesAsArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function createTestEncryptedEnvelope(
  plaintext: Uint8Array,
  useGzip: boolean,
) {
  const fragmentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    bytesAsArrayBuffer(fragmentKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const encryptedInput = useGzip ? await gzipBytesForRelayTest(plaintext) : plaintext;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesAsArrayBuffer(iv) },
    key,
    bytesAsArrayBuffer(encryptedInput),
  ));
  return {
    fragmentKey: bytesToBase64Url(fragmentKey),
    envelope: {
      version: RELAY_ENVELOPE_VERSION,
      algorithm: RELAY_AES_ALGORITHM,
      compression: RELAY_COMPRESSION,
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(ciphertext),
      canonicalBytes: plaintext.length,
    } satisfies RelayCiphertextEnvelope,
  };
}

async function expectRelayClientError(
  action: Promise<unknown>,
  code: RelayClientError["code"],
  message: string,
) {
  try {
    await action;
    assert(false, message);
  } catch (error) {
    assert(error instanceof RelayClientError && error.code === code, message);
  }
}

const relaySourceDocument = codexDocuments[0];
const relaySourceSnapshot = JSON.stringify(relaySourceDocument);
const encryptedRelay = await encryptDrawingDocumentForRelay(relaySourceDocument);
assert(encryptedRelay.ok, "AES-GCM relay encryption accepts a Hosted-eligible canonical document");
if (!encryptedRelay.ok) throw new Error("FAIL: relay encryption fixture was not created");
assert(base64UrlToBytes(encryptedRelay.value.fragmentKey).length === 32, "relay encryption generates a 256-bit CSPRNG key");
assert(validateRelayEnvelope(encryptedRelay.value.envelope).ok, "relay encryption produces a strictly valid ciphertext envelope");
const decryptedRelay = await decryptRelayDrawingDocument(
  encryptedRelay.value.envelope,
  encryptedRelay.value.fragmentKey,
);
assert(decryptedRelay.ok && JSON.stringify(decryptedRelay.value) === relaySourceSnapshot, "AES-GCM encrypt/decrypt round-trip restores canonical DrawingDocument bytes");
assert(JSON.stringify(relaySourceDocument) === relaySourceSnapshot, "relay encryption and decryption do not mutate canonical source data");

const wrongRelayKey = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const wrongKeyResult = await decryptRelayDrawingDocument(encryptedRelay.value.envelope, wrongRelayKey);
assert(!wrongKeyResult.ok, "wrong relay key fails closed at AES-GCM authentication");
const modifiedCiphertextBytes = base64UrlToBytes(encryptedRelay.value.envelope.ciphertext);
modifiedCiphertextBytes[Math.floor(modifiedCiphertextBytes.length / 2)] ^= 1;
const modifiedCiphertextResult = await decryptRelayDrawingDocument({
  ...encryptedRelay.value.envelope,
  ciphertext: bytesToBase64Url(modifiedCiphertextBytes),
}, encryptedRelay.value.fragmentKey);
assert(!modifiedCiphertextResult.ok, "changing one ciphertext byte fails closed at AES-GCM authentication");
const truncatedCiphertextResult = await decryptRelayDrawingDocument({
  ...encryptedRelay.value.envelope,
  ciphertext: bytesToBase64Url(base64UrlToBytes(encryptedRelay.value.envelope.ciphertext).slice(0, -1)),
}, encryptedRelay.value.fragmentKey);
assert(!truncatedCiphertextResult.ok, "truncated ciphertext fails closed");
const invalidEnvelopeResult = await decryptRelayDrawingDocument({
  ...encryptedRelay.value.envelope,
  executable: "<script />",
}, encryptedRelay.value.fragmentKey);
assert(!invalidEnvelopeResult.ok, "relay envelope with an unknown field fails closed");

const invalidGzipFixture = await createTestEncryptedEnvelope(new TextEncoder().encode("not gzip"), false);
assert(
  !(await decryptRelayDrawingDocument(invalidGzipFixture.envelope, invalidGzipFixture.fragmentKey)).ok,
  "authenticated ciphertext containing invalid gzip fails closed",
);
const invalidJsonFixture = await createTestEncryptedEnvelope(new TextEncoder().encode("not json"), true);
assert(
  !(await decryptRelayDrawingDocument(invalidJsonFixture.envelope, invalidJsonFixture.fragmentKey)).ok,
  "authenticated gzip containing invalid JSON fails closed",
);
const invalidDocumentFixture = await createTestEncryptedEnvelope(new TextEncoder().encode("{}"), true);
assert(
  !(await decryptRelayDrawingDocument(invalidDocumentFixture.envelope, invalidDocumentFixture.fragmentKey)).ok,
  "authenticated JSON containing an invalid DrawingDocument fails closed",
);

class RecordingRelayClient implements RelayClient {
  envelope: RelayCiphertextEnvelope | null = null;
  readonly resultId = "R".repeat(24);
  readonly expiresAt = 1_800_000_000_000;

  async createResult(envelope: RelayCiphertextEnvelope) {
    this.envelope = structuredClone(envelope);
    return { resultId: this.resultId, expiresAt: this.expiresAt };
  }

  async getResult(_resultId: string) {
    if (!this.envelope) throw new RelayClientError("not_found", "not found", 404);
    return structuredClone(this.envelope);
  }
}

const recordingRelay = new RecordingRelayClient();
const recordedRelayResult = await createEncryptedRelayResult(
  relaySourceDocument,
  recordingRelay,
  "https://drawing-lab.test/app",
);
assert(recordedRelayResult.status === "ready", "relay handoff creates an immutable result URL after encryption");
if (recordedRelayResult.status !== "ready" || !recordingRelay.envelope) {
  throw new Error("FAIL: recorded relay result was not created");
}
const recordedLocation = parseRelayResultUrl(recordedRelayResult.url);
assert(recordedLocation?.resultId === recordingRelay.resultId, "relay result id is placed in the URL query for server retrieval");
assert(
  recordedLocation !== null &&
    !new URL(recordedRelayResult.url).search.includes(recordedLocation.fragmentKey) &&
    new URL(recordedRelayResult.url).hash.includes(recordedLocation.fragmentKey),
  "relay encryption key exists only in the result URL fragment",
);
const recordedRequest = JSON.stringify(recordingRelay.envelope);
assert(
  !recordedRequest.includes(recordedLocation?.fragmentKey ?? "missing") &&
    !recordedRequest.includes(relaySourceDocument.title) &&
    !recordedRequest.includes("operations"),
  "relay create request contains no encryption key or plaintext DrawingDocument",
);

let memoryNow = 1_800_000_000_000;
const memoryRelay = new InMemoryRelayClient({ now: () => memoryNow });
const memoryRelayResult = await createEncryptedRelayResult(
  relaySourceDocument,
  memoryRelay,
  "https://drawing-lab.test/app",
);
assert(memoryRelayResult.status === "ready", "local mock relay accepts a valid encrypted result");
if (memoryRelayResult.status !== "ready") throw new Error("FAIL: local mock relay result was not created");
const memoryRecord = memoryRelay.inspectStoredRecord(memoryRelayResult.resultId);
assert(
  memoryRecord !== null &&
    JSON.stringify(memoryRecord).includes("ciphertext") &&
    !JSON.stringify(memoryRecord).includes(relaySourceDocument.title) &&
    !JSON.stringify(memoryRecord).includes("fragmentKey"),
  "local mock relay stores ciphertext metadata only, without plaintext or key",
);
const restoredMemoryRelay = await restoreEncryptedRelayResult(memoryRelayResult.url, memoryRelay);
assert(restoredMemoryRelay.ok && JSON.stringify(restoredMemoryRelay.value) === relaySourceSnapshot, "local mock relay read decrypts and strictly restores the same document");
memoryNow += RELAY_TTL_MS;
const expiredMemoryRelay = await restoreEncryptedRelayResult(memoryRelayResult.url, memoryRelay);
assert(!expiredMemoryRelay.ok && expiredMemoryRelay.errors.some((error) => error.startsWith("expired:")), "expired mock relay result is logically unreadable");
await expectRelayClientError(
  memoryRelay.getResult("N".repeat(24)),
  "not_found",
  "nonexistent mock relay result is unreadable",
);

const oversizedCiphertext = new Uint8Array(RELAY_CIPHERTEXT_HARD_CAP_BYTES + 1);
const oversizedEnvelope = {
  ...encryptedRelay.value.envelope,
  ciphertext: bytesToBase64Url(oversizedCiphertext),
};
assert(!validateRelayEnvelope(oversizedEnvelope).ok, "ciphertext hard cap rejects an oversized envelope before write");
assert(
  new TextEncoder().encode(JSON.stringify(oversizedEnvelope)).length <= RELAY_REQUEST_HARD_CAP_BYTES,
  "ciphertext cap is independently tighter than the request envelope cap",
);

const rateLimitedRelay = new InMemoryRelayClient({ rateLimitCreates: 1, resultIdFactory: (() => {
  let index = 0;
  return () => `${index++}`.padEnd(24, "R");
})() });
await rateLimitedRelay.createResult(encryptedRelay.value.envelope);
await expectRelayClientError(
  rateLimitedRelay.createResult(encryptedRelay.value.envelope),
  "rate_limited",
  "mock create rate limit fails closed",
);
const quotaRelay = new InMemoryRelayClient({
  rateLimitCreates: 100,
  globalCreateLimit: 1,
  resultIdFactory: (() => {
    let index = 0;
    return () => `${index++}`.padEnd(24, "Q");
  })(),
});
await quotaRelay.createResult(encryptedRelay.value.envelope);
await expectRelayClientError(
  quotaRelay.createResult(encryptedRelay.value.envelope),
  "quota_reached",
  "mock global create protection fails closed",
);
const storageQuotaRelay = new InMemoryRelayClient({
  globalStoredCiphertextBytes: base64UrlToBytes(encryptedRelay.value.envelope.ciphertext).length - 1,
});
await expectRelayClientError(
  storageQuotaRelay.createResult(encryptedRelay.value.envelope),
  "quota_reached",
  "mock global ciphertext storage protection fails closed",
);

const immutableId = "I".repeat(24);
const immutableRelay = new InMemoryRelayClient({
  rateLimitCreates: 100,
  resultIdFactory: () => immutableId,
});
await immutableRelay.createResult(encryptedRelay.value.envelope);
await expectRelayClientError(
  immutableRelay.createResult(encryptedRelay.value.envelope),
  "duplicate_result",
  "immutable mock relay rejects duplicate result ids instead of updating",
);
assert(!("updateResult" in immutableRelay), "relay client surface has no update operation");

let cleanupNow = 1_900_000_000_000;
const cleanupIds = ["A".repeat(24), "B".repeat(24)];
const cleanupRelay = new InMemoryRelayClient({
  now: () => cleanupNow,
  rateLimitCreates: 100,
  resultIdFactory: () => cleanupIds.shift() ?? "C".repeat(24),
});
const cleanupFirst = await cleanupRelay.createResult(encryptedRelay.value.envelope);
cleanupNow += RELAY_TTL_MS / 2;
const cleanupSecond = await cleanupRelay.createResult(encryptedRelay.value.envelope);
cleanupNow += RELAY_TTL_MS / 2;
assert(cleanupRelay.cleanupExpired() === 1, "mock cleanup physically deletes the expired result");
await expectRelayClientError(cleanupRelay.getResult(cleanupFirst.resultId), "not_found", "cleaned result is absent");
assert((await cleanupRelay.getResult(cleanupSecond.resultId)).ciphertext === encryptedRelay.value.envelope.ciphertext, "cleanup leaves an unexpired result readable");

const corsWorker = createRelayWorker();
const corsEnvironment = createMemoryWorkerEnvironment();
const allowedPreflight = await corsWorker.fetch(new Request("https://relay.test/api/results", {
  method: "OPTIONS",
  headers: { origin: "https://drawing-lab.test" },
}), corsEnvironment);
assert(
  allowedPreflight.status === 204 &&
    allowedPreflight.headers.get("access-control-allow-origin") === "https://drawing-lab.test" &&
    allowedPreflight.headers.get("vary") === "Origin" &&
    allowedPreflight.headers.get("access-control-allow-credentials") === null,
  "Worker CORS echoes an allowed origin without credentials",
);
const blockedCorsEnvironment = createMemoryWorkerEnvironment();
const blockedOriginResponse = await corsWorker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://unapproved.example",
  },
  body: JSON.stringify(encryptedRelay.value.envelope),
}), blockedCorsEnvironment);
assert(
  blockedOriginResponse.status === 403 && blockedCorsEnvironment.DB.rows.size === 0,
  "Worker CORS rejects an unapproved browser origin before D1 write",
);

let workerNow = 2_000_000_000_000;
const workerEnvironment = createMemoryWorkerEnvironment();
const workerResultId = "W".repeat(24);
const worker = createRelayWorker({ now: () => workerNow, resultIdFactory: () => workerResultId });
const workerCreateResponse = await worker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(encryptedRelay.value.envelope),
}), workerEnvironment);
assert(workerCreateResponse.status === 201, "local D1-compatible Worker creates an encrypted result");
const workerCreateBody = await workerCreateResponse.json() as { resultId?: string; expiresAt?: number };
assert(workerCreateBody.resultId === workerResultId && workerCreateBody.expiresAt === workerNow + RELAY_TTL_MS, "Worker returns immutable id and seven-day expiry");
const workerStoredRow = workerEnvironment.DB.rows.get(workerResultId);
assert(
  workerStoredRow !== undefined && workerStoredRow.ciphertext instanceof ArrayBuffer &&
    !("key" in workerStoredRow) && !JSON.stringify(workerStoredRow).includes(relaySourceDocument.title),
  "D1-compatible store receives bound ciphertext BLOB and no key or plaintext",
);
const workerReadResponse = await worker.fetch(
  new Request(`https://relay.test/api/results/${workerResultId}`),
  workerEnvironment,
);
assert(workerReadResponse.status === 200, "local D1-compatible Worker reads an unexpired result from primary semantics");
assert(
  JSON.stringify(await workerReadResponse.json()) === JSON.stringify(encryptedRelay.value.envelope),
  "Worker reconstructs the exact ciphertext envelope",
);
const workerDuplicateResponse = await worker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(encryptedRelay.value.envelope),
}), workerEnvironment);
assert(workerDuplicateResponse.status === 409, "Worker duplicate result id fails closed instead of updating");
const workerUpdateResponse = await worker.fetch(new Request(
  `https://relay.test/api/results/${workerResultId}`,
  { method: "PUT", body: "{}" },
), workerEnvironment);
assert(workerUpdateResponse.status === 405, "Worker exposes no update route");
const workerMissingResponse = await worker.fetch(
  new Request(`https://relay.test/api/results/${"M".repeat(24)}`),
  workerEnvironment,
);
assert(workerMissingResponse.status === 404, "Worker nonexistent result is unreadable");
workerNow += RELAY_TTL_MS;
const workerExpiredResponse = await worker.fetch(
  new Request(`https://relay.test/api/results/${workerResultId}`),
  workerEnvironment,
);
assert(workerExpiredResponse.status === 410, "Worker checks expires_at before returning ciphertext");
await worker.scheduled(null, workerEnvironment);
assert(!workerEnvironment.DB.rows.has(workerResultId), "Worker scheduled cleanup deletes expired rows");

const malformedWorkerResponse = await worker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ciphertext: "not-an-envelope" }),
}), createMemoryWorkerEnvironment());
assert(malformedWorkerResponse.status === 400, "Worker malformed envelope fails closed");
const oversizedWorkerResponse = await worker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "x".repeat(RELAY_REQUEST_HARD_CAP_BYTES + 1),
}), createMemoryWorkerEnvironment());
assert(oversizedWorkerResponse.status === 413, "Worker request hard cap rejects before JSON application");
const rateWorkerEnvironment = createMemoryWorkerEnvironment();
rateWorkerEnvironment.RATE_LIMITER.success = false;
const rateWorkerResponse = await worker.fetch(new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(encryptedRelay.value.envelope),
}), rateWorkerEnvironment);
assert(rateWorkerResponse.status === 429 && rateWorkerEnvironment.DB.rows.size === 0, "Worker rate protection rejects without a partial write");

const workerQuotaEnvironment = createMemoryWorkerEnvironment();
const quotaIds = ["X".repeat(24), "Y".repeat(24)];
const quotaWorker = createRelayWorker({
  now: () => 2_100_000_000_000,
  globalCreateLimit: 1,
  resultIdFactory: () => quotaIds.shift() ?? "Z".repeat(24),
});
const quotaWorkerRequest = () => new Request("https://relay.test/api/results", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(encryptedRelay.value.envelope),
});
assert((await quotaWorker.fetch(quotaWorkerRequest(), workerQuotaEnvironment)).status === 201, "Worker global protection allows create below threshold");
assert((await quotaWorker.fetch(quotaWorkerRequest(), workerQuotaEnvironment)).status === 507, "Worker global protection fails closed at threshold");
assert(workerQuotaEnvironment.DB.rows.size === 1, "Worker quota rejection produces no partial row");

const wranglerExample = JSON.parse(readFileSync("wrangler.example.jsonc", "utf8")) as {
  assets?: { run_worker_first?: unknown };
};
const workerFirstRoutes = wranglerExample.assets?.run_worker_first;
assert(
  Array.isArray(workerFirstRoutes) &&
    workerFirstRoutes.includes("/api/*") &&
    workerFirstRoutes.includes("/mcp") &&
    workerFirstRoutes.includes("/.well-known/*") &&
    workerFirstRoutes.includes("/authorize") &&
    workerFirstRoutes.includes("/token") &&
    workerFirstRoutes.includes("/register"),
  "Static Assets routes MCP and auth discovery probes to Worker before SPA fallback",
);

const failureSnapshot = JSON.stringify(relaySourceDocument);
await decryptRelayDrawingDocument(encryptedRelay.value.envelope, wrongRelayKey);
await restoreEncryptedRelayResult(
  `https://drawing-lab.test/app?relayResult=${"N".repeat(24)}#relay-key=${encryptedRelay.value.fragmentKey}`,
  memoryRelay,
);
assert(JSON.stringify(relaySourceDocument) === failureSnapshot, "all relay failure paths leave the current canonical DrawingDocument unchanged");

passed += await runMcpTests();
console.log(`PASS: ${passed} assertions`);
