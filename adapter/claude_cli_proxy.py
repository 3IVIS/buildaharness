"""
Thin OpenAI-compatible proxy that backs each /v1/chat/completions call with
a `claude -p` subprocess call.  Lets LiteLLM (and everything behind it)
treat the Claude CLI as just another model backend — no API key required,
uses the locally-authenticated ~/.claude/ credentials.

Usage (standalone):
    uvicorn adapter.claude_cli_proxy:app --port 4001

Usage (Docker — see docker-compose.yml claude-cli-proxy service):
    Listens on 0.0.0.0:4001 inside the container.
    Host ~/.claude is bind-mounted read-only for credentials.
    LiteLLM reaches it at http://claude-cli-proxy:4001.

Model aliases handled here (flow spec → Claude model ID):
    claude-cli-sonnet  → claude-sonnet-4-6
    claude-cli-opus    → claude-opus-4-8
    claude-cli-haiku   → claude-haiku-4-5-20251001
    claude-cli         → CLAUDE_CLI_DEFAULT_MODEL env var
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="claude-cli-proxy", version="1.0.0")

CLAUDE_PATH = os.environ.get("CLAUDE_PATH", "claude")
DEFAULT_MODEL = os.environ.get("CLAUDE_CLI_DEFAULT_MODEL", "claude-sonnet-4-6")

_MODEL_MAP: dict[str, str] = {
    "claude-cli-sonnet": "claude-sonnet-4-6",
    "claude-cli-opus":   "claude-opus-4-8",
    "claude-cli-haiku":  "claude-haiku-4-5-20251001",
    "claude-cli":        DEFAULT_MODEL,
}


class _Message(BaseModel):
    role: str
    content: str


class _ChatRequest(BaseModel):
    model: str = DEFAULT_MODEL
    messages: list[_Message]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    stream: bool = False


def _resolve_model(name: str) -> str:
    return _MODEL_MAP.get(name, name)


def _build_args(messages: list[_Message], model_id: str) -> list[str]:
    """Convert OpenAI messages list into claude CLI arguments."""
    system_parts: list[str] = []
    turns: list[str] = []

    for m in messages:
        if m.role == "system":
            system_parts.append(m.content)
        elif m.role == "user":
            turns.append(m.content)
        elif m.role == "assistant":
            turns.append(f"Assistant: {m.content}")

    # Single user message → pass content directly as the prompt
    if len(turns) == 1 and messages[-1].role == "user":
        prompt = turns[0]
    else:
        prompt = "\n\n".join(turns)

    cmd = [
        CLAUDE_PATH,
        "--output-format", "json",
        "--model", model_id,
        "-p", prompt,
    ]

    if system_parts:
        cmd += ["--system-prompt", "\n\n".join(system_parts)]

    return cmd


async def _invoke(cmd: list[str]) -> str:
    """Run the command and return the assistant reply text."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or f"claude exited with code {proc.returncode}"
        raise RuntimeError(detail)

    raw = stdout.decode(errors="replace").strip()

    # --output-format json → {"type":"result","subtype":"success","result":"..."}
    # Fall back to treating the whole stdout as plain text if JSON parse fails.
    try:
        data = json.loads(raw)
        return data.get("result") or data.get("content") or raw
    except json.JSONDecodeError:
        return raw


def _openai_response(model: str, content: str, prompt_text: str) -> dict:
    prompt_tokens = max(1, len(prompt_text) // 4)
    completion_tokens = max(1, len(content) // 4)
    return {
        "id": f"chatcmpl-cli-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: _ChatRequest):
    model_id = _resolve_model(req.model)
    cmd = _build_args(req.messages, model_id)

    try:
        content = await _invoke(cmd)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail=f"claude binary not found at '{CLAUDE_PATH}'. "
                   "Set CLAUDE_PATH or install @anthropic-ai/claude-code.",
        )

    prompt_text = " ".join(m.content for m in req.messages)
    return _openai_response(req.model, content, prompt_text)


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": k, "object": "model", "created": 0, "owned_by": "claude-cli"}
            for k in _MODEL_MAP
        ],
    }


@app.get("/health")
async def health():
    try:
        proc = await asyncio.create_subprocess_exec(
            CLAUDE_PATH, "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return {"status": "ok", "claude_version": stdout.decode().strip()}
    except FileNotFoundError:
        return {"status": "degraded", "error": f"binary not found: {CLAUDE_PATH}"}
    except Exception as exc:
        return {"status": "degraded", "error": str(exc)}
