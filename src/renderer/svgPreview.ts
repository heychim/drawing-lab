import type { RenderCommand } from "./curvePath.js";
import type { RenderPlan } from "./renderPlan.js";

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

export function renderPlanToSvg(
  plan: RenderPlan,
  width = MCP_PREVIEW_WIDTH,
  height = MCP_PREVIEW_HEIGHT,
) {
  const paths = plan.strokes.map((stroke) =>
    `<path d="${pathData(stroke.commands)}" fill="none" stroke="${attribute(stroke.strokeStyle)}" stroke-width="${number(stroke.lineWidth)}" stroke-linecap="round" stroke-linejoin="round" opacity="${number(stroke.globalAlpha)}"/>`
  ).join("");
  return `<svg id="drawing-preview" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${plan.width} ${plan.height}"><rect width="${plan.width}" height="${plan.height}" fill="${attribute(plan.background)}"/>${paths}</svg>`;
}

export function renderPlanToPreviewHtml(plan: RenderPlan) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${MCP_PREVIEW_WIDTH}px;height:${MCP_PREVIEW_HEIGHT}px;overflow:hidden}svg{display:block}</style></head><body>${renderPlanToSvg(plan)}</body></html>`;
}
