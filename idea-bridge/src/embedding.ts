import type { SymbolRecord } from "./types.js";

export async function generateEmbedding(
  text: string,
  model: string,
  host: string,
): Promise<number[]> {
  const response = await fetch(new URL("/api/embeddings", host), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(
      `Embedding request failed (${response.status}) ${await response.text()}`,
    );
  }

  const json = (await response.json()) as { embedding?: number[] };
  if (!json.embedding) {
    throw new Error("Embedding response missing 'embedding' field");
  }
  return json.embedding;
}

export function symbolToEmbeddingText(symbol: SymbolRecord): string {
  const lines = [
    `Symbol: ${symbol.fqn}`,
    `Kind: ${symbol.kind}`,
    `Module: ${symbol.module}`,
    `Package: ${symbol.packageName}`,
    `Summary: ${symbol.summary}`,
  ];

  if (symbol.javadoc) {
    lines.push(`Javadoc: ${symbol.javadoc}`);
  }

  if (symbol.extends && symbol.extends.length > 0) {
    lines.push(`Extends: ${symbol.extends.join(", ")}`);
  }

  if (symbol.implements && symbol.implements.length > 0) {
    lines.push(`Implements: ${symbol.implements.join(", ")}`);
  }

  if (symbol.methods.length > 0) {
    lines.push("Methods:");
    for (const method of symbol.methods.slice(0, 15)) {
      lines.push(
        `- ${method.signature} :: ${method.javadoc ?? "no docs"} (visibility: ${
          method.visibility
        })`,
      );
    }
  }

  lines.push(`Source: ${symbol.relativePath}`);
  const text = lines.join("\n");
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

export function fallbackEmbedding(
  text: string,
  dimension = 384,
): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const idx = code % dimension;
    vector[idx] += (code % 7) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vector.map((val) => Number((val / norm).toFixed(6)));
}
