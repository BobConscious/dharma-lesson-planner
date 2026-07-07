/**
 * Citation grounding.
 *
 * Every quotation the model puts in the student handout is checked,
 * near-verbatim, against the retrieved source text it claims to come from.
 * A citation is:
 *   - verified   — its quoted passage is found in the retrieved content;
 *   - partial    — cited as a talking-point source but never quoted (nothing to
 *                  verify, but the source was really retrieved);
 *   - unverified — the model quoted text that is NOT in the retrieved source
 *                  (a likely fabrication) OR cited an id we never retrieved.
 */

import type { SearchResult } from "./dharmaClient";
import type { HandoutPassageSchema } from "./schema";
import type { z } from "zod";

type HandoutPassage = z.infer<typeof HandoutPassageSchema>;

export type GroundingStatus = "verified" | "partial" | "unverified";

/** Normalise text so trivial punctuation/whitespace/case differences don't fail a match. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-level containment: what fraction of the quote's word-trigrams appear in the source? */
function trigramContainment(quote: string, source: string): number {
  const q = normalize(quote).split(" ").filter(Boolean);
  const s = normalize(source);
  if (q.length === 0) return 0;
  if (q.length < 3) return s.includes(q.join(" ")) ? 1 : 0;

  const sourceTokens = s.split(" ");
  const sourceTrigrams = new Set<string>();
  for (let i = 0; i + 2 < sourceTokens.length; i++) {
    sourceTrigrams.add(`${sourceTokens[i]} ${sourceTokens[i + 1]} ${sourceTokens[i + 2]}`);
  }

  let hits = 0;
  let total = 0;
  for (let i = 0; i + 2 < q.length; i++) {
    total++;
    if (sourceTrigrams.has(`${q[i]} ${q[i + 1]} ${q[i + 2]}`)) hits++;
  }
  return total === 0 ? 0 : hits / total;
}

const VERIFY_THRESHOLD = 0.6; // ≥60% of the quote's trigrams present in the source.

export interface GroundingReport {
  status: Record<string, GroundingStatus>;
  warnings: string[];
}

/**
 * @param retrieved         sources actually returned by the RAG API, keyed by the
 *                          synthetic id we assigned (S1, S2, ...).
 * @param passages          the handout quotations the model produced.
 * @param citedSourceIds    every source id the model referenced anywhere.
 */
export function verifyGrounding(
  retrieved: Map<string, SearchResult>,
  passages: HandoutPassage[],
  citedSourceIds: Set<string>,
): GroundingReport {
  const status: Record<string, GroundingStatus> = {};
  const warnings: string[] = [];

  // Start every cited id at "partial" (it was cited but nothing quoted yet).
  for (const id of citedSourceIds) {
    if (!retrieved.has(id)) {
      status[id] = "unverified";
      warnings.push(`Citation ${id} references a source that was never retrieved — dropped as ungrounded.`);
    } else {
      status[id] = "partial";
    }
  }

  // Any quotation is a concrete claim we can check.
  for (const p of passages) {
    const src = retrieved.get(p.sourceId);
    if (!src) {
      status[p.sourceId] = "unverified";
      warnings.push(`Handout quote attributed to ${p.sourceId}, which was not retrieved.`);
      continue;
    }
    const containment = trigramContainment(p.quote, src.content);
    if (containment >= VERIFY_THRESHOLD) {
      status[p.sourceId] = "verified";
    } else {
      status[p.sourceId] = "unverified";
      warnings.push(
        `Handout quote attributed to "${src.title}" (${p.sourceId}) does not match the retrieved text ` +
          `(${Math.round(containment * 100)}% overlap) — likely paraphrased or fabricated.`,
      );
    }
  }

  return { status, warnings };
}
