"""
adapter_logger.py — shared structured logging for all itsharness adapters.

Usage (in each adapter):
    from adapter_logger import get_adapter_logger, log_compile_start, log_compile_end

Environment variables:
    ADAPTER_LOG_LEVEL   — DEBUG | INFO | WARNING | ERROR  (default: INFO)
    ADAPTER_LOG_FORMAT  — json | text  (default: text)
    ADAPTER_LOG_FILE    — path to append log file (optional; stdout always used)

Log levels emitted:
    DEBUG   — every node/step processed, edge wiring, section generation
    INFO    — compile start/end, warnings summary, node counts
    WARNING — adapter warnings (unsupported nodes, missing refs, fail_branch, etc.)
    ERROR   — empty spec, unhandled exceptions inside compile_*
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from typing import Any

# ─── Constants ────────────────────────────────────────────────────────────────

_ENV_LEVEL  = os.environ.get("ADAPTER_LOG_LEVEL",  "INFO").upper()
_ENV_FORMAT = os.environ.get("ADAPTER_LOG_FORMAT", "text").lower()
_ENV_FILE   = os.environ.get("ADAPTER_LOG_FILE",   "")

_VALID_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR"}
_LOG_LEVEL = getattr(logging, _ENV_LEVEL if _ENV_LEVEL in _VALID_LEVELS else "INFO")


# ─── JSON formatter ───────────────────────────────────────────────────────────

class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line for machine-readable ingestion."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts":      self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level":   record.levelname,
            "logger":  record.name,
            "msg":     record.getMessage(),
        }
        # Attach any extra fields set via the `extra=` kwarg
        for key, val in record.__dict__.items():
            if key.startswith("_") or key in (
                "name", "msg", "args", "levelname", "levelno", "pathname",
                "filename", "module", "exc_info", "exc_text", "stack_info",
                "lineno", "funcName", "created", "msecs", "relativeCreated",
                "thread", "threadName", "processName", "process", "message",
                "taskName",
            ):
                continue
            payload[key] = val
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


# ─── Text formatter ───────────────────────────────────────────────────────────

class _TextFormatter(logging.Formatter):
    """Human-readable coloured text formatter."""

    _COLOURS = {
        "DEBUG":   "\033[36m",   # cyan
        "INFO":    "\033[32m",   # green
        "WARNING": "\033[33m",   # yellow
        "ERROR":   "\033[31m",   # red
        "RESET":   "\033[0m",
    }

    def format(self, record: logging.LogRecord) -> str:
        col   = self._COLOURS.get(record.levelname, "")
        reset = self._COLOURS["RESET"]
        ts    = self.formatTime(record, "%H:%M:%S")
        base  = f"{col}[{ts}] {record.levelname:<7} {record.name}: {record.getMessage()}{reset}"
        # Append extra fields if present
        extras: list[str] = []
        for key, val in record.__dict__.items():
            if key.startswith("_") or key in (
                "name", "msg", "args", "levelname", "levelno", "pathname",
                "filename", "module", "exc_info", "exc_text", "stack_info",
                "lineno", "funcName", "created", "msecs", "relativeCreated",
                "thread", "threadName", "processName", "process", "message",
                "taskName",
            ):
                continue
            extras.append(f"{key}={val!r}")
        if extras:
            base += f"  ({', '.join(extras)})"
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


# ─── Handler setup ────────────────────────────────────────────────────────────

def _build_handler(stream: Any, fmt: str) -> logging.StreamHandler:
    h = logging.StreamHandler(stream)
    h.setFormatter(_JsonFormatter() if fmt == "json" else _TextFormatter())
    return h


def _setup_root_adapter_logger() -> None:
    """Configure the root 'adapter' logger once at import time."""
    root = logging.getLogger("adapter")
    if root.handlers:
        return  # already configured (e.g. in tests)
    root.setLevel(_LOG_LEVEL)
    root.propagate = False

    root.addHandler(_build_handler(sys.stdout, _ENV_FORMAT))

    if _ENV_FILE:
        try:
            fh = logging.FileHandler(_ENV_FILE, encoding="utf-8")
            fh.setFormatter(
                _JsonFormatter() if _ENV_FORMAT == "json" else _TextFormatter()
            )
            root.addHandler(fh)
        except OSError as exc:
            root.warning("adapter_logger: could not open log file %r: %s", _ENV_FILE, exc)


_setup_root_adapter_logger()


# ─── Public helpers ───────────────────────────────────────────────────────────

def get_adapter_logger(adapter_name: str) -> logging.Logger:
    """
    Return a child logger for a specific adapter.
    adapter_name should be one of: crewai | langgraph | maf | mastra
    """
    return logging.getLogger(f"adapter.{adapter_name}")


# ── compile lifecycle ─────────────────────────────────────────────────────────

def log_compile_start(logger: logging.Logger, spec: dict) -> float:
    """
    Log the beginning of a compile call.
    Returns the start timestamp (float) for use in log_compile_end.
    """
    flow_id   = spec.get("id", "unknown")
    flow_name = spec.get("name", flow_id)
    n_nodes   = len(spec.get("nodes", []))
    n_edges   = len(spec.get("edges", []))
    logger.info(
        "compile start",
        extra={
            "flow_id":   flow_id,
            "flow_name": flow_name,
            "n_nodes":   n_nodes,
            "n_edges":   n_edges,
        },
    )
    return time.monotonic()


def log_compile_end(
    logger: logging.Logger,
    start_ts: float,
    code: str,
    warnings: list[str],
    spec: dict,
) -> None:
    """Log the successful end of a compile call with timing and summary."""
    elapsed_ms = int((time.monotonic() - start_ts) * 1000)
    flow_id    = spec.get("id", "unknown")
    logger.info(
        "compile ok",
        extra={
            "flow_id":     flow_id,
            "elapsed_ms":  elapsed_ms,
            "output_chars": len(code),
            "n_warnings":  len(warnings),
        },
    )
    if warnings:
        for w in warnings:
            logger.warning("adapter warning", extra={"flow_id": flow_id, "detail": w})


def log_compile_error(
    logger: logging.Logger,
    start_ts: float,
    exc: Exception,
    spec: dict,
) -> None:
    """Log a compile failure with traceback."""
    elapsed_ms = int((time.monotonic() - start_ts) * 1000)
    flow_id    = spec.get("id", "unknown")
    logger.error(
        "compile failed",
        extra={
            "flow_id":    flow_id,
            "elapsed_ms": elapsed_ms,
            "error":      str(exc),
        },
        exc_info=True,
    )


def log_empty_spec(logger: logging.Logger, spec: dict) -> None:
    """Log when a spec has no nodes."""
    logger.warning(
        "empty spec — no nodes to compile",
        extra={"flow_id": spec.get("id", "unknown")},
    )


# ── node-level debug ──────────────────────────────────────────────────────────

def log_node_processing(
    logger: logging.Logger,
    node: dict,
    flow_id: str = "",
    *,
    skipped: bool = False,
    reason: str = "",
) -> None:
    """DEBUG-level log for each node being processed."""
    extra: dict[str, Any] = {
        "flow_id":   flow_id,
        "node_id":   node.get("id", "?"),
        "node_type": node.get("type", "?"),
    }
    if skipped:
        extra["skipped"] = True
        if reason:
            extra["reason"] = reason
    logger.debug("node processing" if not skipped else "node skipped", extra=extra)


def log_node_warning(
    logger: logging.Logger,
    node: dict,
    message: str,
    flow_id: str = "",
) -> None:
    """WARNING for a node-level issue (missing ref, unsupported feature, etc.)."""
    logger.warning(
        "node issue",
        extra={
            "flow_id":   flow_id,
            "node_id":   node.get("id", "?"),
            "node_type": node.get("type", "?"),
            "detail":    message,
        },
    )


def log_topo_sort(
    logger: logging.Logger,
    nodes: list[dict],
    order: list[Any],
    flow_id: str = "",
) -> None:
    """DEBUG the topological sort result (node order + any cycle detection)."""
    sorted_ids = [n["id"] if isinstance(n, dict) else n for n in order]
    has_cycle  = len(sorted_ids) < len(nodes)
    extra: dict[str, Any] = {
        "flow_id":    flow_id,
        "order":      sorted_ids,
        "has_cycle":  has_cycle,
    }
    if has_cycle:
        all_ids    = {n["id"] for n in nodes}
        cycle_ids  = sorted(all_ids - set(sorted_ids))
        extra["cycle_nodes"] = cycle_ids
        logger.warning("topo sort detected cycle(s)", extra=extra)
    else:
        logger.debug("topo sort ok", extra=extra)


def log_section(logger: logging.Logger, section: str, flow_id: str = "") -> None:
    """DEBUG log for each code section being generated."""
    logger.debug(
        "generating section",
        extra={"flow_id": flow_id, "section": section},
    )
