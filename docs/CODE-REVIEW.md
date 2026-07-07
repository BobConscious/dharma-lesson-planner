# Code review: rebuilding Use Case 3

This repo is a production rewrite of **Use Case 3 — Curriculum Lesson Planner**
from `docs/developer-platform/use-cases.md`. The brief was explicit: *challenge
the code in the doc, don't just implement it as written.* This document is that
challenge — what the reference implementation gets wrong, and what this repo
does instead.

The original `CurriculumPlanner.generateLesson()` is ~30 lines. Every problem
below is in those 30 lines or in the client they depend on.

---

## 1. The syllabus is silently thrown away 🅂 (correctness)

```ts
return {
  title: `${req.topic} Lesson Plan (${req.audience})`,
  overview: text.split('SYLLABUS:')[0]?.replace('OVERVIEW:', '').trim() || text,
  syllabus: [], // Extract structure parsed from response   <-- never populated
  verifiedSources: searchResponse.results.map((r) => r.title),
  handoutMaterial: text.split('HANDOUT:')[1]?.trim() || '',
};
```

The single most valuable output of a lesson planner — the **minute-by-minute
syllabus** — is hard-coded to `[]`. The prompt even asks the model for "a
minute-by-minute syllabus," the model produces one, and the code discards it.
A caller gets an object shaped like success with the payload missing.

**Fix:** the agenda is a first-class, typed array in `schema.ts`
(`AgendaItemSchema`) with start minute, duration, activity type, description,
teacher notes, and which objectives each block advances. It is produced and
rendered, not stubbed.

## 2. Prompt/parser marker mismatch → the parser almost always fails (correctness)

The parsing relies on literal markers:

```ts
text.split('SYLLABUS:')  // and 'OVERVIEW:', 'HANDOUT:'
```

…but the prompt **never instructs the model to emit `OVERVIEW:`, `SYLLABUS:`,
or `HANDOUT:`**. So in the common case the split finds nothing, and every field
falls back to `|| text` or `|| ''` — i.e. the entire model response gets dumped
into `overview`, and `handoutMaterial` comes back empty. This is the classic
"parse the LLM's prose with string ops" failure mode: brittle, silent, and
untestable.

**Fix:** stop parsing prose. `curriculumPlanner.ts` uses the AI SDK's
`generateObject` with a Zod schema, so the model returns validated JSON in
exactly the shape we consume. If it doesn't validate, we get a real error
instead of a half-populated object.

## 3. "verifiedSources" are never verified (integrity — the important one)

```ts
verifiedSources: searchResponse.results.map((r) => r.title),
```

These are just the titles of whatever search returned. Nothing checks that the
generated handout actually quotes them, or quotes them faithfully. Calling them
*verified* is worse than saying nothing: for a platform whose entire thesis is
cognitive integrity and grounded citation, it ships an unearned trust signal.
The model can fabricate a scripture-flavoured quotation and it will sit next to
a "verified source" list with no contradiction surfaced.

**Fix:** `grounding.ts` makes *verified* mean something. Sources are handed to
the model with stable ids (`S1`, `S2`, …); the model must quote near-verbatim;
the server then checks each handout quotation against the retrieved source text
(normalised trigram containment, ≥60%) and labels each citation:

- **verified** — the quotation was matched in the retrieved source;
- **partial** — cited as support but never directly quoted (nothing to verify);
- **unverified** — the quotation is not in the retrieved text (likely
  paraphrase or fabrication), or the id was never retrieved.

Unverified quotes raise a warning the teacher sees before teaching.

## 4. No guard for empty retrieval → confident hallucination (integrity)

If `searchResponse.results` is empty (obscure topic, index gap, a transient
failure), `sources` becomes `''`, and the model is asked to write a fully
"grounded, cited" lesson from **no sources at all**. It will happily comply.

**Fix:** the planner fails safe — zero retrieved sources throws rather than
generating an ungrounded plan.

## 5. One generic query for the whole lesson (retrieval quality)

```ts
await this.client.search(`Buddhist sutras and commentaries regarding: ${req.topic}`, 4);
```

A lesson can have several distinct objectives; a single topic query rarely
covers all of them. And `rag:rerank` — which exists precisely to sort candidate
passages by strict relevance — is never used.

**Fix:** multi-query retrieval (topic + one query per objective), dedupe by
source id, then an optional cross-encoder **rerank** pass over the pooled
candidates. Credits are respected: searches run sequentially so a `402` halts
before spending more, and the number of queries is capped.

## 6. Duration is requested but never enforced (quality)

`durationMinutes` goes into the prompt and is never checked. A "60-minute" plan
whose blocks sum to 90 ships without complaint.

**Fix:** the planner sums the agenda and warns if it drifts more than ~10% from
the requested length.

## 7. The client ignores half the documented API contract (robustness)

The reference `DharmaDeveloperClient.search()`:

- returns `Promise<any>`, so callers index into an unknown shape;
- has **no timeout**, no retry, no backoff;
- ignores the documented **HTTP 202 async + poll-loop** contract entirely — a
  high-volume search that comes back queued would be treated as a malformed
  success;
- does not special-case **`402 token_pool_empty`**, which the platform docs say
  must **halt without retry**. A naive retry wrapper would burn the request
  budget hammering an empty pool.

**Fix:** `dharmaClient.ts` is fully typed to the documented response shapes;
adds per-request timeout, exponential backoff with jitter on network/5xx,
transparent 202 poll-loop resolution, a `402` fatal-halt (plus `401/403/400`
no-retry), credit accounting (`creditsSpent` / `lastPoolBalance`), and a
`502 aws_runtime_async_required` retry that lets the server hand back a 202.

## 8. `(r: any)` everywhere (type safety)

The reference threads `any` through `.map((r: any) => …)`, so a field rename on
the platform side surfaces as a runtime `undefined`, not a compile error.

**Fix:** `SearchResult`, `SearchResponse`, `RerankResponse`, the whole
`LessonPlan`, and the API response are typed end to end.

## 9. Secret token in code that could run anywhere (security)

`new CurriculumPlanner(orgId, token)` is constructed with a `dharma_org_`
secret in code with no server boundary. Bundle that path into a client
component and the org's billable token ships to every browser.

**Fix:** the only place the token and the Gemini key are read is the server
route `src/app/api/generate/route.ts` (`runtime = "nodejs"`). The browser posts
plain lesson parameters; secrets never leave the server. The client even
`console.warn`s if it detects a browser context.

---

## What was kept

The good bones of UC3 are intact: search the corpus for grounding, hand those
sources to Gemini, return a structured lesson object, and use
`gemini-2.5-flash` by default. The rewrite is about making the output complete,
the citations honest, and the failure modes safe.
