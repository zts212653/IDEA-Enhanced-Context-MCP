#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

from pymilvus import Collection, connections

for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
    os.environ.pop(var, None)
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")


def connect(address: str):
    if ":" in address:
        host, port = address.split(":", 1)
    else:
        host, port = address, "19530"
    connections.connect("default", host=host, port=port)


def search(payload: dict):
    connect(payload.get("milvusAddress", "127.0.0.1:19530"))
    collection = Collection(payload["collectionName"])

    params = {"metric_type": payload.get("metricType", "IP"), "params": {}}
    search_params = payload.get("searchParams") or {}
    params["params"].update(search_params)

    expr = None
    module_filter = payload.get("moduleFilter")
    if module_filter:
        expr = f'module == "{module_filter}"'

    results = collection.search(
        data=[payload["vector"]],
        anns_field=payload["vectorField"],
        param=params,
        limit=payload.get("limit", 5),
        expr=expr,
        output_fields=payload.get("outputFields") or ["fqn", "summary", "module"],
    )

    hits = []
    for hit in results[0] if results else []:
        entity = hit.entity
        entity["score"] = hit.score
        hits.append(entity)
    return hits


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python milvus_query.py /path/to/request.json")

    payload = json.loads(Path(sys.argv[1]).read_text())
    hits = search(payload)
    print(json.dumps({"results": hits}))


if __name__ == "__main__":
    main()
