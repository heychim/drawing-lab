import { type DrawingDocument } from "./types.js";
import { validateStoredDocument } from "./validation.js";

export const HOSTED_HANDOFF_CANONICAL_BYTES = 1 * 1024 * 1024;

// Temporary development default. Pending real mobile-chat handoff validation.
// This value is transport configuration, not a permanent product decision.
export const TEMPORARY_FRAGMENT_ELIGIBILITY_THRESHOLD_CHARS = 64 * 1024;

export type HostedHandoffEligibility =
  | { status: "eligible"; canonicalBytes: number }
  | { status: "hosted_unavailable"; canonicalBytes: number; limitBytes: number }
  | { status: "invalid"; errors: string[] };

export function canonicalDocumentByteLength(document: DrawingDocument) {
  return new TextEncoder().encode(JSON.stringify(document)).length;
}

export function getHostedHandoffEligibility(input: unknown): HostedHandoffEligibility {
  const validation = validateStoredDocument(input);
  if (!validation.ok) return { status: "invalid", errors: validation.errors };
  const canonicalBytes = canonicalDocumentByteLength(validation.value);
  if (canonicalBytes > HOSTED_HANDOFF_CANONICAL_BYTES) {
    return {
      status: "hosted_unavailable",
      canonicalBytes,
      limitBytes: HOSTED_HANDOFF_CANONICAL_BYTES,
    };
  }
  return { status: "eligible", canonicalBytes };
}
