import { deriveDocumentState } from "../src/domain/engine.js";
import { createDrawingBranch } from "../src/domain/drawingBranch.js";
import {
  buildFragmentResultUrl,
  createFragmentResult,
} from "../src/domain/fragmentHandoff.js";
import {
  MCP_CONTINUE_TOOL_NAME,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_REQUEST_HARD_CAP_BYTES,
  MCP_TOOL_NAME,
} from "../src/domain/mcpServer.js";
import { restoreMcpSourceResult } from "../src/domain/mcpSourceResult.js";
import { decryptRelayDrawingDocument } from "../src/domain/relayCrypto.js";
import { RELAY_TTL_MS } from "../src/domain/relayEnvelope.js";
import { parseRelayResultUrl } from "../src/domain/relayHandoff.js";
import { createRelayWorker } from "../src/domain/relayWorker.js";
import { createFinalRenderPlan } from "../src/renderer/renderPlan.js";
import { renderPlanToPreviewHtml, renderPlanToSvg } from "../src/renderer/svgPreview.js";
import {
  DRAWING_LIMITS,
  type AgentDrawingPayload,
  type DrawingDocument,
} from "../src/domain/types.js";
import { applyPayload, validatePayload, validateStoredDocument } from "../src/domain/validation.js";
import { createMemoryWorkerEnvironment, MemoryBrowserRun } from "./relay-worker-mock.js";

type JsonObject = Record<string, unknown>;

const payload: AgentDrawingPayload = {
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "MCP sleepy cat",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 8 },
    {
      type: "stroke",
      semanticId: "cat_sleepy_back",
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 8,
      points: [{ x: 280, y: 410 }, { x: 380, y: 350 }, { x: 500, y: 360 }, { x: 590, y: 420 }],
      tValues: [0, 0.33, 0.66, 1],
    },
    { type: "set_color", color: "#C98595" },
    { type: "set_brush_size", brushSize: 5 },
    { type: "select_tool", tool: "brush" },
    {
      type: "stroke",
      semanticId: "cat_sleepy_nose",
      tool: "brush",
      color: "#C98595",
      brushSize: 5,
      points: [{ x: 315, y: 405 }, { x: 325, y: 410 }, { x: 335, y: 405 }],
      tValues: [0, 0.5, 1],
    },
    { type: "complete" },
  ],
};

function createLargePayload(): AgentDrawingPayload {
  const operations: AgentDrawingPayload["operations"] = [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 8 },
  ];
  for (let strokeIndex = 0; strokeIndex < 200; strokeIndex += 1) {
    const points = Array.from({ length: 40 }, (_, pointIndex) => ({
      x: Number((((strokeIndex * 97 + pointIndex * 193) * 0.6180339887) % 1000).toFixed(4)),
      y: Number((((strokeIndex * 61 + pointIndex * 157) * 0.4142135623) % 750).toFixed(4)),
    }));
    operations.push({
      type: "stroke",
      semanticId: `large_stroke_${strokeIndex}`,
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 8,
      points,
      tValues: Array.from({ length: 40 }, (_, pointIndex) =>
        Number((pointIndex / 39).toFixed(6))),
    });
  }
  operations.push({ type: "complete" });
  return {
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: "MCP large relay drawing",
    operations,
  };
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as JsonObject;
}

function semanticJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(semanticJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${semanticJson((value as JsonObject)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://drawing-lab.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function callBody(
  argumentsInput: unknown,
  id: string | number = 3,
  name = MCP_TOOL_NAME,
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: argumentsInput },
  };
}

function structuredResult(body: unknown) {
  const rpc = asObject(body);
  const result = asObject(rpc.result);
  return {
    result,
    structured: typeof result.structuredContent === "object" && result.structuredContent !== null
      ? asObject(result.structuredContent)
      : {},
    content: asObject((result.content as unknown[])[0]),
    contents: result.content as JsonObject[],
  };
}

export async function runMcpTests() {
  let passed = 0;
  const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) throw new Error(`FAIL: ${message}`);
    passed += 1;
  };

  const worker = createRelayWorker({
    now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    resultIdFactory: () => "R".repeat(24),
  });
  const environment = createMemoryWorkerEnvironment();

  const authlessDiscoveryPaths = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/authorize",
    "/token",
    "/register",
  ];
  for (const path of authlessDiscoveryPaths) {
    const response = await worker.fetch(
      new Request(`https://drawing-lab.test${path}`),
      environment,
    );
    assert(
      response.status === 404 &&
        response.headers.get("content-type")?.startsWith("application/json") === true &&
        response.headers.get("www-authenticate") === null,
      `authless MCP returns an explicit JSON 404 without an OAuth challenge for ${path}`,
    );
  }

  const mcpGet = await worker.fetch(new Request("https://drawing-lab.test/mcp", {
    headers: { accept: "application/json, text/event-stream" },
  }), environment);
  assert(
    mcpGet.status === 405 &&
      mcpGet.headers.get("content-type")?.startsWith("application/json") === true &&
      mcpGet.headers.get("www-authenticate") === null,
    "stateless Streamable HTTP MCP rejects unsupported GET without advertising OAuth",
  );

  const initialize = await worker.fetch(request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "drawing-lab-test", version: "1.0.0" },
    },
  }), environment);
  const initializeBody = asObject(await initialize.json());
  const initializeResult = asObject(initializeBody.result);
  assert(
    initialize.status === 200 &&
      initializeResult.protocolVersion === "2025-06-18" &&
      asObject(initializeResult.capabilities).tools !== undefined,
    "MCP initialize negotiates a handshake protocol and advertises tools",
  );

  const initialized = await worker.fetch(request({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }), environment);
  assert(initialized.status === 202 && (await initialized.text()) === "", "MCP initialized notification is accepted without a response body");

  const listResponse = await worker.fetch(request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }), environment);
  const listBody = asObject(await listResponse.json());
  const listResult = asObject(listBody.result);
  const tools = listResult.tools as JsonObject[];
  const tool = asObject(tools.find((entry) => entry.name === MCP_TOOL_NAME));
  const continueTool = asObject(tools.find((entry) => entry.name === MCP_CONTINUE_TOOL_NAME));
  const inputSchema = asObject(tool.inputSchema);
  const inputProperties = asObject(inputSchema.properties);
  assert(
    listResponse.status === 200 &&
      tools.length === 2 &&
      tool.name === MCP_TOOL_NAME &&
      asObject(inputProperties.documentAction).const === "new_drawing",
    "MCP tools/list exposes create_drawing_result using the AgentDrawingPayload schema",
  );
  assert(
    Array.isArray(inputSchema.required) &&
      inputSchema.required.includes("title") &&
      asObject(inputProperties.schemaVersion).type === "string" &&
      asObject(inputProperties.schemaVersion).const === "0.1" &&
      "$defs" in inputSchema,
    "MCP create schema explicitly requires string schemaVersion 0.1 and reuses canonical operations",
  );
  const schemaDefinitions = asObject(inputSchema.$defs);
  const exposedTools = asObject(schemaDefinitions.tool).enum;
  assert(
    Array.isArray(exposedTools) &&
      ["pencil", "brush", "graphite", "watercolor", "marker", "soft_pencil", "ink_brush", "wash_fill", "gouache_fill", "eraser"].every((name) =>
        exposedTools.includes(name)),
    "MCP tools/list publishes all legacy and art-brush canonical tools",
  );
  assert(
    typeof tool.description === "string" &&
      tool.description.includes("expires after 7 days") &&
      tool.description.includes("not cloud sync") &&
      tool.description.includes("保存到本地") &&
      tool.description.includes("graphite, watercolor, marker"),
    "MCP tool description gives concise relay retention and local-save guidance to the assistant",
  );
  const continueSchema = asObject(continueTool.inputSchema);
  const continueProperties = asObject(continueSchema.properties);
  for (const schema of [inputSchema, continueSchema]) {
    assert(asObject(asObject(schema.properties).steps).type === "array" &&
      !((schema.required as string[]).includes("operations")) &&
      JSON.stringify(schema.allOf).includes('{"oneOf":[{"required":["steps"]},{"required":["operations"]}]}'),
      "tools/list advertises steps and operations as exclusive alternatives");
  }
  assert(
    continueTool.name === MCP_CONTINUE_TOOL_NAME &&
      asObject(continueProperties.schemaVersion).type === "string" &&
      asObject(continueProperties.schemaVersion).const === "0.1" &&
      typeof continueProperties.sourceResultUrl === "object" &&
      typeof continueProperties.operations === "object" &&
      "$defs" in continueSchema,
    "MCP tools/list exposes a separate continue_drawing_result that reuses canonical operations",
  );
  assert(
    typeof tool.description === "string" &&
      tool.description.includes("draw freely") &&
      typeof continueTool.description === "string" &&
      continueTool.description.includes("new document ID") &&
      continueTool.description.includes("source completed drawing remains immutable"),
    "MCP descriptions explain autonomous Free Draw and immutable branch continuation",
  );

  const modernDiscover = await worker.fetch(request({
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }, {
    "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
    "mcp-method": "server/discover",
  }), environment);
  const modernDiscoverResult = asObject(asObject(await modernDiscover.json()).result);
  assert(
    modernDiscover.status === 200 &&
      (modernDiscoverResult.supportedVersions as string[]).includes(MCP_MODERN_PROTOCOL_VERSION) &&
      modernDiscoverResult.resultType === "complete" &&
      modernDiscoverResult.cacheScope === "private",
    "MCP current stateless server/discover path is available with conservative cache hints",
  );

  const headerMismatch = await worker.fetch(request({
    jsonrpc: "2.0",
    id: "bad-header",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
      },
    },
  }, {
    "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
    "mcp-method": "tools/call",
  }), environment);
  assert(headerMismatch.status === 400, "MCP modern header/body mismatch fails closed");

  const validResponse = await worker.fetch(request(callBody(payload)), environment);
  const validBody = await validResponse.json();
  const validResult = structuredResult(validBody);
  const resultUrl = String(validResult.structured.resultUrl);
  assert(
    validResponse.status === 200 &&
      validResult.result.isError === false &&
      validResult.structured.transport === "encrypted_relay" &&
      environment.DB.rows.size === 1,
    "create_drawing_result sends a small completed payload through encrypted relay",
  );
  const numericCreateEnvironment = createMemoryWorkerEnvironment();
  const compactEnvironment = createMemoryWorkerEnvironment();
  const compactWorker = createRelayWorker();
  const callCompact = async (args: JsonObject, name = MCP_TOOL_NAME) =>
    structuredResult(await (await compactWorker.fetch(request(callBody(args, 3, name)), compactEnvironment)).json());
  const readCompact = async (url: unknown) => {
    const location = parseRelayResultUrl(String(url));
    if (!location) throw new Error("missing compact result");
    const read = await compactWorker.fetch(new Request("https://drawing-lab.test/api/results/" + location.resultId), compactEnvironment);
    const restored = await decryptRelayDrawingDocument(await read.json(), location.fragmentKey);
    if (!restored.ok) throw new Error("could not restore compact result");
    return restored.value;
  };
  const compactHeader = {schemaVersion:"0.1", documentAction:"new_drawing", title:"Compact fixture"};
  const mark = {id:"horizon", xy:[[20,10],[35,50],[80,10]], t:[0,0.3,1]};
  const compactCreated = await callCompact({...compactHeader, steps:[
    {tool:"graphite"}, {color:"#53576A"}, {brushSize:12}, {paths:[mark]}, "complete",
  ]});
  const base = await readCompact(compactCreated.structured.resultUrl);
  const baseMark = base.operations[3];
  assert(baseMark.type === "stroke" && baseMark.semanticId === mark.id && baseMark.tValues[1] === 0.3,
    "compact create publishes canonical stroke with exact custom curve parameters");
  const branchHeader = {schemaVersion:"0.1", sourceResultUrl:compactCreated.structured.resultUrl, title:"New horizon"};
  const compactBranch = await callCompact({...branchHeader, steps:[
    {paths:[{id:"ridge",xy:mark.xy},mark]}, "undo", "redo", {tool:"eraser"}, {paths:[mark]}, "complete",
  ]}, MCP_CONTINUE_TOOL_NAME);
  const branchDoc = await readCompact(compactBranch.structured.resultUrl);
  const firstNew = branchDoc.operations[branchDoc.latestPlaybackRange.from];
  assert(firstNew.type === "stroke" && firstNew.tool === "graphite" && firstNew.color === "#53576A" &&
    firstNew.brushSize === 12 && firstNew.tValues[1] === 0.5 &&
    branchDoc.operations.slice(branchDoc.latestPlaybackRange.from).map(op=>op.type).join() === "stroke,stroke,undo,redo,select_tool,erase,complete",
    "compact continuation inherits restored style, derives uniform progression and keeps pen lifts and history order");
  assert(semanticJson(base) === semanticJson(await readCompact(compactCreated.structured.resultUrl)),
    "compact branch leaves source Result intact");
  for (const bad of [
    {...compactHeader, steps:["complete"], operations:[]}, compactHeader,
    {...compactHeader, steps:[{paths:[{...mark,t:null}]},"complete"]},
    {...compactHeader, steps:[{paths:[{...mark, xy:[[12,30,99],[30,40]]}]},"complete"]},
    {...compactHeader, steps:[{paths:[{...mark,id:"bad id"}]},"complete"]},
    {...compactHeader, steps:[{tool:"wash_fill"},{paths:[mark,{...mark,grain:"0.3"}]},"complete"]},
    {...compactHeader, steps:[{paths:Array(1500).fill(mark)},"complete"]},
  ]) {
    const rejected = await callCompact(bad);
    assert(rejected.result.isError === true && compactEnvironment.DB.rows.size === 2,
      "ambiguous or invalid compact creation fails without storing a result");
  }
  const invalidBranch = await callCompact({...branchHeader, steps:[{paths:[{...mark,t:[0,1,0]}]},"complete"]}, MCP_CONTINUE_TOOL_NAME);
  assert(invalidBranch.result.isError === true && compactEnvironment.DB.rows.size === 2,
    "invalid compact continuation preserves source and publishes no result");
  const wash = await callCompact({ ...compactHeader, steps: [{tool:"wash_fill"}, {paths:[{...mark, smooth:true, grain:0.3}]}, "complete"] });
  const overlay = await callCompact({ schemaVersion:"0.1", title:"Painted ridge", sourceResultUrl:wash.structured.resultUrl,
    steps:[{tool:"gouache_fill"}, {paths:[{...mark, smooth:true, corners:[1], grain:0}]}, "complete"] }, MCP_CONTINUE_TOOL_NAME);
  const mixedPaint = await readCompact(overlay.structured.resultUrl);
  assert(createFinalRenderPlan(mixedPaint).strokes.map(s => s.region?.paint.medium).join() === "wash_fill,gouache_fill",
    "MCP compact create and continue round-trip both region materials through the existing encrypted Result");
  const marks = mixedPaint.operations.filter(op => op.type === "stroke");
  assert(marks.length === 2 && marks.every(op => op.smooth && op.points.length === mark.xy.length) &&
    marks[0].corners === undefined && marks[1].corners?.join() === "1", "encrypted branch preserves sparse curves and corner indices");
  assert(marks[0].grain === 0.3 && marks[1].grain === 0,
    "compact create and continue preserve fractional and zero paper grain through encrypted restore");
  const beforeBadCorner = compactEnvironment.DB.rows.size;
  const badCorner = await callCompact({ ...compactHeader, steps:[{tool:"gouache_fill"},
    {paths:[{...mark, smooth:true, corners:[mark.xy.length]}]}, "complete"] });
  assert(badCorner.result.isError === true && compactEnvironment.DB.rows.size === beforeBadCorner,
    "invalid compact corner cannot publish a result");
  const numericCreateResult = structuredResult(await (await createRelayWorker({
    now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    resultIdFactory: () => "V".repeat(24),
  }).fetch(request(callBody({ ...payload, schemaVersion: 0.1 })), numericCreateEnvironment)).json());
  assert(
    numericCreateResult.result.isError === false && numericCreateEnvironment.DB.rows.size === 1,
    "MCP create normalizes numeric schemaVersion 0.1 before strict payload validation",
  );
  assert(
    !validatePayload({ ...payload, schemaVersion: 0.1 }).ok,
    "canonical payload validation remains string-only outside the MCP adapter",
  );
  for (const invalidVersion of [0.2, "0.2"]) {
    const invalidVersionEnvironment = createMemoryWorkerEnvironment();
    const invalidVersionResult = structuredResult(await (await createRelayWorker().fetch(
      request(callBody({ ...payload, schemaVersion: invalidVersion })),
      invalidVersionEnvironment,
    )).json());
    assert(
      invalidVersionResult.result.isError === true && invalidVersionEnvironment.DB.rows.size === 0,
      `MCP create rejects unsupported ${typeof invalidVersion} schemaVersion without a result`,
    );
  }
  assert(
    validResult.content.text === `[《${payload.title}》](${resultUrl})` &&
      validResult.content.text.split(resultUrl).length === 2 &&
      validResult.structured.resultUrl === resultUrl,
    "MCP human-facing content contains one title-labelled link while structured output retains the URL",
  );
  assert(
    validResult.structured.relayRetentionDays === 7 &&
      validResult.structured.resultPersistence === "temporary_encrypted_relay" &&
      validResult.structured.localSaveScope === "current_browser" &&
      validResult.structured.localSaveIsCloudSync === false &&
      String(validResult.structured.localSaveGuidance).includes("保存到本地"),
    "MCP structured result exposes non-destructive retention and local-save metadata",
  );
  const previewImage = validResult.contents.find((item) => item.type === "image");
  assert(
    validResult.structured.previewStatus === "ready" &&
      validResult.structured.previewMimeType === "image/png" &&
      validResult.structured.previewWidth === 512 &&
      validResult.structured.previewHeight === 384 &&
      validResult.structured.previewBrowserMsUsed === 137 &&
      previewImage?.mimeType === "image/png" &&
      typeof previewImage.data === "string",
    "MCP success includes model-visible PNG ImageContent and measured Browser Run usage",
  );
  assert(
    environment.BROWSER.calls.length === 1 &&
      environment.BROWSER.calls[0].action === "screenshot" &&
      environment.BROWSER.calls[0].input.selector === "#drawing-preview" &&
      environment.BROWSER.calls[0].input.viewport.width === 512 &&
      environment.BROWSER.calls[0].input.viewport.height === 384,
    "MCP creates at most one 512x384 Browser Run preview per successful drawing",
  );
  const browserHtml = environment.BROWSER.calls[0].input.html;
  const browserKey = parseRelayResultUrl(resultUrl)?.fragmentKey;
  assert(
    !browserHtml.includes(resultUrl) &&
      (browserKey === undefined || !browserHtml.includes(browserKey)) &&
      !browserHtml.includes(payload.title ?? "__missing_title__") &&
      !browserHtml.includes("semanticId") &&
      !browserHtml.includes("operations"),
    "Browser Run receives only derived drawing geometry, never Result URL, key, title, or canonical history",
  );
  assert(
    validResult.contents.length === 2 &&
      validResult.contents[0].type === "text" &&
      validResult.contents[1].type === "image" &&
      !String(validResult.content.text).includes(String(previewImage?.data ?? "__missing_preview__")),
    "preview base64 is MCP ImageContent rather than human-facing chat text",
  );

  const renderPayload: AgentDrawingPayload = {
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: "Render plan fixture",
    operations: [
      { type: "select_tool", tool: "pencil" },
      { type: "set_color", color: "#E36B75" },
      { type: "set_brush_size", brushSize: 9 },
      {
        type: "stroke",
        semanticId: "red_sun",
        tool: "pencil",
        color: "#E36B75",
        brushSize: 9,
        points: [{ x: 100, y: 100 }, { x: 150, y: 60 }, { x: 200, y: 100 }],
        tValues: [0, 0.5, 1],
      },
      { type: "select_tool", tool: "brush" },
      { type: "set_color", color: "#6D9DD1" },
      { type: "set_brush_size", brushSize: 15 },
      {
        type: "stroke",
        semanticId: "blue_house",
        tool: "brush",
        color: "#6D9DD1",
        brushSize: 15,
        points: [{ x: 650, y: 500 }, { x: 760, y: 410 }, { x: 870, y: 500 }],
        tValues: [0, 0.5, 1],
      },
      { type: "select_tool", tool: "eraser" },
      { type: "set_brush_size", brushSize: 22 },
      {
        type: "erase",
        semanticId: "house_window_cut",
        tool: "eraser",
        brushSize: 22,
        points: [{ x: 745, y: 475 }, { x: 775, y: 475 }],
        tValues: [0, 1],
      },
      { type: "undo" },
      { type: "redo" },
      { type: "select_tool", tool: "brush" },
      { type: "set_color", color: "#75B89C" },
      { type: "set_brush_size", brushSize: 7 },
      {
        type: "stroke",
        semanticId: "removed_green_mark",
        tool: "brush",
        color: "#75B89C",
        brushSize: 7,
        points: [{ x: 400, y: 300 }, { x: 450, y: 350 }],
        tValues: [0, 1],
      },
      { type: "undo" },
      { type: "complete" },
    ],
  };
  const renderDocumentResult = applyPayload(renderPayload, undefined, {
    id: "render-plan-document",
    now: "2026-08-27T00:00:00.000Z",
  });
  assert(renderDocumentResult.ok, "shared render-plan fixture passes canonical validation");
  if (!renderDocumentResult.ok) throw new Error("render-plan fixture failed");
  const renderDocument = renderDocumentResult.value;
  const renderDocumentBefore = JSON.stringify(renderDocument);
  const renderPlan = createFinalRenderPlan(renderDocument);
  const renderSvgA = renderPlanToSvg(renderPlan);
  const renderSvgB = renderPlanToSvg(createFinalRenderPlan(renderDocument));
  assert(
    renderSvgA === renderSvgB &&
      renderPlanToPreviewHtml(renderPlan) === renderPlanToPreviewHtml(createFinalRenderPlan(renderDocument)),
    "shared preview SVG and HTML are deterministic for one canonical revision",
  );
  assert(
    renderPlan.sourceDocumentId === renderDocument.id &&
      renderPlan.sourceRevision === renderDocument.currentRevision &&
      renderPlan.sourceOperationCount === renderDocument.operations.length,
    "preview render plan records the exact canonical document identity and revision",
  );
  assert(
    renderPlan.strokes.length === 3 &&
      renderPlan.strokes.some((stroke) => stroke.tool === "pencil" && stroke.strokeStyle === "#E36B75" && stroke.globalAlpha === 0.92) &&
      renderPlan.strokes.some((stroke) => stroke.tool === "brush" && stroke.strokeStyle === "#6D9DD1" && stroke.globalAlpha === 1) &&
      renderPlan.strokes.some((stroke) => stroke.type === "erase" && stroke.strokeStyle === renderDocument.canvas.background),
    "shared render plan preserves multiple tools/colors and renders erase with the canonical background",
  );
  assert(
    !renderPlan.strokes.some((stroke) => stroke.strokeStyle === "#75B89C") &&
      deriveDocumentState(renderDocument).drawables.filter((entry) => entry.active).length === renderPlan.strokes.length,
    "shared render plan follows final undo/redo active drawable state",
  );
  assert(
    renderPlan.strokes.every((stroke) => stroke.commands.length >= 2) &&
      renderPlan.strokes.some((stroke) => stroke.commands.some((command) => command.type === "cubic")),
    "shared render plan reuses existing curvePath commands",
  );
  assert(
    JSON.stringify(renderDocument) === renderDocumentBefore &&
      !renderSvgA.includes(renderDocument.id) &&
      !renderSvgA.includes("semanticId") &&
      !renderSvgA.includes("operations"),
    "preview derivation does not mutate or serialize canonical history into the Browser artifact",
  );
  assert(
    resultUrl.length < 512 &&
      !resultUrl.includes("#drawing=") &&
      !resultUrl.includes(payload.title ?? "") &&
      !resultUrl.includes("operations"),
    "MCP small Result URL stays compact and contains no canonical DrawingDocument payload",
  );
  const smallLocation = parseRelayResultUrl(resultUrl);
  assert(smallLocation !== null, "MCP small Result URL uses the existing encrypted relay format");
  if (!smallLocation) throw new Error("small relay URL parse failed");
  const smallRead = await worker.fetch(
    new Request(`https://drawing-lab.test/api/results/${smallLocation.resultId}`),
    environment,
  );
  const smallRestored = await decryptRelayDrawingDocument(
    await smallRead.json(),
    smallLocation.fragmentKey,
  );
  assert(
    smallRead.status === 200 && smallRestored.ok && validateStoredDocument(smallRestored.value).ok,
    "MCP small relay Result decrypts and passes strict stored-document validation",
  );
  if (!smallRestored.ok) throw new Error("small relay restore failed");
  const expected = applyPayload(payload, undefined, {
    id: smallRestored.value.id,
    now: smallRestored.value.createdAt,
  });
  assert(
    expected.ok &&
      JSON.stringify(expected.value) === JSON.stringify(smallRestored.value),
    "MCP small relay restores the same canonical DrawingDocument",
  );
  assert(
    expected.ok &&
      JSON.stringify(deriveDocumentState(expected.value)) ===
        JSON.stringify(deriveDocumentState(smallRestored.value)),
    "MCP small relay reaches the same Full Replay final EngineState",
  );
  const smallRow = environment.DB.rows.get(smallLocation.resultId);
  assert(
    smallRow !== undefined &&
      smallRow.expires_at - smallRow.created_at === RELAY_TTL_MS &&
      validResult.structured.expiresAt === smallRow.expires_at &&
      !("preview" in smallRow) &&
      !("image" in smallRow),
    "MCP relay preserves the existing seven-day TTL and never persists preview data",
  );

  const quotaPreviewWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T00:30:00.000Z"),
    resultIdFactory: () => "P".repeat(24),
  });
  const quotaPreviewEnvironment = createMemoryWorkerEnvironment();
  quotaPreviewEnvironment.BROWSER = new MemoryBrowserRun(() => new Response("quota", {
    status: 429,
    headers: { "content-type": "text/plain", "x-browser-ms-used": "0" },
  }));
  const quotaPreviewBody = structuredResult(await (await quotaPreviewWorker.fetch(
    request(callBody(payload, "preview-quota")),
    quotaPreviewEnvironment,
  )).json());
  assert(
    quotaPreviewBody.result.isError === false &&
      quotaPreviewBody.structured.transport === "encrypted_relay" &&
      quotaPreviewBody.structured.previewStatus === "unavailable" &&
      quotaPreviewBody.structured.previewUnavailableReason === "browser_quota_exhausted" &&
      quotaPreviewBody.structured.previewBrowserMsUsed === 0 &&
      quotaPreviewEnvironment.DB.rows.size === 1,
    "Browser Run 429 degrades preview only while the encrypted drawing result still succeeds",
  );
  assert(
    quotaPreviewEnvironment.BROWSER.calls.length === 1 &&
      !quotaPreviewBody.contents.some((item) => item.type === "image") &&
      typeof quotaPreviewBody.structured.resultUrl === "string",
    "preview quota fallback makes one attempt, returns no fake image, and preserves the Result URL",
  );

  const failedPreviewWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T00:45:00.000Z"),
    resultIdFactory: () => "F".repeat(24),
  });
  const failedPreviewEnvironment = createMemoryWorkerEnvironment();
  failedPreviewEnvironment.BROWSER = new MemoryBrowserRun(() => new Response("failed", {
    status: 500,
    headers: { "content-type": "text/plain", "x-browser-ms-used": "21" },
  }));
  const failedPreviewBody = structuredResult(await (await failedPreviewWorker.fetch(
    request(callBody(payload, "preview-failed")),
    failedPreviewEnvironment,
  )).json());
  assert(
    failedPreviewBody.result.isError === false &&
      failedPreviewBody.structured.previewStatus === "unavailable" &&
      failedPreviewBody.structured.previewUnavailableReason === "browser_render_failed" &&
      failedPreviewBody.structured.previewBrowserMsUsed === 21 &&
      failedPreviewEnvironment.BROWSER.calls.length === 1 &&
      failedPreviewEnvironment.DB.rows.size === 1,
    "non-quota Browser Run failure also preserves the drawing result without retrying",
  );

  const activeSource = applyPayload({
    ...payload,
    title: "Active branch source",
    operations: payload.operations.slice(0, -1),
  }, undefined, {
    id: "active-source-document",
    now: "2026-08-27T00:50:00.000Z",
  });
  assert(activeSource.ok && activeSource.value.status === "active", "active branch fixture is canonical and unsealed");
  if (!activeSource.ok) throw new Error("active branch fixture failed");
  const activeSourceBefore = JSON.stringify(activeSource.value);
  const activeBranch = createDrawingBranch(activeSource.value, {
    title: "Active branch result",
    operations: [{ type: "complete" }],
  }, {
    id: "active-branch-document",
    now: "2026-08-27T00:51:00.000Z",
  });
  assert(
    activeBranch.ok &&
      activeBranch.value.id === "active-branch-document" &&
      activeBranch.value.status === "completed" &&
      activeBranch.value.latestPlaybackRange.from === activeSource.value.operations.length &&
      JSON.stringify(activeSource.value) === activeSourceBefore,
    "active source branches to a new ID with an exact Latest Replay boundary and no source mutation",
  );

  const nearLimitSource = applyPayload({
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: "Near operation limit",
    operations: Array.from({ length: 1498 }, () => ({
      type: "select_tool" as const,
      tool: "pencil" as const,
    })),
  }, undefined, { id: "near-limit-source" });
  assert(nearLimitSource.ok, "near-limit branch source is valid before appending");
  if (!nearLimitSource.ok) throw new Error("near-limit source failed");
  const nearLimitBefore = JSON.stringify(nearLimitSource.value);
  const oversizeBranch = createDrawingBranch(nearLimitSource.value, {
    title: "Too large branch",
    operations: [
      { type: "select_tool", tool: "brush" },
      { type: "select_tool", tool: "pencil" },
      { type: "complete" },
    ],
  }, { id: "oversize-branch" });
  assert(
    !oversizeBranch.ok &&
      oversizeBranch.errors.some((error) => error.includes("1500 operations")) &&
      JSON.stringify(nearLimitSource.value) === nearLimitBefore,
    "base plus delta operation cap fails closed without mutating its source",
  );

  const branchPointCount = DRAWING_LIMITS.points - 4;
  const pointBranchSource = applyPayload({
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: "Near point limit branch",
    operations: [
      { type: "select_tool", tool: "pencil" },
      { type: "set_color", color: "#6B4F4F" },
      { type: "set_brush_size", brushSize: 3 },
      {
        type: "stroke",
        semanticId: "branch_point_base",
        tool: "pencil",
        color: "#6B4F4F",
        brushSize: 3,
        points: Array.from({ length: branchPointCount }, () => ({ x: 0, y: 0 })),
        tValues: Array.from(
          { length: branchPointCount },
          (_, index) => index === branchPointCount - 1 ? 1 : index / 100_000,
        ),
      },
    ],
  }, undefined, { id: "near-point-branch-source" });
  assert(pointBranchSource.ok, "near-point-limit branch source is valid");
  if (!pointBranchSource.ok) throw new Error("point branch source failed");
  const pointSourceBefore = JSON.stringify(pointBranchSource.value);
  const pointOversizeBranch = createDrawingBranch(pointBranchSource.value, {
    title: "Point oversize branch",
    operations: [
      {
        type: "stroke",
        semanticId: "branch_point_delta",
        tool: "pencil",
        color: "#6B4F4F",
        brushSize: 3,
        points: Array.from({ length: 5 }, (_, index) => ({ x: index + 1, y: index + 1 })),
        tValues: [0, 0.25, 0.5, 0.75, 1],
      },
      { type: "complete" },
    ],
  }, { id: "point-oversize-branch" });
  assert(
    !pointOversizeBranch.ok &&
      pointOversizeBranch.errors.some((error) => error.includes("60000 points")) &&
      JSON.stringify(pointBranchSource.value) === pointSourceBefore,
    "base plus delta point cap fails closed without partial points or source mutation",
  );

  const serializedPointCount = 38_196;
  const serializedBranchSource = applyPayload({
    schemaVersion: "0.1",
    documentAction: "new_drawing",
    title: "Size fixture",
    operations: [
      { type: "select_tool", tool: "pencil" },
      { type: "set_color", color: "#6B4F4F" },
      { type: "set_brush_size", brushSize: 3 },
      {
        type: "stroke",
        semanticId: "s".repeat(42),
        tool: "pencil",
        color: "#6B4F4F",
        brushSize: 3,
        points: Array.from({ length: serializedPointCount }, (_, index) => ({
          x: 123.12345678901234 + (index % 2),
          y: 456.12345678901234 + (index % 2),
        })),
        tValues: Array.from(
          { length: serializedPointCount },
          (_, index) => index === serializedPointCount - 1 ? 1 : index / 100_000,
        ),
      },
    ],
  }, undefined, {
    id: "serialized-branch-source",
    now: "2026-08-27T00:52:00.000Z",
  });
  assert(serializedBranchSource.ok, "near-serialized-limit branch source is valid");
  if (!serializedBranchSource.ok) throw new Error("serialized branch source failed");
  const serializedSourceBefore = JSON.stringify(serializedBranchSource.value);
  const serializedOversizeBranch = createDrawingBranch(serializedBranchSource.value, {
    title: "Size fixture",
    operations: [
      { type: "select_tool", tool: "pencil" },
      { type: "select_tool", tool: "pencil" },
      { type: "complete" },
    ],
  }, {
    id: "serialized-branch-source",
    now: "2026-08-27T00:52:00.000Z",
  });
  assert(
    !serializedOversizeBranch.ok &&
      serializedOversizeBranch.errors.some((error) => error.includes("serialized bytes")) &&
      JSON.stringify(serializedBranchSource.value) === serializedSourceBefore,
    "base plus delta 2 MiB cap fails closed without changing the source document",
  );

  let branchResultIndex = 0;
  const branchWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T03:00:00.000Z"),
    resultIdFactory: () => `${String.fromCharCode(65 + branchResultIndex++).repeat(23)}0`,
  });
  const branchEnvironment = createMemoryWorkerEnvironment();
  const sourceCall = structuredResult(await (await branchWorker.fetch(
    request(callBody(payload, "branch-source")),
    branchEnvironment,
  )).json());
  const sourceResultUrl = String(sourceCall.structured.resultUrl);
  const sourceLocation = parseRelayResultUrl(sourceResultUrl);
  assert(sourceLocation !== null, "completed branch source is an encrypted Drawing Lab Result");
  if (!sourceLocation) throw new Error("branch source URL failed");
  const sourceReadBefore = await branchWorker.fetch(
    new Request(`https://drawing-lab.test/api/results/${sourceLocation.resultId}`),
    branchEnvironment,
  );
  const sourceDocumentBefore = await decryptRelayDrawingDocument(
    await sourceReadBefore.json(),
    sourceLocation.fragmentKey,
  );
  assert(sourceDocumentBefore.ok, "completed source decrypts before branching");
  if (!sourceDocumentBefore.ok) throw new Error("branch source decrypt failed");
  const sourceCanonicalBefore = JSON.stringify(sourceDocumentBefore.value);

  const continueOperations: AgentDrawingPayload["operations"] = [
    { type: "select_tool", tool: "brush" },
    { type: "set_color", color: "#E9A3C3" },
    { type: "set_brush_size", brushSize: 9 },
    {
      type: "stroke",
      semanticId: "new_pink_star",
      tool: "brush",
      color: "#E9A3C3",
      brushSize: 9,
      points: [
        { x: 680, y: 150 }, { x: 700, y: 190 }, { x: 745, y: 195 },
        { x: 710, y: 225 }, { x: 720, y: 270 }, { x: 680, y: 245 },
        { x: 640, y: 270 }, { x: 650, y: 225 }, { x: 615, y: 195 },
        { x: 660, y: 190 }, { x: 680, y: 150 },
      ],
      tValues: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    },
    { type: "select_tool", tool: "eraser" },
    { type: "set_brush_size", brushSize: 4 },
    {
      type: "erase",
      semanticId: "soften_old_nose",
      tool: "eraser",
      brushSize: 4,
      points: [{ x: 318, y: 404 }, { x: 333, y: 408 }],
      tValues: [0, 1],
    },
    { type: "complete" },
  ];
  const continueCall = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl,
      title: "MCP sleepy cat with star",
      operations: continueOperations,
    }, "branch-result", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  assert(
    continueCall.result.isError === false &&
      continueCall.structured.title === "MCP sleepy cat with star" &&
      continueCall.structured.previewStatus === "ready" &&
      continueCall.contents.some((item) => item.type === "image") &&
      branchEnvironment.DB.rows.size === 2,
    "continue_drawing_result restores an encrypted source and returns a compact branch Result with preview",
  );
  const numericContinueCall = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: 0.1,
      sourceResultUrl,
      title: "MCP numeric schema branch",
      operations: continueOperations,
    }, "numeric-branch-result", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  const numericContinueRowCount: number = branchEnvironment.DB.rows.size;
  assert(
    numericContinueCall.result.isError === false && numericContinueRowCount === 3,
    "MCP continue normalizes numeric schemaVersion 0.1 before strict delta validation",
  );
  for (const invalidVersion of [0.2, "0.2"]) {
    const rowsBeforeInvalidVersion: number = branchEnvironment.DB.rows.size;
    const invalidContinueCall = structuredResult(await (await branchWorker.fetch(
      request(callBody({
        schemaVersion: invalidVersion,
        sourceResultUrl,
        title: "MCP invalid schema branch",
        operations: continueOperations,
      }, `invalid-branch-${typeof invalidVersion}`, MCP_CONTINUE_TOOL_NAME)),
      branchEnvironment,
    )).json());
    assert(
      invalidContinueCall.result.isError === true &&
        branchEnvironment.DB.rows.size === rowsBeforeInvalidVersion,
      `MCP continue rejects unsupported ${typeof invalidVersion} schemaVersion without a result`,
    );
  }
  const branchUrl = String(continueCall.structured.resultUrl);
  const branchLocation = parseRelayResultUrl(branchUrl);
  assert(branchLocation !== null && branchUrl.length < 512, "continued branch uses the existing compact relay Result format");
  if (!branchLocation) throw new Error("branch result URL failed");
  const branchRead = await branchWorker.fetch(
    new Request(`https://drawing-lab.test/api/results/${branchLocation.resultId}`),
    branchEnvironment,
  );
  const branchDocument = await decryptRelayDrawingDocument(
    await branchRead.json(),
    branchLocation.fragmentKey,
  );
  assert(branchDocument.ok, "continued branch decrypts through existing relay validation");
  if (!branchDocument.ok) throw new Error("branch result decrypt failed");
  const expectedBase = sourceDocumentBefore.value.operations.slice(0, -1);
  assert(
    branchDocument.value.id !== sourceDocumentBefore.value.id &&
      semanticJson(branchDocument.value.operations.slice(0, expectedBase.length)) === semanticJson(expectedBase) &&
      semanticJson(branchDocument.value.operations.slice(expectedBase.length)) === semanticJson(continueOperations) &&
      branchDocument.value.latestPlaybackRange.from === expectedBase.length &&
      branchDocument.value.latestPlaybackRange.to === branchDocument.value.operations.length,
    "completed source loses terminal complete only in the new branch and Latest Replay covers exactly the delta",
  );
  const branchState = deriveDocumentState(branchDocument.value);
  assert(
    branchState.drawables.some((entry) => entry.active && entry.operation.semanticId === "new_pink_star") &&
      branchState.drawables.some((entry) => entry.active && entry.operation.type === "erase") &&
      continueCall.structured.previewSourceDocumentId === branchDocument.value.id &&
      continueCall.structured.previewSourceRevision === branchDocument.value.currentRevision,
    "continued branch applies a new stroke and erase while preview identifies the new canonical revision",
  );
  const sourceReadAfter = await branchWorker.fetch(
    new Request(`https://drawing-lab.test/api/results/${sourceLocation.resultId}`),
    branchEnvironment,
  );
  const sourceDocumentAfter = await decryptRelayDrawingDocument(
    await sourceReadAfter.json(),
    sourceLocation.fragmentKey,
  );
  assert(
    sourceDocumentAfter.ok &&
      JSON.stringify(sourceDocumentAfter.value) === sourceCanonicalBefore,
    "opening the original encrypted Result after branching restores the byte-identical original document",
  );

  const fragment = await createFragmentResult(sourceDocumentBefore.value, 100_000);
  assert(fragment.status === "ready", "fragment continuation fixture fits a self-contained Result");
  if (fragment.status !== "ready") throw new Error("fragment source failed");
  const fragmentEnvironment = createMemoryWorkerEnvironment();
  const fragmentWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T04:00:00.000Z"),
    resultIdFactory: () => "G".repeat(24),
  });
  const fragmentSourceUrl = buildFragmentResultUrl(fragment.fragment, "https://drawing-lab.test/");
  const fragmentContinue = structuredResult(await (await fragmentWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: fragmentSourceUrl,
      title: "Fragment source branch",
      operations: [{ type: "complete" }],
    }, "fragment-branch", MCP_CONTINUE_TOOL_NAME)),
    fragmentEnvironment,
  )).json());
  assert(
    fragmentContinue.result.isError === false &&
      fragmentEnvironment.DB.rows.size === 1 &&
      fragmentEnvironment.BROWSER.calls.length === 1,
    "continue_drawing_result restores a self-contained fragment without a source relay read",
  );
  const fragmentBranchLocation = parseRelayResultUrl(String(fragmentContinue.structured.resultUrl));
  assert(fragmentBranchLocation !== null, "fragment source produces the standard compact branch Result");
  if (!fragmentBranchLocation) throw new Error("fragment branch URL failed");
  const fragmentBranchRead = await fragmentWorker.fetch(
    new Request(`https://drawing-lab.test/api/results/${fragmentBranchLocation.resultId}`),
    fragmentEnvironment,
  );
  const fragmentBranchDocument = await decryptRelayDrawingDocument(
    await fragmentBranchRead.json(),
    fragmentBranchLocation.fragmentKey,
  );
  assert(
    fragmentBranchDocument.ok &&
      semanticJson(fragmentBranchDocument.value.operations.slice(0, -1)) ===
        semanticJson(sourceDocumentBefore.value.operations.slice(0, -1)) &&
      fragmentBranchDocument.value.latestPlaybackRange.from ===
        sourceDocumentBefore.value.operations.length - 1,
    "fragment source branch preserves its canonical base and Latest Replay boundary",
  );

  let forbiddenLoaderCalls = 0;
  const forbiddenLoader = async () => {
    forbiddenLoaderCalls += 1;
    return { ok: false as const, error: "not_found", status: 404 };
  };
  const foreignRestore = await restoreMcpSourceResult(
    sourceResultUrl.replace("drawing-lab.test", "foreign.example"),
    "https://drawing-lab.test/",
    forbiddenLoader,
  );
  const forgedRestore = await restoreMcpSourceResult(
    sourceResultUrl.replace("https://drawing-lab.test/", "https://drawing-lab.test/forged"),
    "https://drawing-lab.test/",
    forbiddenLoader,
  );
  const malformedFragmentRestore = await restoreMcpSourceResult(
    "https://drawing-lab.test/#drawing=gzip.not@@base64",
    "https://drawing-lab.test/",
    forbiddenLoader,
  );
  assert(
    !foreignRestore.ok && foreignRestore.errors.includes("source_result_foreign_host") &&
      !forgedRestore.ok && forgedRestore.errors.includes("source_result_url_invalid") &&
      !malformedFragmentRestore.ok && malformedFragmentRestore.errors.includes("source_result_fragment_invalid") &&
      forbiddenLoaderCalls === 0,
    "foreign, forged-path, and malformed-fragment sources reject without any relay or generic fetch",
  );

  const branchRowsBeforeFailure = branchEnvironment.DB.rows.size;
  const branchPreviewCallsBeforeFailure = branchEnvironment.BROWSER.calls.length;
  const wrongKeyUrl = new URL(sourceResultUrl);
  wrongKeyUrl.hash = `#relay-key=${"A".repeat(43)}`;
  const wrongKeyResult = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: wrongKeyUrl.toString(),
      title: "Wrong key branch",
      operations: [{ type: "complete" }],
    }, "wrong-key", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  assert(
    wrongKeyResult.result.isError === true &&
      String(wrongKeyResult.content.text).includes("source_result_decrypt_failed") &&
      branchEnvironment.DB.rows.size === branchRowsBeforeFailure,
    "wrong relay key rejects without creating a branch Result",
  );

  const missingUrl = new URL(sourceResultUrl);
  missingUrl.searchParams.set("relayResult", "Z".repeat(24));
  const missingResult = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: missingUrl.toString(),
      title: "Missing source branch",
      operations: [{ type: "complete" }],
    }, "missing-source", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  assert(
    missingResult.result.isError === true &&
      String(missingResult.content.text).includes("source_result_not_found") &&
      branchEnvironment.DB.rows.size === branchRowsBeforeFailure,
    "missing relay source fails closed without a partial branch",
  );

  const invalidDeltaResult = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl,
      title: "Invalid delta branch",
      operations: [{ type: "unknown_operation" }],
    }, "invalid-delta", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  assert(
    invalidDeltaResult.result.isError === true &&
      branchEnvironment.DB.rows.size === branchRowsBeforeFailure &&
      branchEnvironment.BROWSER.calls.length === branchPreviewCallsBeforeFailure,
    "invalid continuation delta is rejected before source restore, result storage, or preview",
  );
  const incompleteDeltaResult = structuredResult(await (await branchWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl,
      title: "Incomplete delta branch",
      operations: [{ type: "select_tool", tool: "pencil" }],
    }, "incomplete-delta", MCP_CONTINUE_TOOL_NAME)),
    branchEnvironment,
  )).json());
  assert(
    incompleteDeltaResult.result.isError === true &&
      String(incompleteDeltaResult.content.text).includes("final continuation operation must be complete") &&
      branchEnvironment.DB.rows.size === branchRowsBeforeFailure,
    "continuation requires an explicit terminal complete and creates no partial Result",
  );

  const expiredWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T05:00:00.000Z"),
    resultIdFactory: () => "H".repeat(24),
  });
  const expiredEnvironment = createMemoryWorkerEnvironment();
  const expiringSource = structuredResult(await (await expiredWorker.fetch(
    request(callBody(payload, "expiring-source")),
    expiredEnvironment,
  )).json());
  const expiringLocation = parseRelayResultUrl(String(expiringSource.structured.resultUrl));
  assert(expiringLocation !== null, "expired-source fixture is created normally");
  if (!expiringLocation) throw new Error("expired fixture URL failed");
  const expiringRow = expiredEnvironment.DB.rows.get(expiringLocation.resultId);
  if (!expiringRow) throw new Error("expired fixture row missing");
  expiringRow.expires_at = Date.parse("2026-08-27T05:00:00.000Z");
  const expiredResult = structuredResult(await (await expiredWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: String(expiringSource.structured.resultUrl),
      title: "Expired source branch",
      operations: [{ type: "complete" }],
    }, "expired-source", MCP_CONTINUE_TOOL_NAME)),
    expiredEnvironment,
  )).json());
  assert(
    expiredResult.result.isError === true &&
      String(expiredResult.content.text).includes("source_result_expired") &&
      String(expiredResult.content.text).includes("Local Drawings") &&
      expiredEnvironment.DB.rows.size === 1,
    "expired source returns actionable source_result_expired without partial recovery or a new row",
  );

  const continueQuotaWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T06:00:00.000Z"),
    resultIdFactory: () => "I".repeat(24),
  });
  const continueQuotaEnvironment = createMemoryWorkerEnvironment();
  continueQuotaEnvironment.BROWSER = new MemoryBrowserRun(() => new Response("quota", {
    status: 429,
    headers: { "content-type": "text/plain", "x-browser-ms-used": "0" },
  }));
  const continueQuotaResult = structuredResult(await (await continueQuotaWorker.fetch(
    request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: fragmentSourceUrl,
      title: "Preview quota branch",
      operations: [{ type: "complete" }],
    }, "continue-preview-quota", MCP_CONTINUE_TOOL_NAME)),
    continueQuotaEnvironment,
  )).json());
  assert(
    continueQuotaResult.result.isError === false &&
      continueQuotaResult.structured.previewStatus === "unavailable" &&
      continueQuotaResult.structured.previewUnavailableReason === "browser_quota_exhausted" &&
      continueQuotaEnvironment.BROWSER.calls.length === 1 &&
      continueQuotaEnvironment.DB.rows.size === 1,
    "continued Result survives Browser quota with one nonfatal preview attempt",
  );

  const invalidEnvironment = createMemoryWorkerEnvironment();
  const invalidPayload = structuredClone(payload) as unknown as JsonObject;
  invalidPayload.operations = [
    ...payload.operations.slice(0, -1),
    { type: "unknown_operation" },
  ];
  const invalidBody = asObject(await (await worker.fetch(
    request(callBody(invalidPayload, 4)),
    invalidEnvironment,
  )).json());
  assert(
    asObject(invalidBody.result).isError === true &&
      invalidEnvironment.DB.rows.size === 0,
    "invalid MCP payload fails closed without creating a relay row",
  );

  const executableEnvironment = createMemoryWorkerEnvironment();
  const executablePayload = { ...payload, html: "<script>alert(1)</script>" };
  const executableBody = asObject(await (await worker.fetch(
    request(callBody(executablePayload, 5)),
    executableEnvironment,
  )).json());
  assert(
    asObject(executableBody.result).isError === true &&
      executableEnvironment.DB.rows.size === 0,
    "executable-content fields are rejected by exact-key validation without persistence",
  );

  const mismatchEnvironment = createMemoryWorkerEnvironment();
  const mismatchPayload = structuredClone(payload);
  const mismatchStroke = mismatchPayload.operations.find((operation) => operation.type === "stroke");
  if (mismatchStroke?.type === "stroke") mismatchStroke.tValues = [0, 1];
  const mismatchBody = asObject(await (await worker.fetch(
    request(callBody(mismatchPayload, 6)),
    mismatchEnvironment,
  )).json());
  assert(
    asObject(mismatchBody.result).isError === true &&
      mismatchEnvironment.DB.rows.size === 0,
    "MCP rejects mismatched points/tValues without a partial result",
  );

  const incompletePayload = { ...payload, operations: payload.operations.slice(0, -1) };
  const incompleteBody = asObject(await (await worker.fetch(
    request(callBody(incompletePayload, 7)),
    createMemoryWorkerEnvironment(),
  )).json());
  assert(asObject(incompleteBody.result).isError === true, "MCP refuses to publish a non-complete drawing");

  const oversizeResponse = await worker.fetch(new Request("https://drawing-lab.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(MCP_REQUEST_HARD_CAP_BYTES + 1),
  }), createMemoryWorkerEnvironment());
  assert(oversizeResponse.status === 413, "MCP request hard cap rejects oversize input before application");

  const relayWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T01:00:00.000Z"),
    resultIdFactory: () => "S".repeat(24),
  });
  const relayEnvironment = createMemoryWorkerEnvironment();
  const largePayload = createLargePayload();
  const relayCall = await relayWorker.fetch(request(callBody(largePayload, 8)), relayEnvironment);
  const relayBody = structuredResult(await relayCall.json());
  const relayUrl = String(relayBody.structured.resultUrl);
  assert(
    relayCall.status === 200 &&
      relayBody.structured.transport === "encrypted_relay" &&
      relayEnvironment.DB.rows.size === 1,
    "MCP large drawing uses the same encrypted relay path",
  );
  assert(
    relayUrl.length < 512 &&
      !relayUrl.includes("#drawing=") &&
      !relayUrl.includes(largePayload.title ?? "") &&
      !relayUrl.includes("operations"),
    "MCP large Result URL remains compact and contains no canonical DrawingDocument payload",
  );
  const relayLocation = parseRelayResultUrl(relayUrl);
  assert(
    relayLocation !== null &&
      !new URL(relayUrl).search.includes(relayLocation.fragmentKey) &&
      new URL(relayUrl).hash.includes(relayLocation.fragmentKey),
    "MCP relay key exists only in the Result URL fragment",
  );
  if (!relayLocation) throw new Error("relay URL parse failed");
  const relayRead = await relayWorker.fetch(
    new Request(`https://drawing-lab.test/api/results/${relayLocation.resultId}`),
    relayEnvironment,
  );
  const relayEnvelope = await relayRead.json();
  const relayRestored = await decryptRelayDrawingDocument(relayEnvelope, relayLocation.fragmentKey);
  assert(
    relayRead.status === 200 &&
      relayRestored.ok &&
      relayRestored.value.operations.length === largePayload.operations.length,
    "MCP large encrypted relay round-trip restores every canonical operation",
  );
  if (!relayRestored.ok) throw new Error("relay restore failed");
  const relayExpected = applyPayload(largePayload, undefined, {
    id: relayRestored.value.id,
    now: relayRestored.value.createdAt,
  });
  assert(
    validateStoredDocument(relayRestored.value).ok &&
      relayExpected.ok &&
      JSON.stringify(relayExpected.value) === JSON.stringify(relayRestored.value) &&
      JSON.stringify(deriveDocumentState(relayExpected.value)) ===
        JSON.stringify(deriveDocumentState(relayRestored.value)),
    "MCP large relay passes strict validation and reaches the Full Replay EngineState",
  );
  const relayRow = relayEnvironment.DB.rows.get(relayLocation.resultId);
  assert(
    relayRow !== undefined &&
      !("key" in relayRow) &&
      !JSON.stringify(relayRow).includes(largePayload.title ?? "") &&
      !JSON.stringify(relayRow).includes('"operations"'),
    "MCP D1 boundary stores ciphertext metadata only, without key or plaintext DrawingDocument",
  );

  const rateEnvironment = createMemoryWorkerEnvironment();
  rateEnvironment.RATE_LIMITER.success = false;
  const rateBody = structuredResult(await (await worker.fetch(
    request(callBody(payload, 9)),
    rateEnvironment,
  )).json());
  assert(
    rateBody.result.isError === true &&
      String(rateBody.content.text).includes("rate_limited") &&
      rateEnvironment.DB.rows.size === 0,
    "MCP create rate protection fails closed without a partial result",
  );

  const quotaWorker = createRelayWorker({
    now: () => Date.parse("2026-08-27T02:00:00.000Z"),
    resultIdFactory: () => "Q".repeat(24),
    globalCreateLimit: 0,
  });
  const quotaEnvironment = createMemoryWorkerEnvironment();
  const quotaBody = structuredResult(await (await quotaWorker.fetch(
    request(callBody(payload, 10)),
    quotaEnvironment,
  )).json());
  assert(
    quotaBody.result.isError === true &&
      String(quotaBody.content.text).includes("quota_reached") &&
      quotaEnvironment.DB.rows.size === 0,
    "MCP global relay protection fails closed without a partial row",
  );

  const logged: unknown[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...values: unknown[]) => { logged.push(values); };
  console.warn = (...values: unknown[]) => { logged.push(values); };
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    await worker.fetch(request(callBody(payload, 11)), createMemoryWorkerEnvironment());
    const logWorker = createRelayWorker({
      now: () => Date.parse("2026-08-27T07:00:00.000Z"),
      resultIdFactory: () => "J".repeat(24),
    });
    await logWorker.fetch(request(callBody({
      schemaVersion: "0.1",
      sourceResultUrl: fragmentSourceUrl,
      title: "Private continuation title",
      operations: [{ type: "complete" }],
    }, "private-continue", MCP_CONTINUE_TOOL_NAME)), createMemoryWorkerEnvironment());
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert(
    logged.length === 0 &&
      !JSON.stringify(logged).includes(payload.title ?? "") &&
      !JSON.stringify(logged).includes(fragmentSourceUrl),
    "create and continue MCP processing emit no plaintext drawing, source URL, or fragment-key logs",
  );

  const invalidCurrentDocument: DrawingDocument = smallRestored.value;
  const beforeFailure = JSON.stringify(invalidCurrentDocument);
  await worker.fetch(request(callBody(invalidPayload, 12)), createMemoryWorkerEnvironment());
  assert(
    JSON.stringify(invalidCurrentDocument) === beforeFailure,
    "MCP failure paths do not mutate an existing canonical DrawingDocument",
  );

  return passed;
}
