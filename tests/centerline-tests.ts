import { expandMcpSteps } from "../src/domain/mcpCompactSteps.js";
import { createDrawingBranch } from "../src/domain/drawingBranch.js";
import { deriveDocumentState } from "../src/domain/engine.js";
import { playDocument, type PlaybackFrame } from "../src/domain/playback.js";
import { DRAWING_LIMITS, type DrawingOperation } from "../src/domain/types.js";
import { applyPayload, validateStoredDocument } from "../src/domain/validation.js";
import { createFinalRenderPlan, createRenderPlan } from "../src/renderer/renderPlan.js";
import { renderPlanToSvg } from "../src/renderer/svgPreview.js";

export async function runCenterlineTests() {
  let passed = 0;
  const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) throw new Error(`FAIL: ${message}`);
    passed++;
  };
  const header = { schemaVersion: "0.1", documentAction: "new_drawing", title: "Centerline fixture" };
  const path = { id: "band", spine: [[100,100,20],[220,100,40]], caps: ["flat", "flat"], grain: 0.3 };
  const expand = (paths: unknown[], tool = "gouache_fill") => expandMcpSteps([{ tool }, { paths }, "complete"]);
  const result = expand([path]);
  assert(result.ok, "centerline expands into an ordinary fill");
  const made = applyPayload({ ...header, operations: result.value });
  assert(made.ok && validateStoredDocument(made.value).ok, "expanded region passes canonical and stored validators");
  const region = made.value.operations[1];
  assert(region.type === "stroke", "one spine produces exactly one canonical stroke");
  assert(region.points[0].x === 100 && region.points[0].y === 110 &&
    region.points.some(p => p.x === 220 && p.y === 120) && region.points.some(p => p.x === 220 && p.y === 80),
    "full width is offset by half on each side, preserving authored end widths");
  assert(region.tValues.every((t, i) => t === i / (region.points.length - 1)) && region.grain === 0.3 &&
    !JSON.stringify(made.value).includes('"spine"') && !JSON.stringify(made.value).includes('"caps"'),
    "only expanded canonical geometry, uniform progression and existing material fields are stored");
  const snapshot = JSON.stringify(path);
  assert(JSON.stringify(expand([path])) === JSON.stringify(result) && JSON.stringify(path) === snapshot,
    "expansion is deterministic and leaves the caller's input unchanged");
  const round = expand([{ ...path, caps: ["round", "round"] }]);
  assert(round.ok, "round caps expand");
  const roundOp = round.value[1] as DrawingOperation;
  assert(roundOp.type === "stroke" && Math.min(...roundOp.points.map(p => p.x)) === 90 &&
    Math.max(...roundOp.points.map(p => p.x)) === 240, "round caps extend exactly by endpoint half-width");
  const tip = expand([{ ...path, spine: [[100,100,20],[220,100,0]], caps: ["round", "round"] }]);
  assert(tip.ok && applyPayload({ ...header, operations: tip.value }).ok, "zero-width endpoint becomes a valid tapered tip");

  const fixtures = [
    { ...path, id: "tail", caps: ["round", "round"], points: 107,
      spine: [[606,522,80],[703,490,72],[779,402,62],[793,299,48],[742,246,34],[684,271,20],[678,317,4]] },
    { ...path, id: "sleeve", caps: ["round", "flat"], points: 68,
      spine: [[375,292,128],[416,397,128],[480,496,117],[566,517,106],[651,454,92],[717,385,76]] },
  ];
  for (const { points, ...fixture } of fixtures) {
    const expanded = expand([fixture]);
    assert(expanded.ok, fixture.id + " expands");
    const op = expanded.value[1] as DrawingOperation;
    assert(op.type === "stroke" && op.points.length === points, fixture.id + " retains the measured reduced perimeter");
  }
  for (const bad of [
    { ...path, id: undefined }, { ...path, id: "bad id" }, { ...path, grain: 2 },
    { ...path, xy: [[1,2],[3,4]] }, { ...path, t: [0,1] }, { ...path, smooth: false },
    { ...path, corners: [] }, { ...path, html: "<script>bad</script>" },
    { ...path, caps: undefined }, { ...path, caps: ["flat"] }, { ...path, caps: ["sharp","round"] },
    { ...path, caps: Array(2) }, { ...path, spine: [[100,100,20]] },
    { ...path, spine: Array(13).fill([100,100,20]) }, { ...path, spine: [[100,100],[200,100,20]] },
    { ...path, spine: [[100,100,NaN],[200,100,20]] }, { ...path, spine: [[100,100,-1],[200,100,20]] },
    { ...path, spine: [[100,100,241],[200,100,20]] }, { ...path, spine: [[1001,100,20],[200,100,20]] },
    { ...path, spine: [[100,100,0],[200,100,0]] }, { ...path, spine: [[100,100,20],[150,100,0],[200,100,20]] },
    { ...path, spine: [[100,100,20],[100,100,30]] }, { ...path, spine: [[100,100,20],[200,100,20],[100,100,20]] },
    { ...path, spine: [[2,2,30],[220,100,20]] },
  ]) {
    const input = [path, bad], before = JSON.stringify(input);
    const expanded = expand(input);
    assert(!expanded.ok || !applyPayload({ ...header, operations: expanded.value }).ok,
      "invalid centerline or metadata rejects the entire batch");
    assert(JSON.stringify(input) === before, "invalid expansion does not mutate any input");
  }
  for (const tool of ["pencil", "ink_brush", "eraser", "unknown"]) {
    assert(!expand([path], tool).ok, "spine is rejected outside the two fill tools");
  }

  const { points: _points, ...bigPath } = fixtures[0];
  const hugePaths = Array.from({ length: 600 }, (_, i) => ({ ...bigPath, id: `tail_${i}` }));
  const tooManyPoints = expandMcpSteps([{ tool: "gouache_fill" }, { paths: hugePaths }]);
  assert(!tooManyPoints.ok && tooManyPoints.errors.join().includes("point limit"), "expanded points, not stations, enforce the batch point cap");
  assert(!expandMcpSteps([{ tool: "gouache_fill" }, { paths: Array(DRAWING_LIMITS.operations).fill(path) }]).ok,
    "operation cap still includes expanded paths");
  const basePointCount = DRAWING_LIMITS.points - 50;
  const crowded = applyPayload({ ...header, operations: [{type:"select_tool", tool:"gouache_fill"}, {
    ...region,
    points: Array.from({length:basePointCount}, (_, i) => ({x:i === 1 ? 200 : 100, y:i === 2 ? 200 : 100})),
    tValues: Array.from({length:basePointCount}, (_, i) => i === basePointCount - 1 ? 1 : i / 100_000),
  }, {type:"complete"}] });
  assert(crowded.ok, "near-limit source is a legal canonical document");
  const crowdedBefore = JSON.stringify(crowded.value);
  const oversizedDelta = expandMcpSteps([{paths:[bigPath]}, "complete"], crowded.value);
  assert(oversizedDelta.ok && !createDrawingBranch(crowded.value, {
    title:"Over limit", operations:oversizedDelta.value as DrawingOperation[],
  }).ok && JSON.stringify(crowded.value) === crowdedBefore, "base plus expanded delta cannot bypass point cap or modify source");

  const old = { id: "old", xy: [[30,30],[80,40],[60,90]], t: [0,0.2,1], smooth: true, corners: [1], grain: 0 };
  const mixed = expandMcpSteps([{ tool: "wash_fill" }, { color: "#83BBD2" }, { brushSize: 9 },
    { paths: [old, path] }, "undo", "redo", { tool: "soft_pencil" },
    { paths: [{ id: "line", xy: [[90,110],[230,110]], t: [0,1] }] },
    { tool: "eraser" }, { paths: [{ id: "cut", xy: [[150,80],[150,120]] }] }, "complete"]);
  assert(mixed.ok, "old and new paths mix with lines, erasure and history commands");
  const mixedDoc = applyPayload({ ...header, operations: mixed.value });
  assert(mixedDoc.ok, "mixed document validates");
  const legacy = mixedDoc.value.operations[3];
  assert(legacy.type === "stroke" && JSON.stringify(legacy.points) === JSON.stringify(old.xy.map(([x,y]) => ({ x,y }))) &&
    JSON.stringify(legacy.tValues) === JSON.stringify(old.t) && legacy.smooth && legacy.corners?.[0] === 1 && legacy.grain === 0,
    "legacy xy, exact t, smoothing, corners and grain are preserved without simplification");

  const base = made.value, baseBefore = JSON.stringify(base);
  const delta = expandMcpSteps([{ paths: [path] }, "undo", "redo", "complete"], base);
  assert(delta.ok, "continuation inherits the source fill tool and style");
  const branch = createDrawingBranch(base, { title: "Branch", operations: delta.value as DrawingOperation[] });
  assert(branch.ok && branch.value.id !== base.id && branch.value.latestPlaybackRange.from === base.operations.length - 1,
    "new branch retains original prefix and Latest Replay range covers only the delta");
  for (const doc of [mixedDoc.value, branch.value]) {
    const before = JSON.stringify(doc), finalPlan = createFinalRenderPlan(doc);
    assert(JSON.stringify(createFinalRenderPlan(doc)) === JSON.stringify(finalPlan), "final render plan is deterministic");
    for (const mode of ["full", "latest"] as const) {
      let last: PlaybackFrame | undefined;
      const indexes: number[] = [];
      await playDocument(doc, mode, frame => { last = frame; if (frame.transient) indexes.push(frame.operationIndex); },
        { aborted: false, addEventListener() {} } as unknown as AbortSignal);
      assert(last?.status === "ready" && JSON.stringify(last.engine) === JSON.stringify(deriveDocumentState(doc)),
        mode + " Replay finishes with the canonical final EngineState");
      assert(renderPlanToSvg(createRenderPlan(doc.canvas.background, last.engine)) === renderPlanToSvg(finalPlan),
        mode + " Replay and final Preview use the same geometry and paint");
      assert(mode === "full" || indexes.every(index => index >= doc.latestPlaybackRange.from), "Latest does not replay base drawables");
    }
    assert(JSON.stringify(doc) === before, "rendering and Replay do not change canonical content");
  }
  assert(JSON.stringify(base) === baseBefore, "source remains byte unchanged after continuation");
  return passed;
}
