import type { SymbolRecord } from "./types.js";

export async function generateEmbedding(
  text: string,
  model: string,
  host: string,
  provider = "ollama",
  task = "retrieval.passage",
): Promise<number[]> {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === "jina") {
    const response = await fetch(new URL("/embed", host), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: text,
        instruction: task,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed (${response.status}) ${await response.text()}`,
      );
    }
    const json = (await response.json()) as { embeddings?: number[][] };
    const embedding = Array.isArray(json.embeddings) ? json.embeddings[0] : undefined;
    if (!embedding) {
      throw new Error("Embedding response missing 'embeddings' field");
    }
    return embedding;
  }

  // Default: Ollama/OpenAI-compatible
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
  const typeInfo = symbol.typeInfo ?? {
    visibility: "package-private",
    isAbstract: false,
    isFinal: false,
    isInterface: false,
    modifiers: [],
  };
  const annotations = symbol.annotations ?? [];
  const fields = symbol.fields ?? [];
  const methods = symbol.methods ?? [];
  const relations = symbol.relations ?? {
    calls: [],
    calledBy: [],
    references: [],
  };
  const quality = symbol.quality ?? {
    hasJavadoc: Boolean(symbol.javadoc),
    methodCount: methods.length,
    fieldCount: fields.length,
    annotationCount: annotations.length,
  };

  const lines = [
    `Repository: ${symbol.repoName}`,
    `Module: ${symbol.module} (${symbol.modulePath})`,
    `Symbol: ${symbol.fqn}`,
    `Kind: ${symbol.kind}`,
    `Visibility: ${typeInfo.visibility}`,
    `Type traits: interface=${typeInfo.isInterface}, abstract=${typeInfo.isAbstract}, final=${typeInfo.isFinal}`,
    `Modifiers: ${typeInfo.modifiers.join(" ") || "none"}`,
    `Package: ${symbol.packageName}`,
    `Summary: ${symbol.summary}`,
  ];

  if (symbol.javadoc) {
    lines.push(`Javadoc: ${symbol.javadoc}`);
  }

  if (annotations.length > 0) {
    lines.push(
      `Annotations: ${annotations.map((ann) => ann.fqn ?? ann.name).join(", ")}`,
    );
  }

  if (symbol.extends && symbol.extends.length > 0) {
    lines.push(`Extends: ${symbol.extends.join(", ")}`);
  }

  if (symbol.implements && symbol.implements.length > 0) {
    lines.push(`Implements: ${symbol.implements.join(", ")}`);
  }

  if (symbol.hierarchy) {
    lines.push(
      `Hierarchy: super=${symbol.hierarchy.superClass ?? "Object"}, interfaces=${symbol.hierarchy.interfaces.join(", ") || "none"}`,
    );
  }

  if (fields.length > 0) {
    lines.push("Fields:");
    for (const field of fields.slice(0, 10)) {
      lines.push(
        `- ${field.type} ${field.name} (${field.annotations
          .map((ann) => ann.name)
          .join(", ")})`,
      );
    }
  }

  if (methods.length > 0) {
    lines.push("Key methods:");
    for (const method of methods.slice(0, 10)) {
      lines.push(
        `- ${method.signature} :: returns ${
          method.returnTypeFqn ?? method.returnType
        }`,
      );
    }
  }

  if (relations.calls.length > 0) {
    lines.push(`Calls: ${relations.calls.slice(0, 10).join(", ")}`);
  }
  if (relations.calledBy.length > 0) {
    lines.push(`Called by: ${relations.calledBy.slice(0, 10).join(", ")}`);
  }
  if (relations.references.length > 0) {
    lines.push(`References: ${relations.references.slice(0, 10).join(", ")}`);
  }

  if (symbol.springInfo?.isSpringBean) {
    lines.push(
      `Spring bean type: ${symbol.springInfo.beanType}, bean name: ${symbol.springInfo.beanName}`,
    );
    if (symbol.springInfo.autoWiredDependencies.length > 0) {
      lines.push(
        `Auto-wired dependencies: ${symbol.springInfo.autoWiredDependencies.join(
          ", ",
        )}`,
      );
    }
  }

  lines.push(
    `Quality: methods=${quality.methodCount}, fields=${quality.fieldCount}, annotations=${quality.annotationCount}, hasJavadoc=${quality.hasJavadoc}`,
  );

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
