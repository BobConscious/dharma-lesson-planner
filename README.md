<div align="center">

# ☸ Dharma Lesson Planner

**Grounded, minute-by-minute Buddhist studies lesson plans — with citations that are actually verified.**

Built on the [Dharma AI](https://dharma-ai.io) organization-scoped RAG platform + Gemini.

**Clone it, add your keys, run one command.** No build step, no framework toolchain.

</div>

---

A teacher enters a topic, a tradition, an audience level, a length, and a few
learning objectives. The app retrieves grounding passages from the Dharma
scriptural corpus, drafts a complete lesson with Gemini as **structured JSON**,
then **verifies every handout quotation against the retrieved source text**
before rendering it. Anything it can't ground is flagged, not hidden.

It produces what a teacher actually walks into the room with:

- a **minute-by-minute agenda** (opening → teaching → guided practice → discussion → closing), with per-block teacher notes and objective links;
- **learning objectives** tagged by Bloom's level, each tied to a check-for-understanding;
- **key terms** with Pali/Sanskrit originals;
- **materials & prep**, adapted for in-person vs. online;
- a ready-to-read **guided-practice / meditation script** with trauma-informed and accessibility notes;
- **discussion questions** for pairs and full circle;
- **differentiation** for beginners and advanced students;
- **home practice** and a reflection prompt;
- a **student handout** with real, cited passages;
- a **closing dedication of merit**;
- a **sources panel** where each citation carries a `verified` / `partial` / `unverified` badge.

## Run it (about two minutes)

```bash
git clone https://github.com/BobConscious/dharma-lesson-planner.git
cd dharma-lesson-planner
npm install
cp .env.example .env        # then paste in your three keys
npm start                   # → http://localhost:3000
```

That's the whole setup once you have API access. The three keys:

| Variable | What |
|---|---|
| `DHARMA_ORG_ID` | Your org id, e.g. `org_12345` |
| `DHARMA_DEV_TOKEN` | Scoped developer token (`dharma_org_…`) with `rag:search` (+ `rag:rerank`) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API key from Google AI Studio |

## Credentials

You need access to a Dharma AI organization with RAG search enabled. In that
organization, create or request a developer token with `rag:search` scope. Add
`rag:rerank` too if you want the default rerank pass.

You also need a Gemini API key from Google AI Studio. The app uses that key only
on the local Node server; it is never sent to the browser.

If you do not already have Dharma AI API access, the UI preview still works
without keys at `preview/lesson-planner.html`, but live generation will return
`server_misconfigured` until `.env` is filled in.

Optional: `PORT`, `DHARMA_API_BASE_URL`, `DHARMA_USE_RERANK=false` to save 10
credits/plan, `GEMINI_MODEL`.

There is a static, no-keys design preview at `preview/lesson-planner.html` —
open it directly in a browser to see the layout with sample content.

## Why a plain Node server?

The goal is that anyone can clone this, drop in keys, and run it without a
framework build or generated client bundle.

So the app is a ~120-line Node HTTP server that serves **one HTML file with its
CSS inline** — styling can never fail to load — and exposes a single JSON
endpoint. No bundler, no native SWC binary, no `.next` cache. The only runtime
dep beyond the AI SDK is `tsx`, to run TypeScript directly.

## Architecture

```
Browser ──POST /api/generate──▶ Node server (server/index.ts — secrets live here)
                                     │
                                     ├─▶ DharmaDeveloperClient
                                     │     · multi-query rag/search  (40 cr each)
                                     │     · rag/rerank              (10 cr)
                                     │     · 402-halt · 202 poll · retry/backoff
                                     │
                                     ├─▶ Gemini via structured output (LessonPlanSchema)
                                     │
                                     └─▶ grounding.ts  verify quotes → badges
```

The Dharma developer token and Gemini key are read **only** by the server. The
browser sends plain lesson parameters and gets a typed plan back.

```
public/index.html          the whole UI: inline CSS + a renderer for the plan JSON
server/index.ts            HTTP server; serves the page, runs /api/generate
src/lib/
  dharmaClient.ts          typed search + rerank client (timeout, retry, 402-halt, 202 poll, credits)
  schema.ts                Zod schema for request + the full LessonPlan (the model's output contract)
  grounding.ts             near-verbatim quote verification → verified/partial/unverified
  curriculumPlanner.ts     retrieve → rerank → structured generation → verify → enforce duration
preview/lesson-planner.html  static design preview (sample content, no keys)
docs/IMPLEMENTATION-NOTES.md implementation choices and safety guardrails
```

## Why this exists

Teachers need generated lesson plans they can actually inspect before teaching:
the agenda should add up, sources should be visible, and quoted passages should
be checked against retrieved text instead of treated as trustworthy by default.
This repo keeps that behavior small, explicit, and easy to run locally.

## Credit cost per plan

Roughly `40 × (1 + #objectives, capped at 5) + 10 (rerank)` credits — about
**130–210 credits** for a typical 2–4 objective lesson. The exact spend and
remaining pool balance come back with every plan and show in the UI.

## Verification, honestly

`grounding.ts` normalises text and computes trigram containment between each
handout quotation and the source it's attributed to. ≥60% overlap →
`verified`. This catches paraphrase-as-quote and outright fabrication; it will
not catch a faithful quote attributed to the wrong (but similar) source. It's a
guardrail, not a proof — and a great deal more than titling unchecked search
hits "verified."

## License

MIT — see [LICENSE](LICENSE). Not affiliated with any monastic institution;
scriptural content is served from the Dharma AI corpus under its own terms.
