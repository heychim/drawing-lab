import type { Point, StrokeOperation } from "../domain/types.js";
import type { DerivedPath, PathSegment } from "./curvePath.js";

export type InkLayer = { d: string; opacity: number };
type Station = Point & { t: number; distance: number; nx: number; ny: number; radius: number };
const cache = new WeakMap<StrokeOperation, { stations: Station[]; final?: InkLayer[] }>();
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const xy = (x: number, y: number) => `${+x.toFixed(2)} ${+y.toFixed(2)}`;

function onCurve(s: PathSegment, t: number): Point {
  const u = 1 - t;
  if (s.type === "line") return { x: u*s.start.x + t*s.end.x, y: u*s.start.y + t*s.end.y };
  const a = u*u*u, b = 3*u*u*t, c = 3*u*t*t, d = t*t*t;
  return {
    x: a*s.start.x + b*s.control1.x + c*s.control2.x + d*s.end.x,
    y: a*s.start.y + b*s.control1.y + c*s.control2.y + d*s.end.y,
  };
}

function sample(path: DerivedPath, op: StrokeOperation) {
  const spans = path.segments.map(s => s.type === "line" ? dist(s.start,s.end) :
    dist(s.start,s.control1) + dist(s.control1,s.control2) + dist(s.control2,s.end));
  const extent = spans.reduce((a,b) => a+b, 0);
  // Resolve both shoulders of even a very short mark. Preserve the usual
  // spacing for longer lines and a finite denominator for stationary taps.
  const spacing = Math.max(Number.EPSILON, extent / 256, Math.min(3, extent / 8));
  const stations: Station[] = [{ ...path.start, t:0, distance:0, nx:0, ny:1, radius:0 }];
  for (const [i,s] of path.segments.entries()) {
    const n = Math.max(1, Math.ceil(spans[i] / spacing));
    for (let j=1; j<=n; j++) {
      const point = onCurve(s,j/n);
      const last = stations[stations.length-1];
      stations.push({ ...point, t:j === n ? s.tEnd : s.tStart+(s.tEnd-s.tStart)*j/n,
        distance:last.distance+dist(point,last), nx:0, ny:1, radius:0 });
    }
  }
  const last = stations.length-1;
  const length = stations[last].distance;
  const loop = length > 0 && dist(stations[0],stations[last]) < 0.001;
  const contact = Math.min(1, length / op.brushSize);
  for (const [i,p] of stations.entries()) {
    const prev = stations[i === 0 && loop ? last-1 : Math.max(0,i-1)];
    const next = stations[i === last && loop ? 1 : Math.min(last,i+1)];
    const span = dist(prev,next);
    p.nx = span > 0 ? -(next.y-prev.y)/span : prev.nx;
    p.ny = span > 0 ? (next.x-prev.x)/span : prev.ny;
    const u = length ? p.distance/length : 0;
    // Distance along the complete stroke controls lift-off, including during Replay.
    const taper = loop ? 1 : contact * Math.sqrt(Math.max(0, Math.min(1,
      p.distance/Math.max(1,Math.min(length*0.24,op.brushSize*3)),
      (length-p.distance)/Math.max(1,Math.min(length*0.34,op.brushSize*5)))));
    const nib = Math.abs(0.8*p.nx + 0.6*p.ny);
    const rhythm = 0.92 - 0.08*Math.cos(2*Math.PI*u);
    const pressure = op.tool === "ink_brush" ? (0.10+0.90*taper)*(0.30+0.70*nib)*rhythm :
      (0.29+0.71*taper)*(0.72+0.28*nib);
    p.radius = Math.max(0.22, op.brushSize*0.5*pressure);
  }
  return stations;
}

function offset(p: Station, k: number) {
  return xy(p.x+p.nx*p.radius*k,p.y+p.ny*p.radius*k);
}

function layers(points: Station[], pencil: boolean, seed: number, stationCount: number): InkLayer[] {
  if (points.length < 2) return [];
  if (points.at(-1)!.distance === 0) {
    const {x,y,radius:r} = points[0];
    return [{d:`M${xy(x-r,y)}a${r} ${r} 0 1 0 ${2*r} 0a${r} ${r} 0 1 0 ${-2*r} 0Z`,opacity:pencil?0.55:0.96}];
  }
  function ribbon(left: (p:Station,i:number)=>number, right: (p:Station,i:number)=>number) {
    const a = points.map((p,i)=>offset(p,left(p,i)));
    const b = points.map((p,i)=>offset(p,right(p,i))).reverse();
    return "M"+a.join("L")+"L"+b.join("L")+"Z";
  }
  if (!pencil) return [{ d:ribbon(()=>1,()=>-1), opacity:0.96 }];
  // Uneven graphite deposits across the width. Noise uses the stable station
  // index so revealing more of the stroke never redistributes earlier grains.
  function grain(i:number, lane:number) {
    let h = Math.imul(i+1,0x45d9f3b) ^ Math.imul(lane+1,0x27d4eb2d) ^ seed;
    h = Math.imul(h ^ (h>>>16),0x45d9f3b);
    return ((h ^ (h>>>16)) >>> 0) / 4294967296;
  }
  const body = ribbon((_,i)=>0.72+0.28*grain(i,4),(_,i)=>-0.72-0.28*grain(i,5));
  const deposits: string[] = [];
  // Budget only the grain; the silhouette follows every original station.
  // Choose one candidate from each stratum of the FULL stroke so replay
  // exposes exactly the same grains as the final image.
  const cells = (stationCount-1)*3;
  const budget = Math.min(192, cells);
  for (let slot=0; slot<budget; slot++) {
    const first = Math.floor(slot*cells/budget);
    const endExclusive = Math.floor((slot+1)*cells/budget);
    const cell = first + Math.floor(grain(slot,20)*(endExclusive-first));
    const i = 1 + Math.floor(cell/3);
    if (i >= points.length) break;
    const lane = cell%3;
    if (grain(i,lane+12) < 0.22) continue;
    const k = (lane-1)*0.54;
    const start = k+0.44*(grain(i-1,lane)-0.5);
    const end = k+0.44*(grain(i,lane)-0.5);
    const half = 0.10+0.17*grain(i,lane+6);
    deposits.push("M"+offset(points[i-1],start-half)+"L"+offset(points[i],end-half)+
      "L"+offset(points[i],end+half)+"L"+offset(points[i-1],start+half)+"Z");
  }
  return [{d:body,opacity:0.36},{d:deposits.join(""),opacity:0.53}];
}

export function naturalInk(op: StrokeOperation, path: DerivedPath, progress: number, tip: Point): InkLayer[] {
  let entry = cache.get(op);
  if (!entry) {
    entry = {stations:sample(path,op)};
    cache.set(op,entry);
  }
  if (progress >= 1 && entry.final) return entry.final;
  const stations = entry.stations;
  const stop = progress >= 1 ? -1 : stations.findIndex(p=>p.t > progress);
  const visible = stop < 0 ? stations : stations.slice(0,stop);
  const prev = visible.at(-1);
  if (stop > 0 && prev && progress > prev.t) {
    const next = stations[stop];
    const f = (progress-prev.t)/(next.t-prev.t);
    visible.push({...tip,t:progress,distance:prev.distance+dist(prev,tip),
      nx:prev.nx+(next.nx-prev.nx)*f,ny:prev.ny+(next.ny-prev.ny)*f,
      radius:prev.radius+(next.radius-prev.radius)*f});
  }
  let seed = 0;
  for (const ch of op.semanticId) seed = Math.imul(31,seed)+ch.charCodeAt(0) | 0;
  const result = layers(visible,op.tool === "soft_pencil",seed,stations.length);
  if (progress >= 1) entry.final = result;
  return result;
}
