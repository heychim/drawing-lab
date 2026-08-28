import { decodeDrawingFragment, DRAWING_FRAGMENT_PREFIX } from "./fragmentHandoff.js";
import { decryptRelayDrawingDocument } from "./relayCrypto.js";
import {
  parseRelayResultUrl,
  RELAY_RESULT_QUERY_PARAMETER,
} from "./relayHandoff.js";
import type { RelayCiphertextEnvelope } from "./relayEnvelope.js";
import type { DrawingDocument, ValidationResult } from "./types.js";

export type LoadedSourceRelayResult =
  | { ok: true; envelope: RelayCiphertextEnvelope }
  | { ok: false; error: string; status: number };

export type LoadSourceRelayResult = (
  resultId: string,
) => Promise<LoadedSourceRelayResult>;

function failure(error: string): ValidationResult<DrawingDocument> {
  return { ok: false, errors: [error] };
}

function isExactRootUrl(url: URL) {
  return url.pathname === "/" && url.username === "" && url.password === "";
}

function hasOnlyRelayQuery(url: URL) {
  return [...url.searchParams.keys()].every((key) => key === RELAY_RESULT_QUERY_PARAMETER) &&
    url.searchParams.getAll(RELAY_RESULT_QUERY_PARAMETER).length === 1;
}

export async function restoreMcpSourceResult(
  sourceResultUrl: string,
  applicationUrl: string,
  loadRelayResult: LoadSourceRelayResult,
): Promise<ValidationResult<DrawingDocument>> {
  let sourceUrl: URL;
  let application: URL;
  try {
    sourceUrl = new URL(sourceResultUrl);
    application = new URL(applicationUrl);
  } catch {
    return failure("source_result_url_invalid");
  }
  if (sourceUrl.origin !== application.origin) return failure("source_result_foreign_host");
  if (!isExactRootUrl(sourceUrl)) return failure("source_result_url_invalid");

  const relayLocation = parseRelayResultUrl(sourceResultUrl);
  if (relayLocation) {
    if (!hasOnlyRelayQuery(sourceUrl)) return failure("source_result_url_invalid");
    const loaded = await loadRelayResult(relayLocation.resultId);
    if (!loaded.ok) {
      if (loaded.status === 410 || loaded.error === "expired") {
        return failure(
          "source_result_expired: the old sharing result expired; if it was saved in Local Drawings, open that local drawing and create a new sharing link",
        );
      }
      if (loaded.status === 404 || loaded.error === "not_found") {
        return failure("source_result_not_found");
      }
      return failure("source_result_unavailable");
    }
    const decrypted = await decryptRelayDrawingDocument(
      loaded.envelope,
      relayLocation.fragmentKey,
    );
    return decrypted.ok ? decrypted : failure("source_result_decrypt_failed");
  }

  if (
    sourceUrl.search === "" &&
    sourceUrl.hash.startsWith(DRAWING_FRAGMENT_PREFIX)
  ) {
    const decoded = await decodeDrawingFragment(sourceResultUrl);
    return decoded.ok ? decoded : failure("source_result_fragment_invalid");
  }
  return failure("source_result_url_invalid");
}
