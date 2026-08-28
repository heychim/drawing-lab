import {
  handleMcpRequest,
  type StoredRelayResult,
} from "./mcpServer.js";
import type { BrowserRunBindingLike } from "./mcpPreview.js";
import {
  RELAY_AES_ALGORITHM,
  RELAY_COMPRESSION,
  RELAY_ENVELOPE_VERSION,
  RELAY_REQUEST_HARD_CAP_BYTES,
  RELAY_RESULT_ID_PATTERN,
  RELAY_TTL_MS,
  base64UrlToBytes,
  bytesToBase64Url,
  validateRelayEnvelope,
  type RelayCiphertextEnvelope,
} from "./relayEnvelope.js";

export const RELAY_CREATE_WINDOW_MS = 60 * 60 * 1000;
export const RELAY_GLOBAL_CREATE_LIMIT_PER_WINDOW = 1_000;
export const RELAY_GLOBAL_LIVE_CIPHERTEXT_BYTES = 128 * 1024 * 1024;

export type D1RunResult = { success: boolean; meta?: { changes?: number } };

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

export interface RateLimitBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export type RelayWorkerEnvironment = {
  DB: D1DatabaseLike;
  RATE_LIMITER: RateLimitBindingLike;
  ALLOWED_ORIGINS: string;
  BROWSER?: BrowserRunBindingLike;
};

export type RelayWorkerOptions = {
  now?: () => number;
  resultIdFactory?: () => string;
  globalCreateLimit?: number;
  globalLiveCiphertextBytes?: number;
};

type StoredRelayRow = {
  result_id: string;
  ciphertext: ArrayBuffer | Uint8Array;
  iv: ArrayBuffer | Uint8Array;
  envelope_version: string;
  canonical_bytes: number;
  ciphertext_bytes: number;
  created_at: number;
  expires_at: number;
};

const INSERT_RESULT_SQL = `
INSERT INTO relay_results (
  result_id, ciphertext, iv, envelope_version, canonical_bytes,
  ciphertext_bytes, created_at, expires_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?
WHERE (
  SELECT COUNT(*) FROM relay_results WHERE created_at >= ?
) < ?
AND (
  SELECT COALESCE(SUM(ciphertext_bytes), 0) FROM relay_results WHERE expires_at > ?
) + ? <= ?
`;

const READ_RESULT_SQL = `
SELECT result_id, ciphertext, iv, envelope_version, canonical_bytes,
       ciphertext_bytes, created_at, expires_at
FROM relay_results
WHERE result_id = ?
LIMIT 1
`;

const CLEANUP_SQL = "DELETE FROM relay_results WHERE expires_at <= ?";

function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  return allowedOrigin === null
    ? {}
    : {
        "access-control-allow-origin": allowedOrigin,
        "vary": "Origin",
      };
}

function allowedRequestOrigin(request: Request, environment: RelayWorkerEnvironment) {
  const origin = request.headers.get("origin");
  if (origin === null) return { ok: true as const, origin: null };
  const allowedOrigins = (environment.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowedOrigins.includes(origin)
    ? { ok: true as const, origin }
    : { ok: false as const, origin: null };
}

function jsonResponse(value: unknown, status: number, allowedOrigin: string | null = null) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(allowedOrigin),
    },
  });
}

function randomResultId() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function arrayBufferFromBytes(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesFromBlob(value: ArrayBuffer | Uint8Array) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function readBoundedJson(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > RELAY_REQUEST_HARD_CAP_BYTES) {
    throw new Response(null, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > RELAY_REQUEST_HARD_CAP_BYTES) throw new Response(null, { status: 413 });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Response(null, { status: 400 });
  }
}

function createKey(request: Request) {
  // The platform Rate Limiting binding receives an ephemeral key only. It is
  // not written to D1 or application logs.
  return request.headers.get("cf-connecting-ip") ?? "anonymous";
}

export function createRelayWorker(options: RelayWorkerOptions = {}) {
  const now = options.now ?? Date.now;
  const resultIdFactory = options.resultIdFactory ?? randomResultId;
  const globalCreateLimit = options.globalCreateLimit ?? RELAY_GLOBAL_CREATE_LIMIT_PER_WINDOW;
  const globalLiveCiphertextBytes = options.globalLiveCiphertextBytes ?? RELAY_GLOBAL_LIVE_CIPHERTEXT_BYTES;

  const worker: {
    fetch(request: Request, environment: RelayWorkerEnvironment): Promise<Response>;
    scheduled(controller: unknown, environment: RelayWorkerEnvironment): Promise<void>;
  } = {
    async fetch(request: Request, environment: RelayWorkerEnvironment): Promise<Response> {
      const url = new URL(request.url);
      const cors = allowedRequestOrigin(request, environment);
      const reply = (value: unknown, status: number) => jsonResponse(value, status, cors.origin);
      const reject = (error: string, status: number) => reply({ error }, status);
      if (!cors.ok) return reject("origin_not_allowed", 403);
      if (request.method === "OPTIONS" && url.pathname === "/mcp") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(cors.origin),
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers":
              "content-type,mcp-protocol-version,mcp-method,mcp-name",
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/mcp") {
        return handleMcpRequest(
          request,
          environment,
          async (envelope, targetEnvironment, sourceRequest): Promise<StoredRelayResult> => {
            const headers = new Headers({ "content-type": "application/json" });
            const connectingIp = sourceRequest.headers.get("cf-connecting-ip");
            if (connectingIp !== null) headers.set("cf-connecting-ip", connectingIp);
            const response: Response = await worker.fetch(new Request(
              new URL("/api/results", sourceRequest.url),
              {
                method: "POST",
                headers,
                body: JSON.stringify(envelope),
              },
            ), targetEnvironment);
            let body: unknown;
            try {
              body = await response.json();
            } catch {
              return { ok: false as const, error: "relay_unavailable", status: 503 };
            }
            if (
              response.status === 201 &&
              typeof body === "object" && body !== null &&
              typeof (body as { resultId?: unknown }).resultId === "string" &&
              typeof (body as { expiresAt?: unknown }).expiresAt === "number"
            ) {
              return {
                ok: true as const,
                resultId: (body as { resultId: string }).resultId,
                expiresAt: (body as { expiresAt: number }).expiresAt,
              };
            }
            const error = typeof body === "object" && body !== null &&
              typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : "relay_unavailable";
            return { ok: false as const, error, status: response.status };
          },
          async (resultId, targetEnvironment, sourceRequest) => {
            const response: Response = await worker.fetch(new Request(
              new URL(`/api/results/${resultId}`, sourceRequest.url),
              { method: "GET" },
            ), targetEnvironment);
            let body: unknown;
            try {
              body = await response.json();
            } catch {
              return { ok: false as const, error: "relay_unavailable", status: 503 };
            }
            if (response.status === 200) {
              const validation = validateRelayEnvelope(body);
              return validation.ok
                ? { ok: true as const, envelope: validation.value }
                : { ok: false as const, error: "invalid_envelope", status: 500 };
            }
            const error = typeof body === "object" && body !== null &&
              typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : "relay_unavailable";
            return { ok: false as const, error, status: response.status };
          },
          {
            now: () => new Date(now()).toISOString(),
          },
        );
      }


      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/results")) {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(cors.origin),
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "cache-control": "no-store",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/results") {
        let rateResult: { success: boolean };
        try {
          rateResult = await environment.RATE_LIMITER.limit({ key: createKey(request) });
        } catch {
          return reject("relay_unavailable", 503);
        }
        if (!rateResult.success) return reject("rate_limited", 429);

        let input: unknown;
        try {
          input = await readBoundedJson(request);
        } catch (error) {
          if (error instanceof Response && error.status === 413) return reject("oversize", 413);
          return reject("invalid_envelope", 400);
        }
        const validation = validateRelayEnvelope(input);
        if (!validation.ok) {
          const oversize = validation.errors.some((error) => error.includes("exceeds"));
          return reject(oversize ? "oversize" : "invalid_envelope", oversize ? 413 : 400);
        }

        const envelope = validation.value;
        const ciphertext = base64UrlToBytes(envelope.ciphertext);
        const iv = base64UrlToBytes(envelope.iv);
        const createdAt = now();
        const expiresAt = createdAt + RELAY_TTL_MS;
        const resultId = resultIdFactory();
        if (!RELAY_RESULT_ID_PATTERN.test(resultId)) return reject("relay_unavailable", 503);

        try {
          const inserted = await environment.DB.prepare(INSERT_RESULT_SQL).bind(
            resultId,
            arrayBufferFromBytes(ciphertext),
            arrayBufferFromBytes(iv),
            envelope.version,
            envelope.canonicalBytes,
            ciphertext.length,
            createdAt,
            expiresAt,
            createdAt - RELAY_CREATE_WINDOW_MS,
            globalCreateLimit,
            createdAt,
            ciphertext.length,
            globalLiveCiphertextBytes,
          ).run();
          if (!inserted.success) return reject("relay_unavailable", 503);
          if ((inserted.meta?.changes ?? 0) !== 1) return reject("quota_reached", 507);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("UNIQUE") || message.includes("immutable")) {
            return reject("duplicate_result", 409);
          }
          return reject("relay_unavailable", 503);
        }
        return reply({ resultId, expiresAt }, 201);
      }

      const resultMatch = url.pathname.match(/^\/api\/results\/([A-Za-z0-9_-]+)$/u);
      if (request.method === "GET" && resultMatch) {
        const resultId = resultMatch[1];
        if (!RELAY_RESULT_ID_PATTERN.test(resultId)) return reject("not_found", 404);
        let row: StoredRelayRow | null;
        try {
          row = await environment.DB.prepare(READ_RESULT_SQL).bind(resultId).first<StoredRelayRow>();
        } catch {
          return reject("relay_unavailable", 503);
        }
        if (!row) return reject("not_found", 404);
        if (row.expires_at <= now()) return reject("expired", 410);
        if (row.envelope_version !== RELAY_ENVELOPE_VERSION) return reject("invalid_envelope", 500);
        const envelope: RelayCiphertextEnvelope = {
          version: RELAY_ENVELOPE_VERSION,
          algorithm: RELAY_AES_ALGORITHM,
          compression: RELAY_COMPRESSION,
          iv: bytesToBase64Url(bytesFromBlob(row.iv)),
          ciphertext: bytesToBase64Url(bytesFromBlob(row.ciphertext)),
          canonicalBytes: row.canonical_bytes,
        };
        const validation = validateRelayEnvelope(envelope);
        if (!validation.ok) return reject("invalid_envelope", 500);
        return reply(validation.value, 200);
      }

      if (url.pathname.startsWith("/api/results")) return reject("method_not_allowed", 405);
      return reject("not_found", 404);
    },

    async scheduled(_controller: unknown, environment: RelayWorkerEnvironment) {
      await environment.DB.prepare(CLEANUP_SQL).bind(now()).run();
    },
  };
  return worker;
}

const relayWorker = createRelayWorker();
export default relayWorker;
