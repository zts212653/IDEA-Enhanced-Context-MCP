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
    collection.load()

    params = {"metric_type": payload.get("metricType", "IP"), "params": {}}
    search_params = payload.get("searchParams") or {}
    params["params"].update(search_params)

    expr_parts = []
    module_filter = payload.get("moduleFilter")
    if module_filter:
        expr_parts.append(f'module_name == "{module_filter}"')

    levels = payload.get("levels")
    if levels:
        level_expr = " or ".join([f'index_level == "{level}"' for level in levels])
        expr_parts.append(f"({level_expr})")

    expr = " and ".join(expr_parts) if expr_parts else None

    output_fields = payload.get("outputFields") or [
        "index_level",
        "repo_name",
        "module_name",
        "package_name",
        "symbol_name",
        "summary",
        "metadata",
        "fqn",
      ]

    results = collection.search(
        data=[payload["vector"]],
        anns_field=payload["vectorField"],
        param=params,
        limit=payload.get("limit", 5),
        expr=expr,
        output_fields=output_fields,
    )

    hits = []
    for hit in results[0] if results else []:
        entity = hit.entity
        record = {}
        for field in output_fields:
            record[field] = entity.get(field)
        record["score"] = float(hit.score)
        hits.append(record)
    return hits


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python milvus_query.py /path/to/request.json")

    payload = json.loads(Path(sys.argv[1]).read_text())
    hits = search(payload)
    print(json.dumps({"results": hits}))


if __name__ == "__main__":
    main()
