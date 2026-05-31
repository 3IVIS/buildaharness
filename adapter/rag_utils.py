"""
rag_utils.py — shared helper functions for RAG flow nodes.

These are referenced via fn_ref in flow specs, e.g.:
    { "mode": "fn_ref", "fn_ref": "rag_utils:format_chunks" }
"""


def format_chunks(state: dict) -> dict:
    """
    Convert a list of retrieved document chunks into a single context string.

    Expects state["retrieved_chunks"] to be one of:
      - A list of dicts with a "text" or "page_content" key  (LangChain / Qdrant style)
      - A list of plain strings
      - None / missing  (returns empty string, flow continues safely)

    Writes the result to state["formatted_context"] and returns the updated state.
    """
    chunks = state.get("retrieved_chunks") or []

    parts: list[str] = []
    for i, chunk in enumerate(chunks, start=1):
        if isinstance(chunk, dict):
            text = chunk.get("text") or chunk.get("page_content") or chunk.get("content", "")
            source = chunk.get("source") or chunk.get("metadata", {}).get("source", "")
            header = f"[{i}] {source}" if source else f"[{i}]"
            parts.append(f"{header}\n{text.strip()}")
        else:
            parts.append(f"[{i}]\n{str(chunk).strip()}")

    state["formatted_context"] = "\n\n".join(parts)
    return state
