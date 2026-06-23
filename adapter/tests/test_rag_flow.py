"""
RAG flow integration tests: seed real Wikipedia data, compile through all 4
adapters, and run the generated LangGraph code end-to-end with the seeded chunks.

Wikipedia is used as a reproducible, freely-available knowledge source.  The
fetched text is split into sentence-level chunks that match the shape Qdrant
would return (dict with 'text', 'source', and 'score' keys).
"""

from __future__ import annotations

import json
import re
import sys
import types
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ── adapters ──────────────────────────────────────────────────────────────────
from crewai_adapter import compile_crewai
from langgraph_adapter import compile_langgraph
from maf_adapter import compile_maf
from mastra_adapter import compile_mastra
from rag_utils import format_chunks

# ── Lightweight fake StateGraph (used when langgraph is not installed) ────────


class _FakeStateGraph:
    """Minimal StateGraph stub that actually executes registered node functions."""

    def __init__(self, state_type=None):
        self._nodes: dict = {}
        self._succs: dict = {}
        self._entry: str | None = None

    def add_node(self, name, fn=None, **_kw):
        self._nodes[name] = fn or (lambda s: {})

    def add_edge(self, src, dst):
        if src == "__start__":
            self._entry = dst
        elif dst != "__end__":
            self._succs.setdefault(src, []).append(dst)

    def add_conditional_edges(self, src, fn, mapping=None, **_kw):
        for dst in (mapping or {}).values():
            if dst != "__end__":
                self._succs.setdefault(src, []).append(dst)

    def compile(self, **_kw):
        return _FakeCompiled(self._nodes, self._succs, self._entry)


class _FakeCompiled:
    def __init__(self, nodes, succs, entry):
        self._nodes = nodes
        self._succs = succs
        self._entry = entry

    def stream(self, inputs, stream_mode="updates", config=None):
        state = dict(inputs)
        preds: dict = {}
        for src, dsts in self._succs.items():
            for dst in dsts:
                preds.setdefault(dst, set()).add(src)
        queue: list[str] = [self._entry] if self._entry else []
        done: set[str] = set()
        queued: set[str] = set(queue)
        while queue:
            ready = [n for n in queue if all(p in done for p in preds.get(n, set()))]
            if not ready:
                break
            queue = [n for n in queue if n not in ready]
            for name in ready:
                fn = self._nodes.get(name)
                if fn is None or name in done:
                    continue
                done.add(name)
                update = fn(state) or {}
                if isinstance(update, dict):
                    state.update(update)
                yield {name: update}
                for nxt in self._succs.get(name, []):
                    if nxt not in done and nxt not in queued:
                        queue.append(nxt)
                        queued.add(nxt)


# ── paths ─────────────────────────────────────────────────────────────────────

RAG_SPEC_PATH = Path(__file__).parent.parent.parent / "flows" / "01-rag-agent-flow.json"

_WIKIPEDIA_UA = "buildaharness-test/1.0 (ci@example.com)"
_WIKI_TOPIC = "retrieval-augmented generation"

# ── helpers ───────────────────────────────────────────────────────────────────


def _fetch_wikipedia_chunks(topic: str = _WIKI_TOPIC, n: int = 5) -> list[dict]:
    """Return up to *n* sentence-level chunks from a Wikipedia article extract."""
    url = (
        "https://en.wikipedia.org/w/api.php"
        "?action=query"
        f"&titles={urllib.parse.quote(topic)}"
        "&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1"
    )
    req = urllib.request.Request(url, headers={"User-Agent": _WIKIPEDIA_UA})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    raw = page.get("extract", "") or ""

    # Split on ". " boundaries; keep sentences long enough to be meaningful.
    slug = topic.replace(" ", "_")
    sentences = [s.strip() for s in re.split(r"\.\s+", raw.replace("\n", " ")) if len(s.strip()) > 30]
    return [
        {
            "text": s + ".",
            "source": f"wikipedia:{slug}#{i}",
            "score": round(0.95 - i * 0.02, 2),
        }
        for i, s in enumerate(sentences[:n])
    ]


def _load_rag_spec() -> dict:
    with open(RAG_SPEC_PATH) as f:
        return json.load(f)


# ── fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def wikipedia_chunks() -> list[dict]:
    """Fetch Wikipedia RAG article once for the whole module."""
    return _fetch_wikipedia_chunks()


@pytest.fixture(scope="module")
def rag_spec() -> dict:
    return _load_rag_spec()


# ── rag_utils.format_chunks with real data ────────────────────────────────────


def test_format_chunks_with_real_wikipedia_data(wikipedia_chunks):
    """format_chunks must handle Qdrant-style dicts returned by a real vector store."""
    assert len(wikipedia_chunks) >= 3, "Wikipedia should return at least 3 chunks"

    state = {"retrieved_chunks": wikipedia_chunks}
    result = format_chunks(state)

    ctx = result["formatted_context"]
    assert ctx, "formatted_context must not be empty"

    # Each chunk should produce a numbered header referencing the Wikipedia source.
    for i in range(1, len(wikipedia_chunks) + 1):
        assert f"[{i}]" in ctx
    assert "wikipedia:" in ctx

    # The text content must be present.
    first_text = wikipedia_chunks[0]["text"][:40]
    assert first_text in ctx


def test_format_chunks_plain_strings():
    """format_chunks must also handle plain-string chunks (Mastra inlines this logic)."""
    state = {
        "retrieved_chunks": ["RAG grounds LLM answers in retrieved evidence.", "Vector search finds relevant passages."]
    }
    result = format_chunks(state)
    ctx = result["formatted_context"]
    assert "[1]" in ctx and "[2]" in ctx
    assert "RAG grounds" in ctx


def test_format_chunks_empty_list():
    result = format_chunks({"retrieved_chunks": []})
    assert result["formatted_context"] == ""


def test_format_chunks_none():
    result = format_chunks({})
    assert result["formatted_context"] == ""


def test_format_chunks_mixed_fields(wikipedia_chunks):
    """Chunks with 'page_content' key (LangChain style) must also be handled."""
    lc_chunks = [{"page_content": c["text"], "metadata": {"source": c["source"]}} for c in wikipedia_chunks[:3]]
    result = format_chunks({"retrieved_chunks": lc_chunks})
    assert "wikipedia:" in result["formatted_context"]


# ── compile: all 4 adapters ───────────────────────────────────────────────────


class TestLangGraphCompile:
    def test_no_warnings(self, rag_spec):
        _, warnings = compile_langgraph(rag_spec)
        assert warnings == []

    def test_retrieve_node_generated(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "node_retrieve" in code
        assert "knowledge_base" in code
        assert "memory_read" in code

    def test_format_chunks_fn_ref_imported(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "node_format_context" in code
        assert "rag_utils" in code
        assert "format_chunks" in code

    def test_llm_call_node(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "node_generate" in code
        assert "mistral:latest" in code
        # System prompt fragment must survive templating.
        assert "Answer using only the provided context" in code

    def test_cache_qa_node(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "node_cache_qa" in code
        assert "qa_cache" in code

    def test_graph_edges_wired(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "add_edge(START, 'retrieve')" in code
        assert "add_edge('retrieve', 'format_context')" in code
        assert "add_edge('format_context', 'generate')" in code
        assert "add_edge('generate', 'cache_qa')" in code
        assert "add_edge('cache_qa', END)" in code

    def test_checkpointer_enabled(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "MemorySaver" in code
        assert "checkpointer" in code

    def test_state_schema_fields(self, rag_spec):
        code, _ = compile_langgraph(rag_spec)
        assert "question" in code
        assert "retrieved_chunks" in code
        assert "formatted_context" in code
        assert "answer" in code


class TestCrewAICompile:
    def test_no_warnings(self, rag_spec):
        _, warnings = compile_crewai(rag_spec)
        assert warnings == []

    def test_retrieve_task(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "task_retrieve" in code
        assert "knowledge_base" in code

    def test_format_context_task(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "task_format_context" in code
        assert "rag_utils:format_chunks" in code

    def test_generate_task(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "task_generate" in code
        assert "Answer using only the provided context" in code

    def test_cache_qa_task(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "task_cache_qa" in code
        assert "qa_cache" in code

    def test_crew_kickoff(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "crew.kickoff" in code

    def test_llm_model(self, rag_spec):
        code, _ = compile_crewai(rag_spec)
        assert "mistral:latest" in code


class TestMastraCompile:
    def test_no_warnings(self, rag_spec):
        _, warnings = compile_mastra(rag_spec)
        assert warnings == []

    def test_retrieve_step(self, rag_spec):
        code, _ = compile_mastra(rag_spec)
        assert "retrieveStep" in code
        # Qdrant backend: direct Qdrant API; other backends: mastra?.memory
        assert "_qdrantUrl" in code or "memory.query" in code or "mastra?.memory" in code

    def test_format_context_step_inlined(self, rag_spec):
        """Mastra inlines the Python fn_ref as equivalent JS logic."""
        code, _ = compile_mastra(rag_spec)
        assert "formatContextStep" in code
        assert "retrieved_chunks" in code
        assert "formatted_context" in code

    def test_generate_step(self, rag_spec):
        code, _ = compile_mastra(rag_spec)
        assert "generateStep" in code
        assert "mistral:latest" in code
        assert "Answer using only the provided context" in code

    def test_cache_qa_step(self, rag_spec):
        code, _ = compile_mastra(rag_spec)
        assert "cacheQaStep" in code
        assert "qa_cache" in code or "memory" in code

    def test_typescript_syntax(self, rag_spec):
        code, _ = compile_mastra(rag_spec)
        assert "createStep" in code
        assert "z.object" in code
        assert "import" in code


class TestMAFCompile:
    def test_no_warnings(self, rag_spec):
        _, warnings = compile_maf(rag_spec)
        assert warnings == []

    def test_retrieve_node(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "node_retrieve" in code
        assert "knowledge_base" in code

    def test_format_context_node(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "node_format_context" in code
        assert "rag_utils" in code or "format_chunks" in code

    def test_generate_node(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "node_generate" in code
        assert "mistral:latest" in code

    def test_cache_qa_node(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "node_cache_qa" in code
        assert "qa_cache" in code

    def test_semantic_kernel_imports(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "semantic_kernel" in code
        assert "Kernel" in code

    def test_otel_setup(self, rag_spec):
        code, _ = compile_maf(rag_spec)
        assert "opentelemetry" in code


# ── end-to-end: exec LangGraph code with seeded Wikipedia chunks ──────────────


def _make_fake_llm_response(content: str) -> MagicMock:
    resp = MagicMock()
    resp.content = content
    return resp


def test_langgraph_end_to_end_with_wikipedia_data(wikipedia_chunks, rag_spec):
    """
    Compile the RAG flow to LangGraph Python, exec it in an isolated namespace,
    pre-seed the in-memory knowledge_base store with Wikipedia chunks, mock the
    LLM call, and run the full pipeline.  Asserts that all four state fields are
    populated by the end of the run.
    """
    code, warnings = compile_langgraph(rag_spec)
    assert warnings == []

    # Build a namespace that stubs out heavy dependencies so exec doesn't need
    # real OpenAI/Ollama credentials.
    fake_llm = MagicMock()
    fake_llm.invoke.return_value = _make_fake_llm_response(
        "RAG (retrieval-augmented generation) is a technique that grounds LLM "
        "answers in retrieved evidence from an external knowledge base."
    )

    fake_chat_openai_cls = MagicMock(return_value=fake_llm)

    # Stub LangGraph / LangChain imports so the exec works without the packages
    # being installed (they are installed in the real env, but this makes the
    # test hermetic even if run in a stripped CI image).
    fake_langgraph = types.ModuleType("langgraph")
    fake_graph_mod = types.ModuleType("langgraph.graph")
    fake_memory_mod = types.ModuleType("langgraph.checkpoint.memory")

    # Real StateGraph / START / END from langgraph if available; fall back to fakes.
    try:
        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import END, START, StateGraph
    except ImportError:
        StateGraph = _FakeStateGraph
        START = "__start__"
        END = "__end__"
        MemorySaver = MagicMock()

    fake_graph_mod.StateGraph = StateGraph
    fake_graph_mod.START = START
    fake_graph_mod.END = END
    fake_memory_mod.MemorySaver = MemorySaver

    # Stub langchain_openai — ChatOpenAI (LLM) + OpenAIEmbeddings (Qdrant helper)
    fake_embeddings = MagicMock()
    fake_embeddings.embed_query.return_value = [0.1] * 768  # 768-dim dummy vector
    lc_openai = types.ModuleType("langchain_openai")
    lc_openai.ChatOpenAI = fake_chat_openai_cls
    lc_openai.OpenAIEmbeddings = MagicMock(return_value=fake_embeddings)
    lc_core_msg = types.ModuleType("langchain_core.messages")
    lc_core_msg.HumanMessage = lambda content: {"role": "human", "content": content}
    lc_core_msg.SystemMessage = lambda content: {"role": "system", "content": content}
    lc_core_tools = types.ModuleType("langchain_core.tools")
    lc_core_tools.tool = lambda f: f

    # Stub qdrant_client so the top-level import in generated code doesn't fail.
    fake_qdrant_mod = types.ModuleType("qdrant_client")
    fake_qdrant_mod.QdrantClient = MagicMock()

    # Inject all stubs so importlib inside the compiled code finds them.
    orig_modules = {}
    stubs = {
        "langchain_openai": lc_openai,
        "langchain_core.messages": lc_core_msg,
        "langchain_core.tools": lc_core_tools,
        "langgraph": fake_langgraph,
        "langgraph.graph": fake_graph_mod,
        "langgraph.checkpoint.memory": fake_memory_mod,
        "qdrant_client": fake_qdrant_mod,
    }
    for name, mod in stubs.items():
        orig_modules[name] = sys.modules.get(name)
        sys.modules[name] = mod

    question = "What is retrieval-augmented generation?"

    try:
        ns: dict = {}
        exec(compile(code, "<rag_langgraph>", "exec"), ns)

        # Override _qdrant_search in the exec namespace to return the Wikipedia
        # chunks directly, bypassing the real Qdrant/embedding calls.
        ns["_qdrant_search"] = lambda query, collection, embedding_model, top_k=5, min_score=0.0: wikipedia_chunks

        # run_flow() is the entry-point generated by compile_langgraph.
        final_state = ns["run_flow"]({"question": question})

    finally:
        for name, orig in orig_modules.items():
            if orig is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = orig

    # All four pipeline state fields must be present in the final state.
    assert "retrieved_chunks" in final_state, "retrieve node must populate retrieved_chunks"
    assert final_state["retrieved_chunks"] == wikipedia_chunks
    assert "formatted_context" in final_state, "format_context node must populate formatted_context"
    ctx = final_state["formatted_context"]
    assert "wikipedia:" in ctx, "formatted_context must contain source headers"
    assert len(ctx) > 100, "formatted_context should be a non-trivial string"
    assert "answer" in final_state, "generate node must populate answer"
    assert len(final_state["answer"]) > 10, "answer must be non-empty"

    # qa_cache should now contain the cached answer.
    assert question in ns["_STORES"].get("qa_cache", {}), "cache_qa node must write to qa_cache"
