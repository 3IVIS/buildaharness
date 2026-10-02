/*
 * DO NOT EDIT — generated from spec/memory-core.json by spec/gen-memory-core.mjs.
 * Run `node spec/gen-memory-core.mjs` after editing the source. CI fails if this file is stale.
 * Agent memory framework plan, phase M8 (shared contract).
 */

export const MEMORY_CORE_VERSION = "1.0.0" as const

export const DEFAULT_MEMORY_BUDGET_CHARS = 4000 as const

export const BUDGET_HEADER = "\nKnown facts about the user:\n" as const

export const BUDGET_LINE_FORMAT = "- {text}{suffix}" as const

export const UNCONFIRMED_SUFFIX = " (unconfirmed)" as const

export const BUDGET_SEPARATOR_COST = 1 as const

export const TIER_PRIORITY = {
  "identity": 0,
  "preference": 0,
  "semantic": 1,
  "episodic": 2
} as const

export const SESSION_PRIORITY = 2 as const

export const LEGACY_FACT_CAP = {
  "value": 20,
  "ported": false
} as const

export const FACT_ID_FORMAT = "{text}|{extractedAt}" as const

export const AUDIT_LOG_KEEP = 500 as const

export const STORE_KEYS = {
  "durable": "facts:durable",
  "pending": "facts:pending-confirmation",
  "rejected": "facts:rejected",
  "retired": "facts:retired",
  "audit": "memory:audit",
  "consolidationState": "memory:consolidation-state",
  "off": "memory:off",
  "SESSION_FACTS_PREFIX": "facts:",
  "archive": "facts:archive",
  "proposals": "memory:proposals",
  "EPISODIC_PREFIX": "episodic:"
} as const

export const FACT_FIELDS = [
  {
    "name": "text",
    "type": "string",
    "required": true,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "extractedAt",
    "type": "string",
    "required": true,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "sourceTurn",
    "type": "string",
    "required": true,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "durable",
    "type": "boolean",
    "required": true,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "source",
    "type": "FactSource",
    "required": true,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "confidence",
    "type": "FactConfidence",
    "required": false,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "category",
    "type": "FactCategory",
    "required": false,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "project",
    "type": "string",
    "required": false,
    "phase": "M0",
    "port": "yes"
  },
  {
    "name": "key",
    "type": "string",
    "required": false,
    "phase": "M1",
    "port": "yes"
  },
  {
    "name": "supersedes",
    "type": "string",
    "required": false,
    "phase": "M1",
    "port": "yes"
  },
  {
    "name": "retiredAt",
    "type": "string",
    "required": false,
    "phase": "M1",
    "port": "yes"
  },
  {
    "name": "injectedCount",
    "type": "number",
    "required": false,
    "phase": "M1",
    "port": "yes"
  },
  {
    "name": "lastInjectedAt",
    "type": "string",
    "required": false,
    "phase": "M1",
    "port": "yes"
  },
  {
    "name": "origin",
    "type": "FactOrigin",
    "required": false,
    "phase": "M2",
    "port": "yes"
  },
  {
    "name": "evidence",
    "type": "string",
    "required": false,
    "phase": "M2",
    "port": "yes"
  },
  {
    "name": "flagged",
    "type": "boolean",
    "required": false,
    "phase": "M2",
    "port": "yes"
  }
] as const

export const FACT_TRANSIENT_FIELDS = [
  "judgement"
] as const

export const PENDING_FACT_EXTRA_FIELDS = [
  {
    "name": "previouslyRejected",
    "type": "boolean",
    "required": false,
    "port": "deferred"
  },
  {
    "name": "proposedOp",
    "type": "'retire'",
    "required": false,
    "port": "deferred"
  },
  {
    "name": "retireTargetId",
    "type": "string",
    "required": false,
    "port": "deferred"
  }
] as const

export const PENDING_FACT_DEFAULT_CATEGORY = "other" as const

export const FACT_SOURCES = [
  "user_asserted",
  "model_inferred",
  "observed",
  "externally_verified"
] as const

export const FACT_ORIGINS = [
  "user",
  "agent",
  "tool",
  "web"
] as const

export const DEFAULT_FACT_ORIGIN = "user" as const

export const FACT_CONFIDENCES = [
  "high",
  "medium",
  "low"
] as const

export const FACT_CATEGORIES = [
  "identity",
  "health",
  "preference",
  "location",
  "occupation",
  "relationships",
  "project",
  "other"
] as const

export const MEMORY_TIERS = [
  "episodic",
  "semantic",
  "procedural",
  "preference",
  "commitment",
  "identity"
] as const

export const TIER_RULES = {
  "episodic": {
    "allowedSources": [
      "user_asserted",
      "model_inferred",
      "observed",
      "externally_verified"
    ],
    "retention": "session",
    "contradictionChecked": false
  },
  "semantic": {
    "allowedSources": [
      "user_asserted",
      "model_inferred",
      "externally_verified"
    ],
    "retention": "durable",
    "contradictionChecked": true
  },
  "identity": {
    "allowedSources": [
      "user_asserted",
      "model_inferred"
    ],
    "retention": "durable",
    "contradictionChecked": true
  },
  "preference": {
    "allowedSources": [
      "user_asserted",
      "model_inferred"
    ],
    "retention": "durable",
    "contradictionChecked": true
  },
  "procedural": {
    "allowedSources": [],
    "retention": "durable",
    "contradictionChecked": false
  },
  "commitment": {
    "allowedSources": [],
    "retention": "durable",
    "contradictionChecked": false
  }
} as const

export const TIER_RULE_ORDER = [
  {
    "id": "non_user_origin",
    "tier": "episodic",
    "when": {
      "all": [
        {
          "field": "origin",
          "present": true
        },
        {
          "field": "origin",
          "neq": "user"
        }
      ]
    }
  },
  {
    "id": "observed",
    "tier": "episodic",
    "when": {
      "field": "source",
      "eq": "observed"
    }
  },
  {
    "id": "model_inferred_unconfirmed",
    "tier": "episodic",
    "when": {
      "all": [
        {
          "field": "source",
          "eq": "model_inferred"
        },
        {
          "not": {
            "all": [
              {
                "field": "durable",
                "eq": true
              },
              {
                "field": "confidence",
                "eq": "high"
              }
            ]
          }
        }
      ]
    }
  },
  {
    "id": "durable_identity",
    "tier": "identity",
    "when": {
      "all": [
        {
          "field": "durable",
          "eq": true
        },
        {
          "field": "category",
          "eq": "identity"
        }
      ]
    }
  },
  {
    "id": "durable_preference",
    "tier": "preference",
    "when": {
      "all": [
        {
          "field": "durable",
          "eq": true
        },
        {
          "field": "category",
          "eq": "preference"
        }
      ]
    }
  },
  {
    "id": "default",
    "tier": "semantic",
    "when": {
      "always": true
    }
  }
] as const

export const WRITE_MODES = [
  "auto",
  "staged",
  "user_only"
] as const

export const DEFAULT_WRITE_MODE = "staged" as const

export const WRITERS = [
  "in_turn",
  "digest",
  "reviewer",
  "consolidation"
] as const

export const WRITE_ROUTES = [
  "durable",
  "pending",
  "session"
] as const

export const WRITE_ROUTE_TABLE = [
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "pending"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "durable"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "in_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "user_asserted",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "model_inferred",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "observed",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "high",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "medium",
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "auto",
    "route": "durable"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "staged",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": true,
    "confidence": null,
    "mode": "user_only",
    "route": "pending"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "high",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "medium",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": "low",
    "mode": "user_only",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "auto",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "staged",
    "route": "session"
  },
  {
    "writerClass": "cross_turn",
    "source": "externally_verified",
    "durable": false,
    "confidence": null,
    "mode": "user_only",
    "route": "session"
  }
] as const

export const ADMIT_ACTIONS = [
  "admit",
  "session",
  "flag",
  "drop"
] as const

export const GATE_RULES = [
  {
    "id": "gate_off",
    "when": {
      "gateOn": false
    },
    "action": "admit",
    "terminal": true,
    "effects": {
      "applyDefaultOrigin": false
    }
  },
  {
    "id": "not_judged",
    "when": {
      "judged": false
    },
    "action": "admit",
    "terminal": true,
    "effects": {}
  },
  {
    "id": "missing_judgement",
    "when": {
      "judgementComplete": false
    },
    "action": "session",
    "terminal": true,
    "effects": {
      "durable": false
    }
  },
  {
    "id": "secret_whole_claim",
    "when": {
      "containsSecret": true,
      "redactedNonEmpty": false
    },
    "action": "drop",
    "terminal": true,
    "effects": {}
  },
  {
    "id": "secret_redacted",
    "when": {
      "containsSecret": true,
      "redactedNonEmpty": true
    },
    "action": null,
    "terminal": false,
    "effects": {
      "replaceTextWithRedacted": true,
      "clearEvidence": true
    }
  },
  {
    "id": "instruction_shaped",
    "when": {
      "looksLikeInstruction": true
    },
    "action": "flag",
    "terminal": true,
    "effects": {
      "flagged": true
    }
  },
  {
    "id": "clean_non_user",
    "when": {
      "nonUser": true
    },
    "action": "session",
    "terminal": true,
    "effects": {
      "durable": false
    }
  },
  {
    "id": "clean_user",
    "when": {},
    "action": "admit",
    "terminal": true,
    "effects": {}
  }
] as const

export const AUDIT_OPS = [
  "add",
  "replace",
  "retire",
  "remove",
  "confirm",
  "reject",
  "undo",
  "archive",
  "restore"
] as const

export const AUDIT_OPS_DEFERRED = [
  "archive",
  "restore"
] as const

export const AUDIT_STORES = [
  "durable",
  "pending",
  "rejected"
] as const

export const AUDIT_ENTRY_FIELDS = [
  {
    "name": "seq",
    "type": "int",
    "required": true,
    "port": "yes"
  },
  {
    "name": "at",
    "type": "string",
    "required": true,
    "port": "yes"
  },
  {
    "name": "op",
    "type": "AuditOp",
    "required": true,
    "port": "yes"
  },
  {
    "name": "factId",
    "type": "string",
    "required": true,
    "port": "yes"
  },
  {
    "name": "before",
    "type": "UserFact",
    "required": false,
    "port": "yes"
  },
  {
    "name": "after",
    "type": "UserFact",
    "required": false,
    "port": "yes"
  },
  {
    "name": "store",
    "type": "AuditStore",
    "required": true,
    "port": "yes"
  },
  {
    "name": "writer",
    "type": "string",
    "required": true,
    "port": "yes"
  },
  {
    "name": "turn",
    "type": "string",
    "required": true,
    "port": "yes"
  },
  {
    "name": "undoes",
    "type": "int",
    "required": false,
    "port": "yes"
  },
  {
    "name": "erased",
    "type": "boolean",
    "required": false,
    "port": "deferred"
  },
  {
    "name": "group",
    "type": "string",
    "required": false,
    "port": "deferred"
  },
  {
    "name": "index",
    "type": "int",
    "required": false,
    "port": "yes"
  }
] as const

export const UNDO_MESSAGES = {
  "unknownSeq": "No audit entry #{seq}.",
  "isUndo": "Entry #{seq} is itself an undo.",
  "alreadyUndone": "Entry #{seq} was already undone.",
  "erased": "Entry #{seq} was erased from history and cannot be restored.",
  "grouped": "Entry #{seq} belongs to a group; undoing grouped entries is not supported in this runtime.",
  "success": "Undid #{seq} ({op}): {text}"
} as const

export const UNDO_MESSAGES_PYTHON_ONLY = [
  "grouped"
] as const

export const INV16 = {
  "knowledgeTiers": [
    "semantic",
    "identity",
    "preference"
  ],
  "nonUserOriginTier": "episodic",
  "neverPromotable": [
    "agent",
    "tool",
    "web"
  ],
  "neverReturnedTiers": [
    "procedural",
    "commitment"
  ]
} as const
