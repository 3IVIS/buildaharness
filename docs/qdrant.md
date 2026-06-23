# Qdrant setup

Qdrant is the vector store used by RAG flows in buildaharness. It is **included in the default Docker Compose stack** — no separate installation is needed when running locally. This guide covers:

- How Qdrant is wired in the stack
- Seeding the `knowledge_base` collection
- Adding new collections and connecting them to flows
- Running Qdrant in production (Kubernetes / external managed)

---

## Stack wiring

The `qdrant` service in `docker-compose.yml` runs `qdrant/qdrant:v1.13.0` and is available at:

| From | URL |
|---|---|
| Host machine | `http://localhost:6333` |
| Adapter container | `http://qdrant:6333` |
| Mastra runner container | `http://qdrant:6333` |

The adapter and mastra-runner containers have `QDRANT_URL=http://qdrant:6333` and `EMBED_BASE_URL=http://litellm:4000` pre-set. You do not need to add these to `.env` for the default stack.

Data is persisted in the `qdrant_data` named Docker volume. It survives restarts but is removed by `docker compose down --volumes` or `scripts/reset-volumes.sh`.

---

## Embedding model

RAG flows embed text via LiteLLM. The default embedding model is `nomic-embed-text`, registered in `adapter/litellm_config.yaml`:

```yaml
- model_name: nomic-embed-text
  litellm_params:
    model: ollama/nomic-embed-text
```

This requires Ollama to be running on the host with the model pulled:

```bash
ollama pull nomic-embed-text
```

Embedding calls always route through LiteLLM (even when LLM calls bypass it via `OPENAI_BASE_URL`) so they appear in Langfuse traces.

### Using a different embedding model

To use OpenAI `text-embedding-3-small` instead, add to `adapter/litellm_config.yaml`:

```yaml
- model_name: text-embedding-3-small
  litellm_params:
    model: openai/text-embedding-3-small
    api_key: os.environ/OPENAI_API_KEY
```

Then set `EMBED_MODEL=text-embedding-3-small` in `.env` and restart the `litellm` container:

```bash
docker compose restart litellm
```

Note that OpenAI embeddings produce 1536-dimensional vectors. If you are recreating an existing collection, the dimension must match. Recreate the collection when changing models.

---

## Seeding the `knowledge_base` collection

The default RAG flow (`flows/01-rag-agent-flow.json`) retrieves from a collection called `knowledge_base`. Seed it with Wikipedia articles:

```bash
python scripts/ingest_rag_data.py
```

This script:
1. Fetches 5 Wikipedia articles (RAG, LLMs, vector databases, word embeddings, semantic search)
2. Splits them into 250-word chunks with 50-word overlap
3. Embeds each chunk via LiteLLM (`nomic-embed-text`, 768 dimensions)
4. Upserts the vectors into Qdrant

The collection is **recreated from scratch** on each run. Run again after pulling new models or changing the embedding dimension.

### Environment variables for the ingest script

| Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant URL. Use `localhost` when running the script from the host. |
| `EMBED_BASE_URL` | `http://localhost:4000` | LiteLLM proxy URL. Use `localhost` from the host. |
| `OPENAI_API_KEY` | `ollama` | API key sent to LiteLLM. Falls back to `LITELLM_MASTER_KEY` from `.env`. |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name as registered in LiteLLM. |
| `COLLECTION` | `knowledge_base` | Target Qdrant collection name. |

### Prerequisites

```bash
# Pull the embedding model in Ollama (host machine)
ollama pull nomic-embed-text

# Start the stack (LiteLLM and Qdrant must be running)
docker compose up -d litellm qdrant

# Install qdrant-client if running outside the venv
pip install qdrant-client

# Run from the project root
python scripts/ingest_rag_data.py
```

Expected output:

```
Qdrant : http://localhost:6333
Embed  : http://localhost:4000  model=nomic-embed-text

Fetching 'Retrieval-augmented generation' … 47 chunks (11604 words)
Fetching 'Large language model' … 89 chunks (21932 words)
...
Total chunks: 312

Embedding (20 chunks/batch) …
  batch 1: 20 vectors (total 20)
  ...

Connecting to Qdrant at http://localhost:6333 …
  deleted existing collection 'knowledge_base'
  created collection 'knowledge_base' (768d cosine)

Upserting 312 points …
  ...
Done. Collection 'knowledge_base': 312 points indexed.
```

---

## Adding a custom collection

To add a collection for a new domain (e.g. product documentation), create a new ingest script or extend the existing one:

```python
# Override environment variables before running
QDRANT_URL  = "http://localhost:6333"
COLLECTION  = "product_docs"
EMBED_MODEL = "nomic-embed-text"
DIMENSIONS  = 768
```

Then reference the new collection in your flow spec:

```json
"memory_stores": {
  "product_kb": {
    "type": "vector",
    "backend": "qdrant",
    "connection_env": "QDRANT_URL",
    "embedding_model": "nomic-embed-text",
    "dimensions": 768
  }
},
"nodes": [
  {
    "id": "retrieve",
    "type": "memory_read",
    "store_id": "product_kb",
    "retrieval_mode": "semantic",
    "query_expr": "$.state.question",
    "top_k": 5,
    "output_key": "retrieved_chunks"
  }
]
```

The adapter resolves `QDRANT_URL` from the environment at runtime and queries the collection whose name matches `store_id`.

---

## Inspecting collections

Qdrant ships a web UI at `http://localhost:6333/dashboard`. Use it to browse collections, run test queries, and inspect stored vectors.

Useful REST calls (requires the stack to be running):

```bash
# List collections
curl http://localhost:6333/collections | jq '.result.collections[].name'

# Collection info (point count, vector config)
curl http://localhost:6333/collections/knowledge_base | jq '.result'

# Test a scroll (first 3 points, with payload)
curl -X POST http://localhost:6333/collections/knowledge_base/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit": 3, "with_payload": true}' | jq '.result.points[].payload.title'
```

---

## Production deployment

### Kubernetes (Helm)

Add Qdrant to your cluster using the official Helm chart:

```bash
helm repo add qdrant https://qdrant.github.io/qdrant-helm
helm install qdrant qdrant/qdrant \
  --set persistence.size=20Gi \
  --set service.type=ClusterIP
```

Then set in your buildaharness Helm values:

```yaml
adapter:
  env:
    QDRANT_URL: "http://qdrant:6333"
```

### Qdrant Cloud (managed)

1. Create a cluster at [cloud.qdrant.io](https://cloud.qdrant.io)
2. Copy the cluster URL and API key
3. Add to `.env`:

```env
QDRANT_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-api-key
```

The adapter passes `QDRANT_API_KEY` automatically when connecting if the variable is set.

### External Qdrant with Docker Compose

To use an external Qdrant instance instead of the bundled service, comment out the `qdrant` service in `docker-compose.yml` and set:

```env
QDRANT_URL=http://your-qdrant-host:6333
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Connection refused` to `localhost:6333` | Run `docker compose up qdrant` — the service may not have started |
| `Collection not found` when running a RAG flow | Run `python scripts/ingest_rag_data.py` to seed the collection |
| Embedding calls fail with `model not found` | Run `ollama pull nomic-embed-text` and restart `litellm` |
| Dimension mismatch error on upsert | Recreate the collection — dimensions are fixed at creation time. Re-run the ingest script |
| Slow embedding (> 30 s per batch) | First-run model loading; subsequent batches will be faster. Use a smaller model or increase `BATCH_SIZE` |
| `qdrant_data` volume has stale data | `docker volume rm buildaharness_qdrant_data` then re-run ingest |
