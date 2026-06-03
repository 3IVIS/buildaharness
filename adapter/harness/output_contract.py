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
    def from_dict(cls, d: dict[str, Any]) -> "OutputContract":
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
    def from_dict(cls, d: dict[str, Any]) -> "ContractCheckResult":
        return cls(
            passed=d["passed"],
            violations=d.get("violations", []),
            is_stub=d.get("is_stub", False),
        )


def validate_output_contract(result: Any, output_contract: OutputContract) -> ContractCheckResult:
    """Full authoritative contract validation — stub until P9."""
    return ContractCheckResult(passed=True, violations=[], is_stub=True)


def contract_shadow_check(result: Any, output_contract: OutputContract) -> ContractCheckResult:
    """Lightweight interface-stability check at post_exec_gate — stub until P5."""
    return ContractCheckResult(passed=True, violations=[], is_stub=True)
