import { HOSTED_HANDOFF_CANONICAL_BYTES } from "./hostedPolicy.js";
import {
  RELAY_AES_ALGORITHM,
  RELAY_CIPHERTEXT_HARD_CAP_BYTES,
  RELAY_COMPRESSION,
  RELAY_ENVELOPE_VERSION,
  RELAY_IV_BYTES,
  RELAY_KEY_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  validateRelayEnvelope,
  type RelayCiphertextEnvelope,
} from "./relayEnvelope.js";
import type { DrawingDocument, ValidationResult } from "./types.js";
import { validateStoredDocument } from "./validation.js";

export type EncryptedRelayPayload = {
  envelope: RelayCiphertextEnvelope;
  fragmentKey: string;
};

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
) {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const transformed = new Blob([source]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(transformed).arrayBuffer());
}

function copyToArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function encryptDrawingDocumentForRelay(
  input: unknown,
): Promise<ValidationResult<EncryptedRelayPayload>> {
  const validation = validateStoredDocument(input);
  if (!validation.ok) return validation;
  const canonical = JSON.stringify(validation.value);
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (canonicalBytes.length > HOSTED_HANDOFF_CANONICAL_BYTES) {
    return { ok: false, errors: [`Hosted relay rejects canonical documents over ${HOSTED_HANDOFF_CANONICAL_BYTES} bytes`] };
  }

  try {
    const compressed = await transformBytes(canonicalBytes, new CompressionStream("gzip"));
    const rawKey = crypto.getRandomValues(new Uint8Array(RELAY_KEY_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(RELAY_IV_BYTES));
    const key = await crypto.subtle.importKey(
      "raw",
      copyToArrayBuffer(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: copyToArrayBuffer(iv) },
      key,
      copyToArrayBuffer(compressed),
    ));
    if (ciphertext.length > RELAY_CIPHERTEXT_HARD_CAP_BYTES) {
      return { ok: false, errors: ["encrypted relay ciphertext exceeds its transport cap"] };
    }
    return {
      ok: true,
      value: {
        envelope: {
          version: RELAY_ENVELOPE_VERSION,
          algorithm: RELAY_AES_ALGORITHM,
          compression: RELAY_COMPRESSION,
          iv: bytesToBase64Url(iv),
          ciphertext: bytesToBase64Url(ciphertext),
          canonicalBytes: canonicalBytes.length,
        },
        fragmentKey: bytesToBase64Url(rawKey),
      },
    };
  } catch {
    return { ok: false, errors: ["relay encryption failed"] };
  }
}

export async function decryptRelayDrawingDocument(
  envelopeInput: unknown,
  fragmentKey: string,
): Promise<ValidationResult<DrawingDocument>> {
  const envelopeValidation = validateRelayEnvelope(envelopeInput);
  if (!envelopeValidation.ok) return envelopeValidation;
  let rawKey: Uint8Array;
  try {
    rawKey = base64UrlToBytes(fragmentKey);
  } catch {
    return { ok: false, errors: ["relay fragment key is invalid"] };
  }
  if (rawKey.length !== RELAY_KEY_BYTES) {
    return { ok: false, errors: [`relay fragment key must contain ${RELAY_KEY_BYTES} bytes`] };
  }

  try {
    const envelope = envelopeValidation.value;
    const iv = base64UrlToBytes(envelope.iv);
    const ciphertext = base64UrlToBytes(envelope.ciphertext);
    const key = await crypto.subtle.importKey(
      "raw",
      copyToArrayBuffer(rawKey),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const compressed = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copyToArrayBuffer(iv) },
      key,
      copyToArrayBuffer(ciphertext),
    ));
    const canonicalBytes = await transformBytes(compressed, new DecompressionStream("gzip"));
    if (
      canonicalBytes.length !== envelope.canonicalBytes ||
      canonicalBytes.length > HOSTED_HANDOFF_CANONICAL_BYTES
    ) {
      return { ok: false, errors: ["relay canonical byte length is invalid"] };
    }
    const canonical = new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes);
    const parsed: unknown = JSON.parse(canonical);
    return validateStoredDocument(parsed);
  } catch {
    return { ok: false, errors: ["relay decrypt, authentication, or decode failed"] };
  }
}
