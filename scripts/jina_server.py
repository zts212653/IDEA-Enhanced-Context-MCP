"""
Lightweight Jina v3 embedding server for local dev on Apple Silicon (MPS).

Usage:
  python scripts/jina_server.py

Environment (optional):
  HOST=127.0.0.1
  PORT=7997
  MODEL=jinaai/jina-embeddings-v3
  DEVICE=mps|cpu

Endpoints:
  POST /embed
  {
    "inputs": "text or code snippet" | ["list", "of", "texts"],
    "instruction": "retrieval.passage" | "retrieval.query" | ...
  }

Why: Jina v3 needs task-specific instruction to activate the right LoRA
(`retrieval.passage` for documents, `retrieval.query` for queries). Ollama
doesn't pass this through, so we expose a minimal FastAPI service instead.
"""

from __future__ import annotations

import os
from typing import List, Union

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "7997"))
MODEL = os.environ.get("MODEL", "jinaai/jina-embeddings-v3")
DEVICE = os.environ.get("DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")

app = FastAPI(title="Jina v3 embedding service", version="1.0.0")

print(f"[jina-server] loading {MODEL} on {DEVICE} (FP16)...")
model = SentenceTransformer(MODEL, trust_remote_code=True, device=DEVICE)
model.half()
print("[jina-server] model loaded.")


class EmbedRequest(BaseModel):
  inputs: Union[str, List[str]]
  instruction: str = "retrieval.passage"


@app.post("/embed")
async def embed(req: EmbedRequest):
  try:
    texts = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    print(
      f"[jina-server] embedding {len(texts)} item(s) "
      f"task={req.instruction} batch_size=32",
    )
    vectors = model.encode(
      texts,
      task=req.instruction,
      prompt_name=req.instruction,
      batch_size=32,
      show_progress_bar=False,
    )
    if DEVICE == "mps":
      torch.mps.empty_cache()
    return {"embeddings": vectors.tolist()}
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
  uvicorn.run(app, host=HOST, port=PORT, log_level="info")
