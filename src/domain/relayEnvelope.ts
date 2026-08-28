import { HOSTED_HANDOFF_CANONICAL_BYTES } from "./hostedPolicy.js";
import type { ValidationResult } from "./types.js";

export const RELAY_ENVELOPE_VERSION = "drawing-relay-v1";
export const RELAY_AES_ALGORITHM = "AES-256-GCM";
export const RELAY_COMPRESSION = "gzip";
export const RELAY_IV_BYTES = 12;
export const RELAY_KEY_BYTES = 32;
export const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A 1 MiB incompressible sample measured 1,048,919 gzip bytes and
// 1,048,935 bytes after the AES-GCM authentication tag. This cap keeps
// 3,737 bytes of transport headroom without accepting arbitrary large blobs.
export const RELAY_CIPHERTEXT_HARD_CAP_BYTES = 1_052_672;

// The measured JSON/base64url envelope was 1,398,722 UTF-8 bytes.
// 1,408 KiB leaves bounded metadata/implementation headroom.
export const RELAY_REQUEST_HARD_CAP_BYTES = 1_441_792;

export const RELAY_RESULT_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/u;

export type RelayCiphertextEnvelope = {
  version: typeof RELAY_ENVELOPE_VERSION;
  algorithm: typeof RELAY_AES_ALGORITHM;
  compression: typeof RELAY_COMPRESSION;
  iv: string;
  ciphertext: string;
  canonicalBytes: number;
};

const EXACT_ENVELOPE_KEYS = [
  "version", "algorithm", "compression", "iv", "ciphertext", "canonicalBytes",
] as const;

export function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("value is not valid base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function relayEnvelopeRequestBytes(input: unknown) {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}

export function validateRelayEnvelope(input: unknown): ValidationResult<RelayCiphertextEnvelope> {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["relay envelope must be an object"] };
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!EXACT_ENVELOPE_KEYS.includes(key as (typeof EXACT_ENVELOPE_KEYS)[number])) {
      errors.push(`relay envelope.${key} is not allowed`);
    }
  }
  for (const key of EXACT_ENVELOPE_KEYS) {
    if (!(key in value)) errors.push(`relay envelope.${key} is required`);
  }
  if (value.version !== RELAY_ENVELOPE_VERSION) errors.push("relay envelope.version is invalid");
  if (value.algorithm !== RELAY_AES_ALGORITHM) errors.push("relay envelope.algorithm is invalid");
  if (value.compression !== RELAY_COMPRESSION) errors.push("relay envelope.compression is invalid");
  if (
    !Number.isInteger(value.canonicalBytes) ||
    (value.canonicalBytes as number) < 1 ||
    (value.canonicalBytes as number) > HOSTED_HANDOFF_CANONICAL_BYTES
  ) {
    errors.push(`relay envelope.canonicalBytes must be from 1 to ${HOSTED_HANDOFF_CANONICAL_BYTES}`);
  }
  if (relayEnvelopeRequestBytes(input) > RELAY_REQUEST_HARD_CAP_BYTES) {
    errors.push(`relay envelope exceeds ${RELAY_REQUEST_HARD_CAP_BYTES} request bytes`);
  }

  let ivBytes: Uint8Array | null = null;
  let ciphertextBytes: Uint8Array | null = null;
  try {
    if (typeof value.iv !== "string") throw new Error();
    ivBytes = base64UrlToBytes(value.iv);
  } catch {
    errors.push("relay envelope.iv must be base64url");
  }
  try {
    if (typeof value.ciphertext !== "string") throw new Error();
    ciphertextBytes = base64UrlToBytes(value.ciphertext);
  } catch {
    errors.push("relay envelope.ciphertext must be base64url");
  }
  if (ivBytes && ivBytes.length !== RELAY_IV_BYTES) {
    errors.push(`relay envelope.iv must contain ${RELAY_IV_BYTES} bytes`);
  }
  if (ciphertextBytes && ciphertextBytes.length < 17) {
    errors.push("relay envelope.ciphertext must contain at least 17 bytes");
  }
  if (ciphertextBytes && ciphertextBytes.length > RELAY_CIPHERTEXT_HARD_CAP_BYTES) {
    errors.push(`relay envelope.ciphertext exceeds ${RELAY_CIPHERTEXT_HARD_CAP_BYTES} bytes`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: RELAY_ENVELOPE_VERSION,
      algorithm: RELAY_AES_ALGORITHM,
      compression: RELAY_COMPRESSION,
      iv: value.iv as string,
      ciphertext: value.ciphertext as string,
      canonicalBytes: value.canonicalBytes as number,
    },
  };
}
