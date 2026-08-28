import agentPayloadSchema from "../../public/drawing-schema.json" with { type: "json" };
import { createDrawingBranch } from "./drawingBranch.js";
import { getHostedHandoffEligibility } from "./hostedPolicy.js";
import { encryptDrawingDocumentForRelay } from "./relayCrypto.js";
import {
  RELAY_REQUEST_HARD_CAP_BYTES,
  type RelayCiphertextEnvelope,
} from "./relayEnvelope.js";
import { buildRelayResultUrl } from "./relayHandoff.js";
import { createMcpPreview } from "./mcpPreview.js";
import {
  restoreMcpSourceResult,
  type LoadedSourceRelayResult,
} from "./mcpSourceResult.js";
import type { RelayWorkerEnvironment } from "./relayWorker.js";
import type { DrawingDocument, DrawingOperation } from "./types.js";
import { applyPayload, validatePayload, validateStoredDocument } from "./validation.js";

export const MCP_ENDPOINT = "/mcp";
export const MCP_TOOL_NAME = "create_drawing_result";
export const MCP_CONTINUE_TOOL_NAME = "continue_drawing_result";
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LATEST_HANDSHAKE_VERSION = "2025-11-25";
export const MCP_REQUEST_HARD_CAP_BYTES = RELAY_REQUEST_HARD_CAP_BYTES;

const MCP_SERVER_INFO = {
  name: "drawing-lab",
  title: "Drawing Lab",
  version: "0.1.0",
};

const HANDSHAKE_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

type UnknownRecord = Record<string, unknown>;
type JsonRpcId = string | number | null;

export type StoredRelayResult =
  | { ok: true; resultId: string; expiresAt: number }
  | { ok: false; error: string; status: number };

export type StoreRelayResult = (
  envelope: RelayCiphertextEnvelope,
  environment: RelayWorkerEnvironment,
  request: Request,
) => Promise<StoredRelayResult>;

export type LoadRelayResult = (
  resultId: string,
  environment: RelayWorkerEnvironment,
  request: Request,
) => Promise<LoadedSourceRelayResult>;

export type McpServerOptions = {
  documentIdFactory?: () => string;
  now?: () => string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeMcpToolArguments(input: unknown): unknown {
  if (!isRecord(input) || input.schemaVersion !== 0.1) return input;
  return { ...input, schemaVersion: "0.1" };
}

const mcpInputSchema = (() => {
  const schema = structuredClone(agentPayloadSchema) as UnknownRecord;
  const properties = schema.properties as UnknownRecord;
  schema.required = ["schemaVersion", "documentAction", "title", "operations"];
  schema.properties = {
    ...properties,
    schemaVersion: { type: "string", const: "0.1" },
    documentAction: {
      const: "new_drawing",
      description: "MCP1 creates a new completed Drawing Lab result.",
    },
  };
  return schema;
})();

const mcpContinueInputSchema = (() => {
  const schema = structuredClone(agentPayloadSchema) as UnknownRecord;
  const properties = schema.properties as UnknownRecord;
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "sourceResultUrl", "title", "operations"],
    properties: {
      schemaVersion: { type: "string", const: "0.1" },
      sourceResultUrl: {
        type: "string",
        format: "uri",
        minLength: 1,
        maxLength: MCP_REQUEST_HARD_CAP_BYTES,
        description: "A Drawing Lab encrypted relay or self-contained Fragment Result URL.",
      },
      title: properties.title,
      operations: properties.operations,
    },
    $defs: schema.$defs,
  };
})();

const mcpOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "success",
    "title",
    "resultUrl",
    "transport",
    "canonicalBytes",
    "operationCount",
    "pointCount",
    "relayRetentionDays",
    "resultPersistence",
    "localSaveScope",
    "localSaveIsCloudSync",
    "localSaveGuidance",
    "previewStatus",
    "previewSourceDocumentId",
    "previewSourceRevision",
    "previewMimeType",
    "previewWidth",
    "previewHeight",
    "previewBrowserMsUsed",
    "previewUnavailableReason",
  ],
  properties: {
    success: { const: true },
    title: { type: "string" },
    resultUrl: { type: "string", format: "uri" },
    transport: { const: "encrypted_relay" },
    canonicalBytes: { type: "integer", minimum: 1, maximum: 1_048_576 },
    operationCount: { type: "integer", minimum: 1, maximum: 1_500 },
    pointCount: { type: "integer", minimum: 0, maximum: 60_000 },
    expiresAt: { type: "integer" },
    relayRetentionDays: { const: 7 },
    resultPersistence: { const: "temporary_encrypted_relay" },
    localSaveScope: { const: "current_browser" },
    localSaveIsCloudSync: { const: false },
    localSaveGuidance: { type: "string" },
    previewStatus: { enum: ["ready", "unavailable"] },
    previewSourceDocumentId: { type: "string" },
    previewSourceRevision: { type: "integer", minimum: 0 },
    previewMimeType: { enum: ["image/png", null] },
    previewWidth: { type: ["integer", "null"] },
    previewHeight: { type: ["integer", "null"] },
    previewBrowserMsUsed: { type: ["integer", "null"], minimum: 0 },
    previewUnavailableReason: {
      enum: [
        "browser_binding_missing",
        "browser_quota_exhausted",
        "browser_render_failed",
        null,
      ],
    },
  },
} as const;

export const CREATE_DRAWING_RESULT_TOOL = {
  name: MCP_TOOL_NAME,
  title: "Create Drawing Result",
  description:
    "Create a completed 1000x750 Drawing Lab result from the existing AgentDrawingPayload 0.1 schema. " +
    "Choose real pencil, brush, or eraser operations with colors, brush sizes, points, tValues, and semanticId values. " +
    "If the user asks you to draw freely without choosing a subject, decide the subject, composition, tools, colors, brush sizes, stroke order, semanticIds, and completion yourself; do not ask for a theme unless necessary. " +
    "The final operation must be complete. The encrypted relay result is temporary and expires after 7 days. " +
    "When Browser Run Free is available, the result also includes one derived 512x384 PNG preview for model inspection. " +
    "Saving in Drawing Lab stores the drawing only in that browser's Local Drawings; it is not cloud sync, and clearing site data or local storage may remove it. " +
    "If the user wants to keep the drawing long-term, suggest opening the result and choosing 保存到本地. " +
    "Do not repeat these storage notes in every chat response unless they are relevant. Do not send bitmap data, SVG, HTML, JavaScript, or executable content.",
  inputSchema: mcpInputSchema,
  outputSchema: mcpOutputSchema,
  annotations: {
    title: "Create Drawing Result",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const CONTINUE_DRAWING_RESULT_TOOL = {
  name: MCP_CONTINUE_TOOL_NAME,
  title: "Continue Drawing Result",
  description:
    "Create a new Drawing Lab result based on an existing Drawing Lab Result URL. " +
    "The source completed drawing remains immutable. Drawing Lab restores and strictly validates it, creates a new document ID, copies its real operations into a branch, removes only a terminal complete from the branch copy, then applies this tool's new operations through the existing validator. " +
    "Use real stroke, erase, undo, redo, tool, color, and brush-size operations; the final new operation must be complete. " +
    "The returned encrypted relay result expires after 7 days and includes one derived PNG preview when Browser Run Free is available. " +
    "Do not send bitmap edits, SVG, HTML, JavaScript, executable content, or third-party URLs.",
  inputSchema: mcpContinueInputSchema,
  outputSchema: mcpOutputSchema,
  annotations: {
    title: "Continue Drawing Result",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function rpcResult(id: JsonRpcId, result: UnknownRecord, modern: boolean) {
  const value = modern
    ? {
        resultType: "complete",
        ...result,
        _meta: {
          ...(isRecord(result._meta) ? result._meta : {}),
          "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
        },
      }
    : result;
  return jsonResponse({ jsonrpc: "2.0", id, result: value });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }, status);
}

async function readBoundedRequest(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MCP_REQUEST_HARD_CAP_BYTES) {
    throw new Response(null, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MCP_REQUEST_HARD_CAP_BYTES) throw new Response(null, { status: 413 });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Response(null, { status: 400 });
  }
}

function readId(input: UnknownRecord): JsonRpcId {
  return typeof input.id === "string" || typeof input.id === "number" || input.id === null
    ? input.id
    : null;
}

function readProtocolVersion(input: UnknownRecord) {
  if (!isRecord(input.params) || !isRecord(input.params._meta)) return null;
  const version = input.params._meta["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : null;
}

function validateModernHeaders(request: Request, input: UnknownRecord) {
  const method = typeof input.method === "string" ? input.method : "";
  const methodHeader = request.headers.get("mcp-method");
  if (methodHeader !== method) return "Mcp-Method header does not match the JSON-RPC method";
  if (method === "tools/call") {
    const name = isRecord(input.params) && typeof input.params.name === "string"
      ? input.params.name
      : "";
    if (request.headers.get("mcp-name") !== name) {
      return "Mcp-Name header does not match the requested tool";
    }
  }
  return null;
}

function countPoints(document: DrawingDocument) {
  return document.operations.reduce(
    (total, operation) =>
      total + (operation.type === "stroke" || operation.type === "erase"
        ? operation.points.length
        : 0),
    0,
  );
}

function markdownLabel(title: string) {
  return title
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/[\r\n]+/gu, " ");
}

function toolFailure(id: JsonRpcId, errors: string[], modern: boolean) {
  const message = errors.slice(0, 12).join("; ");
  return rpcResult(id, {
    content: [{ type: "text", text: `Drawing rejected: ${message}` }],
    isError: true,
  }, modern);
}

async function publishDrawingResult(
  id: JsonRpcId,
  request: Request,
  environment: RelayWorkerEnvironment,
  documentInput: unknown,
  storeRelayResult: StoreRelayResult,
  modern: boolean,
) {
  const storedValidation = validateStoredDocument(documentInput);
  if (!storedValidation.ok) return toolFailure(id, storedValidation.errors, modern);
  const document = storedValidation.value;
  if (document.status !== "completed") {
    return toolFailure(id, ["the final drawing operation must be complete"], modern);
  }
  const eligibility = getHostedHandoffEligibility(document);
  if (eligibility.status === "invalid") return toolFailure(id, eligibility.errors, modern);
  if (eligibility.status === "hosted_unavailable") {
    return toolFailure(id, [
      `Hosted handoff rejects canonical documents over ${eligibility.limitBytes} bytes`,
    ], modern);
  }

  const applicationUrl = new URL("/", request.url).toString();
  const encrypted = await encryptDrawingDocumentForRelay(document);
  if (!encrypted.ok) return toolFailure(id, encrypted.errors, modern);
  const stored = await storeRelayResult(encrypted.value.envelope, environment, request);
  if (!stored.ok) return toolFailure(id, [stored.error], modern);
  const resultUrl = buildRelayResultUrl(
    applicationUrl,
    stored.resultId,
    encrypted.value.fragmentKey,
  );
  const preview = await createMcpPreview(document, environment.BROWSER);

  const structuredContent = {
    success: true as const,
    title: document.title,
    resultUrl,
    transport: "encrypted_relay" as const,
    canonicalBytes: eligibility.canonicalBytes,
    operationCount: document.operations.length,
    pointCount: countPoints(document),
    expiresAt: stored.expiresAt,
    relayRetentionDays: 7 as const,
    resultPersistence: "temporary_encrypted_relay" as const,
    localSaveScope: "current_browser" as const,
    localSaveIsCloudSync: false as const,
    localSaveGuidance:
      "Open the result and choose 保存到本地 for longer retention in the current browser. This is not cloud sync; clearing site data or local storage may remove local drawings.",
    previewStatus: preview.status,
    previewSourceDocumentId: preview.sourceDocumentId,
    previewSourceRevision: preview.sourceRevision,
    previewMimeType: preview.status === "ready" ? preview.mimeType : null,
    previewWidth: preview.status === "ready" ? preview.width : null,
    previewHeight: preview.status === "ready" ? preview.height : null,
    previewBrowserMsUsed: preview.browserMsUsed,
    previewUnavailableReason: preview.status === "unavailable" ? preview.reason : null,
  };
  const content: UnknownRecord[] = [{
    type: "text",
    text: `[《${markdownLabel(document.title)}》](${resultUrl})`,
  }];
  if (preview.status === "ready") {
    content.push({
      type: "image",
      data: preview.data,
      mimeType: preview.mimeType,
      annotations: { audience: ["assistant"], priority: 1 },
    });
  }
  return rpcResult(id, {
    content,
    structuredContent,
    isError: false,
  }, modern);
}

async function createDrawingResult(
  id: JsonRpcId,
  request: Request,
  environment: RelayWorkerEnvironment,
  argumentsInput: unknown,
  storeRelayResult: StoreRelayResult,
  options: McpServerOptions,
  modern: boolean,
) {
  if (!isRecord(argumentsInput)) {
    return toolFailure(id, ["tool arguments must be an AgentDrawingPayload object"], modern);
  }
  if (argumentsInput.documentAction !== "new_drawing") {
    return toolFailure(id, ["MCP1 create_drawing_result only accepts new_drawing"], modern);
  }
  if (typeof argumentsInput.title !== "string") {
    return toolFailure(id, ["payload.title is required for an MCP drawing result"], modern);
  }

  const applied = applyPayload(argumentsInput, undefined, {
    id: options.documentIdFactory?.() ?? crypto.randomUUID(),
    now: options.now?.() ?? new Date().toISOString(),
  });
  if (!applied.ok) return toolFailure(id, applied.errors, modern);
  return publishDrawingResult(
    id,
    request,
    environment,
    applied.value,
    storeRelayResult,
    modern,
  );
}

function validateContinueArguments(input: unknown) {
  if (!isRecord(input)) {
    return { ok: false as const, errors: ["tool arguments must be an object"] };
  }
  const allowed = ["schemaVersion", "sourceResultUrl", "title", "operations"];
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`payload.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!(key in input)) errors.push(`payload.${key} is required`);
  }
  if (input.schemaVersion !== "0.1") errors.push("payload.schemaVersion must be 0.1");
  if (typeof input.sourceResultUrl !== "string" || input.sourceResultUrl.length < 1) {
    errors.push("payload.sourceResultUrl must be a Drawing Lab Result URL");
  }
  const deltaValidation = validatePayload({
    schemaVersion: input.schemaVersion,
    documentAction: "new_drawing",
    title: input.title,
    operations: input.operations,
  });
  if (!deltaValidation.ok) errors.push(...deltaValidation.errors);
  if (
    deltaValidation.ok &&
    deltaValidation.value.operations.at(-1)?.type !== "complete"
  ) {
    errors.push("the final continuation operation must be complete");
  }
  if (errors.length > 0 || !deltaValidation.ok) {
    return { ok: false as const, errors };
  }
  return {
    ok: true as const,
    value: {
      sourceResultUrl: input.sourceResultUrl as string,
      title: deltaValidation.value.title as string,
      operations: deltaValidation.value.operations as DrawingOperation[],
    },
  };
}

async function continueDrawingResult(
  id: JsonRpcId,
  request: Request,
  environment: RelayWorkerEnvironment,
  argumentsInput: unknown,
  storeRelayResult: StoreRelayResult,
  loadRelayResult: LoadRelayResult,
  options: McpServerOptions,
  modern: boolean,
) {
  const validated = validateContinueArguments(argumentsInput);
  if (!validated.ok) return toolFailure(id, validated.errors, modern);
  const applicationUrl = new URL("/", request.url).toString();
  const source = await restoreMcpSourceResult(
    validated.value.sourceResultUrl,
    applicationUrl,
    (resultId) => loadRelayResult(resultId, environment, request),
  );
  if (!source.ok) return toolFailure(id, source.errors, modern);

  const branched = createDrawingBranch(source.value, {
    title: validated.value.title,
    operations: validated.value.operations,
  }, {
    id: options.documentIdFactory?.() ?? crypto.randomUUID(),
    now: options.now?.() ?? new Date().toISOString(),
  });
  if (!branched.ok) return toolFailure(id, branched.errors, modern);
  return publishDrawingResult(
    id,
    request,
    environment,
    branched.value,
    storeRelayResult,
    modern,
  );
}

export async function handleMcpRequest(
  request: Request,
  environment: RelayWorkerEnvironment,
  storeRelayResult: StoreRelayResult,
  loadRelayResult: LoadRelayResult,
  options: McpServerOptions = {},
) {
  if (request.method !== "POST") {
    return rpcError(null, -32600, "Streamable HTTP MCP accepts POST requests", 405);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return rpcError(null, -32600, "Content-Type must be application/json", 415);
  }

  let parsed: unknown;
  try {
    parsed = await readBoundedRequest(request);
  } catch (error) {
    if (error instanceof Response && error.status === 413) {
      return rpcError(null, -32600, "MCP request exceeds its hard size cap", 413);
    }
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    return rpcError(null, -32600, "Invalid Request", 400);
  }

  const id = readId(parsed);
  const headerVersion = request.headers.get("mcp-protocol-version");
  const bodyVersion = readProtocolVersion(parsed);
  const modern = headerVersion === MCP_MODERN_PROTOCOL_VERSION ||
    bodyVersion === MCP_MODERN_PROTOCOL_VERSION;
  if (
    headerVersion !== null &&
    headerVersion !== MCP_MODERN_PROTOCOL_VERSION &&
    !HANDSHAKE_VERSIONS.has(headerVersion)
  ) {
    return rpcError(id, -32022, "Unsupported protocol version", 400, {
      supported: [MCP_MODERN_PROTOCOL_VERSION, ...HANDSHAKE_VERSIONS],
    });
  }
  if (modern) {
    const headerError = validateModernHeaders(request, parsed);
    if (headerError) return rpcError(id, -32020, headerError, 400);
  }

  if (parsed.method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  if (parsed.method === "initialize") {
    if (!isRecord(parsed.params)) return rpcError(id, -32602, "Invalid initialize params");
    const requested = parsed.params.protocolVersion;
    const protocolVersion = typeof requested === "string" && HANDSHAKE_VERSIONS.has(requested)
      ? requested
      : MCP_LATEST_HANDSHAKE_VERSION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      instructions:
        "Use create_drawing_result for a new drawing or continue_drawing_result to branch from an existing Drawing Lab Result URL.",
    }, false);
  }
  if (parsed.method === "server/discover") {
    return rpcResult(id, {
      supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions:
        "Use create_drawing_result for a new drawing or continue_drawing_result to branch from an existing Drawing Lab Result URL.",
      ttlMs: 0,
      cacheScope: "private",
    }, true);
  }
  if (parsed.method === "ping") return rpcResult(id, {}, modern);
  if (parsed.method === "tools/list") {
    return rpcResult(id, {
      tools: [CREATE_DRAWING_RESULT_TOOL, CONTINUE_DRAWING_RESULT_TOOL],
      ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
    }, modern);
  }
  if (parsed.method === "tools/call") {
    if (!isRecord(parsed.params) || typeof parsed.params.name !== "string") {
      return rpcError(id, -32602, "Invalid tools/call params");
    }
    if (parsed.params.name !== MCP_TOOL_NAME && parsed.params.name !== MCP_CONTINUE_TOOL_NAME) {
      return rpcError(id, -32601, "Unknown tool");
    }
    const argumentsInput = normalizeMcpToolArguments(parsed.params.arguments);
    if (parsed.params.name === MCP_CONTINUE_TOOL_NAME) {
      return continueDrawingResult(
        id,
        request,
        environment,
        argumentsInput,
        storeRelayResult,
        loadRelayResult,
        options,
        modern,
      );
    }
    return createDrawingResult(
      id,
      request,
      environment,
      argumentsInput,
      storeRelayResult,
      options,
      modern,
    );
  }
  return rpcError(id, -32601, "Method not found");
}
