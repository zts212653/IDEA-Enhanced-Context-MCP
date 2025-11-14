export type SymbolRecord = {
  fqn: string;
  kind: "CLASS" | "INTERFACE" | "METHOD";
  module: string;
  summary: string;
  scoreHints?: {
    references?: number;
    lastModifiedDays?: number;
  };
};

export type SearchHit = SymbolRecord & { score: number };
