import { DRAWING_LIMITS, type DrawingDocument, type ValidationResult } from "./types.js";
import {
  TEMPORARY_FRAGMENT_ELIGIBILITY_THRESHOLD_CHARS,
  getHostedHandoffEligibility,
} from "./hostedPolicy.js";
import { validateStoredDocument } from "./validation.js";

export const DRAWING_FRAGMENT_PREFIX = "#drawing=gzip.";

export type FragmentResult =
  | {
      status: "ready";
      fragment: string;
      canonicalBytes: number;
      fragmentCharacters: number;
    }
  | {
      status: "relay_required";
      reason: "fragment_threshold_exceeded";
      canonicalBytes: number;
      fragmentCharacters: number;
      thresholdCharacters: number;
    }
  | {
      status: "hosted_unavailable";
      canonicalBytes: number;
      limitBytes: number;
    }
  | { status: "invalid"; errors: string[] };

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
) {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const transformed = new Blob([source]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(transformed).arrayBuffer());
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("fragment payload is not valid base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readFragment(value: string) {
  if (value.startsWith("#")) return value;
  return new URL(value).hash;
}

export async function createFragmentResult(
  input: unknown,
  thresholdCharacters = TEMPORARY_FRAGMENT_ELIGIBILITY_THRESHOLD_CHARS,
): Promise<FragmentResult> {
  const eligibility = getHostedHandoffEligibility(input);
  if (eligibility.status === "invalid") return eligibility;
  if (eligibility.status === "hosted_unavailable") return eligibility;
  if (!Number.isInteger(thresholdCharacters) || thresholdCharacters < 1) {
    return { status: "invalid", errors: ["fragment threshold must be a positive integer"] };
  }

  const canonical = JSON.stringify(input);
  const compressed = await transformBytes(
    new TextEncoder().encode(canonical),
    new CompressionStream("gzip"),
  );
  const fragment = `${DRAWING_FRAGMENT_PREFIX}${bytesToBase64Url(compressed)}`;
  if (fragment.length > thresholdCharacters) {
    return {
      status: "relay_required",
      reason: "fragment_threshold_exceeded",
      canonicalBytes: eligibility.canonicalBytes,
      fragmentCharacters: fragment.length,
      thresholdCharacters,
    };
  }
  return {
    status: "ready",
    fragment,
    canonicalBytes: eligibility.canonicalBytes,
    fragmentCharacters: fragment.length,
  };
}

export async function decodeDrawingFragment(
  fragmentOrUrl: string,
): Promise<ValidationResult<DrawingDocument>> {
  try {
    const fragment = readFragment(fragmentOrUrl);
    if (!fragment.startsWith(DRAWING_FRAGMENT_PREFIX)) {
      return { ok: false, errors: ["drawing fragment prefix is invalid"] };
    }
    const compressed = base64UrlToBytes(fragment.slice(DRAWING_FRAGMENT_PREFIX.length));
    const canonicalBytes = await transformBytes(
      compressed,
      new DecompressionStream("gzip"),
    );
    if (canonicalBytes.length > DRAWING_LIMITS.serializedBytes) {
      return { ok: false, errors: ["fragment document exceeds canonical limits"] };
    }
    const canonical = new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes);
    const parsed: unknown = JSON.parse(canonical);
    return validateStoredDocument(parsed);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "drawing fragment is invalid"],
    };
  }
}

export function buildFragmentResultUrl(fragment: string, pageUrl: string) {
  const url = new URL(pageUrl);
  url.hash = fragment;
  return url.toString();
}
