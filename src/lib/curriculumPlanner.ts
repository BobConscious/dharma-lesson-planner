/**
 * CurriculumPlanner — the production rewrite of use-cases.md UC3.
 *
 * What changed vs. the reference implementation (see docs/CODE-REVIEW.md):
 *
 *  1. Retrieval is multi-query. The original fired one generic query
 *     ("Buddhist sutras and commentaries regarding: {topic}") and hoped it
 *     covered every learning objective. We retrieve for the topic AND each
 *     objective, dedupe by source id, and (optionally) rerank the pooled
 *     candidates so the strongest passages lead.
 *
 *  2. Output is structured, not string-split. The original asked the model for
 *     prose and then did `text.split('SYLLABUS:')` against markers the prompt
 *     never actually required — so `syllabus` was hard-coded to `[]` and the
 *     whole minute-by-minute plan was silently dropped. We use `generateObject`
 *     with the Zod schema; the agenda is a first-class typed array.
 *
 *  3. Citations are verified, not asserted. Sources are handed to the model
 *     with stable ids; the model must quote near-verbatim; the server then
 *     checks each quote against the retrieved text and labels it
 *     verified / partial / unverified.
 *
 *  4. It fails safe on empty retrieval instead of letting the model invent a
 *     scripture-flavoured lesson from nothing.
 *
 *  5. Duration is enforced — we check the agenda sums to the requested length
 *     and surface a warning if the model drifts, rather than shipping a
 *     "60-minute" plan that runs 90.
 */

import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { DharmaDeveloperClient, type SearchResult } from "./dharmaClient";
import { verifyGrounding } from "./grounding";
import {
  GeneratedLessonPlanSchema,
  type LessonPlan,
  type LessonPlanRequest,
  type PlannerResult,
  type RetrievalProvenance,
} from "./schema";

export interface CurriculumPlannerOptions {
  /** Gemini model id. Defaults to env GEMINI_MODEL or gemini-2.5-flash. */
  model?: string;
  /** Rerank the pooled candidates before prompting (extra 10 credits). Default true. */
  useRerank?: boolean;
  /** How many sources to keep after pooling/reranking. Default 8. */
  maxSources?: number;
  /** topK per individual search. Default 4. */
  perQueryTopK?: number;
}

export class CurriculumPlanner {
  private readonly model: string;
  private readonly useRerank: boolean;
  private readonly maxSources: number;
  private readonly perQueryTopK: number;

  constructor(
    private readonly client: DharmaDeveloperClient,
    opts: CurriculumPlannerOptions = {},
  ) {
    this.model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    this.useRerank = opts.useRerank ?? true;
    this.maxSources = opts.maxSources ?? 8;
    this.perQueryTopK = opts.perQueryTopK ?? 4;
  }

  async generateLesson(req: LessonPlanRequest): Promise<PlannerResult> {
    const warnings: string[] = [];

    // 1. Multi-query retrieval ------------------------------------------------
    const queries = this.buildQueries(req);
    const retrieved = await this.retrieve(queries, warnings);

    if (retrieved.size === 0) {
      // Fail safe. The original would have handed the model an empty source
      // block and let it hallucinate a fully-cited lesson. We refuse.
      throw new Error(
        "No sources were retrieved for this topic. Refusing to generate an ungrounded lesson plan. " +
          "Try a broader topic or check the org's RAG index coverage.",
      );
    }

    // 2. Optional rerank to order the pooled candidates -----------------------
    const ordered = await this.orderSources(req, retrieved, warnings);
    const kept = ordered.slice(0, this.maxSources);
    const sourceById = new Map(kept.map((s) => [s.sid, s.result] as const));

    // 3. Structured generation -----------------------------------------------
    const plan = await this.draft(req, kept, warnings);

    // 4. Verify citation grounding -------------------------------------------
    const citedIds = new Set<string>();
    for (const c of plan.citations) citedIds.add(c.id);
    for (const tp of plan.coreTeaching.talkingPoints) tp.sourceIds.forEach((id) => citedIds.add(id));
    for (const p of plan.studentHandout.passages) citedIds.add(p.sourceId);

    const grounding = verifyGrounding(sourceById, plan.studentHandout.passages, citedIds);
    warnings.push(...grounding.warnings);

    const verifiedPlan: LessonPlan = {
      ...plan,
      citations: plan.citations.map((c) => ({
        ...c,
        groundingStatus: grounding.status[c.id] ?? "unverified",
      })),
    };

    // 5. Enforce duration -----------------------------------------------------
    this.checkDuration(req, verifiedPlan, warnings);

    const provenance: RetrievalProvenance[] = kept.map((s) => ({
      sourceId: s.sid,
      title: s.result.title,
      score: s.result.score,
      translationStatus: s.result.translationStatus,
      query: s.query,
    }));

    return {
      plan: verifiedPlan,
      provenance,
      warnings,
      credits: {
        spent: this.client.creditsSpent,
        poolBalance: this.client.lastPoolBalance,
      },
    };
  }

  // -- steps ---------------------------------------------------------------

  private buildQueries(req: LessonPlanRequest): string[] {
    const t = req.tradition;
    const base = `${req.tradition === "Secular / Non-sectarian" ? "Buddhist" : t} teachings, sutras and commentaries on ${req.topic}`;
    const perObjective = req.learningObjectives.map(
      (o) => `${req.topic} — source passages relevant to: ${o}`,
    );
    // Cap total searches; each costs 40 credits.
    return [base, ...perObjective].slice(0, 5);
  }

  private async retrieve(
    queries: string[],
    warnings: string[],
  ): Promise<Map<string, { result: SearchResult; query: string; sid: string }>> {
    const pool = new Map<string, { result: SearchResult; query: string; sid: string }>();
    let counter = 1;

    // Run searches sequentially so a 402 halt stops us before burning more credits.
    for (const q of queries) {
      let res;
      try {
        res = await this.client.search(q, { topK: this.perQueryTopK });
      } catch (err: unknown) {
        const e = err as { fatal?: boolean; message?: string };
        if (e.fatal) throw err; // 401/402/403/400 — do not swallow.
        warnings.push(`A retrieval query failed and was skipped: ${e.message}`);
        continue;
      }
      for (const r of res.results) {
        if (!pool.has(r.id)) {
          pool.set(r.id, { result: r, query: q, sid: `S${counter++}` });
        }
      }
    }
    return pool;
  }

  private async orderSources(
    req: LessonPlanRequest,
    pool: Map<string, { result: SearchResult; query: string; sid: string }>,
    warnings: string[],
  ): Promise<Array<{ sid: string; result: SearchResult; query: string }>> {
    const entries = [...pool.values()];
    if (!this.useRerank || entries.length <= this.maxSources) {
      return entries.sort((a, b) => b.result.score - a.result.score);
    }
    try {
      const rr = await this.client.rerank(
        `Most relevant source passages for teaching a ${req.audience} lesson on ${req.topic}`,
        entries.map((e) => ({ id: e.sid, text: `${e.result.title}: ${e.result.content}` })),
      );
      const order = new Map(rr.results.map((r, i) => [r.candidate.id, i]));
      return entries.sort(
        (a, b) => (order.get(a.sid) ?? 999) - (order.get(b.sid) ?? 999),
      );
    } catch (err: unknown) {
      const e = err as { fatal?: boolean; message?: string };
      if (e.fatal) throw err;
      warnings.push(`Rerank unavailable; falling back to vector score ordering (${e.message}).`);
      return entries.sort((a, b) => b.result.score - a.result.score);
    }
  }

  private async draft(
    req: LessonPlanRequest,
    sources: Array<{ sid: string; result: SearchResult }>,
    warnings: string[],
  ): Promise<Omit<LessonPlan, "citations"> & { citations: LessonPlan["citations"] }> {
    const sourceBlock = sources
      .map(
        (s) =>
          `### ${s.sid} — ${s.result.title} (${s.result.translationStatus}, relevance ${s.result.score.toFixed(2)})\n${s.result.content}`,
      )
      .join("\n\n");

    const objectivesBlock = req.learningObjectives
      .map((o, i) => `  [${i}] ${o}`)
      .join("\n");

    const system = [
      "You are a seasoned Buddhist studies teacher and curriculum director.",
      "You design lessons that are historically careful, doctrinally accurate, and kind.",
      "You NEVER invent scripture. You only quote from the numbered sources provided.",
      "If the sources do not support a claim, teach it as framing/context with an empty sourceIds list rather than attaching a citation.",
      "Quotations in the student handout must be copied near-verbatim from the source text — never paraphrase into quotation marks.",
      "Match depth, vocabulary, and pacing to the stated audience level.",
    ].join(" ");

    const prompt = `Design a complete lesson plan.

TOPIC: ${req.topic}
TRADITION: ${req.tradition}
AUDIENCE LEVEL: ${req.audience}
DURATION: ${req.durationMinutes} minutes (the agenda's blocks must sum to this)
FORMAT: ${req.format}
${req.notes ? `TEACHER NOTES: ${req.notes}\n` : ""}
LEARNING OBJECTIVES (reference these by index):
${objectivesBlock}

RETRIEVED SOURCES — cite ONLY these, by their id (e.g. "S1"):
${sourceBlock}

Requirements:
- Build a minute-by-minute agenda whose block durations add up to ${req.durationMinutes} minutes, including a settling/opening and a closing dedication.
- Every learning objective must be advanced by at least one agenda block (via linkedObjectiveIndexes) and checked in the assessment section.
- Provide a genuinely usable guided-practice script appropriate to a ${req.audience} ${req.tradition} audience.
- Adapt materials and activities for the "${req.format}" format.
- In the citations array, include one entry per source you actually used, copying its id, title, translationStatus and score, and writing a human-readable reference. Do not set groundingStatus.
- In the student handout, include real quotations that appear in the retrieved source text.`;

    try {
      const { object } = await generateObject({
        model: google(this.model),
        schema: GeneratedLessonPlanSchema,
        system,
        prompt,
      });
      // The generated schema omits groundingStatus; add the default back so the
      // shape matches LessonPlan before the server fills real statuses in.
      return {
        ...object,
        citations: object.citations.map((c) => ({ ...c, groundingStatus: "unverified" as const })),
      };
    } catch (err) {
      warnings.push(
        "Structured generation failed schema validation. This usually means the model returned malformed JSON; retrying with a smaller source set may help.",
      );
      throw err;
    }
  }

  private checkDuration(req: LessonPlanRequest, plan: LessonPlan, warnings: string[]) {
    const sum = plan.agenda.reduce((n, a) => n + a.durationMinutes, 0);
    const drift = Math.abs(sum - req.durationMinutes);
    if (drift > Math.max(5, req.durationMinutes * 0.1)) {
      warnings.push(
        `Agenda sums to ${sum} min but ${req.durationMinutes} min was requested — review pacing before teaching.`,
      );
    }
  }
}
