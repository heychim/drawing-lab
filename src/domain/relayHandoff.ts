import { decryptRelayDrawingDocument, encryptDrawingDocumentForRelay } from "./relayCrypto.js";
import {
  RelayClientError,
  type RelayClient,
} from "./relayClient.js";
import {
  RELAY_RESULT_ID_PATTERN,
  base64UrlToBytes,
} from "./relayEnvelope.js";
import type { DrawingDocument, ValidationResult } from "./types.js";

export const RELAY_RESULT_QUERY_PARAMETER = "relayResult";
export const RELAY_KEY_FRAGMENT_PREFIX = "#relay-key=";

export type RelayResultUrl = {
  status: "ready";
  url: string;
  resultId: string;
  expiresAt: number;
  canonicalBytes: number;
};

export type RelayResultCreation = RelayResultUrl | { status: "rejected"; errors: string[] };

function errorMessage(error: unknown) {
  if (error instanceof RelayClientError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "relay operation failed";
}

export function buildRelayResultUrl(
  pageUrl: string,
  resultId: string,
  fragmentKey: string,
) {
  if (!RELAY_RESULT_ID_PATTERN.test(resultId)) throw new Error("relay result id is invalid");
  if (base64UrlToBytes(fragmentKey).length !== 32) throw new Error("relay fragment key is invalid");
  const url = new URL(pageUrl);
  url.searchParams.set(RELAY_RESULT_QUERY_PARAMETER, resultId);
  url.hash = `${RELAY_KEY_FRAGMENT_PREFIX}${fragmentKey}`;
  return url.toString();
}

export function parseRelayResultUrl(urlValue: string) {
  try {
    const url = new URL(urlValue);
    const resultIds = url.searchParams.getAll(RELAY_RESULT_QUERY_PARAMETER);
    if (resultIds.length !== 1 || !RELAY_RESULT_ID_PATTERN.test(resultIds[0])) return null;
    if (!url.hash.startsWith(RELAY_KEY_FRAGMENT_PREFIX)) return null;
    const fragmentKey = url.hash.slice(RELAY_KEY_FRAGMENT_PREFIX.length);
    if (base64UrlToBytes(fragmentKey).length !== 32) return null;
    return { resultId: resultIds[0], fragmentKey };
  } catch {
    return null;
  }
}

export function hasRelayResultLocation(urlValue: string) {
  return parseRelayResultUrl(urlValue) !== null;
}

export async function createEncryptedRelayResult(
  document: DrawingDocument,
  client: RelayClient,
  pageUrl: string,
): Promise<RelayResultCreation> {
  const encrypted = await encryptDrawingDocumentForRelay(document);
  if (!encrypted.ok) return { status: "rejected", errors: encrypted.errors };
  try {
    // The client receives only the non-secret ciphertext envelope. The key is
    // used only after create returns, when the browser constructs the fragment.
    const created = await client.createResult(encrypted.value.envelope);
    return {
      status: "ready",
      url: buildRelayResultUrl(pageUrl, created.resultId, encrypted.value.fragmentKey),
      resultId: created.resultId,
      expiresAt: created.expiresAt,
      canonicalBytes: encrypted.value.envelope.canonicalBytes,
    };
  } catch (error) {
    return { status: "rejected", errors: [errorMessage(error)] };
  }
}

export async function restoreEncryptedRelayResult(
  urlValue: string,
  client: RelayClient,
): Promise<ValidationResult<DrawingDocument>> {
  const location = parseRelayResultUrl(urlValue);
  if (!location) return { ok: false, errors: ["relay result URL is invalid"] };
  try {
    const envelope = await client.getResult(location.resultId);
    return decryptRelayDrawingDocument(envelope, location.fragmentKey);
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] };
  }
}
