"""
Lightweight Jina reranker server for local dev on Apple Silicon (MPS).

Usage:
  python scripts/jina_reranker_server.py

Environment (optional):
  HOST=127.0.0.1
  PORT=7998
  MODEL=jinaai/jina-reranker-v3-base
  DEVICE=mps|cpu
  BATCH_SIZE=8

Endpoint:
  POST /rerank
  {
    "query": "text",
    "documents": ["doc1", "doc2", ...],
    "top_k": 5  // optional
  }

Returns:
  {
    "results": [
      {"index": 0, "score": 0.42},
      ...
    ],
    "model": "...",
    "device": "mps"
  }
"""

from __future__ import annotations

import os
from typing import List, Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "7998"))
MODEL = os.environ.get("MODEL", "jinaai/jina-reranker-v3-base")
DEVICE = os.environ.get("DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "8"))

app = FastAPI(title="Jina reranker service", version="1.0.0")

print(f"[jina-reranker] loading {MODEL} on {DEVICE}...")
model = CrossEncoder(
  MODEL,
  device=DEVICE,
  trust_remote_code=True,
  revision=os.environ.get("REVISION"),
  token=os.environ.get("HF_TOKEN"),
)
print("[jina-reranker] model loaded.")


class RerankRequest(BaseModel):
  query: str
  documents: List[str] = Field(min_items=1)
  top_k: Optional[int] = None


@app.post("/rerank")
async def rerank(req: RerankRequest):
  if not req.query:
    raise HTTPException(status_code=400, detail="query is required")
  if not req.documents:
    raise HTTPException(status_code=400, detail="documents must not be empty")

  pairs = [(req.query, doc) for doc in req.documents]
  try:
    scores = model.predict(
      pairs,
      batch_size=BATCH_SIZE,
      convert_to_tensor=True,
      show_progress_bar=False,
    )
    if DEVICE == "mps":
      torch.mps.empty_cache()
    top_k = req.top_k or len(req.documents)
    indexed = [
      {"index": idx, "score": float(scores[idx])}
      for idx in range(len(req.documents))
    ]
    indexed.sort(key=lambda item: item["score"], reverse=True)
    return {
      "results": indexed[:top_k],
      "model": MODEL,
      "device": DEVICE,
    }
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
  uvicorn.run(app, host=HOST, port=PORT, log_level="info")
