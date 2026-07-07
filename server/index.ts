/**
 * Minimal, dependency-light HTTP server.
 *
 * Why not Next.js? The goal for this repo is: clone it, drop your keys in
 * `.env`, run one command, and it works — for anyone, on any machine, with no
 * build step or native toolchain to break. A ~120-line Node server serving one
 * self-contained HTML page (CSS inline, so styling can never fail to load) hits
 * that bar far more reliably than a framework build.
 *
 * All the real work lives in `src/lib/*`, which is framework-agnostic:
 *   - DharmaDeveloperClient  — typed RAG search + rerank client
 *   - CurriculumPlanner      — retrieve → rerank → structured draft → verify
 *   - schema / grounding     — the lesson-plan contract + citation checking
 *
 * The only place secrets are read is this server. The browser posts plain
 * lesson parameters and gets a typed plan back.
 */

import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DharmaDeveloperClient } from "../src/lib/dharmaClient";
import { CurriculumPlanner } from "../src/lib/curriculumPlanner";
import { LessonPlanRequestSchema } from "../src/lib/schema";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(process.cwd(), "public");

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error("payload_too_large"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse) {
  let parsed;
  try {
    parsed = LessonPlanRequestSchema.safeParse(JSON.parse(await readBody(req)));
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }
  if (!parsed.success) {
    return json(res, 400, { error: "invalid_request", issues: parsed.error.flatten() });
  }

  const orgId = process.env.DHARMA_ORG_ID;
  const token = process.env.DHARMA_DEV_TOKEN;
  if (!orgId || !token) {
    return json(res, 500, {
      error: "server_misconfigured",
      message: "DHARMA_ORG_ID / DHARMA_DEV_TOKEN are not set. Copy .env.example to .env and fill them in.",
    });
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return json(res, 500, {
      error: "server_misconfigured",
      message: "GOOGLE_GENERATIVE_AI_API_KEY is not set.",
    });
  }

  const client = new DharmaDeveloperClient(orgId, token, {
    baseUrl: process.env.DHARMA_API_BASE_URL,
  });
  const planner = new CurriculumPlanner(client, {
    useRerank: process.env.DHARMA_USE_RERANK !== "false",
  });

  try {
    const result = await planner.generateLesson(parsed.data);
    return json(res, 200, result);
  } catch (err: unknown) {
    const e = err as { status?: number; code?: string; message?: string };
    const status = e.status && e.status >= 400 ? e.status : 502;
    return json(res, status, { error: e.code ?? "generation_failed", message: e.message ?? "Unknown error" });
  }
}

async function serveIndex(res: http.ServerResponse) {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500).end("index.html not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "POST" && url.pathname === "/api/generate") {
    return handleGenerate(req, res);
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return serveIndex(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

server.listen(PORT, () => {
  const configured = process.env.DHARMA_ORG_ID && process.env.DHARMA_DEV_TOKEN && process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  console.log(`\n  ☸  Dharma Lesson Planner running at http://localhost:${PORT}`);
  if (!configured) {
    console.log("  ⚠  Keys missing — copy .env.example to .env and add your credentials.\n");
  } else {
    console.log("  ✓  Keys detected. Open the URL above and generate a lesson.\n");
  }
});
