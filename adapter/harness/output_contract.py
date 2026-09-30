"""
Output contract data model and validation — P0.5, P5, P9.

Twin of packages/harness/src/state/output-contract.ts, nodes/output-validation.ts and the contractShadowCheck in
nodes/policy-gates.ts.

  - contract_shadow_check()   the cheap post-exec-gate check: every `required_sections` entry must be a key of a
                              dict result;
  - output_validation()       the authoritative final check (format, required sections, interface constraints,
                              validation rules, caller-constraint negation); raises OutputContractError;
  - validate_output_contract() the same check returned as a ContractCheckResult (no exception).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .lexical_off import harness_lexical_active
from .lexical_patterns import get_constraint_negation_words

_CONSTRAINT_NEGATION_WORDS = get_constraint_negation_words()


@dataclass
class OutputContract:
    format: str = "text"
    required_sections: list[str] = field(default_factory=list)
    required_interface_fields: list[str] = field(default_factory=list)
    interface_constraints: dict[str, Any] = field(default_factory=dict)
    validation_rules: list[str] = field(default_factory=list)
    caller_specific_constraints: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "required_sections": list(self.required_sections),
            "required_interface_fields": list(self.required_interface_fields),
            "interface_constraints": dict(self.interface_constraints),
            "validation_rules": list(self.validation_rules),
            "caller_specific_constraints": list(self.caller_specific_constraints),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> OutputContract:
        fmt = d.get("format")
        if fmt is None:  # legacy shape: format_requirements = {"format": ...}
            legacy = d.get("format_requirements") or {}
            fmt = legacy.get("format", "text") if isinstance(legacy, dict) else "text"
        return cls(
            format=fmt,
            required_sections=list(d.get("required_sections", [])),
            required_interface_fields=list(d.get("required_interface_fields", [])),
            interface_constraints=dict(d.get("interface_constraints", {})),
            validation_rules=list(d.get("validation_rules", [])),
            caller_specific_constraints=list(d.get("caller_specific_constraints", [])),
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
    """Re-derive output contract from updated caller_state constraints — P7.2 (TS updateOutputContract).

    Replaces caller_specific_constraints with the current constraints from caller_state. A constraint written
    "required: <field> ..." adds `<field>` (first token after the colon, one leading/trailing quote stripped) to
    required_interface_fields. Returns a new OutputContract (immutable update).
    """
    new_constraints = list(caller_state.current_constraints)

    required_fields = list(output_contract.required_interface_fields)
    for constraint in new_constraints:
        if "required:" in constraint.lower():
            parts = constraint.split(":")
            if len(parts) > 1:
                rest = ":".join(parts[1:]).strip()
                tokens = re.split(r"\s+", rest)
                candidate = re.sub(r"^['\"]|['\"]$", "", tokens[0]) if tokens else ""
                if candidate and candidate not in required_fields:
                    required_fields.append(candidate)

    return OutputContract(
        format=output_contract.format,
        required_sections=list(output_contract.required_sections),
        required_interface_fields=required_fields,
        interface_constraints=dict(output_contract.interface_constraints),
        validation_rules=list(output_contract.validation_rules),
        caller_specific_constraints=new_constraints,
    )


# ── authoritative output validation (TS nodes/output-validation.ts) ──────────


class OutputContractError(Exception):
    def __init__(self, violated_dimension: str, violations: list[str]) -> None:
        super().__init__(f'Output contract violation in "{violated_dimension}": {"; ".join(violations)}')
        self.violated_dimension = violated_dimension
        self.violations = violations


def _js_str(value: Any) -> str:
    """JS String(value) for the primitives that reach a violation message."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)


def output_validation(
    final_result: Any,
    output_contract: OutputContract,
    caller_state: Any,
    *,
    skip_caller_constraints: bool = False,
) -> ContractCheckResult:
    """Validate a finished reply against the contract (TS outputValidation). Raises OutputContractError.

    `skip_caller_constraints` skips the lexical caller-constraint word match — set when the host judges the
    constraints itself (semantic constraint judge). With HARNESS_LEXICAL constraint-negation off (the default) that
    match does not run either.
    """
    violations: list[str] = []
    result: dict[str, Any] = final_result if isinstance(final_result, dict) else {}

    if output_contract.format and output_contract.format != "any":
        if isinstance(final_result, str) and output_contract.format == "json":
            try:
                json.loads(final_result)
            except ValueError:
                violations.append("format: expected JSON, got non-parseable string")

    for section in output_contract.required_sections:
        if section not in result:
            violations.append(f'required_sections: missing field "{section}"')

    for key, expected in output_contract.interface_constraints.items():
        if key in result and result[key] != expected:
            violations.append(
                f'interface_constraints: field "{key}" expected {_js_str(expected)}, got {_js_str(result[key])}'
            )

    for rule in output_contract.validation_rules:
        colon = rule.find(":")
        if colon > 0:
            rule_field = rule[:colon].strip()
            if rule_field not in result:
                violations.append(f'validation_rules: rule "{rule}" references missing field "{rule_field}"')

    result_text = (
        (final_result if isinstance(final_result, str) else "") + " " + " ".join(_js_str(v) for v in result.values())
    ).lower()

    lexical_constraints = not skip_caller_constraints and harness_lexical_active("constraint-negation")
    for constraint in caller_state.current_constraints if (lexical_constraints and caller_state is not None) else []:
        constraint_lower = constraint.lower()
        if not any(t in _CONSTRAINT_NEGATION_WORDS for t in re.split(r"\s+", constraint_lower)):
            continue
        for kw in _CONSTRAINT_NEGATION_WORDS:
            idx = constraint_lower.find(kw)
            if idx == -1:
                continue
            subject = constraint_lower[idx + len(kw) :].strip()
            subject_tokens = [t for t in re.split(r"\s+", subject)[:4] if len(t) > 3]
            if subject_tokens and any(t in result_text for t in subject_tokens):
                violations.append(f'caller_specific_constraints: constraint violated: "{constraint}"')
                break

    if violations:
        raise OutputContractError(violations[0].split(":")[0], violations)

    return ContractCheckResult(passed=True, violations=[], is_stub=False)


def validate_output_contract(
    result: Any,
    output_contract: OutputContract,
    caller_state: Any = None,
    *,
    skip_caller_constraints: bool = False,
) -> ContractCheckResult:
    """output_validation() returned as a ContractCheckResult instead of raised."""
    try:
        return output_validation(result, output_contract, caller_state, skip_caller_constraints=skip_caller_constraints)
    except OutputContractError as exc:
        return ContractCheckResult(passed=False, violations=list(exc.violations), is_stub=False)


def completion_check_final(
    result: Any,
    output_contract: OutputContract,
    caller_state: Any,
    harness_run_state: Any,
    *,
    session_ask_mode: bool | None = None,
) -> ContractCheckResult:
    """Final completion gate — authoritative contract check before harness return.

    Calls validate_output_contract(). If passed=False, raises EscalationHalt via escalate() with
    reason="review_failure" and the violations as missing_info: the harness must not return a contract-failing
    result silently. (TS output_validation throws an OutputContractError instead of pausing the run; the halt is the
    Python driver's way to surface it. Like TS, no structured question is offered here — that is the review
    gate's site, see review_gate.escalate_review_failure.) `session_ask_mode` is accepted for older callers.
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


def contract_shadow_check(result: Any, output_contract: OutputContract | None) -> ContractCheckResult:
    """Lightweight post-exec-gate check (TS contractShadowCheck): every `required_sections` entry must be present
    as a key of a dict result. A missing contract, or a non-dict result, passes."""
    if output_contract is None:
        return ContractCheckResult(passed=True, violations=[], is_stub=False)

    violations: list[str] = []
    if isinstance(result, dict):
        for section in output_contract.required_sections:
            if section not in result:
                violations.append(f"Missing required field: {section}")

    return ContractCheckResult(passed=len(violations) == 0, violations=violations, is_stub=False)
