import {
  RELAY_CIPHERTEXT_HARD_CAP_BYTES,
  RELAY_REQUEST_HARD_CAP_BYTES,
  RELAY_RESULT_ID_PATTERN,
  RELAY_TTL_MS,
  base64UrlToBytes,
  bytesToBase64Url,
  relayEnvelopeRequestBytes,
  validateRelayEnvelope,
  type RelayCiphertextEnvelope,
} from "./relayEnvelope.js";

export type RelayCreateResult = {
  resultId: string;
  expiresAt: number;
};

export interface RelayClient {
  createResult(envelope: RelayCiphertextEnvelope): Promise<RelayCreateResult>;
  getResult(resultId: string): Promise<RelayCiphertextEnvelope>;
}

export type RelayErrorCode =
  | "expired"
  | "not_found"
  | "invalid_envelope"
  | "oversize"
  | "rate_limited"
  | "quota_reached"
  | "duplicate_result"
  | "relay_unavailable";

export class RelayClientError extends Error {
  constructor(
    public readonly code: RelayErrorCode,
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "RelayClientError";
  }
}

function makeResultId() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function assertResultId(resultId: string) {
  if (!RELAY_RESULT_ID_PATTERN.test(resultId)) {
    throw new RelayClientError("not_found", "relay result id is invalid", 404);
  }
}

function assertEnvelope(envelope: unknown) {
  const validation = validateRelayEnvelope(envelope);
  if (!validation.ok) {
    const oversize = validation.errors.some((error) => error.includes("exceeds"));
    throw new RelayClientError(
      oversize ? "oversize" : "invalid_envelope",
      validation.errors.join("; "),
      400,
    );
  }
  return validation.value;
}

function endpointForResult(endpoint: string, resultId?: string) {
  const normalized = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return resultId ? `${normalized}/${encodeURIComponent(resultId)}` : normalized;
}

function errorCodeFromStatus(status: number, fallback: RelayErrorCode): RelayErrorCode {
  if (status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 413) return "oversize";
  if (status === 429) return "rate_limited";
  if (status === 507) return "quota_reached";
  if (status === 409) return "duplicate_result";
  return fallback;
}

export class HttpRelayClient implements RelayClient {
  constructor(private readonly endpoint = "/api/results") {}

  async createResult(envelopeInput: RelayCiphertextEnvelope): Promise<RelayCreateResult> {
    const envelope = assertEnvelope(envelopeInput);
    const body = JSON.stringify(envelope);
    if (new TextEncoder().encode(body).length > RELAY_REQUEST_HARD_CAP_BYTES) {
      throw new RelayClientError("oversize", "relay create request exceeds its hard cap", 413);
    }
    let response: Response;
    try {
      response = await fetch(endpointForResult(this.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      throw new RelayClientError("relay_unavailable", "relay create is unavailable");
    }
    if (!response.ok) {
      throw new RelayClientError(
        errorCodeFromStatus(response.status, "relay_unavailable"),
        `relay create failed with ${response.status}`,
        response.status,
      );
    }
    const value: unknown = await response.json();
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      !RELAY_RESULT_ID_PATTERN.test((value as { resultId?: unknown }).resultId as string) ||
      !Number.isInteger((value as { expiresAt?: unknown }).expiresAt)
    ) {
      throw new RelayClientError("relay_unavailable", "relay create response is invalid");
    }
    return {
      resultId: (value as { resultId: string }).resultId,
      expiresAt: (value as { expiresAt: number }).expiresAt,
    };
  }

  async getResult(resultId: string): Promise<RelayCiphertextEnvelope> {
    assertResultId(resultId);
    let response: Response;
    try {
      response = await fetch(endpointForResult(this.endpoint, resultId), { method: "GET" });
    } catch {
      throw new RelayClientError("relay_unavailable", "relay read is unavailable");
    }
    if (!response.ok) {
      throw new RelayClientError(
        errorCodeFromStatus(response.status, "relay_unavailable"),
        `relay read failed with ${response.status}`,
        response.status,
      );
    }
    return assertEnvelope(await response.json());
  }
}

export type InMemoryRelayOptions = {
  now?: () => number;
  ttlMs?: number;
  rateLimitCreates?: number;
  rateWindowMs?: number;
  globalCreateLimit?: number;
  globalStoredCiphertextBytes?: number;
  resultIdFactory?: () => string;
};

type MemoryRecord = {
  envelope: RelayCiphertextEnvelope;
  createdAt: number;
  expiresAt: number;
  ciphertextBytes: number;
};

export class InMemoryRelayClient implements RelayClient {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly createTimestamps: number[] = [];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly rateLimitCreates: number;
  private readonly rateWindowMs: number;
  private readonly globalCreateLimit: number;
  private readonly globalStoredCiphertextBytes: number;
  private readonly resultIdFactory: () => string;
  private totalCreates = 0;

  constructor(options: InMemoryRelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? RELAY_TTL_MS;
    this.rateLimitCreates = options.rateLimitCreates ?? 30;
    this.rateWindowMs = options.rateWindowMs ?? 60_000;
    this.globalCreateLimit = options.globalCreateLimit ?? 1_000;
    this.globalStoredCiphertextBytes = options.globalStoredCiphertextBytes ?? 128 * 1024 * 1024;
    this.resultIdFactory = options.resultIdFactory ?? makeResultId;
  }

  async createResult(envelopeInput: RelayCiphertextEnvelope): Promise<RelayCreateResult> {
    const envelope = assertEnvelope(envelopeInput);
    const now = this.now();
    while (this.createTimestamps[0] !== undefined && this.createTimestamps[0] <= now - this.rateWindowMs) {
      this.createTimestamps.shift();
    }
    if (this.createTimestamps.length >= this.rateLimitCreates) {
      throw new RelayClientError("rate_limited", "relay create rate limit reached", 429);
    }
    const ciphertextBytes = base64UrlToBytes(envelope.ciphertext).length;
    const storedBytes = [...this.records.values()]
      .filter((record) => record.expiresAt > now)
      .reduce((total, record) => total + record.ciphertextBytes, 0);
    if (
      this.totalCreates >= this.globalCreateLimit ||
      storedBytes + ciphertextBytes > this.globalStoredCiphertextBytes
    ) {
      throw new RelayClientError("quota_reached", "relay global protection threshold reached", 507);
    }
    const resultId = this.resultIdFactory();
    if (!RELAY_RESULT_ID_PATTERN.test(resultId)) {
      throw new RelayClientError("relay_unavailable", "relay generated an invalid result id");
    }
    if (this.records.has(resultId)) {
      throw new RelayClientError("duplicate_result", "relay result id already exists", 409);
    }
    const expiresAt = now + this.ttlMs;
    this.records.set(resultId, { envelope: structuredClone(envelope), createdAt: now, expiresAt, ciphertextBytes });
    this.createTimestamps.push(now);
    this.totalCreates += 1;
    return { resultId, expiresAt };
  }

  async getResult(resultId: string): Promise<RelayCiphertextEnvelope> {
    assertResultId(resultId);
    const record = this.records.get(resultId);
    if (!record) throw new RelayClientError("not_found", "relay result was not found", 404);
    if (record.expiresAt <= this.now()) {
      throw new RelayClientError("expired", "relay result has expired", 410);
    }
    return structuredClone(record.envelope);
  }

  cleanupExpired() {
    const now = this.now();
    let deleted = 0;
    for (const [resultId, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(resultId);
        deleted += 1;
      }
    }
    return deleted;
  }

  inspectStoredRecord(resultId: string) {
    const record = this.records.get(resultId);
    return record ? structuredClone(record) : null;
  }
}

export function relayRequestContainsOnlyEnvelope(envelope: RelayCiphertextEnvelope) {
  return relayEnvelopeRequestBytes(envelope) <= RELAY_REQUEST_HARD_CAP_BYTES &&
    base64UrlToBytes(envelope.ciphertext).length <= RELAY_CIPHERTEXT_HARD_CAP_BYTES;
}
