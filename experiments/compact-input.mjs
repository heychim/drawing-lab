// Local experiment only. From the repository root: npm test && node experiments/compact-input.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPayload } from '../.test-build/src/domain/validation.js';
import { createDrawingBranch } from '../.test-build/src/domain/drawingBranch.js';
import { deriveDocumentState } from '../.test-build/src/domain/engine.js';
import { expandMcpSteps } from '../.test-build/src/domain/mcpCompactSteps.js';
import { isPaintRegionTool } from '../.test-build/src/domain/types.js';
import { createFinalRenderPlan } from '../.test-build/src/renderer/renderPlan.js';
import { renderPlanToSvg } from '../.test-build/src/renderer/svgPreview.js';
import { createDerivedPath, commandsAtProgress } from '../.test-build/src/renderer/curvePath.js';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const uniform = n => Array.from({length: n}, (_, i) => i / (n - 1));
const controls = { select_tool: 'tool', set_color: 'color', set_brush_size: 'brushSize' };
const history = ['undo', 'redo', 'complete'];
const options = { id: 'codex-sleeping-cat', now: '2026-01-01T00:00:00Z' };
function checked(result) {
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.value;
}

// Pack verified samples as a measurement oracle. Controls are never reordered or removed.
function pack({operations, ...header}) {
  const steps = [];
  for (const op of operations) {
    if (op.type in controls) steps.push({[controls[op.type]]: op[controls[op.type]]});
    else if (history.includes(op.type)) steps.push(op.type);
    else {
      if (!steps.at(-1)?.paths) steps.push({paths: []});
      const xy = op.points.map(({x,y}) => [x,y]);
      const path = {id: op.semanticId, xy};
      if (!op.tValues.every((t,i) => t === i / (xy.length - 1))) path.t = op.tValues;
      if (op.smooth !== undefined) path.smooth = op.smooth;
      if (op.corners !== undefined) path.corners = op.corners;
      if (op.grain !== undefined) path.grain = op.grain;
      steps.at(-1).paths.push(path);
    }
  }
  return {...header, steps};
}

function expand({steps, ...header}, source) {
  return {...header, operations:checked(expandMcpSteps(steps, source))};
}

const measure = o => {
  const json = JSON.stringify(o);
  return [[...json].length, Buffer.byteLength(json)];
};
const rows = [];
let uniformCount = 0, pathCount = 0;
let tupleSavings = 0, groupingSavings = 0, uniformSavings = 0, alteredCurves = 0;
function compare(file, source) {
  const input = load(file);
  const original = input.steps ? expand(input, source) : input;
  const expected = checked(applyPayload(original, source, options));
  const compact = pack(original);
  const tuplesOnly = {...original, operations:original.operations.map(op =>
    op.points ? {...op, points:op.points.map(p=>[p.x,p.y])} : op)};
  tupleSavings += measure(original)[1] - measure(tuplesOnly)[1];
  const ungrouped = {...compact, steps:compact.steps.flatMap(step =>
    step.paths ? step.paths.map(path=>({paths:[path]})) : [step])};
  groupingSavings += measure(ungrouped)[1] - measure(compact)[1];
  const explicitTimes = {...compact, steps:compact.steps.map(step => step.paths
    ? {paths:step.paths.map(path=>({...path,t:path.t ?? uniform(path.xy.length)}))} : step)};
  uniformSavings += measure(explicitTimes)[1] - measure(compact)[1];
  const expanded = expand(JSON.parse(JSON.stringify(compact)), source);
  const actual = checked(applyPayload(expanded, source, options));
  assert.deepEqual(actual, expected);
  assert.deepEqual(expanded.operations, original.operations);
  const plan = createFinalRenderPlan(actual);
  assert.deepEqual(plan, createFinalRenderPlan(expected));
  assert.equal(renderPlanToSvg(plan), renderPlanToSvg(createFinalRenderPlan(expected)));
  for (const [i,op] of expanded.operations.entries()) {
    if (!op.points) continue;
    const other = original.operations[i];
    pathCount++;
    if (op.tValues.every((t,j) => t === j/(op.points.length-1))) uniformCount++;
    // Filled regions use their own closed boundary, already compared in the final plan.
    if (isPaintRegionTool(op.tool)) continue;
    const path = createDerivedPath(op.points, op.tValues);
    const reference = createDerivedPath(other.points, other.tValues);
    const uniformPath = createDerivedPath(op.points, uniform(op.points.length));
    if (JSON.stringify(commandsAtProgress(reference,1)) !== JSON.stringify(commandsAtProgress(uniformPath,1))) alteredCurves++;
    assert.deepEqual(path, reference);
    for (const p of [0.23,0.61,1]) assert.deepEqual(commandsAtProgress(path,p),commandsAtProgress(reference,p));
  }
  rows.push({file:file.split('/').at(-1), original:measure(original), compact:measure(compact)});
  return actual;
}
const cat = compare('drawings/codex/current.drawing.json');
compare('drawings/codex/calico-nap.steps.json');
compare('drawings/codex/calico-coat.steps.json');
compare('drawings/codex/sleeping-cat-continue-moon.drawing.json',cat);
for (const file of ['drawings/codex/nature-scene','drawings/codex/doodle-note',
  'src/examples/simple-shapes','src/examples/doodle-lettering','src/examples/art-brushes']) compare(file+'.drawing.json');

// Hand-authored compact delta inherits a completed source's brush. Two separate marks
// are one input group, so undo must target only the second and redo must restore it.
const source = checked(applyPayload({...load('drawings/codex/current.drawing.json'),
  operations:[...cat.operations,{type:'complete'}]}, undefined, options));
const before = JSON.stringify(source);
const paths = [{id:'left',xy:[[10,20],[30,40]]},{id:'right',xy:[[50,60],[70,80]]}];
const branch = steps => checked(createDrawingBranch(source, {title:'branch',
  operations:expand({steps},source).operations}, {...options,id:'new-branch'}));
const undone = branch([{paths},'undo','complete']);
assert.deepEqual(deriveDocumentState(undone).drawables.slice(-2).map(e=>e.active),[true,false]);
const redone = branch([{paths},'undo','redo','complete']);
assert.deepEqual(deriveDocumentState(redone).drawables.slice(-2).map(e=>e.active),[true,true]);
assert.equal(redone.latestPlaybackRange.from,cat.operations.length);
assert.deepEqual(redone.operations.slice(0,cat.operations.length),cat.operations);
for (const bad of [{xy:[[1,2],[2,3]]}, {...paths[0],xy:[[1,2,3],[3,4]]},
  {...paths[0],xy:[[1001,2],[3,4]]}, {...paths[0],t:[0]}, {...paths[0],color:'#FFFFFF'}]) {
  assert.throws(()=>branch([{paths:[paths[0],bad]},'complete']));
}
assert.throws(()=>branch([{tool:'invalid'},{paths}]));
assert.throws(()=>branch(['complete',{paths}]));
assert.equal(JSON.stringify(source),before);
console.table(rows.map(({file,original,compact})=>({file, chars:original[0]+' → '+compact[0],
  bytes:original[1]+' → '+compact[1]})));
console.log({uniformCount,pathCount, totals:rows.reduce(([a,b],r)=>[a+r.original[1],b+r.compact[1]],[0,0])});
console.log({tupleSavings,groupingSavings,uniformSavings,alteredCurves});
