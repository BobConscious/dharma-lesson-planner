# Implementation Notes

This repo is intentionally small: a plain Node HTTP server, one static HTML UI,
typed request/response schemas, server-side secret handling, and explicit
source-grounding checks before a lesson plan is shown to a teacher.

## Design Priorities

### Complete lesson output

The generated plan is not a blob of prose. `src/lib/schema.ts` defines a typed
lesson contract with agenda blocks, learning objectives, key terms, materials,
guided practice, discussion prompts, differentiation, home practice, handout
passages, source provenance, and warnings.

### Structured generation

`src/lib/curriculumPlanner.ts` uses the AI SDK structured-output API with a Zod
schema. The app expects validated JSON in the shape it renders, which is easier
to test and safer to consume than parsing free-form prose.

### Citation integrity

`src/lib/grounding.ts` checks quoted handout passages against the retrieved
source text. Each citation is labeled:

- `verified`: the quoted text substantially matches retrieved source text.
- `partial`: the source supports the section but no direct quotation is present.
- `unverified`: the quote could not be matched to the retrieved source text.

Unverified quotations are surfaced as warnings so a teacher can review them
before using the lesson.

### Safe failure modes

The planner refuses to generate an ungrounded lesson if no sources are
retrieved. It also treats `402 token_pool_empty` as a hard stop, because retrying
cannot fix an empty credit pool.

### Retrieval quality

The pipeline searches by topic plus learning objectives, deduplicates sources,
and can rerank the pooled results. This gives Gemini more relevant context while
keeping credit spend visible.

### Duration checks

The agenda duration is summed after generation. If the plan drifts materially
from the requested lesson length, the response includes a warning.

### Server-only secrets

Only `server/index.ts` reads `DHARMA_ORG_ID`, `DHARMA_DEV_TOKEN`, and
`GOOGLE_GENERATIVE_AI_API_KEY`. The browser sends lesson parameters and receives
a generated plan; API credentials are never embedded in `public/`.

### No framework build

The app serves `public/index.html` directly with inline CSS and calls a single
JSON endpoint. This keeps setup predictable on a fresh checkout: `npm install`,
copy `.env.example` to `.env`, add keys, and run `npm start`.
