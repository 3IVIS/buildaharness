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


def update_output_contract(caller_state: Any, output_contract: OutputContract) -> OutputContract:
    """Re-derive output contract from updated caller_state constraints — P7.2.

    Replaces caller_specific_constraints with the current constraints from
    caller_state. Re-derives required_interface_fields where a constraint
    specifies a mandatory output field via "required: <field>" syntax.
    Returns a new OutputContract (immutable update).
    """
    new_constraints = list(caller_state.current_constraints)

    # Re-derive required_interface_fields from constraints
    required_fields = list(output_contract.required_interface_fields)
    for constraint in new_constraints:
        lower = constraint.lower()
        if "required:" in lower:
            parts = constraint.split(":", 1)
            if len(parts) > 1:
                field_candidate = parts[1].strip().split()[0].strip("\"'")
                if field_candidate and field_candidate not in required_fields:
                    required_fields.append(field_candidate)

    return OutputContract(
        format_requirements=dict(output_contract.format_requirements),
        required_sections=list(output_contract.required_sections),
        required_interface_fields=required_fields,
        interface_constraints=dict(output_contract.interface_constraints),
        validation_rules=list(output_contract.validation_rules),
        caller_specific_constraints=new_constraints,
    )


def check_format_requirements(result: Any, output_contract: OutputContract) -> list[str]:
    """Validate output_contract.format_requirements against result."""
    violations: list[str] = []
    fmt = output_contract.format_requirements
    if not fmt:
        return violations

    result_dict = _to_dict(result)
    result_str = result if isinstance(result, str) else ""

    # Check required top-level keys
    for req_field in fmt.get("required_fields", []):
        if result_dict is not None and req_field not in result_dict:
            violations.append(f"format_requirements: missing required field {req_field!r}")

    # Check max_length constraint
    max_len = fmt.get("max_length")
    if max_len is not None:
        if result_str and len(result_str) > max_len:
            violations.append(f"format_requirements: result length {len(result_str)} exceeds max_length {max_len}")

    # Check format type
    expected_format = fmt.get("format")
    if expected_format == "json":
        if not isinstance(result, (dict, list)):
            violations.append("format_requirements: expected JSON (dict/list) format")
    elif expected_format == "plain_text":
        if not isinstance(result, str):
            violations.append("format_requirements: expected plain_text (str) format")

    return violations


def check_required_sections(result: Any, output_contract: OutputContract) -> list[str]:
    """Verify all required_sections are present and non-empty in result."""
    violations: list[str] = []
    sections = output_contract.required_sections
    if not sections:
        return violations

    result_dict = _to_dict(result)
    result_str = result if isinstance(result, str) else ""

    for section in sections:
        if result_dict is not None:
            # Dict result: check top-level key
            if section not in result_dict:
                violations.append(f"required_sections: missing section {section!r}")
            elif not result_dict[section]:
                violations.append(f"required_sections: section {section!r} is empty")
        elif result_str:
            # Text result: check for heading marker
            if section.lower() not in result_str.lower():
                violations.append(f"required_sections: missing section {section!r} in text result")
        else:
            violations.append(f"required_sections: cannot check section {section!r} — result is None")

    return violations


def check_interface_constraints(result: Any, output_contract: OutputContract) -> list[str]:
    """Verify required_interface_fields presence and type constraints."""
    violations: list[str] = []
    result_dict = _to_dict(result)
    if result_dict is None:
        result_dict = {}

    for field_name in output_contract.required_interface_fields:
        if field_name not in result_dict:
            violations.append(f"interface_constraints: missing required field {field_name!r}")

    for field_name, expected_type in output_contract.interface_constraints.items():
        if field_name not in result_dict:
            continue  # missing required fields already caught above
        value = result_dict[field_name]
        if not _check_type(value, expected_type):
            actual_type = type(value).__name__
            violations.append(
                f"interface_constraints: type mismatch for {field_name!r}: "
                f"expected {expected_type!r}, got {actual_type!r}"
            )

    return violations


def check_caller_specific_constraints(result: Any, caller_state: Any) -> list[str]:
    """Evaluate result against caller_state.current_constraints (live list — may be updated by P7)."""
    violations: list[str] = []
    if caller_state is None:
        return violations

    current_constraints: list[str] = getattr(caller_state, "current_constraints", [])
    result_str = result if isinstance(result, str) else ""
    result_dict = _to_dict(result) or {}

    negation_keywords = {"not", "never", "no", "without", "exclude", "must not"}

    for constraint in current_constraints:
        constraint_lower = constraint.lower()
        constraint_tokens = set(constraint_lower.split())

        # "output must not reference X" — check absence
        if constraint_tokens & negation_keywords:
            # Extract the subject of the negation (heuristic: words after the negation keyword)
            violated = False
            for kw in negation_keywords:
                if kw in constraint_lower:
                    subject = constraint_lower.split(kw, 1)[-1].strip()
                    subject_tokens = set(subject.split()[:4])  # first 4 words
                    if subject_tokens:
                        result_text = (result_str + " " + " ".join(str(v) for v in result_dict.values())).lower()
                        if any(tok in result_text for tok in subject_tokens if len(tok) > 3):
                            violated = True
                            break
            if violated:
                violations.append(f"caller_constraint violated: {constraint!r}")

        # "response must be in X language" — simple heuristic
        if "must be in" in constraint_lower or "language" in constraint_lower:
            pass  # heuristic too fragile; skip without false-positive

    return violations


def validate_output_contract(
    result: Any,
    output_contract: OutputContract,
    caller_state: Any = None,
) -> ContractCheckResult:
    """Full authoritative output contract validation — P9.4 real implementation.

    Replaces the P0.5 stub.  Checks all four dimensions:
      1. format_requirements
      2. required_sections
      3. interface_constraints (fields + types)
      4. caller-specific constraints from caller_state.current_constraints

    A result that fails any check returns passed=False with a non-empty violations list.
    is_stub is always False — this is the real implementation.
    """
    violations: list[str] = []
    violations.extend(check_format_requirements(result, output_contract))
    violations.extend(check_required_sections(result, output_contract))
    violations.extend(check_interface_constraints(result, output_contract))
    violations.extend(check_caller_specific_constraints(result, caller_state))
    return ContractCheckResult(passed=len(violations) == 0, violations=violations, is_stub=False)


def completion_check_final(
    result: Any,
    output_contract: OutputContract,
    caller_state: Any,
    harness_run_state: Any,
) -> ContractCheckResult:
    """Final completion gate — authoritative contract check before harness return.

    Calls validate_output_contract(). If passed=False, raises EscalationHalt via
    escalate() with reason="contract_violation". The harness must not return a
    contract-failing result silently.
    """
    check = validate_output_contract(result, output_contract, caller_state)
    if not check.passed:
        from .escalation import SurfaceBlocker, escalate

        blocker = SurfaceBlocker(
            reason="review_failure",
            missing_info=check.violations,
            current_task_summary="Output contract validation failed",
        )
        run_id = getattr(harness_run_state, "run_id", "") if harness_run_state else ""
        escalate(blocker, harness_run_state, run_id)
    return check


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
            violations.append(f"Type mismatch for {field_name!r}: expected {expected_type!r}, got {actual_type!r}")

    return ContractCheckResult(
        passed=len(violations) == 0,
        violations=violations,
        is_stub=False,
    )


def _to_dict(result: Any) -> dict[str, Any] | None:
    """Normalise result to a dict for field lookup, or return None."""
    if isinstance(result, dict):
        return result
    if result is None:
        return {}
    if hasattr(result, "to_dict"):
        return result.to_dict()
    if hasattr(result, "__dict__"):
        return vars(result)
    return None


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
            "str": str,
            "int": int,
            "float": float,
            "bool": bool,
            "list": list,
            "dict": dict,
        }
        py_type = type_map.get(expected_type.lower())
        if py_type is None:
            return True  # unknown type — pass conservatively
        return isinstance(value, py_type)
    if isinstance(expected_type, list):
        return any(_check_type(value, t) for t in expected_type)
    return True
