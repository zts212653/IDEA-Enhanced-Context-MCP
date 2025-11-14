export type SymbolKind = "CLASS" | "INTERFACE";

export interface MethodInfo {
  name: string;
  signature: string;
  visibility: string;
  returnType: string;
  parameters: string[];
  javadoc?: string;
}

export interface SymbolRecord {
  fqn: string;
  kind: SymbolKind;
  module: string;
  packageName: string;
  relativePath: string;
  filePath: string;
  summary: string;
  javadoc?: string;
  implements?: string[];
  extends?: string[];
  modifiers: string[];
  methods: MethodInfo[];
}

export interface SearchResult extends SymbolRecord {
  score: number;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  module?: string;
}
