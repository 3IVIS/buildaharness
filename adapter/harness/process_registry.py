"""
Process concept registry — P-PC.3.

ProcessRegistry maps concept IDs to file paths with thread-safe access.
DEFAULT_REGISTRY is auto-populated from the repo-root ``concepts/`` directory
at import time; absent directories are silently ignored.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from .process_concept import ProcessConcept, ProcessConceptNotFoundError, ProcessConceptValidationError


class ProcessRegistry:
    """Thread-safe registry mapping concept IDs to file paths."""

    def __init__(self) -> None:
        self._registry: dict[str, str] = {}
        self._lock = threading.Lock()

    def register(self, concept_id: str, file_path: str | Path) -> None:
        """Register a concept ID pointing to the given JSON file path."""
        with self._lock:
            self._registry[concept_id] = str(file_path)

    def load(self, concept_id: str) -> ProcessConcept:
        """Load a concept by ID.

        Raises ProcessConceptNotFoundError when the ID is not registered.
        Raises ProcessConceptValidationError when the backing file is invalid.
        """
        with self._lock:
            path = self._registry.get(concept_id)
        if path is None:
            raise ProcessConceptNotFoundError(concept_id)
        return ProcessConcept.from_file(path)

    def list_available(self) -> list[str]:
        """Return a sorted list of all registered concept IDs."""
        with self._lock:
            return sorted(self._registry.keys())

    def scan_directory(self, directory: str | Path) -> int:
        """Scan directory for ``*.json`` concept files and register them.

        Skips ``concept_schema.json`` and any file that fails to parse.
        Returns the count of successfully registered concepts.
        """
        dir_path = Path(directory)
        if not dir_path.is_dir():
            return 0

        count = 0
        for json_file in sorted(dir_path.glob("*.json")):
            if json_file.name == "concept_schema.json":
                continue
            try:
                concept = ProcessConcept.from_file(json_file)
                self.register(concept.id, json_file)
                count += 1
            except (ProcessConceptNotFoundError, ProcessConceptValidationError, Exception):
                pass
        return count

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "registered": dict(self._registry),
                "available": sorted(self._registry.keys()),
            }


# Module-level default registry — populated from repo-root concepts/ at import.
# The path climbs: harness/ → adapter/ → repo root → concepts/
DEFAULT_REGISTRY = ProcessRegistry()
DEFAULT_REGISTRY.scan_directory(Path(__file__).parent.parent.parent / "concepts")
