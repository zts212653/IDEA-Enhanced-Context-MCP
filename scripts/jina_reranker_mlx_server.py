"""
MLX-based Jina reranker server for Apple Silicon.

Usage:
  python scripts/jina_reranker_mlx_server.py

Environment (optional):
  HOST=127.0.0.1
  PORT=7998
  MODEL_DIR=tmp/jina-reranker-v3-mlx    # path containing model.safetensors, config.json, rerank.py
  PROJECTOR_PATH=projector.safetensors
  TOP_K=20                              # default top_k if not provided in request
  BATCH_SIZE=8                          # currently unused (MLX runs full list)

Endpoint:
  POST /rerank
  {
    "query": "text",
    "documents": ["doc1", "doc2", ...],
    "top_k": 5,              // optional
    "return_embeddings": false
  }

Returns:
  {
    "results": [
      {"index": 0, "score": 0.42},
      ...
    ],
    "model": "<model_dir>",
    "device": "mlx"
  }
"""

from __future__ import annotations

import os
import sys
from typing import List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "tmp", "jina-reranker-v3-mlx"),
)

MODEL_DIR = os.environ.get("MODEL_DIR", ROOT)
PROJECTOR_PATH = os.environ.get("PROJECTOR_PATH", "projector.safetensors")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "7998"))
DEFAULT_TOP_K = int(os.environ.get("TOP_K", "20"))

# Ensure rerank.py is importable
if MODEL_DIR not in sys.path:
  sys.path.insert(0, MODEL_DIR)

try:
  from rerank import MLXReranker  # type: ignore
except Exception as exc:  # noqa: BLE001
  raise RuntimeError(
    f"Failed to import MLXReranker from {MODEL_DIR}. "
    "Make sure the model repo (jina-reranker-v3-mlx) is downloaded and requirements installed."
  ) from exc

app = FastAPI(title="Jina reranker MLX service", version="1.0.0")

print(f"[jina-reranker-mlx] loading model from {MODEL_DIR}")
reranker = MLXReranker(model_path=MODEL_DIR, projector_path=os.path.join(MODEL_DIR, PROJECTOR_PATH))
print("[jina-reranker-mlx] model loaded.")


class RerankRequest(BaseModel):
  query: str
  documents: List[str] = Field(min_items=1)
  top_k: Optional[int] = None
  return_embeddings: bool = False


@app.post("/rerank")
async def rerank_endpoint(req: RerankRequest):
  if not req.query:
    raise HTTPException(status_code=400, detail="query is required")
  if not req.documents:
    raise HTTPException(status_code=400, detail="documents must not be empty")

  try:
    results = reranker.rerank(
      req.query,
      req.documents,
      top_n=req.top_k or DEFAULT_TOP_K,
      return_embeddings=req.return_embeddings,
    )
    return {
      "results": [
        {"index": item.get("index"), "score": float(item.get("relevance_score", 0.0))}
        for item in results
      ],
      "model": MODEL_DIR,
      "device": "mlx",
    }
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
  uvicorn.run(app, host=HOST, port=PORT, log_level="info")
