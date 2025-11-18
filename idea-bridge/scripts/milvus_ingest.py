#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

from pymilvus import (
    Collection,
    CollectionSchema,
    DataType,
    FieldSchema,
    connections,
    utility,
)

for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
    os.environ.pop(var, None)
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")


def connect(address: str):
    if ":" in address:
        host, port = address.split(":", 1)
    else:
        host, port = address, "19530"
    connections.connect("default", host=host, port=port)


def ensure_collection(payload):
    vector_field = payload["vectorField"]
    dimension = payload["dimension"]

    fields = [
        FieldSchema(
            name="id",
            dtype=DataType.VARCHAR,
            is_primary=True,
            auto_id=False,
            max_length=512,
        ),
        FieldSchema(
            name="index_level",
            dtype=DataType.VARCHAR,
            max_length=32,
        ),
        FieldSchema(
            name="repo_name",
            dtype=DataType.VARCHAR,
            max_length=256,
        ),
        FieldSchema(
            name="module_name",
            dtype=DataType.VARCHAR,
            max_length=256,
        ),
        FieldSchema(
            name="module_path",
            dtype=DataType.VARCHAR,
            max_length=512,
        ),
        FieldSchema(
            name="package_name",
            dtype=DataType.VARCHAR,
            max_length=512,
        ),
        FieldSchema(
            name="symbol_name",
            dtype=DataType.VARCHAR,
            max_length=512,
        ),
        FieldSchema(
            name="fqn",
            dtype=DataType.VARCHAR,
            max_length=1024,
        ),
        FieldSchema(
            name="summary",
            dtype=DataType.VARCHAR,
            max_length=2048,
        ),
        FieldSchema(
            name="metadata",
            dtype=DataType.VARCHAR,
            max_length=8192,
        ),
        FieldSchema(
            name=vector_field,
            dtype=DataType.FLOAT_VECTOR,
            dim=dimension,
        ),
    ]

    schema = CollectionSchema(
        fields,
        description="IDEA Enhanced Context symbols",
    )

    if payload.get("reset") and utility.has_collection(payload["collectionName"]):
        utility.drop_collection(payload["collectionName"])

    if not utility.has_collection(payload["collectionName"]):
        Collection(
            name=payload["collectionName"],
            schema=schema,
            using="default",
        )

    collection = Collection(name=payload["collectionName"])
    # Create index only if not present (script may run chunked)
    if not collection.indexes:
        collection.create_index(
            field_name=vector_field,
            index_params={
                "metric_type": "IP",
                "index_type": "IVF_FLAT",
                "params": {"nlist": 1024},
            },
        )
    return collection


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python milvus_ingest.py /path/to/symbols.json")

    json_path = Path(sys.argv[1])
    payload = json.loads(json_path.read_text())

    connect(payload.get("milvusAddress", "127.0.0.1:19530"))
    collection = ensure_collection(payload)

    rows = payload["rows"]
    if not rows:
        print("No rows to ingest.")
        return

    print(f"Inserting {len(rows)} rows into Milvus...")
    for batch_start in range(0, len(rows), 64):
        batch = rows[batch_start : batch_start + 64]
        collection.insert(batch)

    collection.load()
    print("Milvus ingestion done.")


if __name__ == "__main__":
    main()
