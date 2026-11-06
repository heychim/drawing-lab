import type { RenderCommand } from "./curvePath.js";
import type { RenderPlan, RenderPlanPass } from "./renderPlan.js";
import type { PaintRegion } from "./paintRegion.js";
import { GRAIN_TILE_SIZE, pigmentGrain } from "./pigmentGrain.js";

export const MCP_PREVIEW_WIDTH = 512;
export const MCP_PREVIEW_HEIGHT = 384;

function number(value: number) {
  return Number(value.toFixed(4)).toString();
}

function pathData(commands: RenderCommand[]) {
  return commands.map((command) => {
    if (command.type === "move") {
      return `M ${number(command.point.x)} ${number(command.point.y)}`;
    }
    if (command.type === "line") {
      return `L ${number(command.point.x)} ${number(command.point.y)}`;
    }
    return `C ${number(command.control1.x)} ${number(command.control1.y)} ${number(command.control2.x)} ${number(command.control2.y)} ${number(command.point.x)} ${number(command.point.y)}`;
  }).join(" ");
}

function attribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function regionSvg(region: PaintRegion, color: string, index: number) {
  const p = region.paint, id = `region-${index}`;
  const { x, y, radius, stops } = p.field;
  const paintStops = stops.map(([offset, alpha]) =>
    `<stop offset="${offset}" stop-color="${color}" stop-opacity="${alpha / 255}"/>`).join("");
  const partial = region.revealRadius !== undefined;
  const spread = partial ? `<clipPath id="${id}-spread"><circle cx="${p.origin.x}" cy="${p.origin.y}" r="${region.revealRadius}"/></clipPath>` : "";
  const rim = p.rimWidth ? `<use href="#${id}" fill="none" stroke="${color}" stroke-width="${p.rimWidth}" stroke-linejoin="round" opacity="${p.rimAlpha}"/>` : "";
  const rect = `<rect x="${p.origin.x - p.extent}" y="${p.origin.y - p.extent}" width="${2 * p.extent}" height="${2 * p.extent}"`;
  const grainOpacity = p.grain === 1 ? "" : ` opacity="${p.grain}"`;
  const grain = p.grain > 0 ? `${rect} fill="url(#grain-${p.medium})"${grainOpacity}/>` : "";
  const area = `<g clip-path="url(#${id}-clip)">${rect} fill="url(#${id}-field)"/>${grain}<path d="${p.marks}" fill="${attribute(p.markColor)}" opacity="${p.markAlpha}"/>${rim}</g>`;
  return `<defs><path id="${id}" d="${p.boundary}" clip-rule="evenodd"/><clipPath id="${id}-clip"><use href="#${id}" clip-rule="evenodd"/></clipPath><radialGradient id="${id}-field" gradientUnits="userSpaceOnUse" cx="${x}" cy="${y}" r="${radius}">${paintStops}</radialGradient>${spread}</defs>` +
    (partial ? `<g clip-path="url(#${id}-spread)">${area}</g>` : area);
}

export function renderPlanToSvg(
  plan: RenderPlan,
  width = MCP_PREVIEW_WIDTH,
  height = MCP_PREVIEW_HEIGHT,
) {
  const media = new Set(plan.strokes.flatMap(s => s.region && s.region.paint.grain > 0 ? [s.region.paint.medium] : []));
  const patterns = [...media].map(medium => {
    const layers = pigmentGrain(medium).map(l => `<path d="${l.d}" fill="${l.color}" opacity="${l.alpha}"/>`).join("");
    return `<defs><pattern id="grain-${medium}" patternUnits="userSpaceOnUse" width="${GRAIN_TILE_SIZE}" height="${GRAIN_TILE_SIZE}">${layers}</pattern></defs>`;
  }).join("");
  const paths = plan.strokes.flatMap((stroke, index) => {
    if (stroke.region) return regionSvg(stroke.region, attribute(stroke.strokeStyle), index);
    if (stroke.ink) return stroke.ink.map(layer =>
      `<path d="${layer.d}" fill="${attribute(stroke.strokeStyle)}" opacity="${number(layer.opacity)}"/>`);
    const passes: RenderPlanPass[] = stroke.passes ?? [{
      strokeStyle: stroke.strokeStyle,
      lineWidth: stroke.lineWidth,
      globalAlpha: stroke.globalAlpha,
      offsetX: 0,
      offsetY: 0,
      lineCap: "round",
      lineJoin: "round",
      lineDash: [],
      lineDashOffset: 0,
    }];
    let element = `<path d="${pathData(stroke.commands)}"`;
    let geometry = "";
    if (passes.length > 1) {
      const id = `brush-${index}`;
      const use = `<use href="#${id}"`;
      const definition = `<defs>${element} id="${id}"/></defs>`;
      // A short mark can cost fewer bytes inline than its definition and references.
      if (definition.length + passes.length * use.length < passes.length * element.length) {
        geometry = definition;
        element = use;
      }
    }
    return geometry + passes.map((renderPass) => {
      const transform = renderPass.offsetX === 0 && renderPass.offsetY === 0
        ? ""
        : ` transform="translate(${number(renderPass.offsetX)} ${number(renderPass.offsetY)})"`;
      const dash = renderPass.lineDash.length === 0
        ? ""
        : ` stroke-dasharray="${renderPass.lineDash.map(number).join(" ")}" stroke-dashoffset="${number(renderPass.lineDashOffset)}"`;
      return `${element} fill="none" stroke="${attribute(renderPass.strokeStyle)}" stroke-width="${number(renderPass.lineWidth)}" stroke-linecap="${renderPass.lineCap}" stroke-linejoin="${renderPass.lineJoin}" opacity="${number(renderPass.globalAlpha)}"${transform}${dash}/>`;
    }).join("");
  }).join("");
  return `<svg id="drawing-preview" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${plan.width} ${plan.height}"><rect width="${plan.width}" height="${plan.height}" fill="${attribute(plan.background)}"/>${patterns}${paths}</svg>`;
}

export function renderPlanToPreviewHtml(plan: RenderPlan) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${MCP_PREVIEW_WIDTH}px;height:${MCP_PREVIEW_HEIGHT}px;overflow:hidden}svg{display:block}</style></head><body>${renderPlanToSvg(plan)}</body></html>`;
}
