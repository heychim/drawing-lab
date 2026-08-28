import type { DrawingDocument } from "./types.js";
import {
  createFinalRenderPlan,
  paintRenderPlanToCanvas,
} from "../renderer/renderPlan.js";

export const PNG_EXPORT_MIME_TYPE = "image/png";

export function createPngExportCanvas(drawing: DrawingDocument) {
  const plan = createFinalRenderPlan(drawing);
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成 PNG");
  paintRenderPlanToCanvas(context, plan);
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 生成失败"));
    }, PNG_EXPORT_MIME_TYPE);
  });
}

export async function createDrawingPng(drawing: DrawingDocument) {
  return canvasToPngBlob(createPngExportCanvas(drawing));
}
