export declare const MEMORY_CORE_VERSION: "1.0.0";
export declare const DEFAULT_MEMORY_BUDGET_CHARS: 4000;
export declare const BUDGET_HEADER: "\nKnown facts about the user:\n";
export declare const BUDGET_LINE_FORMAT: "- {text}{suffix}";
export declare const UNCONFIRMED_SUFFIX: " (unconfirmed)";
export declare const BUDGET_SEPARATOR_COST: 1;
export declare const TIER_PRIORITY: {
    readonly identity: 0;
    readonly preference: 0;
    readonly semantic: 1;
    readonly episodic: 2;
};
export declare const SESSION_PRIORITY: 2;
export declare const LEGACY_FACT_CAP: {
    readonly value: 20;
    readonly ported: false;
};
export declare const FACT_ID_FORMAT: "{text}|{extractedAt}";
export declare const AUDIT_LOG_KEEP: 500;
export declare const STORE_KEYS: {
    readonly durable: "facts:durable";
    readonly pending: "facts:pending-confirmation";
    readonly rejected: "facts:rejected";
    readonly retired: "facts:retired";
    readonly audit: "memory:audit";
    readonly consolidationState: "memory:consolidation-state";
    readonly off: "memory:off";
    readonly SESSION_FACTS_PREFIX: "facts:";
    readonly archive: "facts:archive";
    readonly proposals: "memory:proposals";
    readonly EPISODIC_PREFIX: "episodic:";
};
export declare const FACT_FIELDS: readonly [{
    readonly name: "text";
    readonly type: "string";
    readonly required: true;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "extractedAt";
    readonly type: "string";
    readonly required: true;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "sourceTurn";
    readonly type: "string";
    readonly required: true;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "durable";
    readonly type: "boolean";
    readonly required: true;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "source";
    readonly type: "FactSource";
    readonly required: true;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "confidence";
    readonly type: "FactConfidence";
    readonly required: false;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "category";
    readonly type: "FactCategory";
    readonly required: false;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "project";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M0";
    readonly port: "yes";
}, {
    readonly name: "key";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M1";
    readonly port: "yes";
}, {
    readonly name: "supersedes";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M1";
    readonly port: "yes";
}, {
    readonly name: "retiredAt";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M1";
    readonly port: "yes";
}, {
    readonly name: "injectedCount";
    readonly type: "number";
    readonly required: false;
    readonly phase: "M1";
    readonly port: "yes";
}, {
    readonly name: "lastInjectedAt";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M1";
    readonly port: "yes";
}, {
    readonly name: "origin";
    readonly type: "FactOrigin";
    readonly required: false;
    readonly phase: "M2";
    readonly port: "yes";
}, {
    readonly name: "evidence";
    readonly type: "string";
    readonly required: false;
    readonly phase: "M2";
    readonly port: "yes";
}, {
    readonly name: "flagged";
    readonly type: "boolean";
    readonly required: false;
    readonly phase: "M2";
    readonly port: "yes";
}];
export declare const FACT_TRANSIENT_FIELDS: readonly ["judgement"];
export declare const PENDING_FACT_EXTRA_FIELDS: readonly [{
    readonly name: "previouslyRejected";
    readonly type: "boolean";
    readonly required: false;
    readonly port: "deferred";
}, {
    readonly name: "proposedOp";
    readonly type: "'retire'";
    readonly required: false;
    readonly port: "deferred";
}, {
    readonly name: "retireTargetId";
    readonly type: "string";
    readonly required: false;
    readonly port: "deferred";
}];
export declare const PENDING_FACT_DEFAULT_CATEGORY: "other";
export declare const FACT_SOURCES: readonly ["user_asserted", "model_inferred", "observed", "externally_verified"];
export declare const FACT_ORIGINS: readonly ["user", "agent", "tool", "web"];
export declare const DEFAULT_FACT_ORIGIN: "user";
export declare const FACT_CONFIDENCES: readonly ["high", "medium", "low"];
export declare const FACT_CATEGORIES: readonly ["identity", "health", "preference", "location", "occupation", "relationships", "project", "other"];
export declare const MEMORY_TIERS: readonly ["episodic", "semantic", "procedural", "preference", "commitment", "identity"];
export declare const TIER_RULES: {
    readonly episodic: {
        readonly allowedSources: readonly ["user_asserted", "model_inferred", "observed", "externally_verified"];
        readonly retention: "session";
        readonly contradictionChecked: false;
    };
    readonly semantic: {
        readonly allowedSources: readonly ["user_asserted", "model_inferred", "externally_verified"];
        readonly retention: "durable";
        readonly contradictionChecked: true;
    };
    readonly identity: {
        readonly allowedSources: readonly ["user_asserted", "model_inferred"];
        readonly retention: "durable";
        readonly contradictionChecked: true;
    };
    readonly preference: {
        readonly allowedSources: readonly ["user_asserted", "model_inferred"];
        readonly retention: "durable";
        readonly contradictionChecked: true;
    };
    readonly procedural: {
        readonly allowedSources: readonly [];
        readonly retention: "durable";
        readonly contradictionChecked: false;
    };
    readonly commitment: {
        readonly allowedSources: readonly [];
        readonly retention: "durable";
        readonly contradictionChecked: false;
    };
};
export declare const TIER_RULE_ORDER: readonly [{
    readonly id: "non_user_origin";
    readonly tier: "episodic";
    readonly when: {
        readonly all: readonly [{
            readonly field: "origin";
            readonly present: true;
        }, {
            readonly field: "origin";
            readonly neq: "user";
        }];
    };
}, {
    readonly id: "observed";
    readonly tier: "episodic";
    readonly when: {
        readonly field: "source";
        readonly eq: "observed";
    };
}, {
    readonly id: "model_inferred_unconfirmed";
    readonly tier: "episodic";
    readonly when: {
        readonly all: readonly [{
            readonly field: "source";
            readonly eq: "model_inferred";
        }, {
            readonly not: {
                readonly all: readonly [{
                    readonly field: "durable";
                    readonly eq: true;
                }, {
                    readonly field: "confidence";
                    readonly eq: "high";
                }];
            };
        }];
    };
}, {
    readonly id: "durable_identity";
    readonly tier: "identity";
    readonly when: {
        readonly all: readonly [{
            readonly field: "durable";
            readonly eq: true;
        }, {
            readonly field: "category";
            readonly eq: "identity";
        }];
    };
}, {
    readonly id: "durable_preference";
    readonly tier: "preference";
    readonly when: {
        readonly all: readonly [{
            readonly field: "durable";
            readonly eq: true;
        }, {
            readonly field: "category";
            readonly eq: "preference";
        }];
    };
}, {
    readonly id: "default";
    readonly tier: "semantic";
    readonly when: {
        readonly always: true;
    };
}];
export declare const WRITE_MODES: readonly ["auto", "staged", "user_only"];
export declare const DEFAULT_WRITE_MODE: "staged";
export declare const WRITERS: readonly ["in_turn", "digest", "reviewer", "consolidation"];
export declare const WRITE_ROUTES: readonly ["durable", "pending", "session"];
export declare const WRITE_ROUTE_TABLE: readonly [{
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "pending";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "durable";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "in_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "user_asserted";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "model_inferred";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "observed";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "durable";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: true;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "pending";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "high";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "medium";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: "low";
    readonly mode: "user_only";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "auto";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "staged";
    readonly route: "session";
}, {
    readonly writerClass: "cross_turn";
    readonly source: "externally_verified";
    readonly durable: false;
    readonly confidence: null;
    readonly mode: "user_only";
    readonly route: "session";
}];
export declare const ADMIT_ACTIONS: readonly ["admit", "session", "flag", "drop"];
export declare const GATE_RULES: readonly [{
    readonly id: "gate_off";
    readonly when: {
        readonly gateOn: false;
    };
    readonly action: "admit";
    readonly terminal: true;
    readonly effects: {
        readonly applyDefaultOrigin: false;
    };
}, {
    readonly id: "not_judged";
    readonly when: {
        readonly judged: false;
    };
    readonly action: "admit";
    readonly terminal: true;
    readonly effects: {};
}, {
    readonly id: "missing_judgement";
    readonly when: {
        readonly judgementComplete: false;
    };
    readonly action: "session";
    readonly terminal: true;
    readonly effects: {
        readonly durable: false;
    };
}, {
    readonly id: "secret_whole_claim";
    readonly when: {
        readonly containsSecret: true;
        readonly redactedNonEmpty: false;
    };
    readonly action: "drop";
    readonly terminal: true;
    readonly effects: {};
}, {
    readonly id: "secret_redacted";
    readonly when: {
        readonly containsSecret: true;
        readonly redactedNonEmpty: true;
    };
    readonly action: null;
    readonly terminal: false;
    readonly effects: {
        readonly replaceTextWithRedacted: true;
        readonly clearEvidence: true;
    };
}, {
    readonly id: "instruction_shaped";
    readonly when: {
        readonly looksLikeInstruction: true;
    };
    readonly action: "flag";
    readonly terminal: true;
    readonly effects: {
        readonly flagged: true;
    };
}, {
    readonly id: "clean_non_user";
    readonly when: {
        readonly nonUser: true;
    };
    readonly action: "session";
    readonly terminal: true;
    readonly effects: {
        readonly durable: false;
    };
}, {
    readonly id: "clean_user";
    readonly when: {};
    readonly action: "admit";
    readonly terminal: true;
    readonly effects: {};
}];
export declare const AUDIT_OPS: readonly ["add", "replace", "retire", "remove", "confirm", "reject", "undo", "archive", "restore"];
export declare const AUDIT_OPS_DEFERRED: readonly ["archive", "restore"];
export declare const AUDIT_STORES: readonly ["durable", "pending", "rejected"];
export declare const AUDIT_ENTRY_FIELDS: readonly [{
    readonly name: "seq";
    readonly type: "int";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "at";
    readonly type: "string";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "op";
    readonly type: "AuditOp";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "factId";
    readonly type: "string";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "before";
    readonly type: "UserFact";
    readonly required: false;
    readonly port: "yes";
}, {
    readonly name: "after";
    readonly type: "UserFact";
    readonly required: false;
    readonly port: "yes";
}, {
    readonly name: "store";
    readonly type: "AuditStore";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "writer";
    readonly type: "string";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "turn";
    readonly type: "string";
    readonly required: true;
    readonly port: "yes";
}, {
    readonly name: "undoes";
    readonly type: "int";
    readonly required: false;
    readonly port: "yes";
}, {
    readonly name: "erased";
    readonly type: "boolean";
    readonly required: false;
    readonly port: "deferred";
}, {
    readonly name: "group";
    readonly type: "string";
    readonly required: false;
    readonly port: "deferred";
}, {
    readonly name: "index";
    readonly type: "int";
    readonly required: false;
    readonly port: "yes";
}];
export declare const UNDO_MESSAGES: {
    readonly unknownSeq: "No audit entry #{seq}.";
    readonly isUndo: "Entry #{seq} is itself an undo.";
    readonly alreadyUndone: "Entry #{seq} was already undone.";
    readonly erased: "Entry #{seq} was erased from history and cannot be restored.";
    readonly grouped: "Entry #{seq} belongs to a group; undoing grouped entries is not supported in this runtime.";
    readonly success: "Undid #{seq} ({op}): {text}";
};
export declare const UNDO_MESSAGES_PYTHON_ONLY: readonly ["grouped"];
export declare const INV16: {
    readonly knowledgeTiers: readonly ["semantic", "identity", "preference"];
    readonly nonUserOriginTier: "episodic";
    readonly neverPromotable: readonly ["agent", "tool", "web"];
    readonly neverReturnedTiers: readonly ["procedural", "commitment"];
};
export declare const MEMORY_EVENT_STORE_KEY: "memory:events";
export declare const MEMORY_EVENT_KEEP: 500;
export declare const MEMORY_EVENT_KINDS: readonly ["promote", "decline", "correct", "contradict", "supersede", "retire", "forget", "expire", "restore", "recall"];
export declare const MEMORY_REASON_CODES: readonly ["user_stated", "user_corrected", "user_confirmed", "user_rejected", "inferred_high_conf", "inferred_pending_confirmation", "inferred_low_conf_session_only", "conflicts_with_fact", "superseded_by_newer", "explicit_forget", "retention_expired", "gate_blocked_secret", "gate_blocked_instruction", "duplicate"];
export declare const MEMORY_SOURCE_TYPES: readonly ["user_message", "assistant_message", "tool_result", "prior_fact", "user_command"];
export declare const MEMORY_DECIDED_BY: readonly ["user", "classifier", "reviewer", "consolidation", "rule"];
