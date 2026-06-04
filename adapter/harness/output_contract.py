"""
Output contract data model — P0.5.

OutputContract holds the caller's format and interface requirements.
Both validators are stubs in Phase 0:
  - contract_shadow_check()    → full implementation in P5
  - validate_output_contract() → full implementation in P9

Callers can be written against the ContractCheckResult return type now;
the stubs return is_stub=True so integration tests can detect that real
checks have not yet been wired.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class OutputContract:
    format_requirements: dict[str, Any] = field(default_factory=dict)
    required_sections: list[str] = field(default_factory=list)
    required_interface_fields: list[str] = field(default_factory=list)
    interface_constraints: dict[str, Any] = field(default_factory=dict)
    validation_rules: list[str] = field(default_factory=list)
    caller_specific_constraints: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format_requirements": dict(self.format_requirements),
            "required_sections": list(self.required_sections),
            "required_interface_fields": list(self.required_interface_fields),
            "interface_constraints": dict(self.interface_constraints),
            "validation_rules": list(self.validation_rules),
            "caller_specific_constraints": list(self.caller_specific_constraints),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> OutputContract:
        return cls(
            format_requirements=d.get("format_requirements", {}),
            required_sections=d.get("required_sections", []),
            required_interface_fields=d.get("required_interface_fields", []),
            interface_constraints=d.get("interface_constraints", {}),
            validation_rules=d.get("validation_rules", []),
            caller_specific_constraints=d.get("caller_specific_constraints", []),
        )


@dataclass
class ContractCheckResult:
    passed: bool
    violations: list[str] = field(default_factory=list)
    is_stub: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "violations": list(self.violations),
            "is_stub": self.is_stub,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ContractCheckResult:
        return cls(
            passed=d["passed"],
            violations=d.get("violations", []),
            is_stub=d.get("is_stub", False),
        )


def validate_output_contract(result: Any, output_contract: OutputContract) -> ContractCheckResult:
    """Full authoritative contract validation — stub until P9."""
    return ContractCheckResult(passed=True, violations=[], is_stub=True)


def contract_shadow_check(result: Any, output_contract: OutputContract) -> ContractCheckResult:
    """Lightweight interface-stability check at post_exec_gate — P5 real implementation.

    Checks:
    1. All required_interface_fields are present in result dict
    2. Type constraints in interface_constraints are satisfied
    Returns is_stub=False since this is the real implementation.
    """
    violations: list[str] = []

    # Normalise result to a dict for field lookup
    if isinstance(result, dict):
        result_dict = result
    elif result is None:
        result_dict = {}
    else:
        # Try to coerce to dict via to_dict() or __dict__
        if hasattr(result, "to_dict"):
            result_dict = result.to_dict()
        elif hasattr(result, "__dict__"):
            result_dict = vars(result)
        else:
            result_dict = {}

    # 1. Check required_interface_fields are present
    for field_name in output_contract.required_interface_fields:
        if field_name not in result_dict:
            violations.append(f"Missing required interface field: {field_name!r}")

    # 2. Check type constraints
    for field_name, expected_type in output_contract.interface_constraints.items():
        if field_name not in result_dict:
            continue  # missing fields already caught above
        value = result_dict[field_name]
        if not _check_type(value, expected_type):
            actual_type = type(value).__name__
            violations.append(
                f"Type mismatch for {field_name!r}: expected {expected_type!r}, got {actual_type!r}"
            )

    return ContractCheckResult(
        passed=len(violations) == 0,
        violations=violations,
        is_stub=False,
    )


def _check_type(value: Any, expected_type: Any) -> bool:
    """Check that value matches the expected_type descriptor.

    expected_type can be a Python type object, a type name string (e.g. "str", "int"),
    or a list of accepted type names.
    """
    if expected_type is None:
        return True
    if isinstance(expected_type, type):
        return isinstance(value, expected_type)
    if isinstance(expected_type, str):
        type_map: dict[str, type] = {
            "str": str, "int": int, "float": float,
            "bool": bool, "list": list, "dict": dict,
        }
        py_type = type_map.get(expected_type.lower())
        if py_type is None:
            return True  # unknown type — pass conservatively
        return isinstance(value, py_type)
    if isinstance(expected_type, list):
        return any(_check_type(value, t) for t in expected_type)
    return True
