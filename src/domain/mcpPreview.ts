import type { DrawingDocument } from "./types.js";
import { createFinalRenderPlan } from "../renderer/renderPlan.js";
import {
  MCP_PREVIEW_HEIGHT,
  MCP_PREVIEW_WIDTH,
  renderPlanToPreviewHtml,
} from "../renderer/svgPreview.js";

export const MCP_PREVIEW_MIME_TYPE = "image/png";
export const MCP_PREVIEW_RESPONSE_HARD_CAP_BYTES = 2 * 1024 * 1024;

export type BrowserRunBindingLike = {
  quickAction(
    action: "screenshot",
    input: {
      html: string;
      selector: string;
      viewport: { width: number; height: number };
    },
  ): Promise<Response>;
};

export type McpPreviewResult =
  | {
      status: "ready";
      mimeType: typeof MCP_PREVIEW_MIME_TYPE;
      width: number;
      height: number;
      data: string;
      sourceDocumentId: string;
      sourceRevision: number;
      browserMsUsed: number | null;
    }
  | {
      status: "unavailable";
      reason: "browser_binding_missing" | "browser_quota_exhausted" | "browser_render_failed";
      sourceDocumentId: string;
      sourceRevision: number;
      browserMsUsed: number | null;
    };

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function browserMsUsed(response: Response) {
  const value = response.headers.get("x-browser-ms-used");
  if (value === null) return null;
  const milliseconds = Number.parseInt(value, 10);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

export async function createMcpPreview(
  document: DrawingDocument,
  browser: BrowserRunBindingLike | undefined,
): Promise<McpPreviewResult> {
  const sourceDocumentId = document.id;
  const sourceRevision = document.currentRevision;
  if (!browser) {
    return {
      status: "unavailable",
      reason: "browser_binding_missing",
      sourceDocumentId,
      sourceRevision,
      browserMsUsed: null,
    };
  }

  const plan = createFinalRenderPlan(document);
  let response: Response;
  try {
    response = await browser.quickAction("screenshot", {
      html: renderPlanToPreviewHtml(plan),
      selector: "#drawing-preview",
      viewport: { width: MCP_PREVIEW_WIDTH, height: MCP_PREVIEW_HEIGHT },
    });
  } catch {
    return {
      status: "unavailable",
      reason: "browser_render_failed",
      sourceDocumentId,
      sourceRevision,
      browserMsUsed: null,
    };
  }

  const measuredBrowserMs = browserMsUsed(response);
  if (response.status === 429) {
    return {
      status: "unavailable",
      reason: "browser_quota_exhausted",
      sourceDocumentId,
      sourceRevision,
      browserMsUsed: measuredBrowserMs,
    };
  }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith(MCP_PREVIEW_MIME_TYPE)) {
    return {
      status: "unavailable",
      reason: "browser_render_failed",
      sourceDocumentId,
      sourceRevision,
      browserMsUsed: measuredBrowserMs,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.length === 0 ||
    bytes.length > MCP_PREVIEW_RESPONSE_HARD_CAP_BYTES ||
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
  ) {
    return {
      status: "unavailable",
      reason: "browser_render_failed",
      sourceDocumentId,
      sourceRevision,
      browserMsUsed: measuredBrowserMs,
    };
  }

  return {
    status: "ready",
    mimeType: MCP_PREVIEW_MIME_TYPE,
    width: MCP_PREVIEW_WIDTH,
    height: MCP_PREVIEW_HEIGHT,
    data: bytesToBase64(bytes),
    sourceDocumentId: plan.sourceDocumentId,
    sourceRevision: plan.sourceRevision,
    browserMsUsed: measuredBrowserMs,
  };
}
