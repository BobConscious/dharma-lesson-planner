/**
 * DharmaDeveloperClient — a robust, typed client for the Dharma AI
 * organization-scoped Developer APIs (RAG search + cross-encoder rerank).
 *
 * Endpoints:
 *   POST /api/orgs/{orgId}/developer/rag/search   -> 40 credits
 *   POST /api/orgs/{orgId}/developer/rag/rerank   -> 10 credits
 */

// ---------------------------------------------------------------------------
// Wire types — mirror the documented response contracts exactly.
// ---------------------------------------------------------------------------

export interface DharmaUsage {
  creditsCharged: number;
  poolBalanceCredits: number;
  source: string;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  translationStatus: "translated" | "original" | "machine" | string;
  sourceLanguage: string;
  score: number;
  url: string | null;
}

export interface SearchResponse {
  ok: true;
  organizationId: string;
  usage: DharmaUsage;
  query: string;
  results: SearchResult[];
  /** The platform also synthesises a short answer; we keep it but do not trust it as a source. */
  answer?: string;
}

/** HTTP 202 body for asynchronous, high-volume searches. */
interface AsyncQueued {
  ok: true;
  async: true;
  organizationId: string;
  runId: string;
  status: "queued" | "running" | string;
  pollUrl: string;
  usage: DharmaUsage;
}

export interface RerankCandidate {
  id?: string;
  text: string;
}

export interface RerankResult {
  index: number;
  score: number;
  candidate: RerankCandidate;
}

export interface RerankResponse {
  ok: true;
  usage: DharmaUsage;
  results: RerankResult[];
}

export interface DharmaErrorBody {
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Errors — typed so callers can branch on why a call failed.
// ---------------------------------------------------------------------------

export class DharmaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** When true, callers MUST NOT retry (e.g. empty credit pool, bad scope). */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "DharmaApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface DharmaClientOptions {
  baseUrl?: string;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Max retries for transient failures — network / 5xx (default 3). */
  maxRetries?: number;
  /** Ceiling on async poll attempts before giving up (default 20). */
  maxPollAttempts?: number;
  /** Delay between async polls in ms (default 1500). */
  pollIntervalMs?: number;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
}

const isServer = typeof (globalThis as { window?: unknown }).window === "undefined";

export class DharmaDeveloperClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxPollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Running total of credits charged across every call this client has made. */
  public creditsSpent = 0;
  public lastPoolBalance: number | null = null;

  constructor(
    private readonly orgId: string,
    private readonly token: string,
    opts: DharmaClientOptions = {},
  ) {
    if (!orgId) throw new Error("DharmaDeveloperClient: orgId is required");
    if (!token) throw new Error("DharmaDeveloperClient: token is required");
    if (!token.startsWith("dharma_org_")) {
      // The docs are explicit that the prefix must not be stripped. Warn loudly
      // rather than let the developer burn a request on a guaranteed 401.
      console.warn(
        "[DharmaDeveloperClient] token does not start with 'dharma_org_' — this will likely 401.",
      );
    }
    // Guardrail: never let a secret org token run in a browser bundle.
    if (!isServer) {
      console.warn(
        "[DharmaDeveloperClient] running in a browser context. Developer tokens are secrets — proxy calls through a server route instead.",
      );
    }

    this.baseUrl = (opts.baseUrl ?? "https://dharma-ai.io/api").replace(/\/$/, "");
    // pollUrl values are absolute paths beginning with /api, so we resolve them
    // against the origin, not the /api-suffixed base.
    this.origin = this.baseUrl.replace(/\/api$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxPollAttempts = opts.maxPollAttempts ?? 20;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // -- public API ----------------------------------------------------------

  /**
   * Vector RAG search. `topK` is clamped to the documented 1..20 range.
   * Transparently resolves the async 202 poll-loop contract.
   */
  async search(
    query: string,
    opts: { topK?: number; language?: string } = {},
  ): Promise<SearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("search: query must be a non-empty string");
    const topK = Math.min(20, Math.max(1, Math.round(opts.topK ?? 8)));

    const data = await this.post<SearchResponse | AsyncQueued>(
      `/orgs/${this.orgId}/developer/rag/search`,
      { query: trimmed, topK, language: opts.language ?? "en" },
    );

    if ("async" in data && (data as AsyncQueued).async) {
      return this.pollForSearch(data as AsyncQueued);
    }
    return data as SearchResponse;
  }

  /** Cross-encoder rerank. Returns candidates sorted by strict relevance. */
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("rerank: query must be a non-empty string");
    if (!candidates.length) throw new Error("rerank: candidates must be non-empty");

    return this.post<RerankResponse>(`/orgs/${this.orgId}/developer/rag/rerank`, {
      query: trimmed,
      candidates: candidates.map((c) => ({ id: c.id, text: c.text })),
    });
  }

  // -- request helpers ----------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", `${this.baseUrl}${path}`, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Network error / timeout — retry with backoff.
      if (attempt < this.maxRetries) {
        await sleep(backoffMs(attempt));
        return this.request<T>(method, url, body, attempt + 1);
      }
      throw new DharmaApiError(
        `Network failure calling Dharma API: ${(err as Error).message}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = (await res.json().catch(() => ({}))) as T & DharmaErrorBody & { usage?: DharmaUsage };

    if (res.ok) {
      this.accountForUsage(data.usage);
      return data as T;
    }

    // Non-2xx: classify before deciding whether to retry.
    const code = data.error;
    const message = data.message ?? code ?? `HTTP ${res.status}`;

    switch (res.status) {
      case 402: // token_pool_empty — docs say HALT, never retry.
        throw new DharmaApiError(
          `Credit pool empty: ${message}. Fund the org balance in the Dharma console.`,
          402,
          code,
          true,
        );
      case 401: // invalid_token
      case 403: // insufficient_scope
      case 400: // invalid_request
        throw new DharmaApiError(message, res.status, code, true);
      case 502:
        // aws_runtime_async_required — a sync call that must go async. Retry
        // once as-is; the server should hand back a 202 with a pollUrl.
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          return this.request<T>(method, url, body, attempt + 1);
        }
        throw new DharmaApiError(message, 502, code);
      default:
        if (res.status >= 500 && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          return this.request<T>(method, url, body, attempt + 1);
        }
        throw new DharmaApiError(message, res.status, code);
    }
  }

  private async pollForSearch(queued: AsyncQueued): Promise<SearchResponse> {
    this.accountForUsage(queued.usage);
    const url = `${this.origin}${queued.pollUrl}`;

    for (let i = 0; i < this.maxPollAttempts; i++) {
      await sleep(this.pollIntervalMs);
      const data = await this.request<
        (SearchResponse & { status?: string }) | (AsyncQueued & { results?: never })
      >("GET", url);

      const status = "status" in data ? data.status : undefined;
      if (!status || status === "completed" || status === "succeeded" || "results" in data) {
        if ("results" in data && Array.isArray((data as SearchResponse).results)) {
          return data as SearchResponse;
        }
      }
      if (status === "failed" || status === "error") {
        throw new DharmaApiError(`Async search ${queued.runId} failed`, 500, "async_failed");
      }
    }
    throw new DharmaApiError(
      `Async search ${queued.runId} did not complete after ${this.maxPollAttempts} polls`,
      504,
      "async_timeout",
    );
  }

  private accountForUsage(usage?: DharmaUsage) {
    if (!usage) return;
    if (typeof usage.creditsCharged === "number") this.creditsSpent += usage.creditsCharged;
    if (typeof usage.poolBalanceCredits === "number") this.lastPoolBalance = usage.poolBalanceCredits;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with full jitter, capped at 8s. */
function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * Math.pow(2, attempt));
  return Math.floor(Math.random() * base);
}
