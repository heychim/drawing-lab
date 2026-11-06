import { createInitialEngineState, deriveDocumentState } from "./engine.js";
import { CANVAS_WIDTH, CANVAS_HEIGHT, DRAWING_LIMITS, type DrawingDocument, type ValidationResult } from "./types.js";

const singleField = (key: string, schema: object) => ({
  type: "object", additionalProperties: false, required: [key], properties: { [key]: schema },
});
const array = (items: object, minItems: number, maxItems: number) => ({ type: "array", items, minItems, maxItems });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const maxPoints = DRAWING_LIMITS.points;
export const compactStepsSchema = array({ oneOf: [
  { type: "string", enum: ["undo", "redo", "complete"] },
  ...["tool", "color", "brushSize"].map(key => singleField(key, ref(key))),
  singleField("paths", array({
    type: "object", additionalProperties: false, required: ["id", "xy"],
    properties: {
      id: ref("semanticId"),
      xy: array({ type: "array", minItems: 2, maxItems: 2,
        prefixItems: [CANVAS_WIDTH, CANVAS_HEIGHT].map(maximum => ({ type: "number", minimum: 0, maximum })) }, 2, maxPoints),
      t: array({ type: "number", minimum: 0, maximum: 1 }, 2, maxPoints),
      smooth: ref("smooth"),
      corners: ref("corners"),
      grain: ref("grain"),
    },
    if: { required: ["corners"] },
    then: { required: ["smooth"], properties: { smooth: { const: true } } },
  }, 1, DRAWING_LIMITS.operations)),
] }, 1, DRAWING_LIMITS.operations);

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (message: string) => ({ ok: false as const, errors: [message] });

// Output is still untrusted: both callers must use their normal canonical validators.
export function expandMcpSteps(steps: unknown, source?: DrawingDocument): ValidationResult<unknown[]> {
  if (!Array.isArray(steps) || !steps.length || steps.length > DRAWING_LIMITS.operations)
    return invalid("steps must be a nonempty bounded array");
  const initial = source ? deriveDocumentState(source) : createInitialEngineState();
  let tool: unknown = initial.tool;
  let color: unknown = initial.color;
  let brushSize: unknown = initial.brushSize;
  const operations: unknown[] = [];
  let pointCount = 0;
  for (const [i, step] of steps.entries()) {
    const at = `steps[${i}]`;
    if (operations.length >= DRAWING_LIMITS.operations) return invalid("expanded operation limit exceeded");
    if (step === "undo" || step === "redo" || step === "complete") {
      operations.push({ type: step });
      continue;
    }
    if (!record(step) || Object.keys(step).length !== 1) return invalid(at + " must contain one command");
    if ("tool" in step) {
      tool = step.tool;
      operations.push({ type: "select_tool", tool });
    } else if ("color" in step) {
      color = step.color;
      operations.push({ type: "set_color", color });
    } else if ("brushSize" in step) {
      brushSize = step.brushSize;
      operations.push({ type: "set_brush_size", brushSize });
    } else {
      if (!Array.isArray(step.paths) || !step.paths.length) return invalid(at + ".paths must be a nonempty array");
      if (operations.length + step.paths.length > DRAWING_LIMITS.operations) return invalid("expanded operation limit exceeded");
      for (const [j, path] of step.paths.entries()) {
        const location = at + `.paths[${j}]`;
        if (!record(path) || !("id" in path) || Object.keys(path).some(k => !["id","xy","t","smooth","corners","grain"].includes(k)) ||
            !Array.isArray(path.xy) || path.xy.length < 2) return invalid(location + " requires id and xy with at least two points");
        pointCount += path.xy.length;
        if (pointCount > maxPoints) return invalid("expanded point limit exceeded");
        if ("t" in path && (!Array.isArray(path.t) || path.t.length !== path.xy.length)) return invalid(location + ".t must match xy length");
        const points = [];
        for (const pair of path.xy) {
          if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)) return invalid(location + ".xy requires [x,y] pairs");
          points.push({ x: pair[0], y: pair[1] });
        }
        operations.push({ ...(tool === "eraser" ? {type:"erase"} : {type:"stroke",color}),
          tool, brushSize, semanticId: path.id, points,
          ...("smooth" in path && { smooth: path.smooth }),
          ...("corners" in path && { corners: path.corners }),
          ...("grain" in path && { grain: path.grain }),
          tValues: "t" in path ? path.t : points.map((_, k) => k / (points.length - 1)) });
      }
    }
  }
  return { ok: true, value: operations };
}
