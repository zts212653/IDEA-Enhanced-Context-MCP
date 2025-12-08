export type RerankConfig = {
  enabled: boolean;
  provider: "jina" | "hf" | "ollama" | "openai" | "custom" | null;
  host?: string;
  model?: string;
  apiKey?: string;
  maxCandidates: number;
  topK: number;
  timeoutMs: number;
  logProbes: boolean;
};

export type RerankCandidate = {
  id: string;
  text: string;
};

export type RerankResult = {
  id: string;
  score: number;
};

type FetchResponse = {
  json(): Promise<unknown>;
};
type FetchLike = (input: string | URL, init?: Record<string, unknown>) => Promise<FetchResponse>;
const fetchFn: FetchLike = (globalThis as any).fetch;
const AbortCtor: any = (globalThis as any).AbortController;

export function loadRerankConfig(): RerankConfig {
  const enabled = process.env.RERANK_ENABLED === "1";
  const provider =
    (process.env.RERANK_PROVIDER as RerankConfig["provider"]) ?? null;
  return {
    enabled,
    provider,
    host: process.env.RERANK_HOST,
    model: process.env.RERANK_MODEL,
    apiKey: process.env.RERANK_API_KEY,
    maxCandidates: Number(process.env.RERANK_MAX_CANDIDATES ?? 40),
    topK: Number(process.env.RERANK_TOP_K ?? 10),
    timeoutMs: Number(process.env.RERANK_TIMEOUT_MS ?? 6000),
    logProbes: process.env.RERANK_LOG_PROBES === "1",
  };
}

export interface Reranker {
  rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult[]>;
}

export function createReranker(config: RerankConfig): Reranker | null {
  if (!config.enabled) return null;
  if (config.provider === "jina" || !config.provider) {
    return new JinaReranker(config);
  }
  // Other providers can be added here; fall back to null when unsupported.
  return null;
}

class JinaReranker implements Reranker {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly logProbes: boolean;

  constructor(config: RerankConfig) {
    this.endpoint = config.host ?? "https://api.jina.ai/v1/rerank";
    this.model = config.model ?? "jina-reranker-v3-base";
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.logProbes = config.logProbes;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult[]> {
    if (!fetchFn) return [];
    if (!candidates.length) return [];
    const controller = AbortCtor ? new AbortCtor() : null;
    const timer = setTimeout(() => controller?.abort(), this.timeoutMs);
    try {
      const resp = await fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: candidates.map((c) => c.text),
          top_k: candidates.length,
        }),
        signal: controller?.signal as any,
      });
      const json = (await resp.json()) as {
        results?: Array<{ index: number; relevance_score?: number }>;
      };
      const results =
        json.results?.map((item) => {
          const cand = candidates[item.index];
          return {
            id: cand?.id ?? String(item.index),
            score:
              typeof item.relevance_score === "number"
                ? item.relevance_score
                : 0,
          };
        }) ?? [];
      if (this.logProbes) {
        console.error(
          "[rerank:jina] count=",
          candidates.length,
          "results=",
          results.length,
        );
      }
      return results;
    } catch (error) {
      if (this.logProbes) {
        console.error("[rerank:jina] failed", error);
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
