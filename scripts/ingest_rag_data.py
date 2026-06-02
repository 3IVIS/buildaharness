#!/usr/bin/env python3
"""
Seed the Qdrant 'knowledge_base' collection with Wikipedia articles.

Usage (from project root):
    python scripts/ingest_rag_data.py

Environment variables (all optional — defaults shown):
    QDRANT_URL       http://localhost:6333
    EMBED_BASE_URL   http://localhost:4000   (LiteLLM proxy)
    OPENAI_API_KEY   ollama
    EMBED_MODEL      nomic-embed-text
    COLLECTION       knowledge_base
"""
import json
import os
import uuid
import urllib.error
import urllib.parse
import urllib.request
from itertools import islice

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

# ── Config ────────────────────────────────────────────────────────────────────

QDRANT_URL   = os.environ.get("QDRANT_URL",     "http://localhost:6333")
EMBED_BASE   = os.environ.get("EMBED_BASE_URL",  "http://localhost:4000")
OPENAI_KEY   = os.environ.get("OPENAI_API_KEY",  "ollama")
EMBED_MODEL  = os.environ.get("EMBED_MODEL",     "nomic-embed-text")
COLLECTION   = os.environ.get("COLLECTION",      "knowledge_base")
DIMENSIONS   = 768
CHUNK_WORDS  = 250
OVERLAP_WORDS = 50
BATCH_SIZE   = 20

WIKIPEDIA_UA = "itsharness-ingest/1.0 (admin@itsharness.dev)"

TOPICS = [
    "Retrieval-augmented generation",
    "Large language model",
    "Vector database",
    "Word embedding",
    "Semantic search",
]

# ── Wikipedia fetch ───────────────────────────────────────────────────────────

def fetch_article(title: str) -> str:
    url = (
        "https://en.wikipedia.org/w/api.php"
        "?action=query"
        f"&titles={urllib.parse.quote(title)}"
        "&prop=extracts&explaintext=1&format=json&redirects=1"
    )
    req = urllib.request.Request(url, headers={"User-Agent": WIKIPEDIA_UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    pages = data["query"]["pages"]
    page  = next(iter(pages.values()))
    return page.get("extract", "") or ""


# ── Chunking ─────────────────────────────────────────────────────────────────

def chunk_text(text: str, title: str) -> list[dict]:
    words  = text.split()
    chunks = []
    start  = 0
    idx    = 0
    while start < len(words):
        end    = min(start + CHUNK_WORDS, len(words))
        window = words[start:end]
        chunks.append({
            "text":   " ".join(window),
            "source": f"wikipedia:{title.replace(' ', '_')}#{idx}",
            "title":  title,
        })
        if end == len(words):
            break
        start += CHUNK_WORDS - OVERLAP_WORDS
        idx   += 1
    return chunks


# ── Embedding ─────────────────────────────────────────────────────────────────

def embed_batch(texts: list[str]) -> list[list[float]]:
    payload = json.dumps({"model": EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        f"{EMBED_BASE}/v1/embeddings",
        data=payload,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {OPENAI_KEY}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return [item["embedding"] for item in data["data"]]


def batched(iterable, n):
    it = iter(iterable)
    while True:
        batch = list(islice(it, n))
        if not batch:
            break
        yield batch


# ── Qdrant upsert ─────────────────────────────────────────────────────────────

def recreate_collection(client: QdrantClient) -> None:
    existing = {c.name for c in client.get_collections().collections}
    if COLLECTION in existing:
        client.delete_collection(COLLECTION)
        print(f"  deleted existing collection '{COLLECTION}'")
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=DIMENSIONS, distance=Distance.COSINE),
    )
    print(f"  created collection '{COLLECTION}' ({DIMENSIONS}d cosine)")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Qdrant : {QDRANT_URL}")
    print(f"Embed  : {EMBED_BASE}  model={EMBED_MODEL}")
    print()

    # 1. Fetch articles
    all_chunks: list[dict] = []
    for title in TOPICS:
        print(f"Fetching '{title}' …", end=" ", flush=True)
        try:
            text   = fetch_article(title)
            chunks = chunk_text(text, title)
            all_chunks.extend(chunks)
            print(f"{len(chunks)} chunks ({len(text.split())} words)")
        except Exception as exc:
            print(f"FAILED: {exc}")

    if not all_chunks:
        raise SystemExit("No chunks produced — check Wikipedia connectivity.")

    print(f"\nTotal chunks: {len(all_chunks)}")

    # 2. Embed in batches
    print(f"\nEmbedding ({BATCH_SIZE} chunks/batch) …")
    all_vectors: list[list[float]] = []
    for i, batch in enumerate(batched(all_chunks, BATCH_SIZE), 1):
        texts = [c["text"] for c in batch]
        vecs  = embed_batch(texts)
        all_vectors.extend(vecs)
        print(f"  batch {i}: {len(vecs)} vectors (total {len(all_vectors)})")

    # 3. Create Qdrant collection
    print(f"\nConnecting to Qdrant at {QDRANT_URL} …")
    client = QdrantClient(url=QDRANT_URL)
    recreate_collection(client)

    # 4. Upsert
    print(f"\nUpserting {len(all_chunks)} points …")
    points = [
        PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, chunk["source"])),
            vector=vec,
            payload={
                "text":   chunk["text"],
                "source": chunk["source"],
                "title":  chunk["title"],
            },
        )
        for chunk, vec in zip(all_chunks, all_vectors)
    ]
    for i, batch in enumerate(batched(points, BATCH_SIZE), 1):
        client.upsert(collection_name=COLLECTION, points=batch)
        print(f"  upserted batch {i} ({len(batch)} points)")

    info = client.get_collection(COLLECTION)
    print(f"\nDone. Collection '{COLLECTION}': {info.points_count} points indexed.")


if __name__ == "__main__":
    main()
