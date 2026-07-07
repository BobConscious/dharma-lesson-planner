# AGENTS.md — runbook for coding agents

You are an AI coding agent asked to spin up this repo. Follow these steps
exactly. This file is the source of truth for setup; the human-facing overview
is in `README.md`.

## What this is

A self-contained web tool that generates grounded Buddhist-studies lesson plans.
A plain Node HTTP server (`server/index.ts`) serves one HTML page
(`public/index.html`, CSS inline) and exposes `POST /api/generate`, which calls
the Dharma AI RAG API + Google Gemini server-side and returns a typed lesson
plan. There is **no framework and no build step** — do not add Next.js, Vite,
webpack, or a bundler.

## Prerequisites

- Node.js >= 18 (needs global `fetch` and `AbortController`). Check with `node -v`.
- Three API credentials (see "Environment"). The tool starts without them but
  cannot generate a live plan.

## Setup (run in the repo root)

```bash
npm install
cp .env.example .env
```

Then write the three secrets into `.env` (do not hard-code them anywhere else,
never put them in `public/` or any client code):

```
DHARMA_ORG_ID=org_...
DHARMA_DEV_TOKEN=dharma_org_...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

If you were given the keys, write them with your file tools. If not, tell the
human which of the three are missing. They need access to a Dharma AI
organization with a developer token scoped for `rag:search` and, if reranking is
enabled, `rag:rerank`.

## Start

```bash
npm start          # serves http://localhost:3000
# or: PORT=4000 npm start
```

`npm start` runs `tsx server/index.ts`. On boot the server prints either
`✓ Keys detected` or `⚠ Keys missing`. Watch for that line to confirm state.

## Verify it works (do this before reporting success)

1. Page loads and is styled:
   ```bash
   curl -s http://localhost:3000/ | grep -q "Lesson Planner" && echo OK
   ```
2. Missing-key handling (only meaningful before keys are set) returns HTTP 500
   with `server_misconfigured`.
3. Input validation returns HTTP 400:
   ```bash
   curl -s -X POST http://localhost:3000/api/generate \
     -H "Content-Type: application/json" -d '{"topic":""}'
   # -> {"error":"invalid_request", ...}
   ```
4. A real generation (needs valid keys) returns HTTP 200 with a `plan` object:
   ```bash
   curl -s -X POST http://localhost:3000/api/generate \
     -H "Content-Type: application/json" \
     -d '{"topic":"The Four Noble Truths","tradition":"Theravada","audience":"beginner","durationMinutes":60,"format":"IRL","learningObjectives":["Name the Four Noble Truths"]}'
   ```
   Success looks like `{"plan":{...},"provenance":[...],"warnings":[...],"credits":{...}}`.

Also run the type check — it must exit 0:

```bash
npm run typecheck
```

## Request contract for `POST /api/generate`

Body (validated by `src/lib/schema.ts` → `LessonPlanRequestSchema`):

```jsonc
{
  "topic": "string (required)",
  "tradition": "Theravada | Mahayana | Vajrayana | Zen | Pure Land | Secular / Non-sectarian",
  "audience": "beginner | intermediate | advanced",
  "durationMinutes": 15-240,
  "format": "online | IRL | hybrid",
  "learningObjectives": ["string", "..."],   // 1-8 items
  "notes": "string (optional)"
}
```

Responses: `200` `{ plan, provenance, warnings, credits }` · `400`
`invalid_request` · `402` `token_pool_empty` (**do not retry** — the credit pool
is empty; tell the human to fund it) · `500` `server_misconfigured` · `502`
generation/upstream failure (safe to surface to the human).

## Where things live

| Path | Purpose |
|---|---|
| `server/index.ts` | HTTP server; serves the page, handles `/api/generate` |
| `public/index.html` | entire UI: inline CSS + a JS renderer for the plan JSON |
| `src/lib/dharmaClient.ts` | typed Dharma RAG search/rerank client (retry, 402-halt, 202 poll) |
| `src/lib/curriculumPlanner.ts` | retrieve → rerank → structured generation → verify → duration check |
| `src/lib/schema.ts` | Zod schema = request contract + model output contract |
| `src/lib/grounding.ts` | verifies handout quotes against retrieved text |
| `preview/lesson-planner.html` | static, no-keys design preview |
| `docs/IMPLEMENTATION-NOTES.md` | implementation choices and safety guardrails |

## Guardrails — do not violate

- Never move secret reads out of `server/index.ts`. The org token and Gemini key
  must never be sent to the browser or embedded in `public/`.
- On `402 token_pool_empty`, halt. Do not retry or loop.
- Do not "fix" an empty-retrieval error by loosening grounding — the planner is
  meant to refuse to generate an ungrounded plan.
- Keep it build-free: no Next.js, Vite, webpack, or generated client bundle.

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `⚠ Keys missing` on boot | `.env` absent/incomplete | create `.env` from `.env.example`, add the 3 keys |
| `command not found: tsx` | deps not installed | run `npm install` |
| 500 `server_misconfigured` | a key is unset | check `.env` values |
| 502 with a network message | can't reach the Dharma API | verify `DHARMA_ORG_ID` / `DHARMA_DEV_TOKEN` and connectivity |
| generation returns "No sources were retrieved" | RAG index has no match for the topic | broaden the topic; confirm the org's index has content |
```
