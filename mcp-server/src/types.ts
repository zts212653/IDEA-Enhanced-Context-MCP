export type SymbolRecord = {
  fqn: string;
  kind: "CLASS" | "INTERFACE" | "METHOD" | "MODULE" | "REPOSITORY";
  module: string;
  summary: string;
  metadata?: Record<string, unknown>;
  indexLevel?: string;
  scoreHints?: {
    references?: number;
    lastModifiedDays?: number;
  };
};

export type SearchHit = SymbolRecord & { score: number };
