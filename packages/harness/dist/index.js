var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_CLAUSE_PUNCTUATION = /[。！？；!?;]/g;
function containsCJK(text) {
  return CJK_CHAR.test(text);
}
function tokenize$1(text) {
  const tokens = [];
  let buffer = "";
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      if (buffer) {
        tokens.push(...buffer.split(/\s+/).filter(Boolean));
        buffer = "";
      }
      tokens.push(ch);
    } else {
      buffer += ch;
    }
  }
  if (buffer) tokens.push(...buffer.split(/\s+/).filter(Boolean));
  return tokens;
}
function tokenCount(text) {
  return tokenize$1(text).length;
}
function sharedTokens(a, b, stopwords = /* @__PURE__ */ new Set()) {
  const setA = new Set(tokenize$1(a).map((t) => t.toLowerCase()).filter((t) => !stopwords.has(t)));
  const setB = new Set(tokenize$1(b).map((t) => t.toLowerCase()).filter((t) => !stopwords.has(t)));
  return [...setA].filter((t) => setB.has(t));
}
function splitClauses(text, extraBoundary) {
  const chunks = text.split(CJK_CLAUSE_PUNCTUATION);
  const result = [];
  for (const chunk of chunks) {
    if (extraBoundary) result.push(...chunk.split(extraBoundary));
    else result.push(chunk);
  }
  return result.map((s) => s.trim()).filter(Boolean);
}
function normalizeBlend(blend) {
  const floored = {};
  for (const [k, v] of Object.entries(blend)) {
    floored[k] = Math.max(0, v);
  }
  const total = Object.values(floored).reduce((sum, v) => sum + v, 0);
  if (total === 0) return blend;
  const scale = 100 / total;
  const result = {};
  for (const [k, v] of Object.entries(floored)) {
    result[k] = v * scale;
  }
  return result;
}
function makeBlendAdjuster(rules, blendKey = "strategy_blend", momentumCap = 10) {
  return function adjuster(state) {
    const blend = state[blendKey];
    if (!blend) return state;
    const original = { ...blend };
    const current = { ...blend };
    const firedRules = [];
    for (const rule of rules) {
      if (!rule.condition(state)) continue;
      firedRules.push(rule);
      let freed = 0;
      for (const [key, delta] of Object.entries(rule.adjustments)) {
        if (!(key in current)) continue;
        const oldVal = current[key];
        const newVal = Math.max(0, oldVal + delta);
        freed += oldVal - newVal;
        current[key] = newVal;
      }
      if (freed > 0 && rule.redistributeTo) {
        const targets = rule.redistributeTo.filter((k) => k in current);
        const totalTarget = targets.reduce((s, k) => s + current[k], 0);
        if (totalTarget > 0) {
          for (const k of targets) {
            current[k] += freed * (current[k] / totalTarget);
          }
        }
      }
    }
    for (const key of Object.keys(current)) {
      if (!(key in original)) continue;
      const delta = current[key] - original[key];
      if (Math.abs(delta) > momentumCap) {
        current[key] = Math.max(0, original[key] + (delta > 0 ? momentumCap : -momentumCap));
      }
    }
    const normalized = normalizeBlend(current);
    const result = { ...state, [blendKey]: normalized };
    for (const rule of firedRules) {
      if (rule.styleOverride !== void 0) {
        result["style_override"] = rule.styleOverride;
      }
    }
    return result;
  };
}
function resolveDotPath(state, path) {
  let current = state;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return { found: false, value: void 0 };
    }
    current = current[part];
    if (current === null || current === void 0) {
      return { found: true, value: null };
    }
  }
  return { found: true, value: current };
}
function makeTurnInitializer(fields, options) {
  var _a;
  const turnKey = ((_a = options == null ? void 0 : options.resourceBudget) == null ? void 0 : _a.turnKey) ?? "turn_number";
  return function initializer(state) {
    const result = { ...state };
    const rawTurn = result[turnKey];
    const isTurnOne = rawTurn == null || rawTurn <= 1;
    for (const f of fields) {
      if (f.sourcePath !== void 0) {
        if (f.initOnce && !isTurnOne) continue;
        const { found, value } = resolveDotPath(result, f.sourcePath);
        result[f.key] = !found || value === null || value === void 0 ? f.default : value;
      } else {
        if (!(f.key in result)) {
          result[f.key] = f.default;
        }
      }
    }
    if ((options == null ? void 0 : options.resourceBudget) !== void 0) {
      const budget = options.resourceBudget;
      const budgetKey = budget.budgetKey ?? "resource_budget";
      if (isTurnOne) {
        result[budgetKey] = {
          timeLimitSeconds: budget.timeLimitSeconds,
          tokenBudget: budget.tokenBudget,
          elapsedSeconds: 0,
          tokensUsed: 0,
          startedAt: /* @__PURE__ */ new Date()
        };
      } else {
        const existing = result[budgetKey] ?? {};
        const startedAt = existing["startedAt"];
        const elapsed = startedAt instanceof Date ? (Date.now() - startedAt.getTime()) / 1e3 : 0;
        result[budgetKey] = { ...existing, elapsedSeconds: elapsed };
      }
    }
    if ((options == null ? void 0 : options.emptyModelKey) !== void 0 && !result[options.emptyModelKey]) {
      const template = options.emptyModelTemplate ?? {};
      result[options.emptyModelKey] = JSON.parse(JSON.stringify(template));
    }
    return result;
  };
}
const HARNESS_LEXICAL_CHECKS = [
  "negation-pairs",
  "granularity-markers",
  "review-negation",
  "review-phrases",
  "failure-exact-match",
  "system-error-symptoms",
  "criterion-substring",
  "criterion-proximity",
  "criterion-scope",
  "constraint-negation",
  "preference-patterns",
  "source-dedupe"
];
const DEFAULT_HARNESS_LEXICAL_MODE = "disabled";
let hostMode;
function setHarnessLexicalMode(mode) {
  hostMode = mode;
}
function envSource(env) {
  return env ?? (typeof process !== "undefined" && process.env ? process.env : {});
}
function parseList(raw) {
  const out = /* @__PURE__ */ new Set();
  for (const token of String(raw ?? "").toLowerCase().split(",")) {
    const name2 = token.trim();
    if (name2 === "all") for (const c of HARNESS_LEXICAL_CHECKS) out.add(c);
    else if (HARNESS_LEXICAL_CHECKS.includes(name2)) out.add(name2);
  }
  return out;
}
function resolveHarnessLexicalMode(env) {
  const raw = String(envSource(env).HARNESS_LEXICAL_MODE ?? "").trim().toLowerCase();
  if (raw === "enabled" || raw === "disabled") return raw;
  return hostMode ?? DEFAULT_HARNESS_LEXICAL_MODE;
}
function resolveHarnessLexicalOff(env) {
  const source = envSource(env);
  const off = parseList(source.HARNESS_LEXICAL_OFF);
  const on = parseList(source.HARNESS_LEXICAL_ON);
  const modeOn = resolveHarnessLexicalMode(source) === "enabled";
  for (const c of HARNESS_LEXICAL_CHECKS) if (!modeOn && !on.has(c)) off.add(c);
  return off;
}
function harnessLexicalActive(check, env) {
  return !resolveHarnessLexicalOff(env).has(check);
}
function makePreferenceExtractor(signals, options) {
  for (const signal of signals) {
    if (signal.value != null && signal.delta != null) {
      throw new Error("PreferenceSignal: value and delta are mutually exclusive");
    }
  }
  const inputKey = (options == null ? void 0 : options.inputKey) ?? "feedback_text";
  const outputKey = (options == null ? void 0 : options.outputKey) ?? "preference_updates";
  const processedFlagKey = (options == null ? void 0 : options.processedFlagKey) ?? "feedback_processed";
  return function extract(state) {
    const text = state[inputKey];
    if (!text) return state;
    const lowerText = text.toLowerCase();
    const updates = {};
    const patternsOn = harnessLexicalActive("preference-patterns");
    for (const signal of patternsOn ? signals : []) {
      if (signal.patterns.some((p) => lowerText.includes(p.toLowerCase()))) {
        if (signal.delta != null) {
          const base = state[signal.field] ?? 0;
          let newVal = base + signal.delta;
          if (signal.minValue !== void 0) newVal = Math.max(signal.minValue, newVal);
          if (signal.maxValue !== void 0) newVal = Math.min(signal.maxValue, newVal);
          updates[signal.field] = newVal;
        } else {
          updates[signal.field] = signal.value;
        }
      }
    }
    return { ...state, [outputKey]: updates, [processedFlagKey]: true };
  };
}
const RELIABILITY_RANK$1 = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1
};
function tokenize(text) {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean)
  );
}
function jaccardSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}
function makeMultiSourceReducer(branches, itemTextFn, options) {
  const similarityThreshold = (options == null ? void 0 : options.similarityThreshold) ?? 0.85;
  const minDiversityCount = (options == null ? void 0 : options.minDiversityCount) ?? 2;
  const outputKey = (options == null ? void 0 : options.outputKey) ?? "items";
  const diversityWarningKey = (options == null ? void 0 : options.diversityWarningKey) ?? "diversity_warning";
  return function reduce(branchStates) {
    const candidates = [];
    for (let i = 0; i < branches.length; i++) {
      if (i >= branchStates.length) break;
      const config = branches[i];
      const items = branchStates[i][config.stateKey];
      if (!items) continue;
      for (const item of items) {
        const reliability = config.reliabilityFn != null ? config.reliabilityFn(item) : config.reliability;
        const tagged = { ...item };
        tagged["source"] = config.sourceLabel;
        tagged["reliability"] = reliability;
        if (config.internalOnly) tagged["internal_only"] = true;
        candidates.push([tagged, i]);
      }
    }
    const retained = [];
    for (const [candidateItem, candidateBranch] of candidates) {
      const candidateText = itemTextFn(candidateItem);
      let replacedAt = null;
      let skip = false;
      for (let j = 0; j < retained.length; j++) {
        const [existingItem] = retained[j];
        const existingText = itemTextFn(existingItem);
        if (!candidateText || !existingText) continue;
        if (harnessLexicalActive("source-dedupe") && jaccardSimilarity(candidateText, existingText) > similarityThreshold) {
          const candRank = RELIABILITY_RANK$1[candidateItem["reliability"]] ?? 0;
          const existRank = RELIABILITY_RANK$1[existingItem["reliability"]] ?? 0;
          if (candRank > existRank) {
            replacedAt = j;
          } else {
            skip = true;
          }
          break;
        }
      }
      if (replacedAt !== null) {
        retained[replacedAt] = [candidateItem, candidateBranch];
      } else if (!skip) {
        retained.push([candidateItem, candidateBranch]);
      }
    }
    const resultItems = retained.map(([item]) => item);
    const diversityWarning = resultItems.length < minDiversityCount;
    return { [outputKey]: resultItems, [diversityWarningKey]: diversityWarning };
  };
}
class TaxonomyClassifier {
  constructor(config, llmCall) {
    __publicField(this, "_config");
    __publicField(this, "_llmCall");
    __publicField(this, "_validIds");
    __publicField(this, "_model");
    __publicField(this, "_temperature");
    if (!config.taxonomy || config.taxonomy.length === 0) {
      throw new Error("taxonomy must not be empty");
    }
    const validIds = new Set(config.taxonomy.map((t) => t.id));
    if (!validIds.has(config.fallbackTypeId)) {
      throw new Error(`fallbackTypeId '${config.fallbackTypeId}' is not in the taxonomy`);
    }
    this._config = config;
    this._llmCall = llmCall;
    this._validIds = validIds;
    this._model = config.model ?? "claude-haiku-4-5-20251001";
    this._temperature = config.temperature ?? 0;
  }
  _fallback() {
    const fid = this._config.fallbackTypeId;
    return {
      detectedTypes: [fid],
      primaryType: fid,
      confidenceScores: { [fid]: 1 },
      rationale: "fallback"
    };
  }
  _buildPrompt(text, context) {
    const taxonomyLines = this._config.taxonomy.map((t) => `${t.id}: ${t.description}`).join("\n");
    let ctxSection = "";
    if (this._config.contextStateKey && context) {
      const ctxValue = context[this._config.contextStateKey];
      if (ctxValue != null) {
        ctxSection = `

Background context:
${ctxValue}`;
      }
    }
    const validIds = [...this._validIds].join(", ");
    return `Classify the following text against the taxonomy below.

Taxonomy:
${taxonomyLines}

Text to classify:
${text}${ctxSection}

Respond with a JSON object using this exact schema:
{"detected_types": ["TYPE_ID", ...], "primary_type": "TYPE_ID", "confidence_scores": {"TYPE_ID": 0.0-1.0, ...}, "rationale": "..."}
Use only these valid type IDs: ${validIds}`;
  }
  async classify(text, context) {
    if (!text || !text.trim()) {
      return this._fallback();
    }
    let raw;
    try {
      const prompt = this._buildPrompt(text, context);
      raw = await this._llmCall(prompt, this._model, this._temperature);
    } catch {
      return this._fallback();
    }
    let parsed;
    try {
      const nonGreedy = raw.match(/\{[\s\S]*?\}/);
      const greedy = raw.match(/\{[\s\S]*\}/);
      let jsonStr = null;
      if (nonGreedy) {
        try {
          JSON.parse(nonGreedy[0]);
          jsonStr = nonGreedy[0];
        } catch {
          jsonStr = greedy ? greedy[0] : null;
        }
      } else {
        jsonStr = greedy ? greedy[0] : null;
      }
      if (!jsonStr) return this._fallback();
      parsed = JSON.parse(jsonStr);
    } catch {
      return this._fallback();
    }
    try {
      const rawDetected = parsed["detected_types"] ?? [];
      const rawPrimary = parsed["primary_type"] ?? "";
      const rawConfidence = parsed["confidence_scores"] ?? {};
      const rationale = parsed["rationale"] ?? "";
      let detected = rawDetected.filter((t) => this._validIds.has(t));
      const confidence = {};
      for (const [k, v] of Object.entries(rawConfidence)) {
        if (this._validIds.has(k)) confidence[k] = v;
      }
      if (detected.length === 0 && this._validIds.has(rawPrimary)) {
        detected = [rawPrimary];
      }
      if (detected.length === 0) return this._fallback();
      let primary = rawPrimary;
      if (!this._validIds.has(primary)) {
        primary = detected.reduce(
          (best, t) => (confidence[t] ?? 0.5) >= (confidence[best] ?? 0.5) ? t : best
        );
      }
      for (const t of detected) {
        if (!(t in confidence)) confidence[t] = 0.5;
      }
      return { detectedTypes: detected, primaryType: primary, confidenceScores: confidence, rationale };
    } catch {
      return this._fallback();
    }
  }
}
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
const getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
const ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
const errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
let overrideErrorMap = errorMap;
function getErrorMap() {
  return overrideErrorMap;
}
const makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
const INVALID = Object.freeze({
  status: "aborted"
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message == null ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
const handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description: description2 } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description: description2 };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description: description2 };
}
class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: (params == null ? void 0 : params.async) ?? false,
        contextualErrorMap: params == null ? void 0 : params.errorMap
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    var _a, _b;
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if ((_b = (_a = err == null ? void 0 : err.message) == null ? void 0 : _a.toLowerCase()) == null ? void 0 : _b.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params == null ? void 0 : params.errorMap,
        async: true
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description2) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description: description2
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && (decoded == null ? void 0 : decoded.typ) !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      offset: (options == null ? void 0 : options.offset) ?? false,
      local: (options == null ? void 0 : options.local) ?? false,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options == null ? void 0 : options.position,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params == null ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b;
          const defaultError = ((_b = (_a = this._def).errorMap) == null ? void 0 : _b.call(_a, issue, ctx).message) ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}
class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}
class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}
class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
const booleanType = ZodBoolean.create;
const unknownType = ZodUnknown.create;
ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
ZodUnion.create;
ZodIntersection.create;
ZodTuple.create;
const recordType = ZodRecord.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;
const ObservationSchema = objectType({
  id: stringType(),
  content: stringType(),
  source: stringType(),
  recorded_at: stringType()
});
const BeliefSchema = objectType({
  id: stringType(),
  statement: stringType(),
  confidence: numberType().min(0).max(1),
  derived_from: arrayType(stringType()),
  supporting_evidence: arrayType(stringType()).optional(),
  reliability: stringType().optional(),
  recorded_at: stringType(),
  // Tracks which contradiction ids have already been applied to this belief's
  // confidence, so apply_resolution_policy() stays idempotent across repeated calls.
  applied_contradiction_ids: arrayType(stringType()).optional(),
  pending_sweep: booleanType().optional()
});
const ContradictionSchema = objectType({
  id: stringType(),
  type: enumType(["pairwise", "set-level", "temporal", "abstraction"]),
  severity: enumType(["LOW", "MEDIUM", "HIGH", "SYSTEM_BREAKING"]),
  scope: enumType(["local", "task", "global"]),
  description: stringType(),
  involved_belief_ids: arrayType(stringType())
});
const EnvironmentChangeSchema = objectType({
  id: stringType(),
  description: stringType(),
  affected_paths: arrayType(stringType()),
  timestamp: stringType()
});
const BeliefNodeSchema = objectType({
  belief_id: stringType(),
  confidence: numberType()
});
const DepEdgeSchema = objectType({
  from: stringType(),
  to: stringType(),
  confidence: numberType(),
  verified: booleanType()
});
const PropagationTaskSchema = objectType({
  source_belief_id: stringType(),
  target_belief_id: stringType()
});
const BeliefDepGraphSchema = objectType({
  belief_nodes: arrayType(BeliefNodeSchema),
  derived_from_edges: arrayType(DepEdgeSchema),
  invalidation_frontier: arrayType(stringType()),
  propagation_queue: arrayType(PropagationTaskSchema),
  unverified_edge_ratio: numberType(),
  confidence_decay_rate: numberType()
});
class BeliefDepGraph {
  constructor(data) {
    __publicField(this, "belief_nodes");
    __publicField(this, "derived_from_edges");
    __publicField(this, "invalidation_frontier");
    __publicField(this, "propagation_queue");
    __publicField(this, "unverified_edge_ratio");
    __publicField(this, "confidence_decay_rate");
    this.belief_nodes = (data == null ? void 0 : data.belief_nodes) ?? [];
    this.derived_from_edges = (data == null ? void 0 : data.derived_from_edges) ?? [];
    this.invalidation_frontier = (data == null ? void 0 : data.invalidation_frontier) ?? [];
    this.propagation_queue = (data == null ? void 0 : data.propagation_queue) ?? [];
    this.unverified_edge_ratio = (data == null ? void 0 : data.unverified_edge_ratio) ?? 0;
    this.confidence_decay_rate = (data == null ? void 0 : data.confidence_decay_rate) ?? 0.05;
  }
  recomputeUnverifiedEdgeRatio() {
    const total = this.derived_from_edges.length;
    if (total === 0) {
      this.unverified_edge_ratio = 0;
      return;
    }
    const unverified = this.derived_from_edges.filter((e) => !e.verified).length;
    this.unverified_edge_ratio = unverified / total;
  }
  toJSON() {
    return {
      belief_nodes: this.belief_nodes,
      derived_from_edges: this.derived_from_edges,
      invalidation_frontier: this.invalidation_frontier,
      propagation_queue: this.propagation_queue,
      unverified_edge_ratio: this.unverified_edge_ratio,
      confidence_decay_rate: this.confidence_decay_rate
    };
  }
  static fromJSON(json) {
    const parsed = BeliefDepGraphSchema.parse(json);
    return new BeliefDepGraph(parsed);
  }
}
const DepGraphBudgetSchema = objectType({
  max_unverified_edge_ratio: numberType(),
  refresh_policy: stringType(),
  confidence_decay_rate: numberType()
});
class DepGraphBudget {
  constructor(data) {
    __publicField(this, "max_unverified_edge_ratio");
    __publicField(this, "refresh_policy");
    __publicField(this, "confidence_decay_rate");
    this.max_unverified_edge_ratio = (data == null ? void 0 : data.max_unverified_edge_ratio) ?? 0.3;
    this.refresh_policy = (data == null ? void 0 : data.refresh_policy) ?? "per_iteration";
    this.confidence_decay_rate = (data == null ? void 0 : data.confidence_decay_rate) ?? 0.05;
  }
  applyDecay(graph) {
    for (const edge of graph.derived_from_edges) {
      edge.confidence = Math.max(0, edge.confidence - this.confidence_decay_rate);
    }
    graph.recomputeUnverifiedEdgeRatio();
  }
  toJSON() {
    return {
      max_unverified_edge_ratio: this.max_unverified_edge_ratio,
      refresh_policy: this.refresh_policy,
      confidence_decay_rate: this.confidence_decay_rate
    };
  }
  static fromJSON(json) {
    return new DepGraphBudget(json);
  }
}
const WorldModelSchema = objectType({
  generation_id: numberType().int().nonnegative(),
  observations: arrayType(ObservationSchema),
  beliefs: arrayType(BeliefSchema),
  assumptions: arrayType(stringType()),
  contradictions: arrayType(ContradictionSchema),
  environment_change_log: arrayType(EnvironmentChangeSchema),
  completeness_flags: recordType(booleanType()),
  stale_flags: recordType(booleanType())
});
class WorldModel {
  constructor(data) {
    __publicField(this, "generation_id");
    __publicField(this, "observations");
    __publicField(this, "beliefs");
    __publicField(this, "assumptions");
    __publicField(this, "contradictions");
    __publicField(this, "environment_change_log");
    __publicField(this, "completeness_flags");
    __publicField(this, "stale_flags");
    this.generation_id = (data == null ? void 0 : data.generation_id) ?? 0;
    this.observations = (data == null ? void 0 : data.observations) ?? [];
    this.beliefs = (data == null ? void 0 : data.beliefs) ?? [];
    this.assumptions = (data == null ? void 0 : data.assumptions) ?? [];
    this.contradictions = (data == null ? void 0 : data.contradictions) ?? [];
    this.environment_change_log = (data == null ? void 0 : data.environment_change_log) ?? [];
    this.completeness_flags = (data == null ? void 0 : data.completeness_flags) ?? {};
    this.stale_flags = (data == null ? void 0 : data.stale_flags) ?? {};
  }
  addBelief(belief) {
    if (!belief.derived_from || belief.derived_from.length === 0) {
      throw new Error(
        `WorldModel invariant: belief "${belief.id}" must have a non-empty derived_from[] chain`
      );
    }
    this.beliefs.push(belief);
  }
  incrementGenerationId() {
    this.generation_id++;
  }
  toJSON() {
    return {
      generation_id: this.generation_id,
      observations: this.observations,
      beliefs: this.beliefs,
      assumptions: this.assumptions,
      contradictions: this.contradictions,
      environment_change_log: this.environment_change_log,
      completeness_flags: this.completeness_flags,
      stale_flags: this.stale_flags
    };
  }
  static fromJSON(json) {
    const parsed = WorldModelSchema.parse(json);
    return new WorldModel(parsed);
  }
}
function describeAskAnswer(question, answer) {
  const label = (question == null ? void 0 : question.question) ?? answer.questionId;
  switch (answer.kind) {
    case "selected":
      return `Selected — ${label}: ${answer.selectedLabels.join(", ")}`;
    case "selected_with_edit":
      return `Selected with note — ${label}: ${answer.selectedLabels.join(", ")} (note: ${answer.editText})`;
    case "free_text":
      return `Free-text answer — ${label}: ${answer.freeText}`;
  }
}
const CallerStateSchema = objectType({
  current_constraints: arrayType(stringType()),
  clarification_history: arrayType(recordType(unknownType())),
  last_update: stringType(),
  output_preferences: recordType(unknownType()),
  success_criteria: arrayType(stringType()),
  constraints_changed: booleanType(),
  escalation_pending: booleanType(),
  pending_clarification: recordType(unknownType()).nullable()
});
class CallerState {
  constructor(data) {
    __publicField(this, "current_constraints");
    __publicField(this, "clarification_history");
    __publicField(this, "last_update");
    __publicField(this, "output_preferences");
    __publicField(this, "success_criteria");
    __publicField(this, "constraints_changed");
    __publicField(this, "escalation_pending");
    __publicField(this, "pending_clarification");
    this.current_constraints = (data == null ? void 0 : data.current_constraints) ?? [];
    this.clarification_history = (data == null ? void 0 : data.clarification_history) ?? [];
    this.last_update = (data == null ? void 0 : data.last_update) ?? (/* @__PURE__ */ new Date()).toISOString();
    this.output_preferences = (data == null ? void 0 : data.output_preferences) ?? {};
    this.success_criteria = (data == null ? void 0 : data.success_criteria) ?? [];
    this.constraints_changed = (data == null ? void 0 : data.constraints_changed) ?? false;
    this.escalation_pending = (data == null ? void 0 : data.escalation_pending) ?? false;
    this.pending_clarification = (data == null ? void 0 : data.pending_clarification) ?? null;
  }
  /**
   * Matches adapter/harness/caller_state.py's inject_clarification(): the single write
   * path for caller updates. Always appends the raw update to clarification_history
   * (never truncated); current_constraints/success_criteria are replaced wholesale
   * when present, output_preferences is merged.
   *
   * Q4 — a `clarification_answers` key (an AskResponse's answers, as set by
   * AskClarificationService's OneShotAnswerChannel / the adapter's escalation-resume
   * endpoint) is handled distinctly from a plain `current_constraints` replacement: each
   * AskAnswer is rendered via describeAskAnswer() (kind-tagged — a bare "selected" pick
   * reads differently from "selected_with_edit"'s caveat or a "free_text" answer) and
   * *appended* to current_constraints, using the optional `ask_questions` list (the
   * original AskQuestion batch) to resolve question text where available.
   */
  updateConstraints(update) {
    this.clarification_history.push({ ...update });
    if ("current_constraints" in update) {
      this.current_constraints = [...update.current_constraints];
    }
    if ("clarification_answers" in update) {
      const answers = update.clarification_answers;
      const questions = update.ask_questions ?? [];
      const byId = new Map(questions.map((q) => [q.id, q]));
      this.current_constraints = [
        ...this.current_constraints,
        ...answers.map((a) => describeAskAnswer(byId.get(a.questionId), a))
      ];
    }
    if ("output_preferences" in update) {
      this.output_preferences = { ...this.output_preferences, ...update.output_preferences };
    }
    if ("success_criteria" in update) {
      this.success_criteria = [...update.success_criteria];
    }
    if ("add_constraint" in update) {
      this.current_constraints = [...this.current_constraints, update.add_constraint];
    }
    if ("add_success_criteria" in update) {
      this.success_criteria = [...this.success_criteria, ...update.add_success_criteria];
    }
    this.last_update = (/* @__PURE__ */ new Date()).toISOString();
    this.constraints_changed = true;
  }
  resetConstraintsChanged() {
    this.constraints_changed = false;
  }
  toJSON() {
    return {
      current_constraints: this.current_constraints,
      clarification_history: this.clarification_history,
      last_update: this.last_update,
      output_preferences: this.output_preferences,
      success_criteria: this.success_criteria,
      constraints_changed: this.constraints_changed,
      escalation_pending: this.escalation_pending,
      pending_clarification: this.pending_clarification
    };
  }
  static fromJSON(json) {
    const parsed = CallerStateSchema.parse(json);
    return new CallerState(parsed);
  }
}
function updateSuccessCriteria(callerState, worldModel) {
  if (callerState.success_criteria.length === 0) return;
  if (!harnessLexicalActive("criterion-scope")) return;
  const criteriaTokens = /* @__PURE__ */ new Set();
  for (const criterion of callerState.success_criteria) {
    for (const tok of criterion.toLowerCase().split(/\s+/)) criteriaTokens.add(tok);
  }
  for (const belief of worldModel.beliefs) {
    const statementTokens = new Set(belief.statement.toLowerCase().split(/\s+/));
    const overlaps = [...statementTokens].some((t) => criteriaTokens.has(t));
    if (!overlaps) {
      worldModel.stale_flags[belief.id] = true;
    }
  }
}
const BlockEntrySchema = objectType({
  dimension: stringType(),
  value: numberType(),
  recovery_action_class: stringType()
});
const ControlStateSchema = objectType({
  generation_id: numberType().int().nonnegative(),
  permission: enumType(["ALLOW", "DENY"]),
  execution_mode: enumType(["NORMAL", "CAUTIOUS", "RECOVERY"]),
  escalation: enumType(["NONE", "HUMAN_REQUIRED", "SYSTEM_BREAKING"]),
  risk_estimate: numberType().min(0).max(1),
  confidence_estimate: numberType().min(0).max(1),
  escalation_reason: stringType().nullable(),
  block_mask: arrayType(BlockEntrySchema),
  notes: arrayType(stringType())
});
class ControlState {
  constructor(data) {
    __publicField(this, "generation_id");
    __publicField(this, "permission");
    __publicField(this, "execution_mode");
    __publicField(this, "escalation");
    __publicField(this, "risk_estimate");
    __publicField(this, "confidence_estimate");
    __publicField(this, "escalation_reason");
    __publicField(this, "block_mask");
    __publicField(this, "notes");
    this.generation_id = (data == null ? void 0 : data.generation_id) ?? 0;
    this.permission = (data == null ? void 0 : data.permission) ?? "ALLOW";
    this.execution_mode = (data == null ? void 0 : data.execution_mode) ?? "NORMAL";
    this.escalation = (data == null ? void 0 : data.escalation) ?? "NONE";
    this.risk_estimate = (data == null ? void 0 : data.risk_estimate) ?? 0;
    this.confidence_estimate = (data == null ? void 0 : data.confidence_estimate) ?? 1;
    this.escalation_reason = (data == null ? void 0 : data.escalation_reason) ?? null;
    this.block_mask = (data == null ? void 0 : data.block_mask) ?? [];
    this.notes = (data == null ? void 0 : data.notes) ?? [];
  }
  stampGenerationId(worldModelGenerationId) {
    this.generation_id = worldModelGenerationId;
  }
  toJSON() {
    return {
      generation_id: this.generation_id,
      permission: this.permission,
      execution_mode: this.execution_mode,
      escalation: this.escalation,
      risk_estimate: this.risk_estimate,
      confidence_estimate: this.confidence_estimate,
      escalation_reason: this.escalation_reason,
      block_mask: this.block_mask,
      notes: this.notes
    };
  }
  static fromJSON(json) {
    const parsed = ControlStateSchema.parse(json);
    return new ControlState(parsed);
  }
}
function riskSummary(cs) {
  if (cs.permission === "DENY") return "BLOCKED";
  if (cs.execution_mode === "CAUTIOUS") return "CAUTIOUS";
  return "NORMAL";
}
const BeliefHealthSchema = objectType({
  freshness: numberType(),
  consistency: numberType(),
  support: numberType()
});
const CoverageHealthSchema = objectType({
  symptom_coverage: numberType(),
  explanation_coverage: numberType()
});
const VerificationHealthSchema = objectType({
  strength: numberType(),
  feasibility: numberType()
});
const ExecutionHealthSchema = objectType({
  progress_rate: numberType(),
  failure_recurrence: numberType(),
  oscillation_score: numberType()
});
const DimensionProvenanceSchema = objectType({
  source: enumType(["deterministic", "model", "heuristic", "default"]).default("deterministic"),
  calibrated: booleanType().default(false),
  evidence_ids: arrayType(stringType()).default([])
});
const DiagnosticsSchema = objectType({
  belief_health: BeliefHealthSchema,
  coverage_health: CoverageHealthSchema,
  verification_health: VerificationHealthSchema,
  execution_health: ExecutionHealthSchema,
  dep_class_gap_annotation: stringType(),
  provenance: recordType(stringType(), DimensionProvenanceSchema).default({})
});
class Diagnostics {
  constructor(data) {
    __publicField(this, "belief_health");
    __publicField(this, "coverage_health");
    __publicField(this, "verification_health");
    __publicField(this, "execution_health");
    __publicField(this, "dep_class_gap_annotation");
    // INV-11: provenance for each of the ten sub-dimension names. May be sparse on
    // construction; ensureProvenance() (called by resolveControlState) fills any missing
    // name with the deterministic default before the resolver reads it.
    __publicField(this, "provenance");
    this.belief_health = (data == null ? void 0 : data.belief_health) ?? { freshness: 1, consistency: 1, support: 1 };
    this.coverage_health = (data == null ? void 0 : data.coverage_health) ?? { symptom_coverage: 0.5, explanation_coverage: 0.5 };
    this.verification_health = (data == null ? void 0 : data.verification_health) ?? { strength: 1, feasibility: 1 };
    this.execution_health = (data == null ? void 0 : data.execution_health) ?? { progress_rate: 1, failure_recurrence: 0, oscillation_score: 0 };
    this.dep_class_gap_annotation = (data == null ? void 0 : data.dep_class_gap_annotation) ?? "";
    this.provenance = (data == null ? void 0 : data.provenance) ?? {};
  }
  toJSON() {
    return {
      belief_health: this.belief_health,
      coverage_health: this.coverage_health,
      verification_health: this.verification_health,
      execution_health: this.execution_health,
      dep_class_gap_annotation: this.dep_class_gap_annotation,
      provenance: this.provenance
    };
  }
  static fromJSON(json) {
    const parsed = DiagnosticsSchema.parse(json);
    return new Diagnostics(parsed);
  }
}
const TaskSchema = objectType({
  id: stringType(),
  description: stringType(),
  status: enumType(["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]),
  risk_level: enumType(["LOW", "MEDIUM", "HIGH"]),
  depends_on: arrayType(stringType()),
  parallel_write_domains: arrayType(stringType()),
  abstraction_level: numberType().int().nonnegative(),
  assigned_strategy: stringType().nullable(),
  block_reason: stringType().optional(),
  /**
   * Hierarchical goal tree fields (Phase 1 of plans/hierarchical_goal_tree_and_steering_plan.html)
   * — schema-only in this phase: nothing produces or consumes these yet (wiring lands Phase 4+),
   * so they're all optional and every existing Task literal/persisted record round-trips unchanged.
   * `node_kind` distinguishes an ordinary work item from a `goal_hypothesis` node — a competing
   * guess at the user's actual intent, per R3. `goal_id` is the stable task→goal parent link (R2)
   * so "which goal does this task belong to" is an O(1) field read, not a graph traversal.
   * `hypothesis_ids` groups a `goal_hypothesis` node with its sibling hypotheses, and
   * `relation_to_siblings` says whether those siblings are competing guesses where resolving one
   * abandons the others (`alternative`), or genuinely separate goals that coexist (`concurrent`).
   */
  node_kind: enumType(["task", "goal_hypothesis"]).optional(),
  goal_id: stringType().nullable().optional(),
  hypothesis_ids: arrayType(stringType()).optional(),
  relation_to_siblings: enumType(["alternative", "concurrent"]).optional()
});
const TaskGraphSchema = objectType({
  tasks: arrayType(TaskSchema),
  conflict_probability_cache: recordType(numberType()),
  changed: booleanType()
});
function makeConflictKey(domainA, domainB) {
  return [domainA, domainB].sort().join("::");
}
class TaskGraph {
  constructor(data) {
    __publicField(this, "tasks");
    __publicField(this, "conflict_probability_cache");
    __publicField(this, "changed");
    this.tasks = (data == null ? void 0 : data.tasks) ?? [];
    this.conflict_probability_cache = (data == null ? void 0 : data.conflict_probability_cache) ?? {};
    this.changed = (data == null ? void 0 : data.changed) ?? false;
  }
  getTask(id2) {
    return this.tasks.find((t) => t.id === id2);
  }
  setStatus(taskId, newStatus, options = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`TaskGraph: task "${taskId}" not found`);
    if (task.status === "COMPLETE") {
      throw new Error(`TaskGraph: task "${taskId}" is in terminal status COMPLETE; no further transitions allowed`);
    }
    if (newStatus === "FAILED" && !options.fromExecutionLayer) {
      throw new Error(`TaskGraph: status FAILED can only be set by the execution layer`);
    }
    task.status = newStatus;
    this.changed = true;
  }
  selectUnblockedLeaf() {
    const taskMap = new Map(this.tasks.map((t) => [t.id, t]));
    const eligible = this.tasks.filter((t) => {
      if (t.status !== "PENDING") return false;
      return t.depends_on.every((depId) => {
        var _a;
        return ((_a = taskMap.get(depId)) == null ? void 0 : _a.status) === "COMPLETE";
      });
    });
    if (eligible.length === 0) return null;
    const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    eligible.sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level]);
    return eligible[0];
  }
  setConflictProbability(domainA, domainB, probability) {
    this.conflict_probability_cache[makeConflictKey(domainA, domainB)] = probability;
  }
  getConflictProbability(domainA, domainB) {
    return this.conflict_probability_cache[makeConflictKey(domainA, domainB)] ?? 0;
  }
  toJSON() {
    return {
      tasks: this.tasks,
      conflict_probability_cache: this.conflict_probability_cache,
      changed: this.changed
    };
  }
  static fromJSON(json) {
    const parsed = TaskGraphSchema.parse(json);
    return new TaskGraph(parsed);
  }
}
const OutputContractSchema = objectType({
  format: stringType(),
  required_sections: arrayType(stringType()),
  required_interface_fields: arrayType(stringType()),
  interface_constraints: recordType(unknownType()),
  validation_rules: arrayType(stringType()),
  caller_specific_constraints: arrayType(stringType())
});
class OutputContract {
  constructor(data) {
    __publicField(this, "format");
    __publicField(this, "required_sections");
    __publicField(this, "required_interface_fields");
    __publicField(this, "interface_constraints");
    __publicField(this, "validation_rules");
    __publicField(this, "caller_specific_constraints");
    this.format = (data == null ? void 0 : data.format) ?? "text";
    this.required_sections = (data == null ? void 0 : data.required_sections) ?? [];
    this.required_interface_fields = (data == null ? void 0 : data.required_interface_fields) ?? [];
    this.interface_constraints = (data == null ? void 0 : data.interface_constraints) ?? {};
    this.validation_rules = (data == null ? void 0 : data.validation_rules) ?? [];
    this.caller_specific_constraints = (data == null ? void 0 : data.caller_specific_constraints) ?? [];
  }
  toJSON() {
    return {
      format: this.format,
      required_sections: this.required_sections,
      required_interface_fields: this.required_interface_fields,
      interface_constraints: this.interface_constraints,
      validation_rules: this.validation_rules,
      caller_specific_constraints: this.caller_specific_constraints
    };
  }
  static fromJSON(json) {
    const parsed = OutputContractSchema.parse(json);
    return new OutputContract(parsed);
  }
}
function updateOutputContract(callerState, outputContract) {
  var _a;
  const newConstraints = [...callerState.current_constraints];
  const requiredFields = [...outputContract.required_interface_fields];
  for (const constraint of newConstraints) {
    const lower = constraint.toLowerCase();
    if (lower.includes("required:")) {
      const parts = constraint.split(":");
      if (parts.length > 1) {
        const rest = parts.slice(1).join(":").trim();
        const fieldCandidate = (_a = rest.split(/\s+/)[0]) == null ? void 0 : _a.replace(/^['"]|['"]$/g, "");
        if (fieldCandidate && !requiredFields.includes(fieldCandidate)) {
          requiredFields.push(fieldCandidate);
        }
      }
    }
  }
  return new OutputContract({
    format: outputContract.format,
    required_sections: [...outputContract.required_sections],
    required_interface_fields: requiredFields,
    interface_constraints: { ...outputContract.interface_constraints },
    validation_rules: [...outputContract.validation_rules],
    caller_specific_constraints: newConstraints
  });
}
const EvidenceTypeSchema = enumType(["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]);
const ReliabilitySchema = enumType(["HIGH", "MEDIUM", "LOW"]);
const EvidenceSchema = objectType({
  id: stringType(),
  obs: stringType(),
  reliability: ReliabilitySchema,
  source: stringType(),
  evidence_type: EvidenceTypeSchema,
  freshness: stringType()
});
const ToolReliabilityEnvelopeSchema = objectType({
  tool: stringType(),
  max_observation_reliability: ReliabilitySchema,
  max_conclusion_reliability: ReliabilitySchema
});
const ToolAvailabilitySchema = objectType({
  available: booleanType(),
  fallback_tool: stringType().nullable()
});
const EvidenceStoreSchema = objectType({
  observations: arrayType(EvidenceSchema),
  tool_reliability_envelopes: recordType(ToolReliabilityEnvelopeSchema),
  tool_availability_manifest: recordType(ToolAvailabilitySchema)
});
class EvidenceStore {
  constructor(data) {
    __publicField(this, "observations");
    __publicField(this, "tool_reliability_envelopes");
    __publicField(this, "tool_availability_manifest");
    this.observations = (data == null ? void 0 : data.observations) ?? [];
    this.tool_reliability_envelopes = (data == null ? void 0 : data.tool_reliability_envelopes) ?? {};
    this.tool_availability_manifest = (data == null ? void 0 : data.tool_availability_manifest) ?? {};
  }
  addObservation(evidence) {
    this.observations.push(evidence);
  }
  isToolAvailable(toolName) {
    var _a;
    return ((_a = this.tool_availability_manifest[toolName]) == null ? void 0 : _a.available) ?? false;
  }
  toJSON() {
    return {
      observations: this.observations,
      tool_reliability_envelopes: this.tool_reliability_envelopes,
      tool_availability_manifest: this.tool_availability_manifest
    };
  }
  static fromJSON(json) {
    const parsed = EvidenceStoreSchema.parse(json);
    return new EvidenceStore(parsed);
  }
}
const HypothesisSchema = objectType({
  id: stringType(),
  explanation: stringType(),
  confidence: numberType(),
  predicted_observations: arrayType(stringType()),
  discriminating_evidence: arrayType(stringType()),
  generation_sources: arrayType(stringType()),
  diversity_score: numberType(),
  /** Semantic hypotheses only: the check or observation that would tell this explanation apart from its rivals. */
  separating_check: stringType().optional()
});
const EliminationPolicySchema = objectType({
  conditions: arrayType(stringType()),
  retention_k: numberType().int().positive(),
  floor: numberType()
});
const HypothesisSetSchema = objectType({
  active: arrayType(HypothesisSchema),
  eliminated: arrayType(HypothesisSchema),
  elimination_policy: EliminationPolicySchema
});
class HypothesisSet {
  constructor(data) {
    __publicField(this, "active");
    __publicField(this, "eliminated");
    __publicField(this, "elimination_policy");
    this.active = (data == null ? void 0 : data.active) ?? [];
    this.eliminated = (data == null ? void 0 : data.eliminated) ?? [];
    this.elimination_policy = (data == null ? void 0 : data.elimination_policy) ?? {
      conditions: ["contradicting_evidence", "prediction_failure_count"],
      retention_k: 10,
      floor: 0.05
    };
  }
  eliminate(hypothesis) {
    this.active = this.active.filter((h) => h.id !== hypothesis.id);
    this.eliminated.push(hypothesis);
    if (this.eliminated.length > this.elimination_policy.retention_k) {
      this.eliminated.splice(0, this.eliminated.length - this.elimination_policy.retention_k);
    }
  }
  toJSON() {
    return {
      active: this.active,
      eliminated: this.eliminated,
      elimination_policy: this.elimination_policy
    };
  }
  static fromJSON(json) {
    const parsed = HypothesisSetSchema.parse(json);
    return new HypothesisSet(parsed);
  }
}
const StructureSchema = objectType({
  id: stringType(),
  description: stringType(),
  token_count: numberType().int().nonnegative()
});
const PrunedRegionSchema = objectType({
  id: stringType(),
  description: stringType(),
  token_count: numberType().int().nonnegative(),
  pruned_at: stringType()
});
const CompressionRiskSchema = objectType({
  compressed_structures: arrayType(StructureSchema),
  pruned_regions: arrayType(PrunedRegionSchema),
  dependent_tasks: arrayType(stringType())
});
const TokenBudgetSchema = objectType({
  total: numberType().int().positive(),
  used: numberType().int().nonnegative()
});
const JournalEntrySchema = objectType({
  step: numberType().int().nonnegative(),
  action_class: stringType(),
  outcome: stringType(),
  verbatim: stringType().optional(),
  success: booleanType()
});
const JournalRetentionPolicySchema = objectType({
  retain_failures_permanently: booleanType(),
  max_passing_verbatim: numberType().int().nonnegative(),
  compress_older_passing: booleanType()
});
const RollbackPointSchema = objectType({
  id: stringType(),
  step: numberType().int().nonnegative(),
  description: stringType(),
  serialised_state: stringType()
});
const MemoryStateSchema = objectType({
  token_budget: TokenBudgetSchema,
  compression_risk: CompressionRiskSchema,
  journal: arrayType(JournalEntrySchema),
  journal_retention_policy: JournalRetentionPolicySchema,
  rollback_points: arrayType(RollbackPointSchema),
  max_steps: numberType().int().positive()
});
class MemoryState {
  constructor(data) {
    __publicField(this, "token_budget");
    __publicField(this, "compression_risk");
    __publicField(this, "journal");
    __publicField(this, "journal_retention_policy");
    __publicField(this, "rollback_points");
    __publicField(this, "max_steps");
    this.token_budget = (data == null ? void 0 : data.token_budget) ?? { total: 2e5, used: 0 };
    this.compression_risk = (data == null ? void 0 : data.compression_risk) ?? {
      compressed_structures: [],
      pruned_regions: [],
      dependent_tasks: []
    };
    this.journal = (data == null ? void 0 : data.journal) ?? [];
    this.journal_retention_policy = (data == null ? void 0 : data.journal_retention_policy) ?? {
      retain_failures_permanently: true,
      max_passing_verbatim: 20,
      compress_older_passing: true
    };
    this.rollback_points = (data == null ? void 0 : data.rollback_points) ?? [];
    this.max_steps = (data == null ? void 0 : data.max_steps) ?? 100;
  }
  action_dep_overlap(actionWriteDomains) {
    const structureIds = new Set(this.compression_risk.compressed_structures.map((s) => s.id));
    const prunedIds = new Set(this.compression_risk.pruned_regions.map((r) => r.id));
    return actionWriteDomains.some((d) => structureIds.has(d) || prunedIds.has(d));
  }
  toJSON() {
    return {
      token_budget: this.token_budget,
      compression_risk: this.compression_risk,
      journal: this.journal,
      journal_retention_policy: this.journal_retention_policy,
      rollback_points: this.rollback_points,
      max_steps: this.max_steps
    };
  }
  static fromJSON(json) {
    const parsed = MemoryStateSchema.parse(json);
    return new MemoryState(parsed);
  }
}
const StrategyTypeSchema = enumType([
  "DIRECT_EDIT",
  "TRACE_EXEC",
  "BROADER_SEARCH",
  "REIMPLEMENT",
  "MINIMAL_FIX",
  "ESCALATE"
]);
const DEFAULT_STRATEGY_ORDER = [
  "DIRECT_EDIT",
  "TRACE_EXEC",
  "BROADER_SEARCH",
  "REIMPLEMENT",
  "MINIMAL_FIX",
  "ESCALATE"
];
function makeFlatWeights() {
  const w = 1 / DEFAULT_STRATEGY_ORDER.length;
  return Object.fromEntries(DEFAULT_STRATEGY_ORDER.map((s) => [s, w]));
}
const StrategyStateSchema = objectType({
  current_strategy: StrategyTypeSchema,
  switch_triggers: arrayType(stringType()),
  prior_strategy_weights: recordType(numberType()),
  recovery_strategy_order: arrayType(StrategyTypeSchema).default(() => [...DEFAULT_STRATEGY_ORDER]),
  switch_count: numberType().int().nonnegative(),
  stall_reason: stringType(),
  completion_history: arrayType(numberType().int().nonnegative()),
  risk_state_history: arrayType(stringType()),
  recovery_was_used: booleanType(),
  last_failure_class: stringType()
});
class StrategyState {
  constructor(data) {
    __publicField(this, "current_strategy");
    __publicField(this, "switch_triggers");
    __publicField(this, "prior_strategy_weights");
    __publicField(this, "recovery_strategy_order");
    __publicField(this, "switch_count");
    __publicField(this, "stall_reason");
    /** Running count of completed tasks recorded each iteration — used by cannot_make_progress() proxy 1. */
    __publicField(this, "completion_history");
    /** Risk state string recorded each iteration — used by cannot_make_progress() proxy 4. */
    __publicField(this, "risk_state_history");
    /** Whether a recovery strategy was used in the current run (P8). */
    __publicField(this, "recovery_was_used");
    /** The failure class that triggered the most recent strategy switch (P8). */
    __publicField(this, "last_failure_class");
    this.current_strategy = (data == null ? void 0 : data.current_strategy) ?? "DIRECT_EDIT";
    this.switch_triggers = (data == null ? void 0 : data.switch_triggers) ?? [];
    this.prior_strategy_weights = (data == null ? void 0 : data.prior_strategy_weights) ?? makeFlatWeights();
    this.recovery_strategy_order = (data == null ? void 0 : data.recovery_strategy_order) ?? [...DEFAULT_STRATEGY_ORDER];
    this.switch_count = (data == null ? void 0 : data.switch_count) ?? 0;
    this.stall_reason = (data == null ? void 0 : data.stall_reason) ?? "";
    this.completion_history = (data == null ? void 0 : data.completion_history) ?? [];
    this.risk_state_history = (data == null ? void 0 : data.risk_state_history) ?? [];
    this.recovery_was_used = (data == null ? void 0 : data.recovery_was_used) ?? false;
    this.last_failure_class = (data == null ? void 0 : data.last_failure_class) ?? "";
  }
  toJSON() {
    return {
      current_strategy: this.current_strategy,
      switch_triggers: this.switch_triggers,
      prior_strategy_weights: this.prior_strategy_weights,
      recovery_strategy_order: this.recovery_strategy_order,
      switch_count: this.switch_count,
      stall_reason: this.stall_reason,
      completion_history: this.completion_history,
      risk_state_history: this.risk_state_history,
      recovery_was_used: this.recovery_was_used,
      last_failure_class: this.last_failure_class
    };
  }
  static fromJSON(json) {
    const parsed = StrategyStateSchema.parse(json);
    return new StrategyState(parsed);
  }
}
const MatchResultSchema = objectType({
  failure_class: stringType(),
  confidence: numberType(),
  matched_pattern: stringType(),
  /** The matched curated entry's preferred recovery strategy, if it named one — see FailureModeEntrySchema.strategy_affinity and rollback-replan.ts's bias. Absent for an entry with none, or a semantic match whose id wasn't found in the library. */
  strategy_affinity: StrategyTypeSchema.optional()
});
const FailureRecordSchema = objectType({
  id: stringType(),
  timestamp: stringType(),
  failure_class: stringType(),
  description: stringType(),
  context: recordType(unknownType())
});
const FailureModeEntrySchema = objectType({
  id: stringType(),
  failure_class: stringType(),
  symptoms: arrayType(stringType()),
  pattern_description: stringType(),
  /**
   * The recovery strategy this failure class responds best to — e.g. a tool being unavailable
   * calls for REIMPLEMENT, not another DIRECT_EDIT attempt. Mirrors adapter/harness/failure_modes.py's
   * FailurePattern.strategy_affinity. Optional so an entry can be diagnostic-only (no lever), and so
   * old persisted entries (from before this field existed) still parse.
   */
  strategy_affinity: StrategyTypeSchema.optional()
});
const DEFAULT_FAILURE_MODE_ENTRIES = [
  {
    id: "circular-dependency",
    failure_class: "CIRCULAR_DEPENDENCY",
    symptoms: ["circular dependency", "depends on itself", "dependency cycle", "blocked on each other"],
    pattern_description: "Two or more tasks/beliefs depend on each other in a cycle, so nothing can complete first.",
    strategy_affinity: "BROADER_SEARCH"
  },
  {
    id: "tool-unavailable-cascade",
    failure_class: "TOOL_UNAVAILABLE_CASCADE",
    symptoms: ["tool unavailable", "service unavailable", "connection refused", "not available", "unreachable", "rate limit exceeded", "too many requests", "request timed out"],
    pattern_description: "The same tool or service (or several) keeps failing to respond — unavailable, overloaded, rate-limited, timing out or unreachable — so repeating the identical call is unlikely to help and a different approach is needed.",
    strategy_affinity: "REIMPLEMENT"
  },
  {
    id: "scope-creep",
    failure_class: "SCOPE_CREEP",
    symptoms: ["scope expanded", "grew beyond", "beyond the original", "more than originally"],
    pattern_description: "The task's write domain grew across iterations — each attempt takes on more than the last.",
    strategy_affinity: "MINIMAL_FIX"
  },
  {
    id: "stale-belief-reliance",
    failure_class: "STALE_BELIEF_RELIANCE",
    symptoms: ["stale belief", "outdated information", "no longer accurate", "no longer current"],
    pattern_description: "A high-confidence belief the plan relies on is flagged stale — its source may no longer reflect reality.",
    strategy_affinity: "TRACE_EXEC"
  }
];
class FailureModeLibrary {
  constructor(entries = [], class_priors = {}) {
    __publicField(this, "entries");
    __publicField(this, "class_priors");
    this.entries = entries;
    this.class_priors = class_priors;
  }
  /** Read-only view of the curated entries — used by a semantic (e.g. LLM-based) matcher layered on top of this class's own substring-overlap match() (see harness-runtime.ts's semanticFailureMatcher). */
  getEntries() {
    return this.entries;
  }
  // Curated `symptoms` are short hand-written phrases, but observed `symptoms` passed in here are
  // free-text (e.g. raw error messages) that will almost never equal a curated phrase byte-for-byte —
  // so matching has to look for the curated phrase *within* the free text (or vice versa), case-insensitively.
  // Mirrors adapter/harness/failure_modes.py's FailureModeLibrary.match(), which does the same via
  // substring containment against a joined free-text context blob.
  match(symptoms) {
    if (!harnessLexicalActive("failure-exact-match")) return null;
    let best = null;
    let bestScore = -1;
    for (const entry of this.entries) {
      const overlap = entry.symptoms.filter(
        (curated) => curated.length > 0 && symptoms.some(
          (s) => s.toLowerCase().includes(curated.toLowerCase()) || curated.toLowerCase().includes(s.toLowerCase())
        )
      ).length;
      if (overlap > 0) {
        const confidence = overlap / Math.max(entry.symptoms.length, symptoms.length);
        if (confidence > bestScore) {
          bestScore = confidence;
          best = { failure_class: entry.failure_class, confidence, matched_pattern: entry.id, strategy_affinity: entry.strategy_affinity };
        }
      }
    }
    return best;
  }
  toJSON() {
    return { entries: this.entries, class_priors: this.class_priors };
  }
}
function resolveSemanticMatchStrategy(semanticMatch, entries) {
  var _a;
  return (_a = entries.find((e) => e.id === semanticMatch.matched_pattern)) == null ? void 0 : _a.strategy_affinity;
}
const FailureDiagnosticsSchema = objectType({
  matched_pattern: MatchResultSchema.nullable(),
  failure_history: arrayType(FailureRecordSchema),
  failure_mode_library_data: objectType({
    entries: arrayType(FailureModeEntrySchema),
    class_priors: recordType(numberType())
  })
});
class FailureDiagnostics {
  constructor(data) {
    __publicField(this, "failure_mode_library");
    __publicField(this, "matched_pattern");
    __publicField(this, "failure_history");
    this.failure_mode_library = (data == null ? void 0 : data.failure_mode_library) ?? new FailureModeLibrary();
    this.matched_pattern = (data == null ? void 0 : data.matched_pattern) ?? null;
    this.failure_history = (data == null ? void 0 : data.failure_history) ?? [];
  }
  recordFailure(record) {
    this.failure_history.push(record);
  }
  toJSON() {
    return {
      matched_pattern: this.matched_pattern,
      failure_history: this.failure_history,
      failure_mode_library_data: this.failure_mode_library.toJSON()
    };
  }
  static fromJSON(json) {
    const parsed = FailureDiagnosticsSchema.parse(json);
    const library = new FailureModeLibrary(
      parsed.failure_mode_library_data.entries,
      parsed.failure_mode_library_data.class_priors
    );
    return new FailureDiagnostics({
      failure_mode_library: library,
      matched_pattern: parsed.matched_pattern,
      failure_history: parsed.failure_history
    });
  }
}
const EXPERIENCE_STORE_SCHEMA_VERSION = 1;
class InMemoryExperienceStore {
  constructor() {
    __publicField(this, "_strategyWeights", {});
    __publicField(this, "_strategyEvidence", {});
    __publicField(this, "_classPriors", {});
    __publicField(this, "_decompositions", []);
    __publicField(this, "_toolWorkflows", []);
    __publicField(this, "_verificationPlans", []);
    __publicField(this, "_recoverySequences", []);
    __publicField(this, "_runs", /* @__PURE__ */ new Map());
  }
  get available() {
    return true;
  }
  getStrategyWeights() {
    return { ...this._strategyWeights };
  }
  setStrategyWeight(key, weight) {
    this._strategyWeights[key] = weight;
  }
  getStrategyEvidence() {
    return { ...this._strategyEvidence };
  }
  setStrategyEvidence(key, evidence) {
    this._strategyEvidence[key] = evidence;
  }
  getClassPriors() {
    return { ...this._classPriors };
  }
  setClassPrior(failureClass, prior) {
    this._classPriors[failureClass] = prior;
  }
  getDecompositions() {
    return [...this._decompositions];
  }
  addDecomposition(entry) {
    this._decompositions.push(entry);
  }
  getToolWorkflows() {
    return [...this._toolWorkflows];
  }
  addToolWorkflow(entry) {
    this._toolWorkflows.push(entry);
  }
  getVerificationPlans() {
    return [...this._verificationPlans];
  }
  addVerificationPlan(entry) {
    this._verificationPlans.push(entry);
  }
  getRecoverySequences() {
    return [...this._recoverySequences];
  }
  addRecoverySequence(entry) {
    this._recoverySequences.push(entry);
  }
  updateExperienceStore(runId, outcome) {
    this._runs.set(runId, outcome);
  }
  toJSON() {
    return {
      strategy_weights: { ...this._strategyWeights },
      class_priors: { ...this._classPriors },
      strategy_evidence: { ...this._strategyEvidence },
      decompositions: [...this._decompositions],
      tool_workflows: [...this._toolWorkflows],
      verification_plans: [...this._verificationPlans],
      recovery_sequences: [...this._recoverySequences],
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION
    };
  }
  /**
   * Never throws. Experience data is optional cross-run learning, not correctness-critical
   * state (see the harness's "learning must never be on the critical correctness path"
   * principle) — an unreadable or newer-than-known snapshot degrades to a fresh, empty
   * store the same way an unavailable store already does, rather than crashing whatever
   * called fromJSON(). Each field defaults independently so a partially-shaped legacy
   * blob keeps whatever parts of it still parse instead of being discarded wholesale.
   */
  static fromJSON(json) {
    const store = new InMemoryExperienceStore();
    if (!json || typeof json !== "object") return store;
    if ((json.schemaVersion ?? EXPERIENCE_STORE_SCHEMA_VERSION) > EXPERIENCE_STORE_SCHEMA_VERSION) {
      console.warn(
        `InMemoryExperienceStore.fromJSON: schemaVersion ${json.schemaVersion} is newer than this build understands (current: ${EXPERIENCE_STORE_SCHEMA_VERSION}) — starting from a fresh store instead of misreading it.`
      );
      return store;
    }
    store._strategyWeights = json.strategy_weights ? { ...json.strategy_weights } : {};
    store._strategyEvidence = json.strategy_evidence && typeof json.strategy_evidence === "object" ? { ...json.strategy_evidence } : {};
    store._classPriors = json.class_priors ? { ...json.class_priors } : {};
    store._decompositions = Array.isArray(json.decompositions) ? [...json.decompositions] : [];
    store._toolWorkflows = Array.isArray(json.tool_workflows) ? [...json.tool_workflows] : [];
    store._verificationPlans = Array.isArray(json.verification_plans) ? [...json.verification_plans] : [];
    store._recoverySequences = Array.isArray(json.recovery_sequences) ? [...json.recovery_sequences] : [];
    return store;
  }
}
class UnavailableExperienceStore {
  get available() {
    return false;
  }
  getStrategyWeights() {
    return {};
  }
  setStrategyWeight() {
  }
  getStrategyEvidence() {
    return {};
  }
  setStrategyEvidence() {
  }
  getClassPriors() {
    return {};
  }
  setClassPrior() {
  }
  getDecompositions() {
    return [];
  }
  addDecomposition() {
  }
  getToolWorkflows() {
    return [];
  }
  addToolWorkflow() {
  }
  getVerificationPlans() {
    return [];
  }
  addVerificationPlan() {
  }
  getRecoverySequences() {
    return [];
  }
  addRecoverySequence() {
  }
  updateExperienceStore() {
  }
  toJSON() {
    return {
      strategy_weights: {},
      class_priors: {},
      strategy_evidence: {},
      decompositions: [],
      tool_workflows: [],
      verification_plans: [],
      recovery_sequences: [],
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION
    };
  }
}
const BudgetSchema = objectType({
  maxCalls: numberType().nonnegative(),
  maxCost: numberType().nonnegative(),
  maxTime: numberType().nonnegative(),
  maxParallelism: numberType().nonnegative(),
  callsUsed: numberType().nonnegative(),
  costUsed: numberType().nonnegative(),
  timeUsed: numberType().nonnegative(),
  parallelismUsed: numberType().nonnegative()
});
class Budget {
  constructor(data) {
    __publicField(this, "maxCalls");
    __publicField(this, "maxCost");
    __publicField(this, "maxTime");
    __publicField(this, "maxParallelism");
    __publicField(this, "callsUsed");
    __publicField(this, "costUsed");
    __publicField(this, "timeUsed");
    __publicField(this, "parallelismUsed");
    this.maxCalls = (data == null ? void 0 : data.maxCalls) ?? Infinity;
    this.maxCost = (data == null ? void 0 : data.maxCost) ?? Infinity;
    this.maxTime = (data == null ? void 0 : data.maxTime) ?? Infinity;
    this.maxParallelism = (data == null ? void 0 : data.maxParallelism) ?? Infinity;
    this.callsUsed = (data == null ? void 0 : data.callsUsed) ?? 0;
    this.costUsed = (data == null ? void 0 : data.costUsed) ?? 0;
    this.timeUsed = (data == null ? void 0 : data.timeUsed) ?? 0;
    this.parallelismUsed = (data == null ? void 0 : data.parallelismUsed) ?? 0;
  }
  /** Any single exhausted dimension exhausts the whole budget — same OR-of-thresholds rule
   * as RecoveryBudget.is_exhausted(), for the same reason: a budget generous on cost but out
   * of calls shouldn't be treated as still usable. */
  isExhausted() {
    return this.callsUsed >= this.maxCalls || this.costUsed >= this.maxCost || this.timeUsed >= this.maxTime || this.parallelismUsed >= this.maxParallelism;
  }
  /** Remaining room on one dimension, floored at 0 (never negative). */
  remaining(dimension) {
    switch (dimension) {
      case "calls":
        return Math.max(0, this.maxCalls - this.callsUsed);
      case "cost":
        return Math.max(0, this.maxCost - this.costUsed);
      case "time":
        return Math.max(0, this.maxTime - this.timeUsed);
      case "parallelism":
        return Math.max(0, this.maxParallelism - this.parallelismUsed);
    }
  }
  /** Returns a new Budget with the given deltas added to the used counters — immutable, like
   * RecoveryBudget.consume(). */
  consume(delta) {
    return new Budget({
      maxCalls: this.maxCalls,
      maxCost: this.maxCost,
      maxTime: this.maxTime,
      maxParallelism: this.maxParallelism,
      callsUsed: this.callsUsed + (delta.calls ?? 0),
      costUsed: this.costUsed + (delta.cost ?? 0),
      timeUsed: this.timeUsed + (delta.time ?? 0),
      parallelismUsed: this.parallelismUsed + (delta.parallelism ?? 0)
    });
  }
  toJSON() {
    return {
      maxCalls: this.maxCalls,
      maxCost: this.maxCost,
      maxTime: this.maxTime,
      maxParallelism: this.maxParallelism,
      callsUsed: this.callsUsed,
      costUsed: this.costUsed,
      timeUsed: this.timeUsed,
      parallelismUsed: this.parallelismUsed
    };
  }
  static fromJSON(json) {
    return new Budget(json);
  }
}
var DimensionType = /* @__PURE__ */ ((DimensionType2) => {
  DimensionType2["ratio"] = "ratio";
  DimensionType2["composite"] = "composite";
  DimensionType2["entropy"] = "entropy";
  DimensionType2["match_confidence"] = "match_confidence";
  return DimensionType2;
})(DimensionType || {});
class NormalisationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NormalisationError";
  }
}
function normalise(raw, type) {
  switch (type) {
    case "ratio":
    case "match_confidence":
      return Math.max(0, Math.min(1, raw));
    case "composite": {
      const { components, weights } = raw;
      const sumWeights = weights.reduce((a, b) => a + b, 0);
      if (sumWeights === 0) return 0;
      const weightedSum = components.reduce((acc, c, i) => acc + c * (weights[i] ?? 0), 0);
      return Math.max(0, Math.min(1, weightedSum / sumWeights));
    }
    case "entropy": {
      const counts = raw;
      const numSources = counts.length;
      if (numSources <= 1) return 0;
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) return 0;
      const probs = counts.map((c) => c / total);
      const entropy = -probs.filter((p) => p > 0).reduce((acc, p) => acc + p * Math.log2(p), 0);
      const maxEntropy = Math.log2(numSources);
      return Math.max(0, Math.min(1, entropy / maxEntropy));
    }
  }
}
function assertNormalised(value, label) {
  if (value < 0 || value > 1) {
    throw new NormalisationError(`assertNormalised: "${label}" = ${value} is outside [0, 1]`);
  }
}
const CRITICAL_THRESHOLD = 0.2;
const CAUTION_THRESHOLD = 0.4;
const EXECUTION_RATIO_MIN_ATTEMPTS = 3;
const RECOVERY_ACTION_DEPENDENCIES = {
  "dep_graph_refresh": ["verification_strength"],
  "verification_pass": ["dep_graph_quality"],
  "belief_refresh": ["verification_feasibility"],
  "coverage_expand": ["verification_strength"],
  "execution_retry": ["dep_graph_quality"],
  "oscillation_stabilise": ["belief_freshness"],
  "failure_recovery": ["dep_graph_quality"],
  "consistency_repair": ["verification_strength"],
  "support_augment": ["belief_freshness"],
  "feasibility_check": ["dep_graph_quality"],
  "explanation_expand": ["belief_freshness"]
};
const DIMENSION_RECOVERY = {
  "belief_freshness": "belief_refresh",
  "belief_consistency": "consistency_repair",
  "belief_support": "support_augment",
  "symptom_coverage": "coverage_expand",
  "explanation_coverage": "explanation_expand",
  "verification_strength": "verification_pass",
  "verification_feasibility": "feasibility_check",
  "progress_rate": "execution_retry",
  "failure_recurrence": "failure_recovery",
  "oscillation_score": "oscillation_stabilise",
  "dep_graph_quality": "dep_graph_refresh",
  "world_model_integrity": "consistency_repair"
};
const CONFIDENCE_DIMENSIONS = /* @__PURE__ */ new Set(["belief_freshness", "belief_consistency", "belief_support", "symptom_coverage", "explanation_coverage"]);
const RISK_DIMENSIONS = /* @__PURE__ */ new Set(["verification_strength", "verification_feasibility", "progress_rate", "failure_recurrence", "oscillation_score"]);
const LAYER_TIER = {
  "syntax": "mechanical",
  "unit": "mechanical",
  "integration": "mechanical",
  "consistency": "mechanical",
  "requirements": "environmental",
  "assumptions": "environmental",
  "goal_correctness": "model",
  "evidence_sufficiency": "environmental",
  "output_contract_partial": "mechanical"
};
const DEP_CLASS_GAP_NOTE_PREFIX = "dep_class_gap: ";
const MODEL_PROVENANCE_NOTE_PREFIX = "provenance: uncalibrated model-derived value drove block on ";
const RECOVERY_CLASSIFICATION_TABLE = {
  "timeout": { policy: "retry_with_backoff", action: "execution_retry" },
  "transient_tool_error": { policy: "retry_with_backoff", action: "execution_retry" },
  "missing_evidence": { policy: "gather_evidence", action: "coverage_expand" },
  "insufficient_context": { policy: "gather_evidence", action: "belief_refresh" },
  "permission_denied": { policy: "surface_to_human", action: "escalate" },
  "approval_required": { policy: "surface_to_human", action: "escalate" },
  "unsafe_state": { policy: "terminate_objective", action: "escalation_halt" },
  "system_breaking": { policy: "terminate_objective", action: "escalation_halt" },
  "tool_unreliable": { policy: "switch_method", action: "dep_graph_refresh" },
  "contradiction": { policy: "refresh_beliefs", action: "consistency_repair" },
  "stall": { policy: "replan", action: "replan" },
  "no_progress": { policy: "replan", action: "replan" }
};
class StalenessError extends Error {
  constructor(message) {
    super(message);
    this.name = "StalenessError";
  }
}
function _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver) {
  if (controlState.generation_id >= worldModel.generation_id) return;
  if (!diagnostics || !resolver) {
    throw new StalenessError(
      `ControlState generation_id (${controlState.generation_id}) is stale relative to WorldModel (${worldModel.generation_id})`
    );
  }
  const fd = failureDiagnostics ?? new FailureDiagnostics();
  const resolved = resolver(diagnostics, worldModel, fd);
  controlState.generation_id = resolved.generation_id;
  controlState.permission = resolved.permission;
  controlState.execution_mode = resolved.execution_mode;
  controlState.escalation = resolved.escalation;
  controlState.risk_estimate = resolved.risk_estimate;
  controlState.confidence_estimate = resolved.confidence_estimate;
  controlState.escalation_reason = resolved.escalation_reason;
  controlState.block_mask = [...resolved.block_mask];
  controlState.notes = [...resolved.notes];
  if (controlState.generation_id < worldModel.generation_id) {
    throw new StalenessError(
      `ControlState still stale after one resolution attempt (generation_id=${controlState.generation_id}, worldModel.generation_id=${worldModel.generation_id})`
    );
  }
}
function computeElevationFactor(subDims) {
  if (subDims.length === 0) return 0;
  const below = subDims.filter((d) => d < CAUTION_THRESHOLD);
  if (below.length === 0) return 0;
  const avgDeficit = below.reduce((acc, d) => acc + (CAUTION_THRESHOLD - d), 0) / below.length;
  return Math.min(1, avgDeficit / CAUTION_THRESHOLD);
}
class HarnessRunState {
  constructor(data) {
    __publicField(this, "worldModel");
    __publicField(this, "callerState");
    __publicField(this, "controlState");
    __publicField(this, "diagnostics");
    __publicField(this, "taskGraph");
    __publicField(this, "outputContract");
    __publicField(this, "evidenceStore");
    __publicField(this, "hypothesisSet");
    __publicField(this, "memoryState");
    __publicField(this, "strategyState");
    __publicField(this, "failureDiagnostics");
    __publicField(this, "experienceStore");
    __publicField(this, "beliefDepGraph");
    this.worldModel = (data == null ? void 0 : data.worldModel) ?? new WorldModel();
    this.callerState = (data == null ? void 0 : data.callerState) ?? new CallerState();
    this.controlState = (data == null ? void 0 : data.controlState) ?? new ControlState();
    this.diagnostics = (data == null ? void 0 : data.diagnostics) ?? new Diagnostics();
    this.taskGraph = (data == null ? void 0 : data.taskGraph) ?? new TaskGraph();
    this.outputContract = (data == null ? void 0 : data.outputContract) ?? new OutputContract();
    this.evidenceStore = (data == null ? void 0 : data.evidenceStore) ?? new EvidenceStore();
    this.hypothesisSet = (data == null ? void 0 : data.hypothesisSet) ?? new HypothesisSet();
    this.memoryState = (data == null ? void 0 : data.memoryState) ?? new MemoryState();
    this.strategyState = (data == null ? void 0 : data.strategyState) ?? new StrategyState();
    this.failureDiagnostics = (data == null ? void 0 : data.failureDiagnostics) ?? new FailureDiagnostics();
    this.experienceStore = (data == null ? void 0 : data.experienceStore) ?? new InMemoryExperienceStore();
    this.beliefDepGraph = (data == null ? void 0 : data.beliefDepGraph) ?? new BeliefDepGraph();
  }
  toJSON() {
    return {
      worldModel: this.worldModel.toJSON(),
      callerState: this.callerState.toJSON(),
      controlState: this.controlState.toJSON(),
      diagnostics: this.diagnostics.toJSON(),
      taskGraph: this.taskGraph.toJSON(),
      outputContract: this.outputContract.toJSON(),
      evidenceStore: this.evidenceStore.toJSON(),
      hypothesisSet: this.hypothesisSet.toJSON(),
      memoryState: this.memoryState.toJSON(),
      strategyState: this.strategyState.toJSON(),
      failureDiagnostics: this.failureDiagnostics.toJSON(),
      experienceStore: this.experienceStore.toJSON(),
      beliefDepGraph: this.beliefDepGraph.toJSON()
    };
  }
  static fromJSON(json) {
    return new HarnessRunState({
      worldModel: WorldModel.fromJSON(json.worldModel),
      callerState: CallerState.fromJSON(json.callerState),
      controlState: ControlState.fromJSON(json.controlState),
      diagnostics: Diagnostics.fromJSON(json.diagnostics),
      taskGraph: TaskGraph.fromJSON(json.taskGraph),
      outputContract: OutputContract.fromJSON(json.outputContract),
      evidenceStore: EvidenceStore.fromJSON(json.evidenceStore),
      hypothesisSet: HypothesisSet.fromJSON(json.hypothesisSet),
      memoryState: MemoryState.fromJSON(json.memoryState),
      strategyState: StrategyState.fromJSON(json.strategyState),
      failureDiagnostics: FailureDiagnostics.fromJSON(json.failureDiagnostics),
      experienceStore: InMemoryExperienceStore.fromJSON(json.experienceStore),
      beliefDepGraph: BeliefDepGraph.fromJSON(json.beliefDepGraph)
    });
  }
}
const CHECKPOINT_SCHEMA_VERSION = 2;
const CHECKPOINT_MIGRATIONS = {
  // v1 → v2 (Phase D1): PendingProposalData.kind became required. A v1 pendingProposal
  // predates the 'continuation' concept entirely, so it was always a fresh 'proposal'.
  1: (raw) => {
    const legacyProposal = raw.progress.pendingProposal;
    return {
      ...raw,
      progress: {
        ...raw.progress,
        pendingProposal: legacyProposal ? { ...legacyProposal, kind: "proposal" } : legacyProposal ?? null
      },
      schemaVersion: 2
    };
  }
};
class CheckpointSchemaError extends Error {
  constructor(foundVersion, currentVersion) {
    super(
      foundVersion > currentVersion ? `Checkpoint schema version ${foundVersion} is newer than this build understands (current: ${currentVersion}). Refusing to read it rather than silently misinterpreting its shape.` : `Checkpoint schema version ${foundVersion} has no migration path to ${currentVersion}. Refusing to read it rather than letting a stale-shape read throw deep inside a state structure's fromJSON().`
    );
    this.foundVersion = foundVersion;
    this.currentVersion = currentVersion;
    this.name = "CheckpointSchemaError";
  }
}
function readCheckpointSchemaVersion(checkpoint) {
  return checkpoint.schemaVersion ?? 1;
}
function assertCheckpointSchemaCurrent(checkpoint) {
  let current = checkpoint;
  let version = readCheckpointSchemaVersion(current);
  while (version < CHECKPOINT_SCHEMA_VERSION) {
    const migrate = CHECKPOINT_MIGRATIONS[version];
    if (!migrate) throw new CheckpointSchemaError(version, CHECKPOINT_SCHEMA_VERSION);
    current = migrate(current);
    version = readCheckpointSchemaVersion(current);
  }
  if (version > CHECKPOINT_SCHEMA_VERSION) throw new CheckpointSchemaError(version, CHECKPOINT_SCHEMA_VERSION);
  return current;
}
const checkpointKey = (runId) => `harness-checkpoint:${runId}`;
async function saveHarnessCheckpoint(store, checkpoint) {
  await store.set(checkpointKey(checkpoint.runId), checkpoint);
}
async function loadHarnessCheckpoint(store, runId) {
  const value = await store.get(checkpointKey(runId));
  if (value === void 0) return void 0;
  try {
    return assertCheckpointSchemaCurrent(value);
  } catch (err) {
    if (!(err instanceof CheckpointSchemaError)) throw err;
    console.warn(`loadHarnessCheckpoint: discarding unreadable checkpoint for runId="${runId}": ${err.message}`);
    await store.delete(checkpointKey(runId));
    return void 0;
  }
}
async function deleteHarnessCheckpoint(store, runId) {
  await store.delete(checkpointKey(runId));
}
function gatherEvidence(input, evidenceStore, onWarning) {
  if (!evidenceStore.isToolAvailable(input.source)) {
    onWarning == null ? void 0 : onWarning(`gatherEvidence: tool "${input.source}" unavailable; no evidence collected`);
    return void 0;
  }
  const reliability = input.evidence_type === "SYSTEM_ERROR" ? "HIGH" : input.reliability ?? "MEDIUM";
  const evidence = {
    id: input.id,
    obs: input.obs,
    reliability,
    source: input.source,
    evidence_type: input.evidence_type,
    freshness: input.freshness ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  evidenceStore.addObservation(evidence);
  return evidence;
}
const RELIABILITY_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 };
const RANK_TO_RELIABILITY = ["LOW", "MEDIUM", "HIGH"];
function applyToolReliability(evidence, evidenceStore, diagnostics) {
  const envelope = evidenceStore.tool_reliability_envelopes[evidence.source];
  let cappedReliability = evidence.reliability;
  if (envelope) {
    const maxRank = RELIABILITY_RANK[envelope.max_conclusion_reliability];
    const evidenceRank = RELIABILITY_RANK[evidence.reliability];
    if (evidenceRank > maxRank) {
      cappedReliability = RANK_TO_RELIABILITY[maxRank];
    }
  }
  const envelopes = Object.values(evidenceStore.tool_reliability_envelopes);
  const lowCount = envelopes.filter((e) => e.max_conclusion_reliability === "LOW").length;
  const total = envelopes.length;
  const gapRatio = total > 0 ? lowCount / total : 0;
  diagnostics.verification_health.feasibility = normalise(1 - gapRatio, DimensionType.ratio);
  return { ...evidence, reliability: cappedReliability };
}
function reliabilityToFloat(r) {
  if (r === "HIGH") return 1;
  if (r === "MEDIUM") return 0.5;
  return 0;
}
function updateWorldModel(evidence, worldModel, diagnostics, beliefInput, regionKey, prune) {
  const type = evidence.evidence_type;
  if (type === "OBSERVATION" || type === "SYSTEM_ERROR") {
    worldModel.observations.push({
      id: evidence.id,
      content: evidence.obs,
      source: evidence.source,
      recorded_at: evidence.freshness
    });
    const key = regionKey ?? evidence.source;
    worldModel.completeness_flags[key] = prune !== true;
  } else if (type === "INFERENCE") {
    const belief = {
      id: (beliefInput == null ? void 0 : beliefInput.id) ?? evidence.id,
      statement: (beliefInput == null ? void 0 : beliefInput.statement) ?? evidence.obs,
      confidence: reliabilityToFloat(evidence.reliability),
      supporting_evidence: [],
      reliability: "",
      derived_from: (beliefInput == null ? void 0 : beliefInput.derived_from) ?? [],
      recorded_at: evidence.freshness
    };
    worldModel.addBelief(belief);
    if (regionKey) {
      worldModel.completeness_flags[regionKey] = prune !== true;
    }
  }
  recomputeBeliefHealth(worldModel, diagnostics);
  worldModel.incrementGenerationId();
}
function recomputeBeliefHealth(worldModel, diagnostics) {
  const staleValues = Object.values(worldModel.stale_flags);
  const beliefCountForStaleness = Math.max(1, worldModel.beliefs.length);
  const staleFlagRatio = staleValues.filter(Boolean).length / beliefCountForStaleness;
  diagnostics.belief_health.freshness = normalise(1 - staleFlagRatio, DimensionType.ratio);
  const contradictionDensity = worldModel.beliefs.length > 0 ? Math.min(1, worldModel.contradictions.length / worldModel.beliefs.length) : 0;
  diagnostics.belief_health.consistency = normalise(1 - contradictionDensity, DimensionType.ratio);
  const meanSupport = worldModel.beliefs.length > 0 ? worldModel.beliefs.reduce((acc, b) => acc + b.confidence, 0) / worldModel.beliefs.length : 1;
  diagnostics.belief_health.support = normalise(meanSupport, DimensionType.ratio);
}
function propagateBeliefs(beliefDepGraph, depGraphBudget, _worldModel) {
  for (const edge of beliefDepGraph.derived_from_edges) {
    if (edge.confidence < 1) {
      const sourceNode = beliefDepGraph.belief_nodes.find((n) => n.belief_id === edge.from);
      const targetNode = beliefDepGraph.belief_nodes.find((n) => n.belief_id === edge.to);
      if (sourceNode && targetNode) {
        targetNode.confidence = Math.max(0, Math.min(
          targetNode.confidence,
          sourceNode.confidence * edge.confidence
        ));
      }
    }
  }
  beliefDepGraph.recomputeUnverifiedEdgeRatio();
  if (beliefDepGraph.unverified_edge_ratio > depGraphBudget.max_unverified_edge_ratio) {
    const frontier = new Set(beliefDepGraph.invalidation_frontier);
    const toAdd = [];
    for (const edge of beliefDepGraph.derived_from_edges) {
      if (frontier.has(edge.from) && !frontier.has(edge.to)) {
        toAdd.push(edge.to);
      }
    }
    for (const nodeId of toAdd) {
      beliefDepGraph.invalidation_frontier.push(nodeId);
      frontier.add(nodeId);
    }
  }
}
const en$1 = {
  stopwords: [
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "in",
    "at"
  ],
  pairs: [
    [
      "present",
      "absent"
    ],
    [
      "true",
      "false"
    ],
    [
      "exists",
      "missing"
    ],
    [
      "success",
      "failure"
    ],
    [
      "available",
      "unavailable"
    ],
    [
      "enabled",
      "disabled"
    ],
    [
      "found",
      "not found"
    ],
    [
      "is",
      "is not"
    ],
    [
      "passed",
      "failed"
    ],
    [
      "passing",
      "failing"
    ],
    [
      "running",
      "stopped"
    ],
    [
      "online",
      "offline"
    ]
  ],
  polarityWords: [
    "not",
    "absent",
    "no"
  ],
  reviewStopwords: [
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "in",
    "at",
    "to",
    "of",
    "and"
  ],
  reviewTriggers: [
    "not ",
    "removes ",
    "remove ",
    "delete ",
    "revert ",
    "contradicts ",
    "negate ",
    "negates ",
    "no longer "
  ],
  evidenceNegationWords: [
    "no",
    "not",
    "absent",
    "missing",
    "failed",
    "none",
    "error",
    "unavailable"
  ],
  constraintNegationWords: [
    "not",
    "never",
    "no",
    "without",
    "exclude",
    "must not"
  ]
};
const zh$1 = {
  stopwords: [
    "的",
    "是",
    "在",
    "了",
    "和",
    "与",
    "都",
    "也",
    "就",
    "还",
    "而",
    "对"
  ],
  pairs: [
    [
      "存在",
      "不存在"
    ],
    [
      "真",
      "假"
    ],
    [
      "具备",
      "缺失"
    ],
    [
      "成功",
      "失败"
    ],
    [
      "可用",
      "不可用"
    ],
    [
      "启用",
      "禁用"
    ],
    [
      "找到",
      "未找到"
    ],
    [
      "是",
      "不是"
    ],
    [
      "通过",
      "失败"
    ],
    [
      "通过",
      "不通过"
    ],
    [
      "运行中",
      "已停止"
    ],
    [
      "在线",
      "离线"
    ]
  ],
  polarityWords: [
    "不",
    "没",
    "无",
    "否",
    "未"
  ],
  reviewStopwords: [
    "的",
    "是",
    "在",
    "了",
    "和",
    "与",
    "都",
    "也",
    "就",
    "还",
    "而",
    "对",
    "把",
    "被",
    "从",
    "到",
    "为",
    "之"
  ],
  reviewTriggers: [
    "删除",
    "移除",
    "撤销",
    "回撤",
    "取消",
    "恢复"
  ],
  evidenceNegationWords: [
    "无",
    "不",
    "没有",
    "缺失",
    "失败",
    "错误",
    "不可用"
  ],
  constraintNegationWords: [
    "不",
    "从不",
    "没有",
    "排除",
    "禁止",
    "不得",
    "切勿"
  ]
};
const negationData = {
  en: en$1,
  zh: zh$1
};
const en = {
  statementLevelMarkers: [
    "line ",
    "line	",
    ":line",
    " ln ",
    " l",
    "column ",
    "char ",
    "line:",
    "statement",
    "expression",
    "lineno"
  ],
  functionLevelMarkers: [
    "function",
    "method",
    "def ",
    "procedure",
    "()"
  ]
};
const zh = {
  statementLevelMarkers: [
    "行号",
    "语句",
    "表达式",
    "字符",
    "列"
  ],
  functionLevelMarkers: [
    "函数",
    "方法",
    "过程"
  ]
};
const granularityData = {
  en,
  zh
};
function mergeAcrossLanguages(data) {
  const merged = {
    stopwords: [],
    pairs: [],
    polarityWords: [],
    reviewStopwords: [],
    reviewTriggers: [],
    evidenceNegationWords: [],
    constraintNegationWords: []
  };
  for (const lang of Object.values(data)) {
    merged.stopwords.push(...lang.stopwords);
    merged.pairs.push(...lang.pairs);
    merged.polarityWords.push(...lang.polarityWords);
    merged.reviewStopwords.push(...lang.reviewStopwords);
    merged.reviewTriggers.push(...lang.reviewTriggers);
    merged.evidenceNegationWords.push(...lang.evidenceNegationWords);
    merged.constraintNegationWords.push(...lang.constraintNegationWords);
  }
  return merged;
}
const negation = mergeAcrossLanguages(negationData);
function getNegationPairs() {
  return { pairs: negation.pairs, stopwords: new Set(negation.stopwords), polarityWords: negation.polarityWords };
}
function getReviewNegationTriggers() {
  return { triggers: negation.reviewTriggers, stopwords: new Set(negation.reviewStopwords) };
}
function getConstraintNegationWords() {
  return new Set(negation.constraintNegationWords);
}
function mergeGranularityAcrossLanguages(data) {
  const merged = { statementLevelMarkers: [], functionLevelMarkers: [] };
  for (const lang of Object.values(data)) {
    merged.statementLevelMarkers.push(...lang.statementLevelMarkers);
    merged.functionLevelMarkers.push(...lang.functionLevelMarkers);
  }
  return merged;
}
const granularity = mergeGranularityAcrossLanguages(granularityData);
function getGranularityMarkers() {
  return { statementLevelMarkers: granularity.statementLevelMarkers, functionLevelMarkers: granularity.functionLevelMarkers };
}
const { pairs: NEGATION_PAIRS, stopwords: STOPWORDS, polarityWords: POLARITY_WORDS } = getNegationPairs();
function statementsOpposed(stmtA, stmtB) {
  const a = stmtA.toLowerCase();
  const b = stmtB.toLowerCase();
  const common = sharedTokens(a, b, STOPWORDS);
  if (common.length === 0) return false;
  for (const [pos, neg] of NEGATION_PAIRS) {
    if (a.includes(pos) && b.includes(neg)) return true;
    if (a.includes(neg) && b.includes(pos)) return true;
  }
  const wordsA = new Set(tokenize$1(a));
  const wordsB = new Set(tokenize$1(b));
  for (const word of POLARITY_WORDS) {
    if (wordsA.has(word) !== wordsB.has(word)) return true;
  }
  return false;
}
function confidenceToClass(confidence) {
  if (confidence >= 0.8) return "HIGH";
  if (confidence >= 0.5) return "MEDIUM";
  return "LOW";
}
let uidCounter = 0;
function makeId() {
  uidCounter += 1;
  return `c-${Date.now().toString(36)}-${uidCounter}`;
}
function detectPairwiseContradictions(beliefs) {
  const results = [];
  for (let i = 0; i < beliefs.length; i++) {
    for (let j = i + 1; j < beliefs.length; j++) {
      const bA = beliefs[i];
      const bB = beliefs[j];
      if (!statementsOpposed(bA.statement, bB.statement)) continue;
      if (bA.confidence < 0.5 && bB.confidence < 0.5) continue;
      const clsA = confidenceToClass(bA.confidence);
      const clsB = confidenceToClass(bB.confidence);
      let severity;
      if (clsA === "HIGH" && clsB === "HIGH") severity = "HIGH";
      else if (clsA === "LOW" && clsB === "LOW") severity = "LOW";
      else severity = "MEDIUM";
      results.push({
        id: makeId(),
        type: "pairwise",
        severity,
        scope: "local",
        description: `Pairwise contradiction between "${bA.id}" and "${bB.id}"`,
        involved_belief_ids: [bA.id, bB.id]
      });
    }
  }
  return results;
}
function detectSetLevelContradictions(beliefs) {
  const results = [];
  const highConf = beliefs.filter((b) => b.confidence >= 0.6);
  const opposition = new Map(highConf.map((b) => [b.id, []]));
  for (let i = 0; i < highConf.length; i++) {
    for (let j = i + 1; j < highConf.length; j++) {
      const bA = highConf[i];
      const bB = highConf[j];
      if (statementsOpposed(bA.statement, bB.statement)) {
        opposition.get(bA.id).push(bB.id);
        opposition.get(bB.id).push(bA.id);
      }
    }
  }
  const reported = /* @__PURE__ */ new Set();
  for (const idA of highConf.map((b) => b.id)) {
    for (const idB of opposition.get(idA) ?? []) {
      for (const idC of opposition.get(idB) ?? []) {
        if (idC === idA || idC === idB) continue;
        const triple = [idA, idB, idC].sort().join("|");
        if (reported.has(triple)) continue;
        reported.add(triple);
        results.push({
          id: makeId(),
          type: "set-level",
          severity: "HIGH",
          scope: "task",
          description: `Set-level contradiction in triple [${idA}, ${idB}, ${idC}]`,
          involved_belief_ids: [idA, idB, idC]
        });
      }
    }
  }
  return results;
}
function detectTemporalContradictions(beliefs, environmentChangeLog) {
  const results = [];
  for (const belief of beliefs) {
    const beliefSources = /* @__PURE__ */ new Set([...belief.derived_from, ...belief.supporting_evidence ?? []]);
    const beliefTs = new Date(belief.recorded_at).getTime();
    for (const change of environmentChangeLog) {
      if (!change.affected_paths.some((p) => beliefSources.has(p))) continue;
      const changeTs = new Date(change.timestamp).getTime();
      if (Number.isNaN(changeTs)) continue;
      const severity = changeTs > beliefTs ? "MEDIUM" : "HIGH";
      results.push({
        id: makeId(),
        type: "temporal",
        severity,
        scope: "local",
        description: `Temporal contradiction: belief "${belief.id}" invalidated by change "${change.id}"`,
        involved_belief_ids: [belief.id]
      });
    }
  }
  return results;
}
const LINE_LEVEL_KEYWORDS = getGranularityMarkers().statementLevelMarkers;
function detectAbstractionContradictions(beliefs, context) {
  const results = [];
  if (!context) return results;
  if (!harnessLexicalActive("granularity-markers")) return results;
  const abstractionLevel = context.abstraction_level ?? "module";
  if (!["module", "component", "system"].includes(abstractionLevel)) return results;
  for (const belief of beliefs) {
    const stmt = belief.statement.toLowerCase();
    if (LINE_LEVEL_KEYWORDS.some((kw) => stmt.includes(kw))) {
      results.push({
        id: makeId(),
        type: "abstraction",
        severity: "LOW",
        scope: "local",
        description: `Abstraction contradiction: belief "${belief.id}" stated at line-level granularity`,
        involved_belief_ids: [belief.id]
      });
    }
  }
  return results;
}
function assignSystemBreakingSeverity(contradictions, hypothesisSet) {
  const hypothesisConflictPairs = /* @__PURE__ */ new Set();
  for (const hyp of hypothesisSet.active) {
    const ev = hyp.discriminating_evidence;
    for (let i = 0; i < ev.length; i++) {
      for (let j = i + 1; j < ev.length; j++) {
        hypothesisConflictPairs.add([ev[i], ev[j]].sort().join("|"));
      }
    }
  }
  return contradictions.map((c) => {
    if (c.severity !== "HIGH" || c.type !== "pairwise" && c.type !== "set-level") return c;
    const pairKey = [...c.involved_belief_ids].sort().join("|");
    if (hypothesisConflictPairs.has(pairKey)) {
      return { ...c, severity: "SYSTEM_BREAKING" };
    }
    return c;
  });
}
function hasAppliedContradiction(belief, contradictionId) {
  return (belief.applied_contradiction_ids ?? []).includes(contradictionId);
}
function markApplied(belief, contradictionId) {
  belief.applied_contradiction_ids = [...belief.applied_contradiction_ids ?? [], contradictionId];
  belief.pending_sweep = true;
}
function resolveLow(c, worldModel) {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue;
    if (hasAppliedContradiction(belief, c.id)) continue;
    belief.confidence = Math.max(0, belief.confidence * 0.9);
    markApplied(belief, c.id);
  }
}
function resolveMedium(c, worldModel, beliefDepGraph) {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue;
    if (hasAppliedContradiction(belief, c.id)) continue;
    belief.confidence = Math.max(0, belief.confidence * 0.75);
    markApplied(belief, c.id);
    if (beliefDepGraph && !beliefDepGraph.propagation_queue.some((t) => t.source_belief_id === belief.id)) {
      beliefDepGraph.propagation_queue.push({ source_belief_id: belief.id, target_belief_id: belief.id });
    }
  }
}
function resolveHigh(c, worldModel, beliefDepGraph) {
  for (const belief of worldModel.beliefs) {
    if (!c.involved_belief_ids.includes(belief.id)) continue;
    if (hasAppliedContradiction(belief, c.id)) continue;
    markApplied(belief, c.id);
    if (beliefDepGraph && !beliefDepGraph.invalidation_frontier.includes(belief.id)) {
      beliefDepGraph.invalidation_frontier.push(belief.id);
    }
  }
}
function resolveSystemBreaking(c, worldModel) {
  if (!worldModel.contradictions.some((existing) => existing.id === c.id)) {
    worldModel.contradictions.push(c);
  }
  const stored = worldModel.contradictions.find((existing) => existing.id === c.id);
  if (stored) stored.scope = "global";
}
function applyResolutionPolicy(c, worldModel, beliefDepGraph) {
  if (c.severity === "LOW") resolveLow(c, worldModel);
  else if (c.severity === "MEDIUM") resolveMedium(c, worldModel, beliefDepGraph);
  else if (c.severity === "HIGH") resolveHigh(c, worldModel, beliefDepGraph);
  else if (c.severity === "SYSTEM_BREAKING") resolveSystemBreaking(c, worldModel);
}
function contradictionKey(c) {
  return `${c.type}|${[...c.involved_belief_ids].sort().join(",")}|${c.type === "temporal" ? c.description : ""}`;
}
function detectContradictions(worldModel, _evidenceStore, hypothesisSet, abstractionContext, beliefDepGraph) {
  const beliefs = worldModel.beliefs;
  const envLog = worldModel.environment_change_log;
  let all = [
    ...harnessLexicalActive("negation-pairs") ? detectPairwiseContradictions(beliefs) : [],
    // The set-level detector is built on the same lexical negation matcher, so it follows the same switch.
    ...harnessLexicalActive("negation-pairs") ? detectSetLevelContradictions(beliefs) : [],
    ...detectTemporalContradictions(beliefs, envLog),
    ...detectAbstractionContradictions(beliefs, abstractionContext)
  ];
  all = assignSystemBreakingSeverity(all, hypothesisSet);
  const known = new Set(worldModel.contradictions.map(contradictionKey));
  all = all.filter((c) => {
    const key = contradictionKey(c);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  for (const c of all) {
    worldModel.contradictions.push(c);
    applyResolutionPolicy(c, worldModel, beliefDepGraph);
  }
}
function recordExternalContradiction(worldModel, input, beliefDepGraph) {
  const key = [...input.beliefIds].sort().join("|");
  const alreadyRecorded = worldModel.contradictions.some(
    (c) => [...c.involved_belief_ids].sort().join("|") === key
  );
  if (alreadyRecorded) return null;
  const contradiction = {
    id: makeId(),
    type: "pairwise",
    severity: input.severity ?? "MEDIUM",
    scope: "local",
    description: input.description,
    involved_belief_ids: input.beliefIds
  };
  worldModel.contradictions.push(contradiction);
  applyResolutionPolicy(contradiction, worldModel, beliefDepGraph);
  return contradiction;
}
const MAX_BELIEFS = 10;
const KEEP_BELIEFS = 5;
const DIVERSITY_THRESHOLD = 0.7;
const MAX_PASSES = 10;
function makeSeed(id2, source, explanation, confidence = 0.5) {
  return {
    id: id2,
    explanation,
    confidence,
    predicted_observations: [],
    discriminating_evidence: [],
    generation_sources: [source],
    diversity_score: 0
  };
}
function computeDiversityScore(hypothesisSet) {
  if (hypothesisSet.active.length === 0) return 0;
  const sources = /* @__PURE__ */ new Set();
  for (const h of hypothesisSet.active) {
    for (const s of h.generation_sources) sources.add(s);
  }
  const sourceCounts = Array.from(sources).map(
    (s) => hypothesisSet.active.filter((h) => h.generation_sources.includes(s)).length
  );
  return normalise(sourceCounts, DimensionType.entropy);
}
function generateFromSource(source, worldModel, evidenceStore, hypothesisSet, failureDiagnostics, pass) {
  const suffix = pass > 0 ? `_p${pass}` : "";
  switch (source) {
    case "symptom_inference": {
      const obs = evidenceStore.observations;
      if (obs.length > 0) {
        return obs.slice(0, 1).map(
          (o, i) => makeSeed(`symp_${o.id}${suffix}`, source, `Symptom inference from: ${o.obs}`, 0.4 + i * 0.05)
        );
      }
      return [makeSeed(`symp_default${suffix}`, source, "No symptoms observed — hypothesis: system nominal", 0.3)];
    }
    case "counterfactual": {
      const beliefs = worldModel.beliefs;
      if (beliefs.length > 0) {
        return [makeSeed(
          `counter_${beliefs[0].id}${suffix}`,
          source,
          `Counterfactual: if "${beliefs[0].statement}" were false, goal would be impacted`,
          0.35
        )];
      }
      return [makeSeed(`counter_default${suffix}`, source, "Counterfactual: prior state differs from expected", 0.3)];
    }
    case "failure_mode_library": {
      const symptoms = evidenceStore.observations.map((o) => o.obs);
      const match = failureDiagnostics.failure_mode_library.match(symptoms);
      if (match) {
        return [makeSeed(
          `fml_${match.matched_pattern}${suffix}`,
          source,
          `Failure mode match: ${match.failure_class} (confidence ${match.confidence.toFixed(2)})`,
          match.confidence
        )];
      }
      return [makeSeed(`fml_unknown${suffix}`, source, "Failure mode: unknown pattern — exploratory", 0.2)];
    }
    case "analogy": {
      if (hypothesisSet.eliminated.length > 0) {
        const template = hypothesisSet.eliminated[0];
        return [makeSeed(
          `analogy_${template.id}${suffix}`,
          source,
          `Analogy from eliminated hypothesis: ${template.explanation}`,
          0.25
        )];
      }
      return [makeSeed(`analogy_default${suffix}`, source, "Analogy: no prior eliminations — structural guess", 0.2)];
    }
  }
}
function applyEliminationPolicy(hypothesisSet, worldModel) {
  const toEliminate = hypothesisSet.active.filter((h) => {
    if (h.confidence < hypothesisSet.elimination_policy.floor) return true;
    if (worldModel.contradictions.some((c) => c.description.includes(h.id))) return true;
    return false;
  });
  for (const h of toEliminate) {
    hypothesisSet.eliminate(h);
  }
}
function generateUpdateHypotheses(worldModel, evidenceStore, hypothesisSet, failureDiagnostics, memoryState) {
  const sources = [
    "symptom_inference",
    "counterfactual",
    "failure_mode_library",
    "analogy"
  ];
  let pass = 0;
  let diversityScore = computeDiversityScore(hypothesisSet);
  do {
    const existingIds = new Set(hypothesisSet.active.map((h) => h.id));
    for (const source of sources) {
      const newHypotheses = generateFromSource(
        source,
        worldModel,
        evidenceStore,
        hypothesisSet,
        failureDiagnostics,
        pass
      );
      for (const h of newHypotheses) {
        if (!existingIds.has(h.id)) {
          hypothesisSet.active.push(h);
          existingIds.add(h.id);
        }
      }
    }
    diversityScore = computeDiversityScore(hypothesisSet);
    pass++;
  } while (diversityScore < DIVERSITY_THRESHOLD && pass < MAX_PASSES);
  for (const h of hypothesisSet.active) {
    h.diversity_score = diversityScore;
  }
  applyEliminationPolicy(hypothesisSet, worldModel);
  if (hypothesisSet.active.length > MAX_BELIEFS) {
    hypothesisSet.active.sort((a, b) => b.confidence - a.confidence);
    const pruned = hypothesisSet.active.splice(KEEP_BELIEFS);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const h of pruned) {
      const region = {
        id: `hypothesis_${h.id}`,
        description: h.explanation,
        token_count: 0,
        pruned_at: now
      };
      memoryState.compression_risk.pruned_regions.push(region);
    }
  }
}
function computeSourceEntropy(hypothesisSet) {
  return computeDiversityScore(hypothesisSet);
}
function estimateWorldModelGranularity(worldModel) {
  const beliefs = worldModel.beliefs;
  if (beliefs.length === 0) return 0;
  const { statementLevelMarkers: statementMarkers, functionLevelMarkers: functionMarkers } = getGranularityMarkers();
  let statementCount = 0;
  let functionCount = 0;
  for (const b of beliefs) {
    const stmt = b.statement.toLowerCase();
    if (statementMarkers.some((m) => stmt.includes(m))) statementCount++;
    else if (functionMarkers.some((m) => stmt.includes(m))) functionCount++;
  }
  if (statementCount / beliefs.length > 0.5) return 2;
  if (functionCount / beliefs.length > 0.5) return 1;
  return 0;
}
function checkAbstractionAlignment(taskGraph, worldModel, force = false) {
  if (!force && !taskGraph.changed) return 1;
  if (!harnessLexicalActive("granularity-markers")) return 1;
  const wmGranularity = estimateWorldModelGranularity(worldModel);
  const total = taskGraph.tasks.length;
  if (total === 0) return 1;
  const mismatched = taskGraph.tasks.filter((t) => t.abstraction_level > wmGranularity + 1).length;
  const score = 1 - mismatched / total;
  return Math.max(0, Math.min(1, score));
}
function computeDepClassGapAnnotation(taskGraph) {
  const abstractLevels = new Set(taskGraph.tasks.map((t) => t.abstraction_level));
  if (abstractLevels.size <= 1) return "";
  const levels = [...abstractLevels].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) gaps.push(`gap between level ${levels[i - 1]} and ${levels[i]}`);
  }
  return gaps.length > 0 ? `Abstraction class gaps detected: ${gaps.join(", ")}` : "";
}
function updateDiagnostics(worldModel, hypothesisSet, taskGraph, failureDiagnostics, depGraph, diagnostics, force = false) {
  const staleValues = Object.values(worldModel.stale_flags);
  const beliefCountForStaleness = Math.max(1, worldModel.beliefs.length);
  const staleFlagRatio = staleValues.filter(Boolean).length / beliefCountForStaleness;
  const freshness = normalise(1 - staleFlagRatio, DimensionType.ratio);
  assertNormalised(freshness, "belief_health.freshness");
  const contradictionDensity = worldModel.beliefs.length > 0 ? Math.min(1, worldModel.contradictions.length / worldModel.beliefs.length) : 0;
  const consistency = normalise(1 - contradictionDensity, DimensionType.ratio);
  assertNormalised(consistency, "belief_health.consistency");
  const reliabilityWeight = { HIGH: 1, MEDIUM: 0.5, LOW: 0 };
  const meanSupport = worldModel.beliefs.length > 0 ? worldModel.beliefs.reduce((acc, b) => acc + (reliabilityWeight[b.reliability ?? "MEDIUM"] ?? 0.5), 0) / worldModel.beliefs.length : 1;
  const support = normalise(meanSupport, DimensionType.ratio);
  assertNormalised(support, "belief_health.support");
  diagnostics.belief_health = { freshness, consistency, support };
  const symptomCoverage = normalise(
    hypothesisSet.active.length > 0 ? Math.min(1, hypothesisSet.active.length / Math.max(worldModel.observations.length, 1)) : 0,
    DimensionType.ratio
  );
  assertNormalised(symptomCoverage, "coverage_health.symptom_coverage");
  const explanationCoverage = normalise(computeSourceEntropy(hypothesisSet), DimensionType.ratio);
  assertNormalised(explanationCoverage, "coverage_health.explanation_coverage");
  diagnostics.coverage_health = { symptom_coverage: symptomCoverage, explanation_coverage: explanationCoverage };
  const strength = normalise(1 - depGraph.unverified_edge_ratio, DimensionType.ratio);
  assertNormalised(strength, "verification_health.strength");
  const abstractionFit = checkAbstractionAlignment(taskGraph, worldModel, force);
  const toolAdequacy = normalise(
    Object.keys(worldModel.completeness_flags).length > 0 ? 0.8 : 0.6,
    DimensionType.ratio
  );
  const evidenceAdequacy = normalise(
    worldModel.observations.length > 0 ? 0.8 : 0.4,
    DimensionType.ratio
  );
  const feasibility = normalise(
    { components: [toolAdequacy, evidenceAdequacy, abstractionFit], weights: [1, 1, 0.3] },
    DimensionType.composite
  );
  assertNormalised(feasibility, "verification_health.feasibility");
  diagnostics.verification_health = { strength, feasibility };
  const totalTasks = taskGraph.tasks.length;
  const completedTasks = taskGraph.tasks.filter((t) => t.status === "COMPLETE").length;
  const failedTasks = taskGraph.tasks.filter((t) => t.status === "FAILED").length;
  const attemptedTasks = completedTasks + failedTasks;
  const progressRate = normalise(
    attemptedTasks >= EXECUTION_RATIO_MIN_ATTEMPTS ? completedTasks / attemptedTasks : 1,
    DimensionType.ratio
  );
  assertNormalised(progressRate, "execution_health.progress_rate");
  const failureRecurrence = normalise(
    Math.min(1, failureDiagnostics.failure_history.length / 10),
    DimensionType.ratio
  );
  assertNormalised(failureRecurrence, "execution_health.failure_recurrence");
  const oscillationScore = normalise(totalTasks > 0 && attemptedTasks >= EXECUTION_RATIO_MIN_ATTEMPTS ? failedTasks / totalTasks : 0, DimensionType.ratio);
  assertNormalised(oscillationScore, "execution_health.oscillation_score");
  diagnostics.execution_health = { progress_rate: progressRate, failure_recurrence: failureRecurrence, oscillation_score: oscillationScore };
  const symptoms = worldModel.observations.map((o) => o.content);
  const match = failureDiagnostics.failure_mode_library.match(symptoms);
  if (match) {
    const normalisedConfidence = normalise(match.confidence, DimensionType.match_confidence);
    failureDiagnostics.matched_pattern = { ...match, confidence: normalisedConfidence };
  } else {
    failureDiagnostics.matched_pattern = null;
  }
  diagnostics.dep_class_gap_annotation = computeDepClassGapAnnotation(taskGraph);
}
function buildRecoveryActionGraph(blockMask) {
  const blockedDims = new Set(blockMask.map((e) => e.dimension));
  const graph = /* @__PURE__ */ new Map();
  for (const entry of blockMask) {
    const required = RECOVERY_ACTION_DEPENDENCIES[entry.recovery_action_class] ?? [];
    const blockedDeps = new Set(required.filter((d) => blockedDims.has(d)));
    graph.set(entry.dimension, blockedDeps);
  }
  return graph;
}
function hasCycle(graph) {
  const visited = /* @__PURE__ */ new Set();
  const recStack = /* @__PURE__ */ new Set();
  function dfs(node) {
    visited.add(node);
    recStack.add(node);
    for (const neighbor of graph.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }
  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}
function detectDeadlock(blockMask) {
  const graph = buildRecoveryActionGraph(blockMask);
  return hasCycle(graph);
}
function ensureProvenance(diagnostics, subDims) {
  for (const [name2] of subDims) {
    if (!(name2 in diagnostics.provenance)) {
      diagnostics.provenance[name2] = { source: "deterministic", calibrated: false, evidence_ids: [] };
    }
  }
}
function attachProvenanceNotes(cs, notes, diagnostics) {
  const flagged = cs.block_mask.map((e) => e.dimension).filter((dim) => {
    const p = diagnostics.provenance[dim];
    return p !== void 0 && p.source === "model" && !p.calibrated;
  }).sort();
  for (const dim of flagged) {
    notes.push(`${MODEL_PROVENANCE_NOTE_PREFIX}${dim}`);
  }
}
function extractSubDimensions(diagnostics) {
  const { belief_health: bh, coverage_health: ch, verification_health: vh, execution_health: eh } = diagnostics;
  return [
    ["belief_freshness", bh.freshness],
    ["belief_consistency", bh.consistency],
    ["belief_support", bh.support],
    ["symptom_coverage", ch.symptom_coverage],
    ["explanation_coverage", ch.explanation_coverage],
    ["verification_strength", vh.strength],
    ["verification_feasibility", vh.feasibility],
    ["progress_rate", eh.progress_rate],
    // failure_recurrence and oscillation_score: 0=healthy, so invert for threshold logic
    ["failure_recurrence", 1 - eh.failure_recurrence],
    ["oscillation_score", 1 - eh.oscillation_score]
  ];
}
function computeRiskAndConfidenceEstimates(subDims) {
  const confidenceValues = [];
  const riskPoolValues = [];
  for (const [name2, normValue] of subDims) {
    if (CONFIDENCE_DIMENSIONS.has(name2)) confidenceValues.push(normValue);
    else if (RISK_DIMENSIONS.has(name2)) riskPoolValues.push(normValue);
  }
  const confidence_estimate = confidenceValues.length > 0 ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : 1;
  const riskPoolHealth = riskPoolValues.length > 0 ? riskPoolValues.reduce((a, b) => a + b, 0) / riskPoolValues.length : 1;
  const risk_estimate = Math.max(0, Math.min(1, 1 - riskPoolHealth));
  return { risk_estimate, confidence_estimate };
}
function applyPendingReviewerVerdict(cs, notes, verdict) {
  if (verdict == null) return;
  if (verdict.severity !== "MEDIUM" && verdict.severity !== "HIGH") return;
  notes.push(`Pending reviewer verdict (${verdict.lens}, ${verdict.severity}): ${verdict.summary}`);
  if (cs.execution_mode === "NORMAL") {
    cs.execution_mode = "CAUTIOUS";
  }
}
function resolveControlState(diagnostics, worldModel, failureDiagnostics, _step, pendingReviewerVerdict) {
  assertNormalised(diagnostics.belief_health.freshness, "belief_health.freshness");
  assertNormalised(diagnostics.belief_health.consistency, "belief_health.consistency");
  assertNormalised(diagnostics.belief_health.support, "belief_health.support");
  assertNormalised(diagnostics.coverage_health.symptom_coverage, "coverage_health.symptom_coverage");
  assertNormalised(diagnostics.coverage_health.explanation_coverage, "coverage_health.explanation_coverage");
  assertNormalised(diagnostics.verification_health.strength, "verification_health.strength");
  assertNormalised(diagnostics.verification_health.feasibility, "verification_health.feasibility");
  assertNormalised(diagnostics.execution_health.progress_rate, "execution_health.progress_rate");
  assertNormalised(diagnostics.execution_health.failure_recurrence, "execution_health.failure_recurrence");
  assertNormalised(diagnostics.execution_health.oscillation_score, "execution_health.oscillation_score");
  const cs = new ControlState();
  const notes = [];
  const subDimsForEstimate = extractSubDimensions(diagnostics);
  ensureProvenance(diagnostics, subDimsForEstimate);
  const estimates = computeRiskAndConfidenceEstimates(subDimsForEstimate);
  cs.risk_estimate = estimates.risk_estimate;
  cs.confidence_estimate = estimates.confidence_estimate;
  const subDims = subDimsForEstimate;
  if (worldModel.contradictions.some((c) => c.severity === "SYSTEM_BREAKING")) {
    cs.permission = "DENY";
    cs.execution_mode = "RECOVERY";
    cs.escalation = "SYSTEM_BREAKING";
    cs.escalation_reason = "SYSTEM_BREAKING_CONTRADICTION";
    cs.block_mask = [{
      dimension: "world_model_integrity",
      value: 0,
      recovery_action_class: "consistency_repair"
    }];
  }
  if (cs.permission !== "DENY") {
    const blockMask = [];
    for (const [dimName, normValue] of subDims) {
      if (normValue < CRITICAL_THRESHOLD) {
        blockMask.push({
          dimension: dimName,
          value: normValue,
          recovery_action_class: DIMENSION_RECOVERY[dimName] ?? "consistency_repair"
        });
      }
    }
    if (blockMask.length > 0) {
      cs.block_mask = blockMask;
      cs.permission = "DENY";
      cs.execution_mode = "RECOVERY";
      if (detectDeadlock(blockMask)) {
        cs.escalation = "HUMAN_REQUIRED";
        cs.escalation_reason = "HUMAN_REQUIRED";
      }
    }
  }
  if (cs.permission !== "DENY") {
    const { symptom_coverage, explanation_coverage } = diagnostics.coverage_health;
    if (symptom_coverage >= CRITICAL_THRESHOLD && symptom_coverage < CAUTION_THRESHOLD || explanation_coverage >= CRITICAL_THRESHOLD && explanation_coverage < CAUTION_THRESHOLD) {
      cs.execution_mode = "CAUTIOUS";
      if (symptom_coverage >= CRITICAL_THRESHOLD && symptom_coverage < CAUTION_THRESHOLD) {
        notes.push(`Coverage gap in symptom_coverage (${symptom_coverage.toFixed(3)}): exploration actions allowed`);
      }
      if (explanation_coverage >= CRITICAL_THRESHOLD && explanation_coverage < CAUTION_THRESHOLD) {
        notes.push(`Coverage gap in explanation_coverage (${explanation_coverage.toFixed(3)}): exploration actions allowed`);
      }
    }
    const allSubDimValues = subDims.map(([, v]) => v);
    let elevationFactor = computeElevationFactor(allSubDimValues);
    const matchedPattern = failureDiagnostics.matched_pattern;
    if (matchedPattern !== null) {
      const patternConfidence = normalise(matchedPattern.confidence, DimensionType.ratio);
      elevationFactor = elevationFactor * 0.8 + patternConfidence * 0.2;
    }
    if (elevationFactor > 0.05 && cs.execution_mode === "NORMAL") {
      cs.execution_mode = "CAUTIOUS";
    }
  }
  if (diagnostics.dep_class_gap_annotation) {
    notes.push(`${DEP_CLASS_GAP_NOTE_PREFIX}${diagnostics.dep_class_gap_annotation}`);
  }
  attachProvenanceNotes(cs, notes, diagnostics);
  applyPendingReviewerVerdict(cs, notes, pendingReviewerVerdict);
  cs.notes = notes;
  cs.generation_id = worldModel.generation_id;
  return cs;
}
const RESTART_ITERATION = "RESTART_ITERATION";
class NoOpUpdateChannel {
  poll() {
    return null;
  }
}
class AsyncFnUpdateChannel {
  constructor(fn) {
    this.fn = fn;
  }
  poll() {
    return this.fn();
  }
}
function taskInScope(task, criteriaTokens) {
  const descTokens = new Set(task.description.toLowerCase().split(/\s+/));
  return criteriaTokens.some((tokens) => [...descTokens].some((t) => tokens.has(t)));
}
function criterionCovered(criterionTokens, taskGraph) {
  for (const task of taskGraph.tasks) {
    if (task.status === "COMPLETE") continue;
    if (task.status === "BLOCKED" && task.block_reason === "scope_eliminated") continue;
    const descTokens = new Set(task.description.toLowerCase().split(/\s+/));
    if ([...descTokens].some((t) => criterionTokens.has(t))) return true;
  }
  return false;
}
function revalidateTaskGraph(taskGraph, callerState) {
  const updatedCriteria = [...new Set(callerState.success_criteria)];
  if (updatedCriteria.length === 0) return taskGraph;
  if (!harnessLexicalActive("criterion-scope")) return taskGraph;
  const criteriaTokenSets = updatedCriteria.map((c) => new Set(c.toLowerCase().split(/\s+/)));
  for (const task of taskGraph.tasks) {
    if (task.status === "COMPLETE") continue;
    if (!taskInScope(task, criteriaTokenSets)) {
      if (task.status !== "BLOCKED" || task.block_reason !== "scope_eliminated") {
        task.status = "BLOCKED";
        task.block_reason = "scope_eliminated";
        taskGraph.changed = true;
      }
    }
  }
  for (const criterion of updatedCriteria) {
    const criterionTokens = new Set(criterion.toLowerCase().split(/\s+/));
    if (!criterionCovered(criterionTokens, taskGraph)) {
      taskGraph.tasks.push({
        id: `task-${Math.random().toString(36).slice(2, 10)}`,
        description: criterion,
        status: "PENDING",
        risk_level: "MEDIUM",
        depends_on: [],
        parallel_write_domains: [],
        abstraction_level: 1,
        assigned_strategy: null
      });
      taskGraph.changed = true;
    }
  }
  return taskGraph;
}
function cancelTaskGraph(taskGraph) {
  for (const task of taskGraph.tasks) {
    if (task.status === "COMPLETE" || task.status === "FAILED") continue;
    if (task.status === "BLOCKED" && task.block_reason === "goal_cancelled") continue;
    task.status = "BLOCKED";
    task.block_reason = "goal_cancelled";
    taskGraph.changed = true;
  }
}
function applyConstraintChangePropagation(callerState, ctx, _resolverFn) {
  updateSuccessCriteria(callerState, ctx.worldModel);
  const evidenceStore = ctx.evidenceStore ?? {};
  detectContradictions(ctx.worldModel, evidenceStore, ctx.hypothesisSet);
  const seen = /* @__PURE__ */ new Set();
  ctx.worldModel.contradictions = ctx.worldModel.contradictions.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  if (ctx.outputContract) {
    const newOc = updateOutputContract(callerState, ctx.outputContract);
    ctx.outputContract.caller_specific_constraints = newOc.caller_specific_constraints;
    ctx.outputContract.required_interface_fields = newOc.required_interface_fields;
  }
  revalidateTaskGraph(ctx.taskGraph, callerState);
  ctx.worldModel.generation_id++;
  callerState.resetConstraintsChanged();
}
async function checkCallerUpdates(callerState, updateChannel, ctx, resolverFn) {
  const update = await updateChannel.poll();
  if (update === null) return "NO_UPDATE";
  callerState.updateConstraints(update.pending_update);
  if (callerState.constraints_changed) {
    if (ctx) {
      if (update.pending_update.cancel_current === true) {
        cancelTaskGraph(ctx.taskGraph);
        ctx.worldModel.generation_id++;
        callerState.resetConstraintsChanged();
      } else {
        applyConstraintChangePropagation(callerState, ctx);
      }
    } else {
      callerState.resetConstraintsChanged();
    }
    return RESTART_ITERATION;
  }
  return "NO_UPDATE";
}
class GraphCycleError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphCycleError";
  }
}
function detectCycles(taskGraph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = /* @__PURE__ */ new Map();
  for (const t of taskGraph.tasks) color.set(t.id, WHITE);
  const taskMap = new Map(taskGraph.tasks.map((t) => [t.id, t]));
  const dfs = (id2) => {
    var _a;
    color.set(id2, GRAY);
    for (const depId of ((_a = taskMap.get(id2)) == null ? void 0 : _a.depends_on) ?? []) {
      const c = color.get(depId) ?? WHITE;
      if (c === GRAY) throw new GraphCycleError(`Cycle detected in task graph: "${depId}" is part of a cycle`);
      if (c === WHITE) dfs(depId);
    }
    color.set(id2, BLACK);
  };
  for (const t of taskGraph.tasks) {
    if ((color.get(t.id) ?? WHITE) === WHITE) dfs(t.id);
  }
}
function updateConflictProbabilities(taskGraph) {
  const tasks = taskGraph.tasks;
  if (tasks.length < 2) return;
  const allDomains = /* @__PURE__ */ new Set();
  for (const t of tasks) {
    for (const d of t.parallel_write_domains) allDomains.add(d);
  }
  const domains = [...allDomains].sort();
  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const domA2 = domains[i], domB = domains[j];
      if (taskGraph.getConflictProbability(domA2, domB) === 0) {
        const countA = tasks.filter((t) => t.parallel_write_domains.includes(domA2)).length;
        const countB = tasks.filter((t) => t.parallel_write_domains.includes(domB)).length;
        if (countA > 0 && countB > 0) {
          taskGraph.setConflictProbability(domA2, domB, Math.min(1, (countA + countB) / (2 * tasks.length)));
        }
      }
    }
    const domA = domains[i];
    if (taskGraph.getConflictProbability(domA, domA) === 0) {
      const countA = tasks.filter((t) => t.parallel_write_domains.includes(domA)).length;
      if (countA >= 2) {
        taskGraph.setConflictProbability(domA, domA, Math.min(1, countA / tasks.length));
      }
    }
  }
}
function updateTaskGraph(_objective, _worldModel, _hypothesisSet, taskGraph) {
  detectCycles(taskGraph);
  updateConflictProbabilities(taskGraph);
}
const PESSIMISTIC_THRESHOLD = 0.5;
function selectTask(taskGraph, controlState) {
  if (controlState.escalation_reason === "HUMAN_REQUIRED") {
    return { task: null, concurrentTask: null, escalate: true };
  }
  const taskMap = new Map(taskGraph.tasks.map((t) => [t.id, t]));
  const eligible = taskGraph.tasks.filter((t) => {
    if (t.status !== "PENDING") return false;
    return t.depends_on.every((depId) => {
      var _a;
      return ((_a = taskMap.get(depId)) == null ? void 0 : _a.status) === "COMPLETE";
    });
  });
  if (eligible.length === 0) return { task: null, concurrentTask: null, escalate: false };
  const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...eligible].sort((a, b) => (riskOrder[a.risk_level] ?? 1) - (riskOrder[b.risk_level] ?? 1));
  const primary = sorted[0];
  if (sorted.length < 2) return { task: primary, concurrentTask: null, escalate: false };
  const secondary = sorted[1];
  const primaryDomains = new Set(primary.parallel_write_domains);
  const hasOverlap = secondary.parallel_write_domains.some((d) => primaryDomains.has(d));
  if (!hasOverlap) return { task: primary, concurrentTask: secondary, escalate: false };
  const conflictProb = Math.max(
    0,
    ...primary.parallel_write_domains.flatMap(
      (da) => secondary.parallel_write_domains.map((db) => taskGraph.getConflictProbability(da, db))
    )
  );
  if (conflictProb > PESSIMISTIC_THRESHOLD) {
    return { task: primary, concurrentTask: null, escalate: false };
  }
  return { task: primary, concurrentTask: secondary, escalate: false };
}
function mergeWorldModels(wm1, wm2) {
  const merged = new WorldModel();
  merged.generation_id = Math.max(wm1.generation_id, wm2.generation_id);
  const beliefMap = /* @__PURE__ */ new Map();
  for (const b of [...wm1.beliefs, ...wm2.beliefs]) beliefMap.set(b.id, b);
  merged.beliefs = [...beliefMap.values()];
  const obsMap = /* @__PURE__ */ new Map();
  for (const o of [...wm1.observations, ...wm2.observations]) obsMap.set(o.id, o);
  merged.observations = [...obsMap.values()];
  const contMap = /* @__PURE__ */ new Map();
  for (const c of [...wm1.contradictions, ...wm2.contradictions]) contMap.set(c.id, c);
  merged.contradictions = [...contMap.values()];
  merged.assumptions = [.../* @__PURE__ */ new Set([...wm1.assumptions, ...wm2.assumptions])];
  merged.completeness_flags = { ...wm1.completeness_flags, ...wm2.completeness_flags };
  return merged;
}
function reconcileParallelBranches(branches, taskGraph, diagnostics, failureDiagnostics, evidenceStore, hypothesisSet, resolver, parallelDomainPairs) {
  if (branches.length === 0) throw new Error("reconcileParallelBranches: no branches provided");
  const maxGenId = Math.max(...branches.map((b) => b.worldModel.generation_id));
  let merged = branches[0].worldModel;
  for (let i = 1; i < branches.length; i++) {
    merged = mergeWorldModels(merged, branches[i].worldModel);
  }
  merged.generation_id = maxGenId;
  detectContradictions(merged, evidenceStore, hypothesisSet);
  const mergedCS = resolver(diagnostics, merged, failureDiagnostics);
  mergedCS.generation_id = merged.generation_id;
  if (parallelDomainPairs) {
    for (const [da, db] of parallelDomainPairs) {
      const existing = taskGraph.getConflictProbability(da, db);
      taskGraph.setConflictProbability(da, db, existing > 0 ? existing * 0.9 : 0);
    }
  }
  return { worldModel: merged, controlState: mergedCS };
}
function applyTaskOutcome(taskGraph, taskId, outcome) {
  taskGraph.setStatus(taskId, outcome.status, { fromExecutionLayer: outcome.fromExecutionLayer });
}
const MAX_LINES = 500;
const MAX_FUNCTIONS = 20;
function estimateRisk(action, taskGraph, _worldModel) {
  if (action.module_type === "infrastructure") {
    return "HIGH";
  }
  if (action.module_type === "test") {
    return "LOW";
  }
  const affectedFiles = action.affected_files ?? [];
  const allDomains = taskGraph.tasks.flatMap((t) => t.parallel_write_domains);
  const fileCentrality = affectedFiles.length === 0 ? 0 : affectedFiles.reduce((sum, f) => sum + allDomains.filter((d) => d.includes(f)).length, 0) / (Math.max(allDomains.length, 1) * affectedFiles.length);
  const lineScore = Math.min(1, (action.lines_affected ?? 0) / MAX_LINES);
  const funcScore = Math.min(1, (action.functions_affected ?? 0) / MAX_FUNCTIONS);
  const changeScope = (lineScore + funcScore) / 2;
  const MODULE_SCORE_BUSINESS = 0.5;
  const composite = 0.3 * fileCentrality + 0.4 * changeScope + 0.3 * MODULE_SCORE_BUSINESS;
  let risk;
  if (composite >= 0.5) {
    risk = "HIGH";
  } else if (composite >= 0.3) {
    risk = "MEDIUM";
  } else {
    risk = "LOW";
  }
  return risk;
}
const LOW_ADEQUACY_THRESHOLD = 0.3;
const HIGH_VOI_THRESHOLD = 0.5;
function estimateVOI(diagnostics, _worldModel, hypothesisSet, toolAvailabilityManifest) {
  const activeCount = hypothesisSet.active.length;
  const expectedUncertaintyReduction = activeCount > 1 ? (activeCount - 1) / activeCount : 0;
  const decisionImpact = 1 - diagnostics.verification_health.strength;
  const voi = normalise(expectedUncertaintyReduction * decisionImpact, DimensionType.ratio);
  const tools = Object.values(toolAvailabilityManifest);
  const availableCount = tools.filter((t) => t.available).length;
  const adequacy = tools.length === 0 ? 1 : availableCount / tools.length;
  const adequacy_shortfall = Math.max(0, LOW_ADEQUACY_THRESHOLD - adequacy);
  const should_gather_evidence = voi > HIGH_VOI_THRESHOLD || adequacy < LOW_ADEQUACY_THRESHOLD;
  const hasAnyFallback = tools.some((t) => !t.available && t.fallback_tool !== null);
  const adequacy_unresolvable = adequacy < LOW_ADEQUACY_THRESHOLD && !hasAnyFallback && availableCount === 0;
  let updated_verification_strength = null;
  if (adequacy_unresolvable) {
    updated_verification_strength = normalise(adequacy, DimensionType.ratio);
    diagnostics.verification_health.strength = updated_verification_strength;
  }
  return {
    voi,
    should_gather_evidence,
    adequacy_shortfall,
    adequacy_unresolvable,
    updated_verification_strength
  };
}
const MAX_QUESTIONS_PER_BATCH = 4;
const MIN_OPTIONS_PER_QUESTION = 2;
const MAX_OPTIONS_PER_QUESTION = 4;
function validateAskQuestion(q) {
  if (q.options !== void 0) {
    if (q.options.length < MIN_OPTIONS_PER_QUESTION || q.options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new Error(
        `AskQuestion "${q.id}": options must have between ${MIN_OPTIONS_PER_QUESTION} and ${MAX_OPTIONS_PER_QUESTION} entries, got ${q.options.length}`
      );
    }
    if (q.allowMultiple && q.options.some((o) => o.preview !== void 0)) {
      throw new Error(`AskQuestion "${q.id}": options with "preview" cannot be combined with allowMultiple`);
    }
  }
}
function makeQuestionsBatch(questions) {
  if (questions.length > MAX_QUESTIONS_PER_BATCH) {
    throw new Error(
      `questions batch exceeds the ${MAX_QUESTIONS_PER_BATCH}-question cap (got ${questions.length}); use batchQuestions() to split into sequential batches`
    );
  }
  questions.forEach(validateAskQuestion);
  return questions;
}
function validateAskAnswer(answer) {
  if ((answer.kind === "selected" || answer.kind === "selected_with_edit") && !Array.isArray(answer.selectedLabels)) {
    throw new Error(`AskAnswer for "${answer.questionId}": kind "${answer.kind}" requires a selectedLabels array`);
  }
  switch (answer.kind) {
    case "selected":
      if (answer.selectedLabels.length === 0) {
        throw new Error(
          `AskAnswer for "${answer.questionId}": kind "selected" requires at least one selected label`
        );
      }
      break;
    case "selected_with_edit":
      if (answer.selectedLabels.length === 0) {
        throw new Error(
          `AskAnswer for "${answer.questionId}": kind "selected_with_edit" requires at least one selected label`
        );
      }
      if (!answer.editText) {
        throw new Error(`AskAnswer for "${answer.questionId}": kind "selected_with_edit" requires non-empty editText`);
      }
      break;
    case "free_text":
      if (!answer.freeText) {
        throw new Error(`AskAnswer for "${answer.questionId}": kind "free_text" requires non-empty freeText`);
      }
      break;
    default:
      throw new Error(`AskAnswer for "${answer.questionId}": unknown kind "${answer.kind}"`);
  }
}
function validateAskResponse(questions, response) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answeredIds = /* @__PURE__ */ new Set();
  for (const answer of response.answers) {
    validateAskAnswer(answer);
    const question = byId.get(answer.questionId);
    if (!question) {
      throw new Error(`AskResponse: answer references unknown question id "${answer.questionId}"`);
    }
    if (!question.allowMultiple && (answer.kind === "selected" || answer.kind === "selected_with_edit") && answer.selectedLabels.length > 1) {
      throw new Error(`AskResponse: question "${question.id}" does not allow multiple selections`);
    }
    if (answeredIds.has(answer.questionId)) {
      throw new Error(`AskResponse: question "${answer.questionId}" received more than one answer`);
    }
    answeredIds.add(answer.questionId);
  }
  const missing = questions.filter((q) => !answeredIds.has(q.id));
  if (missing.length > 0) {
    throw new Error(`AskResponse: missing answers for question id(s) ${missing.map((q) => q.id).join(", ")}`);
  }
}
function batchQuestions(candidates, cap2 = MAX_QUESTIONS_PER_BATCH) {
  if (cap2 < 1) {
    throw new Error("cap must be >= 1");
  }
  return { batch: candidates.slice(0, cap2), deferred: candidates.slice(cap2) };
}
function refineDeferredBatch(deferred, isMoot, cap2 = MAX_QUESTIONS_PER_BATCH) {
  return deferred.filter((q) => !isMoot(q)).slice(0, cap2);
}
class EscalationHalt extends Error {
  constructor(blocker) {
    super(`Escalation halt: ${blocker.reason}`);
    __publicField(this, "blocker");
    this.name = "EscalationHalt";
    this.blocker = blocker;
  }
}
function makeSurfaceBlocker(reason, missing_info, current_task_summary, questions) {
  const blocker = {
    reason,
    missing_info,
    current_task_summary,
    escalated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (questions !== void 0) {
    blocker.questions = makeQuestionsBatch(questions);
  }
  return blocker;
}
function awaitClarification(blocker) {
  throw new EscalationHalt(blocker);
}
function escalateBudgetExhausted(stepCount, maxSteps) {
  return {
    escalated: true,
    reason: "budget_exhausted",
    missing_info: [`Step count ${stepCount} reached max_steps limit of ${maxSteps}`]
  };
}
function escalate(_controlState, _strategyState, reason, missingInfo, currentTaskSummary) {
  const blocker = makeSurfaceBlocker(reason, missingInfo, currentTaskSummary);
  throw new EscalationHalt(blocker);
}
function handleEscalationResponse(callerState, humanResponse, ctx) {
  callerState.updateConstraints(humanResponse);
  if (callerState.constraints_changed) {
    applyConstraintChangePropagation(callerState, ctx);
  }
}
const ESCALATION_THRESHOLD = 2;
function getChangeDescription(proposedChange) {
  return (proposedChange.description ?? "").toLowerCase();
}
const { triggers: NEGATION_TRIGGERS, stopwords: NEGATION_STOPWORDS } = getReviewNegationTriggers();
function isNegation(changeDesc, stmt) {
  if (!changeDesc || !stmt) return false;
  if (!harnessLexicalActive("review-negation")) return false;
  const patterns = NEGATION_TRIGGERS.map((trigger) => `${trigger}${stmt}`);
  if (patterns.some((p) => changeDesc.includes(p))) return true;
  if (!NEGATION_TRIGGERS.some((t) => changeDesc.includes(t))) return false;
  const stmtWords = tokenize$1(stmt).filter((w) => (containsCJK(w) || w.length > 3) && !NEGATION_STOPWORDS.has(w));
  if (stmtWords.length === 0) return false;
  const changeWords = new Set(tokenize$1(changeDesc));
  const overlap = stmtWords.filter((w) => changeWords.has(w));
  return overlap.length >= Math.min(2, stmtWords.length);
}
function checkTaskAlignment(proposedChange, currentTask) {
  if (currentTask === null) {
    return { dimension: "task_alignment", passed: true, reason: "No current task — alignment not applicable" };
  }
  const taskDesc = currentTask.description.toLowerCase();
  const changeDesc = getChangeDescription(proposedChange);
  if (taskDesc && !changeDesc) {
    return { dimension: "task_alignment", passed: false, reason: "Proposed change has no description but task requires one" };
  }
  return { dimension: "task_alignment", passed: true, reason: "Change aligns with task" };
}
function checkWorldModelConsistency(proposedChange, worldModel) {
  if (worldModel === null) {
    return { dimension: "world_model_consistency", passed: true, reason: "No world model provided" };
  }
  const changeDesc = getChangeDescription(proposedChange);
  for (const belief of worldModel.beliefs) {
    if (belief.confidence < 0.8) continue;
    const stmt = belief.statement.toLowerCase();
    if (isNegation(changeDesc, stmt)) {
      return {
        dimension: "world_model_consistency",
        passed: false,
        reason: `Change contradicts HIGH-reliability belief: ${JSON.stringify(stmt)}`
      };
    }
  }
  return { dimension: "world_model_consistency", passed: true, reason: "No contradiction with world model beliefs" };
}
function checkOutputContract(proposedChange, outputContract) {
  if (outputContract === null) {
    return { dimension: "output_contract_precheck", passed: true, reason: "No output contract provided" };
  }
  if (!harnessLexicalActive("review-phrases")) {
    return { dimension: "output_contract_precheck", passed: true, reason: "Lexical phrase check switched off" };
  }
  const changeDesc = getChangeDescription(proposedChange);
  for (const section of outputContract.required_sections) {
    const s = section.toLowerCase();
    const removalPatterns = [`remove ${s}`, `delete ${s}`, `drop ${s}`, `removes ${s}`];
    if (removalPatterns.some((p) => changeDesc.includes(p))) {
      return {
        dimension: "output_contract_precheck",
        passed: false,
        reason: `Change removes required interface field: ${JSON.stringify(section)}`
      };
    }
  }
  return { dimension: "output_contract_precheck", passed: true, reason: "No required interface fields removed" };
}
function checkCodeQuality(proposedChange, toolManifest) {
  var _a, _b, _c;
  if (toolManifest === null) {
    return { dimension: "code_quality", passed: true, reason: "No tool manifest — code quality check skipped" };
  }
  const manifest = toolManifest.tool_availability_manifest;
  const hasLinter = (((_a = manifest["linter"]) == null ? void 0 : _a.available) ?? false) || (((_b = manifest["pylint"]) == null ? void 0 : _b.available) ?? false) || (((_c = manifest["ruff"]) == null ? void 0 : _c.available) ?? false);
  if (!hasLinter) {
    return { dimension: "code_quality", passed: true, reason: "No linter available — code quality check skipped" };
  }
  const changeDesc = getChangeDescription(proposedChange);
  if (harnessLexicalActive("review-phrases") && (changeDesc.includes("syntax error") || changeDesc.includes("invalid code"))) {
    return { dimension: "code_quality", passed: false, reason: "Change description indicates code quality issues" };
  }
  return { dimension: "code_quality", passed: true, reason: "Code quality check passed" };
}
function checkHypothesisCompatibility(proposedChange, hypothesisSet) {
  if (hypothesisSet === null) {
    return { dimension: "hypothesis_compatibility", passed: true, reason: "No hypothesis set provided" };
  }
  const changeDesc = getChangeDescription(proposedChange);
  for (const h of hypothesisSet.active) {
    for (const obs of h.predicted_observations) {
      const obsLower = obs.toLowerCase();
      if (isNegation(changeDesc, obsLower)) {
        return {
          dimension: "hypothesis_compatibility",
          passed: false,
          reason: `Change contradicts predicted observation: ${JSON.stringify(obs)}`
        };
      }
    }
  }
  return { dimension: "hypothesis_compatibility", passed: true, reason: "Compatible with active hypotheses" };
}
function applyReviewOutcome(taskId, passed, consecutiveFailuresMap, failedDimension) {
  if (passed) {
    consecutiveFailuresMap.set(taskId, 0);
    return { passed: true, failed_dimensions: [], consecutive_failures: 0, escalation_triggered: false };
  }
  const prev = consecutiveFailuresMap.get(taskId) ?? 0;
  const consec = prev + 1;
  consecutiveFailuresMap.set(taskId, consec);
  return {
    passed: false,
    failed_dimensions: failedDimension === void 0 ? [] : Array.isArray(failedDimension) ? failedDimension : [failedDimension],
    consecutive_failures: consec,
    escalation_triggered: consec >= ESCALATION_THRESHOLD
  };
}
function reviewProposedChange(proposedChange, currentTask, worldModel, outputContract, hypothesisSet, toolManifest, consecutiveFailuresMap) {
  const taskId = (currentTask == null ? void 0 : currentTask.id) ?? "default";
  const checks = [
    () => checkTaskAlignment(proposedChange, currentTask),
    () => checkWorldModelConsistency(proposedChange, worldModel),
    () => checkOutputContract(proposedChange, outputContract),
    () => checkCodeQuality(proposedChange, toolManifest),
    () => checkHypothesisCompatibility(proposedChange, hypothesisSet)
  ];
  const failed = checks.map((check) => check()).filter((result) => !result.passed);
  return failed.length > 0 ? applyReviewOutcome(taskId, false, consecutiveFailuresMap, failed) : applyReviewOutcome(taskId, true, consecutiveFailuresMap);
}
const REVIEW_DIMENSION_FIXES = {
  task_alignment: "Revise the proposed change to align with the current task description",
  world_model_consistency: "Resolve the conflict with existing high-confidence beliefs before proceeding",
  output_contract_precheck: "Adjust the proposed change to satisfy the output contract",
  code_quality: "Address the code-quality issue before proceeding",
  hypothesis_compatibility: "Reconcile the change with the active hypothesis predictions"
};
function diagnoseReviewFailureOptions(failedDimensions) {
  const distinct = Array.from(new Set(failedDimensions.map((d) => d.dimension)));
  if (distinct.length < 2 || distinct.length > MAX_OPTIONS_PER_QUESTION) return void 0;
  return distinct.map((d) => ({ label: REVIEW_DIMENSION_FIXES[d] }));
}
function buildReviewFailureQuestion(options) {
  return {
    id: "review-failure-resolution",
    question: "The proposed change failed review. Which fix should I apply?",
    options
  };
}
function contractShadowCheck(result, outputContract) {
  if (outputContract === null) return { passed: true, violations: [] };
  const violations = [];
  if (typeof result === "object" && result !== null) {
    for (const section of outputContract.required_sections) {
      if (!(section in result)) {
        violations.push(`Missing required field: ${section}`);
      }
    }
  }
  return { passed: violations.length === 0, violations };
}
function actionGate(action, controlState, worldModel, diagnostics, failureDiagnostics, resolver) {
  _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver);
  if (controlState.escalation_reason === "HUMAN_REQUIRED") return "ESCALATE";
  if (controlState.permission === "DENY") return "BLOCK";
  if (controlState.block_mask.length > 0 && action !== null) {
    const blockedDims = new Set(controlState.block_mask.map((e) => e.dimension));
    const required = new Set(action.required_resources ?? []);
    for (const r of required) {
      if (blockedDims.has(r)) return "BLOCK";
    }
  }
  return "PASS";
}
function postExecGate(result, verification, controlState, worldModel, diagnostics, failureDiagnostics, outputContract, resolver) {
  _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver);
  if (outputContract !== void 0 && outputContract !== null) {
    const check = contractShadowCheck(result, outputContract);
    if (!check.passed) return false;
  }
  if (verification.has_critical_failure) return false;
  return true;
}
function isContinuableOutcome(value) {
  if (typeof value !== "object" || value === null || !("__harnessExecutionStatus" in value)) return false;
  const status = value.__harnessExecutionStatus;
  return status === "continue" || status === "complete" || status === "failed";
}
function isHarnessPauseSignal(value) {
  return typeof value === "object" && value !== null && value.__harnessPause === true;
}
const UNVERIFIED_EDGE_RATIO_THRESHOLD = 0.5;
function selectReversibilityStrategy(change) {
  const changeType = change.change_type ?? "file_mutation";
  if (changeType === "read-only") return "ephemeral";
  if (changeType === "schema" || changeType === "infra") return "snapshot";
  return "patch-rollback";
}
function makeRollbackRef() {
  return Math.random().toString(36).slice(2, 10);
}
const SYSTEM_ERROR_SYMPTOM_PATTERNS = [
  { test: (m) => m.includes("enoent") || m.includes("no such file or directory"), symptom: "file not found" },
  { test: (m) => m.includes("etimedout") || m.includes("timed out") || m.includes("timeout"), symptom: "request timed out" },
  { test: (m) => m.includes("econnrefused") || m.includes("connection refused"), symptom: "connection refused" },
  { test: (m) => m.includes("eacces") || m.includes("permission denied"), symptom: "permission denied" },
  { test: (m) => m.includes("enotfound") || m.includes("getaddrinfo"), symptom: "host not found" },
  { test: (m) => m.includes("econnreset"), symptom: "connection reset" },
  { test: (m) => m.includes("404") || m.includes("not found"), symptom: "not found" },
  { test: (m) => m.includes("401") || m.includes("403") || m.includes("unauthorized") || m.includes("forbidden"), symptom: "access denied" },
  { test: (m) => /\b5\d{2}\b/.test(m) || m.includes("internal server error"), symptom: "server error" },
  { test: (m) => m.includes("exited with code") || /non-?zero exit/.test(m), symptom: "command failed" }
];
function classifySystemErrorSymptom(message) {
  if (!harnessLexicalActive("system-error-symptoms")) return null;
  const lower = message.toLowerCase();
  for (const { test, symptom } of SYSTEM_ERROR_SYMPTOM_PATTERNS) {
    if (test(lower)) return symptom;
  }
  return null;
}
async function execute(proposedChange, toolFn, ctx) {
  const strategy = selectReversibilityStrategy(proposedChange);
  const taskId = ctx.currentTask.id;
  let rollback_ref = null;
  if (strategy !== "ephemeral") {
    rollback_ref = `${strategy}-${makeRollbackRef()}`;
    if (strategy === "snapshot") {
      ctx.memoryState.rollback_points.push({
        id: rollback_ref,
        step: ctx.memoryState.rollback_points.length,
        description: proposedChange.description ?? "snapshot",
        serialised_state: JSON.stringify(ctx.worldModel.toJSON())
      });
    } else {
      ctx.memoryState.rollback_points.push({
        id: rollback_ref,
        step: ctx.memoryState.rollback_points.length,
        description: proposedChange.description ?? strategy,
        serialised_state: ""
      });
    }
  }
  if (ctx.beliefDepGraph !== void 0 && ctx.beliefDepGraph.unverified_edge_ratio > UNVERIFIED_EDGE_RATIO_THRESHOLD && ctx.planToolWorkflow !== void 0) {
    ctx.planToolWorkflow();
  }
  let output = null;
  let error = null;
  let success = false;
  let status = "failed";
  let failureKind;
  const recordFailure = (message) => {
    const symptom = classifySystemErrorSymptom(message);
    ctx.evidenceStore.observations.push({
      id: `sys-err-${makeRollbackRef()}`,
      obs: symptom ? `${symptom} — Tool execution failed: ${message}` : `Tool execution failed: ${message}`,
      reliability: "HIGH",
      source: "execution_engine",
      evidence_type: "SYSTEM_ERROR",
      freshness: (/* @__PURE__ */ new Date()).toISOString()
    });
    ctx.worldModel.observations.push({
      id: `err-obs-${makeRollbackRef()}`,
      content: `SYSTEM_ERROR: ${message}`,
      source: "execution_engine",
      recorded_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    try {
      applyTaskOutcome(ctx.taskGraph, taskId, { status: "FAILED", fromExecutionLayer: true });
    } catch {
    }
  };
  try {
    const raw = await toolFn({
      worldModel: ctx.worldModel,
      evidenceStore: ctx.evidenceStore,
      controlState: ctx.controlState,
      diagnostics: ctx.diagnostics,
      failureDiagnostics: ctx.failureDiagnostics,
      currentTaskId: taskId
    });
    if (isContinuableOutcome(raw)) {
      status = raw.__harnessExecutionStatus;
      output = raw.output ?? null;
      success = status !== "failed";
      if (status === "failed") {
        error = raw.error ?? "execution reported a failed status";
        failureKind = raw.__harnessFailureKind === "exhausted" ? "exhausted" : "system_error";
        recordFailure(error);
      }
    } else {
      output = raw;
      success = true;
      status = "complete";
    }
  } catch (err) {
    if (isHarnessPauseSignal(err)) {
      ctx.worldModel.environment_change_log.push({
        id: `change-${makeRollbackRef()}`,
        description: proposedChange.description ?? "execution",
        affected_paths: [],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      throw err;
    }
    error = err instanceof Error ? err.message : String(err);
    status = "failed";
    failureKind = "system_error";
    recordFailure(error);
  }
  ctx.worldModel.environment_change_log.push({
    id: `change-${makeRollbackRef()}`,
    description: proposedChange.description ?? "execution",
    affected_paths: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
  return { success, output, error, strategy, rollback_ref, status, ...failureKind ? { failure_kind: failureKind } : {} };
}
function assertCriticalFailureTiersConsistent(r) {
  if (r.has_critical_failure !== r.critical_failure_tiers.length > 0) {
    throw new Error(
      `VerificationResult.has_critical_failure (${r.has_critical_failure}) is inconsistent with critical_failure_tiers (${JSON.stringify(r.critical_failure_tiers)}) — critical_failure_tiers must be empty iff has_critical_failure is false (see its own field comment above).`
    );
  }
}
const LAYER_TO_TOOL = {
  syntax: "linter",
  unit: "pytest",
  integration: "integration_runner",
  consistency: "consistency_checker",
  requirements: "requirements_checker",
  assumptions: "assumption_checker",
  goal_correctness: "goal_checker",
  evidence_sufficiency: "evidence_checker",
  output_contract_partial: "contract_checker"
};
function isToolAvailable(tool, toolManifest) {
  if (!toolManifest) return true;
  const entry = toolManifest[tool];
  if (entry === void 0) return true;
  return entry.available;
}
function skipped(layer) {
  return { layer, status: "SKIPPED", detail: `${LAYER_TO_TOOL[layer]} not available` };
}
function runSyntax(result, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.syntax, manifest)) return skipped("syntax");
  if (result === null || result === void 0) {
    return { layer: "syntax", status: "FAIL", detail: "Result is null — syntax check failed" };
  }
  return { layer: "syntax", status: "SKIPPED", detail: "no execution boundary in packages/harness — nothing to lint" };
}
function runUnit(manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.unit, manifest)) return skipped("unit");
  return { layer: "unit", status: "SKIPPED", detail: "no execution boundary in packages/harness — nothing to run" };
}
function runIntegration() {
  return { layer: "integration", status: "SKIPPED", detail: "integration_runner not available" };
}
function runConsistency(worldModel, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.consistency, manifest)) return skipped("consistency");
  if (worldModel === null || worldModel === void 0) {
    return { layer: "consistency", status: "SKIPPED", detail: "no world_model to check against" };
  }
  const unresolved = worldModel.contradictions.filter((c) => c.severity === "HIGH" || c.severity === "SYSTEM_BREAKING");
  if (unresolved.length > 0) {
    return {
      layer: "consistency",
      status: "FAIL",
      detail: `${unresolved.length} unresolved HIGH/SYSTEM_BREAKING contradiction(s) in world model`
    };
  }
  return { layer: "consistency", status: "PASS", detail: "no unresolved HIGH/SYSTEM_BREAKING contradictions" };
}
function runRequirements(result, successCriteria, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.requirements, manifest)) return skipped("requirements");
  if (successCriteria.length === 0) {
    return { layer: "requirements", status: "SKIPPED", detail: "no success criteria to check" };
  }
  if (result === null || result === void 0) {
    return { layer: "requirements", status: "FAIL", detail: "success criteria specified but no result was produced" };
  }
  return {
    layer: "requirements",
    status: "SKIPPED",
    detail: "result produced; semantic satisfaction of criteria requires model-tier judgment, not verified here"
  };
}
function runAssumptions(result, assumptions, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.assumptions, manifest)) return skipped("assumptions");
  if (assumptions.length === 0) {
    return { layer: "assumptions", status: "SKIPPED", detail: "no assumptions to check" };
  }
  if (result === null || result === void 0) {
    return { layer: "assumptions", status: "FAIL", detail: "assumptions stated but no result was produced" };
  }
  return {
    layer: "assumptions",
    status: "SKIPPED",
    detail: "result produced; environmental validation of assumptions not implemented at this layer"
  };
}
function runGoalCorrectness(manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.goal_correctness, manifest)) return skipped("goal_correctness");
  return {
    layer: "goal_correctness",
    status: "SKIPPED",
    detail: "goal correctness requires model-tier judgment, not implemented at this layer"
  };
}
function runEvidenceSufficiency(evidenceStore, scope, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.evidence_sufficiency, manifest)) return skipped("evidence_sufficiency");
  if (evidenceStore === null) {
    return { layer: "evidence_sufficiency", status: "FAIL", detail: "No evidence store provided" };
  }
  const entries = evidenceStore.observations;
  if (scope === "global") {
    const qualifying = entries.filter((e) => e.reliability === "HIGH" || e.reliability === "MEDIUM");
    if (qualifying.length < 5) {
      return {
        layer: "evidence_sufficiency",
        status: "FAIL",
        detail: `Global scope needs >= 5 HIGH/MEDIUM evidence items; found ${qualifying.length}`
      };
    }
  } else {
    if (entries.length < 2) {
      return {
        layer: "evidence_sufficiency",
        status: "FAIL",
        detail: `Local scope needs >= 2 evidence items; found ${entries.length}`
      };
    }
  }
  return { layer: "evidence_sufficiency", status: "PASS", detail: "Evidence sufficiency check passed" };
}
function runOutputContractPartial(result, outputContract, manifest) {
  if (!isToolAvailable(LAYER_TO_TOOL.output_contract_partial, manifest)) return skipped("output_contract_partial");
  if (outputContract === null) {
    return { layer: "output_contract_partial", status: "PASS", detail: "No output contract to check" };
  }
  const check = contractShadowCheck(result, outputContract);
  if (!check.passed) {
    return {
      layer: "output_contract_partial",
      status: "FAIL",
      detail: `Contract violations: ${check.violations.join(", ")}`
    };
  }
  return { layer: "output_contract_partial", status: "PASS", detail: "Output contract check passed" };
}
function runAdversarialPass(result, hypothesisSet) {
  if (hypothesisSet === null) return true;
  const active = hypothesisSet.active;
  if (active.length === 0) return true;
  const topH = active.reduce((best, h) => h.confidence > best.confidence ? h : best, active[0]);
  if (topH.predicted_observations.length === 0) return true;
  if (result === null || result === void 0) return false;
  if (typeof result === "object" && result["adversarial_failure"]) return false;
  return true;
}
function verify(result, successCriteria, assumptions, toolManifest, riskLevel, evidenceStore, worldModel, outputContract, hypothesisSet, scope = "local") {
  const manifest = toolManifest == null ? void 0 : toolManifest.tool_availability_manifest;
  const layer_results = [
    runSyntax(result, manifest),
    runUnit(manifest),
    runIntegration(),
    runConsistency(worldModel ?? null, manifest),
    runRequirements(result, successCriteria, manifest),
    runAssumptions(result, assumptions, manifest),
    runGoalCorrectness(manifest),
    runEvidenceSufficiency(evidenceStore ?? null, scope, manifest),
    runOutputContractPartial(result, outputContract ?? null, manifest)
  ];
  const has_critical_failure = layer_results.some((lr) => lr.status === "FAIL");
  const critical_failure_tiers = [
    ...new Set(
      layer_results.filter((lr) => lr.status === "FAIL").map((lr) => LAYER_TIER[lr.layer] ?? "mechanical")
    )
  ].sort();
  let adversarial_passed = null;
  if (riskLevel === "HIGH") {
    adversarial_passed = runAdversarialPass(result, hypothesisSet ?? null);
  }
  const verificationResult = { layer_results, has_critical_failure, adversarial_passed, critical_failure_tiers };
  assertCriticalFailureTiersConsistent(verificationResult);
  return verificationResult;
}
function classifyRecovery(failureClass) {
  if (!failureClass) return null;
  const entry = RECOVERY_CLASSIFICATION_TABLE[failureClass];
  if (entry === void 0) return null;
  return { failure_class: failureClass, policy: entry.policy, action: entry.action };
}
const FLAG_ENV = "HARNESS_TRAJECTORY_SUPERVISOR";
const TRUTHY = /* @__PURE__ */ new Set(["1", "true", "yes", "on", "enabled"]);
function supervisorEnabled(env) {
  const source = env ?? (typeof process !== "undefined" ? process.env : {});
  return TRUTHY.has(String(source[FLAG_ENV] ?? "").trim().toLowerCase());
}
const SUPERVISOR_ACTIONS = [
  "CONTINUE",
  "REDIRECT_STRATEGY",
  "REFRAME_PLAN",
  "GATHER_EVIDENCE",
  "ASK_USER",
  "ABORT"
];
const ACTION_SET = new Set(SUPERVISOR_ACTIONS);
const MAX_STR$1 = 600;
const MAX_TOOLS = 8;
function clip$2(text, limit = MAX_STR$1) {
  const s = String(text ?? "").trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + "…";
}
class InvestigationRequest {
  constructor(data) {
    __publicField(this, "question");
    __publicField(this, "suggested_tools");
    __publicField(this, "budget");
    this.question = (data == null ? void 0 : data.question) ?? "";
    this.suggested_tools = (data == null ? void 0 : data.suggested_tools) ?? [];
    this.budget = (data == null ? void 0 : data.budget) ?? 5;
  }
  toJSON() {
    return { question: this.question, suggested_tools: [...this.suggested_tools], budget: this.budget };
  }
  static fromJSON(json) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    const d = json;
    const tools = (Array.isArray(d.suggested_tools) ? d.suggested_tools : []).filter((t) => String(t ?? "").trim()).map((t) => clip$2(t, 120)).slice(0, MAX_TOOLS);
    let budget = Number(d.budget ?? 5);
    if (!Number.isFinite(budget)) budget = 5;
    budget = Math.max(0, Math.min(Math.trunc(budget), 50));
    return new InvestigationRequest({ question: clip$2(d.question ?? ""), suggested_tools: tools, budget });
  }
}
class UserQuestion {
  constructor(data) {
    __publicField(this, "question");
    __publicField(this, "options");
    this.question = (data == null ? void 0 : data.question) ?? "";
    this.options = (data == null ? void 0 : data.options) ?? [];
  }
  toJSON() {
    return { question: this.question, options: [...this.options] };
  }
  static fromJSON(json) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    const d = json;
    const opts = (Array.isArray(d.options) ? d.options : []).filter((o) => String(o ?? "").trim()).map((o) => clip$2(o, 200)).slice(0, MAX_TOOLS);
    return new UserQuestion({ question: clip$2(d.question ?? ""), options: opts });
  }
}
class SupervisorDirective {
  constructor(data) {
    __publicField(this, "action");
    __publicField(this, "rationale");
    __publicField(this, "strategy_hint");
    __publicField(this, "plan_note");
    __publicField(this, "investigation");
    __publicField(this, "question");
    this.action = (data == null ? void 0 : data.action) ?? "CONTINUE";
    this.rationale = (data == null ? void 0 : data.rationale) ?? "";
    this.strategy_hint = (data == null ? void 0 : data.strategy_hint) ?? null;
    this.plan_note = (data == null ? void 0 : data.plan_note) ?? null;
    this.investigation = (data == null ? void 0 : data.investigation) ?? null;
    this.question = (data == null ? void 0 : data.question) ?? null;
  }
  /** A CONTINUE directive — the deterministic ladder proceeds unchanged. */
  static cont(rationale = "") {
    return new SupervisorDirective({ action: "CONTINUE", rationale: clip$2(rationale) });
  }
  toJSON() {
    return {
      action: this.action,
      rationale: this.rationale,
      strategy_hint: this.strategy_hint,
      plan_note: this.plan_note,
      investigation: this.investigation ? this.investigation.toJSON() : null,
      question: this.question ? this.question.toJSON() : null
    };
  }
  static fromJSON(json) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) return SupervisorDirective.cont();
    const d = json;
    const action = d.action;
    if (typeof action !== "string" || !ACTION_SET.has(action)) {
      return SupervisorDirective.cont(clip$2(d.rationale ?? ""));
    }
    const rationale = clip$2(d.rationale ?? "");
    const strategyHint = d.strategy_hint ? clip$2(d.strategy_hint, 200) : null;
    const planNote = d.plan_note ? clip$2(d.plan_note) : null;
    const investigation = InvestigationRequest.fromJSON(d.investigation);
    const question = UserQuestion.fromJSON(d.question);
    if (action === "REDIRECT_STRATEGY" && !strategyHint) return SupervisorDirective.cont(rationale);
    if (action === "REFRAME_PLAN" && !planNote) return SupervisorDirective.cont(rationale);
    if (action === "GATHER_EVIDENCE" && (!investigation || !investigation.question)) {
      return SupervisorDirective.cont(rationale);
    }
    if (action === "ASK_USER" && (!question || !question.question)) return SupervisorDirective.cont(rationale);
    return new SupervisorDirective({
      action,
      rationale,
      strategy_hint: strategyHint,
      plan_note: planNote,
      investigation: action === "GATHER_EVIDENCE" ? investigation : null,
      question: action === "ASK_USER" ? question : null
    });
  }
}
const UNWIRED_ACTIONS = /* @__PURE__ */ new Set([]);
function coerceForWiredActions(directive) {
  if (UNWIRED_ACTIONS.has(directive.action)) {
    return SupervisorDirective.cont(`[not wired: ${directive.action}] ${directive.rationale}`);
  }
  return directive;
}
async function resolveSupervisorDirective(decider, digest, onDirective) {
  let raw = null;
  try {
    raw = await decider(digest);
  } catch {
    raw = null;
  }
  const directive = coerceForWiredActions(SupervisorDirective.fromJSON(raw));
  try {
    onDirective == null ? void 0 : onDirective(directive);
  } catch {
  }
  return directive;
}
const MAX_GOAL = 12;
const MAX_LIST = 10;
const MAX_STR = 240;
function clip$1(text, limit = MAX_STR) {
  const s = String(text ?? "").trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + "…";
}
function cap(items, limit = MAX_LIST) {
  return items.slice(0, limit);
}
class TrajectoryDigest {
  constructor(data) {
    __publicField(this, "goal");
    __publicField(this, "steps_taken");
    __publicField(this, "stall_reason");
    __publicField(this, "stall_history");
    __publicField(this, "strategies_tried");
    __publicField(this, "failure_classes");
    __publicField(this, "reopened_tasks");
    __publicField(this, "open_contradictions");
    __publicField(this, "blocking_unknowns");
    __publicField(this, "budget_remaining");
    this.goal = (data == null ? void 0 : data.goal) ?? [];
    this.steps_taken = (data == null ? void 0 : data.steps_taken) ?? 0;
    this.stall_reason = (data == null ? void 0 : data.stall_reason) ?? "";
    this.stall_history = (data == null ? void 0 : data.stall_history) ?? [];
    this.strategies_tried = (data == null ? void 0 : data.strategies_tried) ?? [];
    this.failure_classes = (data == null ? void 0 : data.failure_classes) ?? [];
    this.reopened_tasks = (data == null ? void 0 : data.reopened_tasks) ?? [];
    this.open_contradictions = (data == null ? void 0 : data.open_contradictions) ?? [];
    this.blocking_unknowns = (data == null ? void 0 : data.blocking_unknowns) ?? [];
    this.budget_remaining = (data == null ? void 0 : data.budget_remaining) ?? {};
  }
  toJSON() {
    return {
      goal: [...this.goal],
      steps_taken: this.steps_taken,
      stall_reason: this.stall_reason,
      stall_history: [...this.stall_history],
      strategies_tried: this.strategies_tried.map((s) => ({ ...s })),
      failure_classes: this.failure_classes.map((f) => ({ ...f })),
      reopened_tasks: [...this.reopened_tasks],
      open_contradictions: [...this.open_contradictions],
      blocking_unknowns: [...this.blocking_unknowns],
      budget_remaining: { ...this.budget_remaining }
    };
  }
  static fromJSON(json) {
    const d = json && typeof json === "object" ? json : {};
    let steps2 = Number(d.steps_taken ?? 0);
    if (!Number.isFinite(steps2)) steps2 = 0;
    const asArr = (v) => Array.isArray(v) ? v : [];
    return new TrajectoryDigest({
      goal: cap(asArr(d.goal).map((g) => clip$1(g)), MAX_GOAL),
      steps_taken: Math.max(0, Math.trunc(steps2)),
      stall_reason: clip$1(d.stall_reason ?? ""),
      stall_history: cap(asArr(d.stall_history).map((s) => clip$1(s, 80))),
      strategies_tried: cap(
        asArr(d.strategies_tried).filter((s) => s && typeof s === "object").map((s) => {
          const o = s;
          return { strategy: clip$1(o.strategy ?? "", 40), outcome: clip$1(o.outcome ?? "", 80) };
        })
      ),
      failure_classes: cap(
        asArr(d.failure_classes).filter((f) => f && typeof f === "object").map((f) => {
          const o = f;
          let n = Number(o.count ?? 0);
          if (!Number.isFinite(n)) n = 0;
          return { class: clip$1(o.class ?? "", 80), count: Math.trunc(n) };
        })
      ),
      reopened_tasks: cap(asArr(d.reopened_tasks).map((t) => clip$1(t))),
      open_contradictions: cap(asArr(d.open_contradictions).map((c) => clip$1(c))),
      blocking_unknowns: cap(asArr(d.blocking_unknowns).map((u) => clip$1(u))),
      budget_remaining: d.budget_remaining && typeof d.budget_remaining === "object" ? { ...d.budget_remaining } : {}
    });
  }
}
function strategiesTried(ss) {
  const switchCount = Math.max(0, Math.trunc(ss.switch_count ?? 0));
  const triggers = ss.switch_triggers ?? [];
  const out = [];
  const n = Math.min(switchCount, DEFAULT_STRATEGY_ORDER.length);
  for (let i = 0; i < n; i++) {
    out.push({
      strategy: DEFAULT_STRATEGY_ORDER[i],
      outcome: i < triggers.length ? clip$1(triggers[i], 80) : "switched"
    });
  }
  const current = ss.current_strategy ?? "";
  if (current && (out.length === 0 || out[out.length - 1].strategy !== current)) {
    out.push({ strategy: clip$1(current, 40), outcome: "current" });
  }
  return cap(out);
}
function failureClasses(fd) {
  const history = (fd == null ? void 0 : fd.failure_history) ?? [];
  const counts = /* @__PURE__ */ new Map();
  for (const entry of history) {
    const fc = entry == null ? void 0 : entry.failure_class;
    if (fc) counts.set(fc, (counts.get(fc) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LIST).map(([fc, n]) => ({ class: clip$1(fc, 80), count: n }));
}
function openContradictions(wm) {
  const out = [];
  for (const c of wm.contradictions ?? []) {
    if (c.severity !== "HIGH") continue;
    const desc = c.description ?? "";
    const cid = c.id ?? "?";
    if (desc) out.push(clip$1(`${cid}: ${desc}`));
    else out.push(clip$1(`${cid}: beliefs ${(c.involved_belief_ids ?? []).slice(0, 4).join(", ")}`));
  }
  return cap(out);
}
function buildDigest(strategyState, failureDiagnostics, taskGraph, worldModel, opts = {}) {
  const completionHistory = strategyState.completion_history ?? [];
  const failed = (taskGraph.tasks ?? []).filter((t) => t.status === "FAILED").map((t) => clip$1(t.description || t.id));
  const reopened = [...opts.reopenedTaskDescriptions ?? [], ...failed].filter(Boolean);
  let budget = {};
  const rb = opts.recoveryBudget;
  if (rb && typeof rb === "object") {
    budget = typeof rb.toJSON === "function" ? rb.toJSON() : { ...rb };
  }
  return new TrajectoryDigest({
    goal: cap((opts.successCriteria ?? []).map((c) => clip$1(c)), MAX_GOAL),
    steps_taken: completionHistory.length,
    stall_reason: clip$1(strategyState.stall_reason ?? ""),
    stall_history: cap((strategyState.switch_triggers ?? []).map((t) => clip$1(t, 80))),
    strategies_tried: strategiesTried(strategyState),
    failure_classes: failureClasses(failureDiagnostics),
    reopened_tasks: cap(reopened),
    open_contradictions: openContradictions(worldModel),
    blocking_unknowns: cap([
      ...(worldModel.assumptions ?? []).filter((a) => String(a ?? "").trim()).map((a) => clip$1(a)),
      ...(opts.missingInfo ?? []).map((m) => clip$1(m))
    ]),
    budget_remaining: budget
  });
}
const INVESTIGATION_READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "retrieve",
  "rag_retrieve",
  "kb_retrieve",
  "search",
  "web_search",
  "fetch_url",
  "http_get",
  "read_file",
  "list_directory",
  "get_session_state",
  "list_reminders",
  "lookup"
]);
const INVESTIGATION_FORBIDDEN_TOOLS = /* @__PURE__ */ new Set([
  "write_file",
  "run_shell_command",
  "shell",
  "exec",
  "send_email",
  "deploy",
  "apply_patch"
]);
const MAX_DEPTH = 1;
const MAX_CALL_BUDGET = 20;
const DEFAULT_PER_CALL_TIMEOUT_MS = 15e3;
const MAX_FINDING_LEN = 800;
class InvestigationDepthExceededError extends Error {
  constructor(depth) {
    super(
      `investigation depth ${depth} >= ${MAX_DEPTH}: an investigation cannot spawn an investigation (INV-24)`
    );
    this.name = "InvestigationDepthExceededError";
  }
}
function clip(text, limit = MAX_FINDING_LEN) {
  const s = String(text ?? "").trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + "…";
}
function validateInvestigationTools(tools) {
  const allowed = [];
  const rejected = [];
  for (const raw of tools ?? []) {
    const name2 = String(raw ?? "").trim();
    if (!name2) continue;
    if (INVESTIGATION_READ_ONLY_TOOLS.has(name2)) allowed.push(name2);
    else rejected.push(name2);
  }
  return { allowed, rejected };
}
async function callToolBounded(toolRunner, tool, question, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => toolRunner(tool, question)), timeout]);
    return result ?? null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function runInvestigation(request, opts) {
  var _a;
  const depth = opts.depth ?? 0;
  if (depth >= MAX_DEPTH) throw new InvestigationDepthExceededError(depth);
  const question = clip(request.question ?? "", 600);
  const rawBudget = Number(request.budget ?? 5);
  const budget = Math.max(0, Math.min(Number.isFinite(rawBudget) ? Math.trunc(rawBudget) : 5, MAX_CALL_BUDGET));
  const { allowed, rejected } = validateInvestigationTools(request.suggested_tools);
  const outcome = { findings: [], callsMade: 0, exhausted: false, rejectedTools: rejected };
  if (!question || allowed.length === 0 || budget === 0) {
    outcome.exhausted = allowed.length > 0 && budget === 0;
    return outcome;
  }
  const timeoutMs = opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  for (const tool of allowed) {
    if (outcome.callsMade >= budget) {
      outcome.exhausted = true;
      break;
    }
    outcome.callsMade++;
    const raw = await callToolBounded(opts.toolRunner, tool, question, timeoutMs);
    const text = clip(raw);
    if (!text) continue;
    const reliability = ((_a = opts.toolReliability) == null ? void 0 : _a[tool]) === "HIGH" ? "HIGH" : "MEDIUM";
    outcome.findings.push({ content: text, tool, reliability });
  }
  if (!outcome.exhausted && outcome.callsMade < allowed.length) outcome.exhausted = true;
  return outcome;
}
let _obsCounter = 0;
function mergeInvestigationFindings(worldModel, findings, meta) {
  const q = clip(meta.question, 300).replace(/]/g, " ");
  const merged = [];
  const runTag = `${(++_obsCounter).toString(36)}${Date.now().toString(36)}`;
  for (const finding of findings) {
    const obs = {
      id: `supervisor_investigation:${(++_obsCounter).toString(36)}${Date.now().toString(36)}`,
      content: `[supervisor_investigation q=${q} run=${runTag}] [tool=${finding.tool} reliability=${finding.reliability} derived_from=supervisor_investigation] ${finding.content}`,
      source: "supervisor_investigation",
      recorded_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    worldModel.observations.push(obs);
    merged.push(obs);
  }
  worldModel.incrementGenerationId();
  return merged;
}
function countInvestigations(worldModel) {
  const seen = /* @__PURE__ */ new Set();
  for (const obs of worldModel.observations ?? []) {
    if (obs.source === "supervisor_investigation" && obs.content.startsWith("[supervisor_investigation ")) {
      seen.add(obs.content.split("]", 1)[0]);
    }
  }
  return seen.size;
}
const INVESTIGATION_CAP_K = 3;
const INVESTIGATION_DONE_PREFIX = "[investigation done]";
async function resolveGatherEvidence(worldModel, directive, host) {
  if (!host || !directive.investigation) {
    return SupervisorDirective.cont(`[not wired: GATHER_EVIDENCE] ${directive.rationale}`);
  }
  if (countInvestigations(worldModel) >= INVESTIGATION_CAP_K) {
    return SupervisorDirective.cont(`[investigation cap ${INVESTIGATION_CAP_K} reached] ${directive.rationale}`);
  }
  const req = directive.investigation.toJSON();
  let findings;
  try {
    findings = await host(req) ?? [];
  } catch {
    return SupervisorDirective.cont(`[investigation failed] ${directive.rationale}`);
  }
  if (findings.length > 0) mergeInvestigationFindings(worldModel, findings, { question: req.question });
  return SupervisorDirective.cont(`${INVESTIGATION_DONE_PREFIX} ${directive.rationale}`);
}
const STALL_WINDOW = 5;
const MAX_SWITCHES = 3;
const RECURRENCE_THRESHOLD = 3;
const OSCILLATION_WINDOW = 6;
const CAUTIOUS_THRESHOLD = 1;
const RISK_ORDER$1 = { NORMAL: 0, CAUTIOUS: 1, BLOCKED: 2 };
function stalledCompletion(strategyState) {
  const history = strategyState.completion_history;
  if (history.length < STALL_WINDOW) return false;
  const window = history.slice(-STALL_WINDOW);
  return new Set(window).size === 1;
}
function strategyLooping(strategyState) {
  if (strategyState.switch_count <= MAX_SWITCHES) return false;
  const history = strategyState.completion_history;
  if (history.length === 0) return true;
  return history[history.length - 1] === history[0];
}
function failureRecurring(failureDiagnostics) {
  const history = failureDiagnostics.failure_history;
  if (history.length < RECURRENCE_THRESHOLD) return false;
  const recent = history.slice(-RECURRENCE_THRESHOLD);
  const classes = recent.map((e) => e.failure_class);
  return new Set(classes).size === 1 && classes[0] !== void 0 && classes[0] !== "";
}
function riskOscillating(strategyState) {
  const history = strategyState.risk_state_history;
  if (history.length < OSCILLATION_WINDOW) return false;
  const window = history.slice(-OSCILLATION_WINDOW);
  const levels = window.map((r) => RISK_ORDER$1[r] ?? 0);
  let alternations = 0;
  for (let i = 1; i < levels.length; i++) {
    const prevBelowCaution = levels[i - 1] < CAUTIOUS_THRESHOLD;
    const curBelowCaution = levels[i] < CAUTIOUS_THRESHOLD;
    if (prevBelowCaution !== curBelowCaution) alternations++;
  }
  return alternations >= 2;
}
function cannotMakeProgress(strategyState, failureDiagnostics) {
  if (stalledCompletion(strategyState)) {
    strategyState.stall_reason = "completion_velocity";
    return true;
  }
  if (strategyLooping(strategyState)) {
    strategyState.stall_reason = "strategy_loop";
    return true;
  }
  if (failureRecurring(failureDiagnostics)) {
    strategyState.stall_reason = "failure_recurrence";
    return true;
  }
  if (riskOscillating(strategyState)) {
    strategyState.stall_reason = "risk_oscillation";
    return true;
  }
  strategyState.stall_reason = "";
  return false;
}
function softmax$1(values) {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
function buildStrategyOrdering(failureClass, experienceStore, _currentStrategy) {
  if (!experienceStore.available) return [...DEFAULT_STRATEGY_ORDER];
  const weights = experienceStore.getStrategyWeights();
  const classWeights = DEFAULT_STRATEGY_ORDER.map((s) => {
    const key = `${s}:${failureClass}`;
    return weights[key] ?? 0;
  });
  if (classWeights.every((v) => v === 0)) return [...DEFAULT_STRATEGY_ORDER];
  const probs = softmax$1(classWeights);
  const indexed = DEFAULT_STRATEGY_ORDER.map((s, i) => ({ s, p: probs[i] }));
  indexed.sort((a, b) => b.p - a.p);
  return indexed.map((x) => x.s);
}
const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function pickLearnedStrategy(ordering, current, switchCount) {
  const i = Math.min(switchCount, ordering.length - 1);
  const candidate = ordering[i];
  return candidate === current ? ordering[Math.min(i + 1, ordering.length - 1)] : candidate;
}
function getNextStrategy(current, ordering) {
  const idx = ordering.indexOf(current);
  const nextIdx = Math.min(idx + 1, ordering.length - 1);
  return ordering[nextIdx];
}
function diagnoseAndReplan(currentTask, taskGraph) {
  const currentId = currentTask.id;
  for (const task of taskGraph.tasks) {
    if (task.depends_on.includes(currentId) && task.status !== "COMPLETE") {
      task.status = "PENDING";
    }
  }
  taskGraph.tasks = taskGraph.tasks.filter(
    (t) => !(t.status === "FAILED" && t.depends_on.includes(currentId))
  );
  taskGraph.changed = true;
  return taskGraph;
}
function requeueFailedLeaves(taskGraph) {
  const idsWithLiveDependents = /* @__PURE__ */ new Set();
  for (const t of taskGraph.tasks) {
    if (t.status !== "FAILED") for (const dep of t.depends_on) idsWithLiveDependents.add(dep);
  }
  let changed = false;
  for (const t of taskGraph.tasks) {
    if (t.status === "FAILED" && !idsWithLiveDependents.has(t.id)) {
      t.status = "PENDING";
      changed = true;
    }
  }
  if (changed) taskGraph.changed = true;
  return changed;
}
function requeueFailedTask(taskGraph, taskId) {
  const t = taskGraph.tasks.find((x) => x.id === taskId);
  if (!t || t.status !== "FAILED") return false;
  t.status = "PENDING";
  taskGraph.changed = true;
  return true;
}
function requeueFailedTasks(taskGraph) {
  let changed = false;
  for (const t of taskGraph.tasks) {
    if (t.status === "FAILED") {
      t.status = "PENDING";
      changed = true;
    }
  }
  if (changed) taskGraph.changed = true;
  return changed;
}
function validateTaskGraph$1(taskGraph) {
  const errors = [];
  const ids = new Set(taskGraph.tasks.map((t) => t.id));
  for (const task of taskGraph.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  return errors;
}
function rebuildTaskGraph(worldModel, callerState, planNote) {
  const successCriteria = [...callerState.success_criteria ?? []];
  if (planNote) successCriteria.push(`Reframe: ${planNote}`);
  const newTasks = successCriteria.map((criterion, i) => ({
    id: `rebuilt-task-${i}-${Math.random().toString(36).slice(2, 6)}`,
    description: String(criterion),
    status: "PENDING",
    risk_level: "MEDIUM",
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null
  }));
  const beliefTasks = worldModel.beliefs.slice(0, 5).map((belief, i) => ({
    id: `belief-verify-${i}-${Math.random().toString(36).slice(2, 6)}`,
    description: `Verify: ${belief.statement.slice(0, 120)}`,
    status: "PENDING",
    risk_level: "LOW",
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 2,
    assigned_strategy: null
  }));
  return new TaskGraph({ tasks: [...newTasks, ...beliefTasks], changed: true });
}
const FAILURE_MODE_BIAS_MIN_CONFIDENCE = 0.7;
function rollbackAndReplan(currentTask, strategyState, failureDiagnostics, taskGraph, worldModel, callerState, experienceStore, rollbackFn, supervisorDirective, requeueLeafOnLocal = false, learnedLadder = false, retryFailedTask = false) {
  var _a, _b, _c;
  rollbackFn == null ? void 0 : rollbackFn();
  failureDiagnostics.failure_history.push({
    id: `fail-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    failure_class: ((_a = failureDiagnostics.matched_pattern) == null ? void 0 : _a.failure_class) ?? "unknown",
    description: `Task failed: ${currentTask.description}`,
    context: { task_id: currentTask.id }
  });
  const noProgress = cannotMakeProgress(strategyState, failureDiagnostics);
  const failureClass = ((_b = failureDiagnostics.matched_pattern) == null ? void 0 : _b.failure_class) ?? "";
  const isReframe = (supervisorDirective == null ? void 0 : supervisorDirective.action) === "REFRAME_PLAN" && !!supervisorDirective.plan_note;
  const redirectHint = !isReframe && (supervisorDirective == null ? void 0 : supervisorDirective.action) === "REDIRECT_STRATEGY" && supervisorDirective.strategy_hint && DEFAULT_STRATEGY_ORDER.includes(supervisorDirective.strategy_hint) ? supervisorDirective.strategy_hint : null;
  const failureModeHint = !redirectHint && !isReframe && failureDiagnostics.matched_pattern && failureDiagnostics.matched_pattern.confidence >= FAILURE_MODE_BIAS_MIN_CONFIDENCE && failureDiagnostics.matched_pattern.strategy_affinity && DEFAULT_STRATEGY_ORDER.includes(failureDiagnostics.matched_pattern.strategy_affinity) ? failureDiagnostics.matched_pattern.strategy_affinity : null;
  let ordering;
  if (experienceStore !== null && experienceStore.available) {
    ordering = buildStrategyOrdering(failureClass, experienceStore, strategyState.current_strategy);
  } else {
    ordering = [...DEFAULT_STRATEGY_ORDER];
  }
  const supTrigger = (tag) => `supervisor:${tag} ${(supervisorDirective == null ? void 0 : supervisorDirective.rationale) ?? ""}`.trim().slice(0, 200);
  let newStrategyState;
  let failureModeSwitch;
  let learnedSwitch;
  if (isReframe) {
    newStrategyState = new StrategyState({
      ...strategyState.toJSON(),
      switch_triggers: [...strategyState.switch_triggers, supTrigger("REFRAME_PLAN")],
      completion_history: [...strategyState.completion_history],
      risk_state_history: [...strategyState.risk_state_history]
    });
  } else {
    const learnedRanking = learnedLadder && !redirectHint && !sameOrder(ordering, DEFAULT_STRATEGY_ORDER);
    const nextStrategy = redirectHint ?? (learnedRanking ? pickLearnedStrategy(ordering, strategyState.current_strategy, strategyState.switch_count) : failureModeHint ?? getNextStrategy(strategyState.current_strategy, ordering));
    learnedSwitch = learnedRanking ? { failure_class: failureClass, strategy: nextStrategy } : void 0;
    failureModeSwitch = !redirectHint && !learnedRanking && failureModeHint && failureDiagnostics.matched_pattern ? { failure_class: failureDiagnostics.matched_pattern.failure_class, strategy: failureModeHint } : void 0;
    newStrategyState = new StrategyState({
      ...strategyState.toJSON(),
      current_strategy: nextStrategy,
      switch_count: strategyState.switch_count + 1,
      switch_triggers: [
        ...strategyState.switch_triggers,
        redirectHint ? supTrigger("REDIRECT_STRATEGY") : learnedRanking ? `learned:${failureClass || "unmatched"} -> ${nextStrategy}` : failureModeHint ? `failure_mode:${(_c = failureDiagnostics.matched_pattern) == null ? void 0 : _c.failure_class} -> ${failureModeHint}` : `task_failed: ${currentTask.id}`
      ],
      stall_reason: strategyState.stall_reason,
      completion_history: [...strategyState.completion_history],
      risk_state_history: [...strategyState.risk_state_history]
    });
  }
  let newTaskGraph;
  let replanScope = null;
  if (isReframe) {
    replanScope = "GLOBAL";
    newTaskGraph = rebuildTaskGraph(worldModel, callerState, supervisorDirective.plan_note);
    const errors = validateTaskGraph$1(newTaskGraph);
    if (errors.length > 0) {
      throw new Error(`Rebuilt task graph is invalid: ${errors.join("; ")}`);
    }
  } else if (noProgress) {
    replanScope = "GLOBAL";
    newTaskGraph = rebuildTaskGraph(worldModel, callerState);
    const errors = validateTaskGraph$1(newTaskGraph);
    if (errors.length > 0) {
      throw new Error(`Rebuilt task graph is invalid: ${errors.join("; ")}`);
    }
  } else {
    replanScope = "LOCAL";
    newTaskGraph = diagnoseAndReplan(currentTask, taskGraph);
    if (retryFailedTask) {
      if (requeueFailedTasks(newTaskGraph)) newStrategyState.switch_triggers.push(`retry_failed_task: ${currentTask.id}`);
    } else {
      let requeued = false;
      if (failureModeSwitch && requeueFailedTask(newTaskGraph, currentTask.id)) {
        requeued = true;
        newStrategyState.switch_triggers.push(`failure_mode:requeue_task ${failureModeSwitch.failure_class}`.slice(0, 200));
      }
      if (!requeued && requeueLeafOnLocal && !newTaskGraph.tasks.some((t) => t.status === "PENDING")) {
        if (requeueFailedLeaves(newTaskGraph)) {
          newStrategyState.switch_triggers.push(
            `supervisor:requeue_leaf ${(supervisorDirective == null ? void 0 : supervisorDirective.rationale) ?? ""}`.trim().slice(0, 200)
          );
        }
      }
    }
  }
  return {
    rolledBack: true,
    cannotProgress: noProgress,
    newStrategyState,
    newTaskGraph,
    replanScope,
    failureModeSwitch,
    learnedSwitch
  };
}
function resolveAskMode({ globalEnabled, sessionAskMode, structured = true }) {
  if (!structured) return false;
  if (sessionAskMode === false) return false;
  return globalEnabled;
}
function buildAskBlocker(questions, opts) {
  var _a;
  const effective = resolveAskMode(opts);
  const base = {
    reason: opts.reason,
    missing_info: opts.missingInfo,
    current_task_summary: opts.currentTaskSummary,
    escalated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (effective && questions.length > 0) {
    return { ...base, questions: makeQuestionsBatch(questions) };
  }
  const first = questions[0];
  if (!first) return base;
  const options = (_a = first.options) == null ? void 0 : _a.map((o) => o.label);
  return {
    ...base,
    question: first.question,
    ...options && options.length > 0 ? { options } : {}
  };
}
function askQuestion(questions, opts) {
  throw new EscalationHalt(buildAskBlocker(questions, opts));
}
const DEFAULT_BUDGET_EXTENSION = 10;
function buildBudgetExhaustedQuestion(stepsUsed, extension = DEFAULT_BUDGET_EXTENSION) {
  return {
    id: "budget-exhausted-resolution",
    question: `The step budget is exhausted (at step ${stepsUsed}). How should I proceed?`,
    options: [
      { label: `Continue with ${extension} more steps` },
      { label: "Stop and summarize progress so far" },
      { label: "Let me clarify the goal" }
    ]
  };
}
class ProcessConceptValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessConceptValidationError";
  }
}
class ProcessConceptNotFoundError extends Error {
  constructor(conceptId) {
    super(`Process concept "${conceptId}" not found in registry`);
    this.name = "ProcessConceptNotFoundError";
  }
}
const ABSTRACTION_MAP = {
  module: 0,
  goal: 0,
  subgoal: 1,
  function: 1,
  leaf: 2,
  statement: 2
};
const VALID_RISK_LEVELS = /* @__PURE__ */ new Set(["LOW", "MEDIUM", "HIGH"]);
const VALID_ABSTRACTION_LEVELS = /* @__PURE__ */ new Set([
  "module",
  "goal",
  "subgoal",
  "function",
  "leaf",
  "statement"
]);
class ProcessConcept {
  constructor(data) {
    __publicField(this, "id");
    __publicField(this, "name");
    __publicField(this, "description");
    __publicField(this, "successCriteria");
    __publicField(this, "schemaVersion");
    __publicField(this, "steps");
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.successCriteria = data.successCriteria;
    this.schemaVersion = data.schemaVersion;
    this.steps = data.steps;
  }
  validate() {
    const errors = [];
    if (!this.id || !this.id.trim()) {
      errors.push("Concept 'id' must be a non-empty string");
    }
    const stepIds = [];
    const seen = /* @__PURE__ */ new Set();
    for (const step of this.steps) {
      if (!step.id || !step.id.trim()) {
        errors.push("Each step must have a non-empty id");
        continue;
      }
      if (seen.has(step.id)) {
        errors.push(`Duplicate step id "${step.id}"`);
      } else {
        seen.add(step.id);
        stepIds.push(step.id);
      }
      if (!VALID_RISK_LEVELS.has(step.riskLevel)) {
        errors.push(`Step "${step.id}": riskLevel "${step.riskLevel}" must be one of HIGH, LOW, MEDIUM`);
      }
      if (!VALID_ABSTRACTION_LEVELS.has(step.abstractionLevel)) {
        errors.push(
          `Step "${step.id}": abstractionLevel "${step.abstractionLevel}" must be one of function, goal, leaf, module, statement, subgoal`
        );
      }
    }
    const idSet = new Set(stepIds);
    for (const step of this.steps) {
      for (const dep of step.dependsOn) {
        if (!idSet.has(dep)) {
          errors.push(`Step "${step.id}" depends_on unknown step "${dep}"`);
        }
      }
    }
    const adj = {};
    for (const step of this.steps) {
      if (idSet.has(step.id)) adj[step.id] = step.dependsOn.filter((d) => idSet.has(d));
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const colour = {};
    for (const id2 of stepIds) colour[id2] = WHITE;
    const hasCycle2 = (start) => {
      const stack = [[start, 0, adj[start] ?? []]];
      colour[start] = GRAY;
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const [node, idx, children] = frame;
        if (idx >= children.length) {
          colour[node] = BLACK;
          stack.pop();
          continue;
        }
        frame[1]++;
        const child = children[idx];
        if (!(child in colour)) continue;
        if (colour[child] === GRAY) return true;
        if (colour[child] === WHITE) {
          colour[child] = GRAY;
          stack.push([child, 0, adj[child] ?? []]);
        }
      }
      return false;
    };
    for (const id2 of stepIds) {
      if (colour[id2] === WHITE) {
        if (hasCycle2(id2)) {
          errors.push(`Dependency cycle detected involving step "${id2}"`);
        }
      }
    }
    return errors;
  }
  static fromJson(json) {
    if (!json.id) {
      throw new ProcessConceptValidationError("Concept JSON missing required field 'id'");
    }
    const rawSteps = json.steps ?? [];
    const steps2 = rawSteps.map((s, i) => {
      const step = s;
      if (!step.id) {
        throw new ProcessConceptValidationError(`Step at index ${i} missing required field 'id'`);
      }
      const riskLevel = step.risk_level ?? step.riskLevel ?? "LOW";
      const abstractionLevel = step.abstraction_level ?? step.abstractionLevel ?? "module";
      if (!VALID_RISK_LEVELS.has(riskLevel)) {
        throw new ProcessConceptValidationError(
          `Step "${step.id}": invalid riskLevel "${riskLevel}"`
        );
      }
      return {
        id: String(step.id),
        description: String(step.description ?? ""),
        dependsOn: (step.depends_on ?? step.dependsOn ?? []).map(String),
        riskLevel,
        abstractionLevel,
        expectedTools: (step.expected_tools ?? step.expectedTools ?? []).map(String),
        successCriteria: (step.success_criteria ?? step.successCriteria ?? []).map(String),
        strategyHint: step.strategy_hint ?? step.strategyHint ?? null
      };
    });
    const concept = new ProcessConcept({
      id: String(json.id),
      name: String(json.name ?? json.id),
      description: String(json.description ?? ""),
      successCriteria: (json.success_criteria ?? json.successCriteria ?? []).map(String),
      schemaVersion: String(json.schema_version ?? json.schemaVersion ?? "1"),
      steps: steps2
    });
    const errors = concept.validate();
    if (errors.length > 0) {
      throw new ProcessConceptValidationError(`Concept validation failed: ${errors.join("; ")}`);
    }
    return concept;
  }
  seedTaskGraph(taskGraph) {
    for (const step of this.steps) {
      const task = {
        id: `${this.id}:${step.id}`,
        description: step.description,
        status: "PENDING",
        risk_level: step.riskLevel,
        depends_on: step.dependsOn.map((dep) => `${this.id}:${dep}`),
        parallel_write_domains: [],
        abstraction_level: ABSTRACTION_MAP[step.abstractionLevel] ?? 0,
        assigned_strategy: step.strategyHint
      };
      taskGraph.tasks.push(task);
    }
    taskGraph.changed = true;
  }
}
const schema_version$3 = "1";
const id$4 = "debug_test_failure";
const name$3 = "Debug Test Failure";
const description$3 = "Canonical decomposition for diagnosing and fixing a failing test. Guides the model from symptom gathering through root-cause isolation to minimal fix and verification.";
const success_criteria$3 = [
  "All previously failing tests pass",
  "No previously passing tests are broken",
  "Root cause is documented in completed_evidence"
];
const steps$3 = [
  {
    id: "gather_context",
    description: "Read the failing test file and the module under test. Understand what the test asserts and what the code is supposed to do.",
    depends_on: [],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Test body and assertion logic understood",
      "Module under test located and read"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "reproduce_failure",
    description: "Run the failing test in isolation to confirm the failure and capture the exact error message and traceback.",
    depends_on: [
      "gather_context"
    ],
    risk_level: "LOW",
    abstraction_level: "function",
    expected_tools: [
      "run_tests",
      "read_file"
    ],
    success_criteria: [
      "Failure confirmed reproducible",
      "Exact error message and traceback captured"
    ],
    strategy_hint: "TRACE_EXEC"
  },
  {
    id: "isolate_root_cause",
    description: "Trace the failure to its root cause. Distinguish between test bug, implementation bug, and environmental issue.",
    depends_on: [
      "reproduce_failure"
    ],
    risk_level: "MEDIUM",
    abstraction_level: "function",
    expected_tools: [
      "search_code",
      "read_file"
    ],
    success_criteria: [
      "Root cause identified as one of: test bug, implementation bug, or environment",
      "Affected code location pinpointed to a specific function or method"
    ],
    strategy_hint: "TRACE_EXEC"
  },
  {
    id: "apply_fix",
    description: "Apply the minimal fix to resolve the root cause without changing unrelated behaviour.",
    depends_on: [
      "isolate_root_cause"
    ],
    risk_level: "HIGH",
    abstraction_level: "leaf",
    expected_tools: [
      "edit_file",
      "write_file"
    ],
    success_criteria: [
      "Fix is minimal — only changes required lines",
      "No unrelated code modified"
    ],
    strategy_hint: "MINIMAL_FIX"
  },
  {
    id: "verify_fix",
    description: "Re-run the full test suite (or at minimum the affected test file) to confirm the fix passes and no regressions are introduced.",
    depends_on: [
      "apply_fix"
    ],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "run_tests"
    ],
    success_criteria: [
      "Target test passes",
      "No new failures in other tests"
    ],
    strategy_hint: "DIRECT_EDIT"
  }
];
const debugTestFailureJson = {
  schema_version: schema_version$3,
  id: id$4,
  name: name$3,
  description: description$3,
  success_criteria: success_criteria$3,
  steps: steps$3
};
const schema_version$2 = "1";
const id$3 = "implement_feature";
const name$2 = "Implement Feature";
const description$2 = "Canonical decomposition for adding a new feature to an existing codebase. Guides the model from requirements clarification through design, implementation, testing, and integration.";
const success_criteria$2 = [
  "Feature behaves as specified in requirements",
  "Tests cover the happy path and key edge cases",
  "Existing tests continue to pass",
  "Code follows the project's conventions"
];
const steps$2 = [
  {
    id: "clarify_requirements",
    description: "Parse the feature request and identify ambiguities. Confirm scope, edge cases, and acceptance criteria before writing any code.",
    depends_on: [],
    risk_level: "LOW",
    abstraction_level: "goal",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Acceptance criteria documented",
      "Scope boundaries clear — what is in and out of scope"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "survey_codebase",
    description: "Identify all existing code that the new feature must integrate with: interfaces, data models, entry points, and test infrastructure.",
    depends_on: [
      "clarify_requirements"
    ],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "search_code",
      "read_file"
    ],
    success_criteria: [
      "Integration points identified",
      "Data flow from caller to new code understood"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "design_interface",
    description: "Define the public interface (function signatures, data classes, API endpoints) for the new feature. Confirm it is consistent with existing conventions.",
    depends_on: [
      "survey_codebase"
    ],
    risk_level: "MEDIUM",
    abstraction_level: "subgoal",
    expected_tools: [
      "read_file"
    ],
    success_criteria: [
      "Public interface defined",
      "Naming follows existing conventions"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "implement_core",
    description: "Write the core implementation. Keep changes minimal and focused on the new feature; do not refactor existing code unless required.",
    depends_on: [
      "design_interface"
    ],
    risk_level: "HIGH",
    abstraction_level: "leaf",
    expected_tools: [
      "write_file",
      "edit_file"
    ],
    success_criteria: [
      "Core logic implemented",
      "No unrelated files modified"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "write_tests",
    description: "Write tests that exercise the happy path, at least one edge case, and any error conditions relevant to the feature.",
    depends_on: [
      "implement_core"
    ],
    risk_level: "LOW",
    abstraction_level: "function",
    expected_tools: [
      "write_file",
      "edit_file"
    ],
    success_criteria: [
      "Happy path test written",
      "At least one edge-case test written"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "run_and_verify",
    description: "Run the full test suite and confirm the new tests pass and no regressions are introduced.",
    depends_on: [
      "write_tests"
    ],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "run_tests"
    ],
    success_criteria: [
      "All new tests pass",
      "No regressions in existing tests"
    ],
    strategy_hint: "DIRECT_EDIT"
  }
];
const implementFeatureJson = {
  schema_version: schema_version$2,
  id: id$3,
  name: name$2,
  description: description$2,
  success_criteria: success_criteria$2,
  steps: steps$2
};
const schema_version$1 = "1";
const id$2 = "code_review";
const name$1 = "Code Review";
const description$1 = "Canonical decomposition for reviewing a code change (PR, diff, or file set). Guides the model through structured analysis covering correctness, security, style, and test coverage.";
const success_criteria$1 = [
  "All review dimensions covered (correctness, security, style, tests)",
  "Findings are specific — each has a location and a suggested action",
  "Summary distinguishes blocking issues from advisory suggestions"
];
const steps$1 = [
  {
    id: "understand_change",
    description: "Read the diff or the changed files. Understand what the change is trying to do and what the intended outcome is.",
    depends_on: [],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Change purpose understood",
      "Changed files and functions identified"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "check_correctness",
    description: "Verify that the logic is correct: check edge cases, boundary conditions, error handling, and potential off-by-one errors.",
    depends_on: [
      "understand_change"
    ],
    risk_level: "MEDIUM",
    abstraction_level: "function",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Logic traced through at least one happy path",
      "Key edge cases considered"
    ],
    strategy_hint: "TRACE_EXEC"
  },
  {
    id: "check_security",
    description: "Identify security risks: injection vectors, authentication bypasses, insecure defaults, sensitive data exposure, and input validation gaps.",
    depends_on: [
      "understand_change"
    ],
    risk_level: "HIGH",
    abstraction_level: "function",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "OWASP Top-10 categories relevant to this change reviewed",
      "No unreviewed user-controlled data paths"
    ],
    strategy_hint: "TRACE_EXEC"
  },
  {
    id: "check_style_conventions",
    description: "Verify that the change follows the project's naming conventions, formatting rules, and documentation standards.",
    depends_on: [
      "understand_change"
    ],
    risk_level: "LOW",
    abstraction_level: "leaf",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Naming consistent with surrounding code",
      "No missing or misleading comments"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "check_test_coverage",
    description: "Assess whether the change is adequately tested: check that new behaviour is covered by tests and no existing tests are silently broken.",
    depends_on: [
      "check_correctness"
    ],
    risk_level: "MEDIUM",
    abstraction_level: "function",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Test coverage for new behaviour verified",
      "No test deletions or skips without justification"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "summarise_findings",
    description: "Produce a structured review summary: separate blocking issues from advisory suggestions, and provide specific line references for each finding.",
    depends_on: [
      "check_correctness",
      "check_security",
      "check_style_conventions",
      "check_test_coverage"
    ],
    risk_level: "LOW",
    abstraction_level: "goal",
    expected_tools: [],
    success_criteria: [
      "Blocking issues listed with locations",
      "Advisory suggestions separated from blocking issues"
    ],
    strategy_hint: null
  }
];
const codeReviewJson = {
  schema_version: schema_version$1,
  id: id$2,
  name: name$1,
  description: description$1,
  success_criteria: success_criteria$1,
  steps: steps$1
};
const schema_version = "1";
const id$1 = "refactor_module";
const name = "Refactor Module";
const description = "Canonical decomposition for refactoring an existing module. Guides the model through understanding current behaviour, planning the refactor, implementing changes incrementally, and verifying behavioural equivalence.";
const success_criteria = [
  "Existing test suite passes without modification",
  "Public interface is preserved or migration path is documented",
  "Internal complexity is measurably reduced"
];
const steps = [
  {
    id: "understand_current_behaviour",
    description: "Read the module and its tests to understand current behaviour, public contracts, and known edge cases before making any changes.",
    depends_on: [],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Public interface documented",
      "Test coverage understood"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "identify_refactor_targets",
    description: "Identify specific code smells, duplication, or complexity hotspots that the refactor should address. Prioritise by impact.",
    depends_on: [
      "understand_current_behaviour"
    ],
    risk_level: "LOW",
    abstraction_level: "subgoal",
    expected_tools: [
      "read_file",
      "search_code"
    ],
    success_criteria: [
      "Refactor targets listed with rationale",
      "Targets prioritised by impact vs risk"
    ],
    strategy_hint: "BROADER_SEARCH"
  },
  {
    id: "plan_changes",
    description: "Design the refactored structure without writing code. Confirm that the new structure preserves all public interfaces and that existing tests will still pass.",
    depends_on: [
      "identify_refactor_targets"
    ],
    risk_level: "MEDIUM",
    abstraction_level: "subgoal",
    expected_tools: [
      "read_file"
    ],
    success_criteria: [
      "New structure sketched",
      "Interface preservation confirmed"
    ],
    strategy_hint: "DIRECT_EDIT"
  },
  {
    id: "apply_refactor",
    description: "Apply the planned refactor incrementally. Make one logical change at a time and verify tests pass after each change.",
    depends_on: [
      "plan_changes"
    ],
    risk_level: "HIGH",
    abstraction_level: "leaf",
    expected_tools: [
      "edit_file",
      "write_file",
      "run_tests"
    ],
    success_criteria: [
      "Each incremental change keeps the test suite green",
      "No behaviour-changing side effects"
    ],
    strategy_hint: "MINIMAL_FIX"
  },
  {
    id: "verify_equivalence",
    description: "Run the full test suite after all refactor changes are applied. Confirm no regressions and that the public interface is unchanged.",
    depends_on: [
      "apply_refactor"
    ],
    risk_level: "LOW",
    abstraction_level: "module",
    expected_tools: [
      "run_tests"
    ],
    success_criteria: [
      "Full test suite passes",
      "No public interface changes without documentation"
    ],
    strategy_hint: "DIRECT_EDIT"
  }
];
const refactorModuleJson = {
  schema_version,
  id: id$1,
  name,
  description,
  success_criteria,
  steps
};
class ProcessRegistry {
  constructor() {
    __publicField(this, "_registry", /* @__PURE__ */ new Map());
  }
  register(conceptId, concept) {
    this._registry.set(conceptId, concept);
  }
  load(conceptId) {
    const concept = this._registry.get(conceptId);
    if (!concept) {
      throw new ProcessConceptNotFoundError(conceptId);
    }
    return concept;
  }
  listAvailable() {
    return [...this._registry.keys()].sort();
  }
}
function registerAll(registry) {
  const bundles = [
    debugTestFailureJson,
    implementFeatureJson,
    codeReviewJson,
    refactorModuleJson
  ];
  for (const json of bundles) {
    const concept = ProcessConcept.fromJson(json);
    registry.register(concept.id, concept);
  }
}
const DEFAULT_REGISTRY = new ProcessRegistry();
registerAll(DEFAULT_REGISTRY);
class SelfReferentialDependencyError extends Error {
  constructor(actionClass) {
    super(`Self-referential recovery action dependency detected for "${actionClass}"`);
    this.name = "SelfReferentialDependencyError";
  }
}
class InvalidTaskGraphError extends Error {
  constructor(errors) {
    super(`Task graph validation failed: ${errors.join("; ")}`);
    __publicField(this, "errors");
    this.name = "InvalidTaskGraphError";
    this.errors = errors;
  }
}
function validateRecoveryActionDependencies(deps = RECOVERY_ACTION_DEPENDENCIES) {
  for (const [action, required] of Object.entries(deps)) {
    if (required.includes(action)) {
      throw new SelfReferentialDependencyError(action);
    }
  }
}
function validateTaskGraph(taskGraph) {
  const errors = [];
  const ids = new Set(taskGraph.tasks.map((t) => t.id));
  for (const task of taskGraph.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }
  return errors;
}
function initializeHarness(_objective, options = {}) {
  const {
    max_steps = 50,
    toolConfigs = {},
    initialTasks = [],
    successCriteria = [],
    callerConstraints = [],
    outputContract: outputContractOptions,
    processConceptId,
    processRegistry = DEFAULT_REGISTRY,
    recoveryActionDeps = RECOVERY_ACTION_DEPENDENCIES
  } = options;
  validateRecoveryActionDependencies(recoveryActionDeps);
  const worldModel = new WorldModel();
  const callerState = new CallerState({
    success_criteria: successCriteria,
    current_constraints: callerConstraints
  });
  const taskGraph = new TaskGraph({
    tasks: initialTasks.length > 0 ? initialTasks.map((t) => ({ ...t })) : successCriteria.map((criterion, i) => ({
      id: `task-${i}`,
      description: String(criterion),
      status: "PENDING",
      risk_level: "MEDIUM",
      depends_on: [],
      parallel_write_domains: [],
      abstraction_level: 1,
      assigned_strategy: null
    }))
  });
  const diagnostics = new Diagnostics();
  const hypothesisSet = new HypothesisSet();
  const toolManifest = {};
  for (const [toolName, config] of Object.entries(toolConfigs)) {
    toolManifest[toolName] = {
      available: config.available,
      fallback_tool: config.fallback_tool ?? null
    };
  }
  for (const internalSource of ["execution_engine", "result_inspection", "fact_extraction", "world_model_trail"]) {
    if (!(internalSource in toolManifest)) {
      toolManifest[internalSource] = { available: true, fallback_tool: null };
    }
  }
  const evidenceStore = new EvidenceStore({
    tool_availability_manifest: toolManifest
  });
  const memoryState = new MemoryState({
    journal_retention_policy: {
      retain_failures_permanently: true,
      max_passing_verbatim: 20,
      compress_older_passing: true
    }
  });
  const strategyState = new StrategyState();
  const failureDiagnostics = new FailureDiagnostics({ failure_mode_library: new FailureModeLibrary(DEFAULT_FAILURE_MODE_ENTRIES) });
  const outputContract = new OutputContract(outputContractOptions ?? {});
  const beliefDepGraph = new BeliefDepGraph();
  const depGraphBudget = new DepGraphBudget();
  if (processConceptId) {
    const concept = processRegistry.load(processConceptId);
    concept.seedTaskGraph(taskGraph);
  }
  const graphErrors = validateTaskGraph(taskGraph);
  if (graphErrors.length > 0) {
    return {
      worldModel,
      callerState,
      controlState: new ControlState(),
      taskGraph,
      diagnostics,
      hypothesisSet,
      evidenceStore,
      memoryState,
      strategyState,
      failureDiagnostics,
      outputContract,
      beliefDepGraph,
      depGraphBudget,
      maxSteps: max_steps,
      decompositionGate: false,
      valid: false,
      errors: graphErrors,
      processConceptId: processConceptId ?? null
    };
  }
  diagnostics.verification_health.feasibility = checkAbstractionAlignment(taskGraph, worldModel);
  diagnostics.coverage_health.symptom_coverage = normalise(0.5, DimensionType.ratio);
  diagnostics.coverage_health.explanation_coverage = normalise(0.5, DimensionType.ratio);
  worldModel.incrementGenerationId();
  const controlState = resolveControlState(diagnostics, worldModel, failureDiagnostics);
  const decompositionGate = controlState.permission !== "DENY";
  return {
    worldModel,
    callerState,
    controlState,
    taskGraph,
    diagnostics,
    hypothesisSet,
    evidenceStore,
    memoryState,
    strategyState,
    failureDiagnostics,
    outputContract,
    beliefDepGraph,
    depGraphBudget,
    maxSteps: max_steps,
    decompositionGate,
    valid: true,
    errors: [],
    processConceptId: processConceptId ?? null
  };
}
function softmax(values, temperature) {
  const scaled = values.map((v) => v / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
function softmaxStrategyPolicy(strategyState, temperature = 1) {
  const weights = strategyState.prior_strategy_weights;
  const values = DEFAULT_STRATEGY_ORDER.map((s) => weights[s] ?? 0);
  const probs = softmax(values, temperature);
  const result = {};
  for (let i = 0; i < DEFAULT_STRATEGY_ORDER.length; i++) {
    result[DEFAULT_STRATEGY_ORDER[i]] = probs[i];
  }
  return result;
}
function warmStart(experienceStore, strategyState, failureDiagnostics, depGraphBudget, _taskGraph) {
  if (!experienceStore.available) return;
  const strategyWeights = experienceStore.getStrategyWeights();
  if (Object.keys(strategyWeights).length > 0) {
    for (const [key, weight] of Object.entries(strategyWeights)) {
      const strategyType = key.split(":")[0];
      if (DEFAULT_STRATEGY_ORDER.includes(strategyType)) {
        strategyState.prior_strategy_weights[strategyType] = (strategyState.prior_strategy_weights[strategyType] ?? 0) + weight;
      }
    }
  }
  const classPriors = experienceStore.getClassPriors();
  if (Object.keys(classPriors).length > 0) {
    for (const [cls, prior] of Object.entries(classPriors)) {
      failureDiagnostics.failure_mode_library.class_priors[cls] = prior;
    }
  }
  const strategyWeightsForDecay = experienceStore.getStrategyWeights();
  if (Object.keys(strategyWeightsForDecay).length > 0) {
    const totalWeight = Object.values(strategyWeightsForDecay).reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
      depGraphBudget.confidence_decay_rate = Math.max(
        0.01,
        depGraphBudget.confidence_decay_rate * (1 - Math.min(0.5, totalWeight / 100))
      );
    }
  }
  const policy = softmaxStrategyPolicy(strategyState, 1);
  const ordered = Object.entries(policy).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  if (ordered.length === DEFAULT_STRATEGY_ORDER.length) {
    strategyState.recovery_strategy_order = ordered;
  }
}
const COMPRESSION_THRESHOLD = 0.9;
function assessContextPressure(memoryState) {
  const { total, used } = memoryState.token_budget;
  if (total === 0) return 1;
  return used / total;
}
function compressMemory(memoryState, _preserveSet) {
  const dropped = [];
  const pruned = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const excess = memoryState.compression_risk.compressed_structures.length - 10;
  if (excess > 0) {
    const toDrop = memoryState.compression_risk.compressed_structures.splice(0, excess);
    dropped.push(...toDrop);
  }
  const regionsToPrune = memoryState.compression_risk.pruned_regions.filter(
    (r) => !_preserveSet.includes(r.id)
  );
  if (regionsToPrune.length > 0) {
    pruned.push(...regionsToPrune.map((r) => ({ ...r, pruned_at: now })));
  }
  return { dropped, pruned };
}
const BELIEF_TTL_MS = 30 * 60 * 1e3;
function stalenessSweep(worldModel, environmentChangeLog) {
  const now = Date.now();
  const staleFlags = worldModel.stale_flags;
  for (const belief of worldModel.beliefs) {
    if (staleFlags[belief.id]) continue;
    const beliefTs = new Date(belief.recorded_at).getTime();
    if (now - beliefTs > BELIEF_TTL_MS) {
      staleFlags[belief.id] = true;
      continue;
    }
    const beliefSources = /* @__PURE__ */ new Set([...belief.derived_from, ...belief.supporting_evidence ?? []]);
    for (const change of environmentChangeLog) {
      if (!change.affected_paths.some((p) => beliefSources.has(p))) continue;
      const changeTs = new Date(change.timestamp).getTime();
      if (Number.isNaN(changeTs)) continue;
      if (changeTs > beliefTs) {
        staleFlags[belief.id] = true;
        break;
      }
    }
  }
}
function applyJournalRetentionPolicy(memoryState) {
  const policy = memoryState.journal_retention_policy;
  const journal = memoryState.journal;
  const failures = [];
  const passingVerbatim = [];
  for (const entry of journal) {
    if (!entry.success && policy.retain_failures_permanently) {
      failures.push(entry);
    } else if (entry.success) {
      passingVerbatim.push(entry);
    }
  }
  const splitAt = Math.max(0, passingVerbatim.length - policy.max_passing_verbatim);
  const recentPassing = passingVerbatim.slice(splitAt);
  const compressedOlder = [];
  if (policy.compress_older_passing && splitAt > 0) {
    const olderPassing = passingVerbatim.slice(0, splitAt);
    for (const entry of olderPassing) {
      compressedOlder.push({
        step: entry.step,
        action_class: entry.action_class,
        outcome: entry.outcome,
        success: entry.success
        // verbatim dropped — compressed to summary record
      });
    }
  }
  memoryState.journal = [...failures, ...compressedOlder, ...recentPassing];
}
function contextCompression(memoryState, worldModel, beliefDepGraph, depGraphBudget, hypothesisSet, taskGraph, diagnostics, controlState, callerState) {
  const pressure = assessContextPressure(memoryState);
  if (pressure >= COMPRESSION_THRESHOLD) {
    const preserveSet = [
      "worldModel",
      "beliefDepGraph",
      "hypothesisSet",
      "taskGraph",
      "diagnostics",
      "controlState",
      "callerState"
    ];
    const result = compressMemory(memoryState, preserveSet);
    memoryState.compression_risk.compressed_structures.push(...result.dropped);
    const known = new Set(memoryState.compression_risk.pruned_regions.map((r) => r.id));
    memoryState.compression_risk.pruned_regions.push(...result.pruned.filter((r) => !known.has(r.id)));
  }
  stalenessSweep(worldModel, worldModel.environment_change_log);
  depGraphBudget.applyDecay(beliefDepGraph);
  applyJournalRetentionPolicy(memoryState);
}
const ADVERSARIAL_PROXIMITY_THRESHOLD = 0.5;
const ADVERSARIAL_MAX_SEEDS = 10;
const BFS_HOP_LIMIT = 3;
const REVIEWER_VERDICT_SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };
function classifyFindingSeverity(lens, finding) {
  if (lens === "reviewer" && (finding.startsWith("Unresolved HIGH") || finding.startsWith("Unresolved SYSTEM_BREAKING"))) {
    return "HIGH";
  }
  if (lens === "adversarial" && finding.startsWith("Adversarial challenge:")) {
    return "HIGH";
  }
  return "MEDIUM";
}
function derivePendingVerdict(implementerFindings, reviewerFindings, adversarialFindings) {
  const candidates = [
    ...implementerFindings.map((f) => ({ severity: classifyFindingSeverity("implementer", f), lens: "implementer", summary: f })),
    ...reviewerFindings.map((f) => ({ severity: classifyFindingSeverity("reviewer", f), lens: "reviewer", summary: f })),
    ...adversarialFindings.map((f) => ({ severity: classifyFindingSeverity("adversarial", f), lens: "adversarial", summary: f }))
  ].filter((c) => REVIEWER_VERDICT_SEVERITY_RANK[c.severity] >= REVIEWER_VERDICT_SEVERITY_RANK.MEDIUM);
  if (candidates.length === 0) return null;
  return candidates.reduce(
    (top, c) => REVIEWER_VERDICT_SEVERITY_RANK[c.severity] > REVIEWER_VERDICT_SEVERITY_RANK[top.severity] ? c : top
  );
}
function seedAdversarialPrior(worldModel, successCriteria, beliefDepGraph, maxSeeds) {
  const criteriaSet = new Set(successCriteria.map((c) => c.toLowerCase()));
  function causalProximity(belief) {
    const text = belief.statement.toLowerCase();
    if (harnessLexicalActive("criterion-proximity")) {
      for (const criterion of criteriaSet) {
        if (text.includes(criterion)) return 1;
      }
    }
    if (belief.derived_from.length > 0) return 0.6;
    return 0.1;
  }
  const visited = /* @__PURE__ */ new Set();
  const queue = [];
  const selected = [];
  for (const belief of worldModel.beliefs) {
    if (causalProximity(belief) >= ADVERSARIAL_PROXIMITY_THRESHOLD) {
      queue.push({ id: belief.id, hop: 0 });
      visited.add(belief.id);
    }
  }
  while (queue.length > 0 && selected.length < maxSeeds) {
    const { id: id2, hop } = queue.shift();
    const belief = worldModel.beliefs.find((b) => b.id === id2);
    if (!belief) continue;
    selected.push(belief);
    if (hop >= BFS_HOP_LIMIT) continue;
    for (const edge of beliefDepGraph.derived_from_edges) {
      const nextId = edge.from === id2 ? edge.to : edge.to === id2 ? edge.from : null;
      if (nextId && !visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ id: nextId, hop: hop + 1 });
      }
    }
  }
  return selected;
}
async function implementerLens(worldModel, successCriteria, semanticCriterionCoverage, isCheckableCriterion) {
  const findings = [];
  const reopened = [];
  for (const criterion of successCriteria) {
    if (isCheckableCriterion && !isCheckableCriterion(criterion)) continue;
    const covered = harnessLexicalActive("criterion-substring") && worldModel.beliefs.some(
      (b) => b.statement.toLowerCase().includes(criterion.toLowerCase())
    );
    if (!covered) {
      const semanticallyCovered = semanticCriterionCoverage ? await semanticCriterionCoverage(criterion, worldModel.beliefs) : false;
      if (!semanticallyCovered) {
        findings.push(`Success criterion not covered by any belief: "${criterion}"`);
      }
    }
  }
  return { findings, reopened_task_ids: reopened };
}
function reviewerLens(worldModel, successCriteria) {
  const findings = [];
  const reopened = [];
  for (const contradiction of worldModel.contradictions) {
    if (contradiction.severity === "HIGH" || contradiction.severity === "SYSTEM_BREAKING") {
      findings.push(`Unresolved ${contradiction.severity} contradiction: ${contradiction.description}`);
    }
  }
  const weakBeliefs = worldModel.beliefs.filter((b) => b.confidence < 0.25);
  if (weakBeliefs.length > worldModel.beliefs.length / 2) {
    findings.push(`More than half of beliefs have LOW confidence (${weakBeliefs.length}/${worldModel.beliefs.length})`);
  }
  return { findings, reopened_task_ids: reopened };
}
function adversarialLens(worldModel, successCriteria, failureDiagnostics, beliefDepGraph) {
  const findings = [];
  const reopened = [];
  const adversarialPrior = seedAdversarialPrior(
    worldModel,
    successCriteria,
    beliefDepGraph,
    ADVERSARIAL_MAX_SEEDS
  );
  for (const belief of adversarialPrior) {
    if (belief.confidence >= 0.8) {
      const contradicted = worldModel.contradictions.some(
        (c) => c.involved_belief_ids.includes(belief.id)
      );
      if (contradicted) {
        findings.push(`Adversarial challenge: HIGH-reliability belief "${belief.id}" is contradicted`);
      }
    }
  }
  const classPriors = failureDiagnostics.failure_mode_library.class_priors;
  for (const [cls, prior] of Object.entries(classPriors)) {
    if (prior > 0.5) {
      findings.push(`High prior probability (${prior.toFixed(2)}) for failure class "${cls}"`);
    }
  }
  return { findings, reopened_task_ids: reopened };
}
function recomputeAbstractionFit(taskGraph, worldModel, diagnostics) {
  diagnostics.verification_health.feasibility = checkAbstractionAlignment(taskGraph, worldModel, true);
}
function isIdChar(ch) {
  return ch !== void 0 && ch.length === 1 && (ch >= "0" && ch <= "9" || ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_" || ch === "-");
}
function mentionsId(text, id2) {
  if (id2.length === 0) return false;
  let from = 0;
  for (; ; ) {
    const at = text.indexOf(id2, from);
    if (at === -1) return false;
    if (!isIdChar(text[at - 1]) && !isIdChar(text[at + id2.length])) return true;
    from = at + 1;
  }
}
function drainPropagationQueue(queue) {
  const ids = [...queue.reopenedTaskIds];
  queue.reopenedTaskIds = [];
  return ids;
}
async function reviewerPass(worldModel, successCriteria, failureDiagnostics, beliefDepGraph, depGraphBudget, hypothesisSet, taskGraph, diagnostics, evidenceStore, propagationQueue, runAdversarialLens = true, semanticCriterionCoverage, isCheckableCriterion) {
  const implResult = await implementerLens(worldModel, successCriteria, semanticCriterionCoverage, isCheckableCriterion);
  const reviewResult = reviewerLens(worldModel);
  const adversarialResult = runAdversarialLens ? adversarialLens(worldModel, successCriteria, failureDiagnostics, beliefDepGraph) : { findings: [], reopened_task_ids: [] };
  recomputeAbstractionFit(taskGraph, worldModel, diagnostics);
  propagateBeliefs(beliefDepGraph, depGraphBudget);
  generateUpdateHypotheses(worldModel, evidenceStore, hypothesisSet, failureDiagnostics, new MemoryState());
  detectContradictions(worldModel, evidenceStore, hypothesisSet);
  const allReopened = [
    ...implResult.reopened_task_ids,
    ...reviewResult.reopened_task_ids,
    ...adversarialResult.reopened_task_ids
  ];
  for (const finding of reviewResult.findings) {
    for (const task of taskGraph.tasks) {
      if (task.status === "COMPLETE" && mentionsId(finding, task.id)) {
        if (!allReopened.includes(task.id)) {
          allReopened.push(task.id);
          propagationQueue.reopenedTaskIds.push(task.id);
        }
      }
    }
  }
  const reopenedTaskIds = drainPropagationQueue(propagationQueue);
  return {
    implementer_findings: implResult.findings,
    reviewer_findings: reviewResult.findings,
    adversarial_findings: adversarialResult.findings,
    reopened_task_ids: reopenedTaskIds,
    pending_verdict: derivePendingVerdict(implResult.findings, reviewResult.findings, adversarialResult.findings)
  };
}
const NEGATION_KEYWORDS = getConstraintNegationWords();
class OutputContractError extends Error {
  constructor(violatedDimension, violations) {
    super(`Output contract violation in "${violatedDimension}": ${violations.join("; ")}`);
    __publicField(this, "violatedDimension");
    __publicField(this, "violations");
    this.name = "OutputContractError";
    this.violatedDimension = violatedDimension;
    this.violations = violations;
  }
}
function outputValidation(finalResult, outputContract, callerState, options = {}) {
  const violations = [];
  const result = typeof finalResult === "object" && finalResult !== null ? finalResult : {};
  if (outputContract.format && outputContract.format !== "any") {
    if (typeof finalResult === "string" && outputContract.format === "json") {
      try {
        JSON.parse(finalResult);
      } catch {
        violations.push(`format: expected JSON, got non-parseable string`);
      }
    }
  }
  for (const section of outputContract.required_sections) {
    if (!(section in result)) {
      violations.push(`required_sections: missing field "${section}"`);
    }
  }
  for (const [key, expected] of Object.entries(outputContract.interface_constraints)) {
    if (key in result && result[key] !== expected) {
      violations.push(`interface_constraints: field "${key}" expected ${String(expected)}, got ${String(result[key])}`);
    }
  }
  for (const rule of outputContract.validation_rules) {
    const colonIdx = rule.indexOf(":");
    if (colonIdx > 0) {
      const field = rule.slice(0, colonIdx).trim();
      if (!(field in result)) {
        violations.push(`validation_rules: rule "${rule}" references missing field "${field}"`);
      }
    }
  }
  const resultText = ((typeof finalResult === "string" ? finalResult : "") + " " + Object.values(result).map((v) => String(v)).join(" ")).toLowerCase();
  const lexicalConstraints = !options.skipCallerConstraints && harnessLexicalActive("constraint-negation");
  for (const constraint of lexicalConstraints ? callerState.current_constraints : []) {
    const constraintLower = constraint.toLowerCase();
    const constraintTokens = new Set(constraintLower.split(/\s+/));
    if (![...constraintTokens].some((t) => NEGATION_KEYWORDS.has(t))) continue;
    for (const kw of NEGATION_KEYWORDS) {
      const idx = constraintLower.indexOf(kw);
      if (idx === -1) continue;
      const subject = constraintLower.slice(idx + kw.length).trim();
      const subjectTokens = subject.split(/\s+/).slice(0, 4).filter((t) => t.length > 3);
      if (subjectTokens.length > 0 && subjectTokens.some((t) => resultText.includes(t))) {
        violations.push(`caller_specific_constraints: constraint violated: "${constraint}"`);
        break;
      }
    }
  }
  if (violations.length > 0) {
    const violatedDimension = violations[0].split(":")[0];
    throw new OutputContractError(violatedDimension, violations);
  }
  return { passed: true, violations: [] };
}
const MIN_ATTEMPTS = 5;
const DECAY = 0.9;
const RECENT_WINDOW = 10;
const MAX_RUN_REFS = 20;
const DEFAULT_BASELINE = 0.5;
const DEMOTION_STREAK = 3;
const Z = 1.96;
const round$1 = (n) => Math.round(n * 1e4) / 1e4;
function wilsonLowerBound(successes, n) {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}
function emptyEvidence(context) {
  return { attempts: 0, successes: 0, weightedAttempts: 0, weightedSuccesses: 0, lastUsedAt: 0, context, recent: [], runIds: [], promoted: false };
}
function recordAttempt(prior, input) {
  const base = prior && prior.context === input.context ? prior : emptyEvidence(input.context);
  const runIds = input.runId && !base.runIds.includes(input.runId) ? [...base.runIds, input.runId] : [...base.runIds];
  return {
    attempts: base.attempts + 1,
    successes: base.successes + (input.success ? 1 : 0),
    weightedAttempts: round$1(base.weightedAttempts * DECAY + 1),
    weightedSuccesses: round$1(base.weightedSuccesses * DECAY + (input.success ? 1 : 0)),
    lastUsedAt: input.now,
    context: input.context,
    recent: [...base.recent, input.success].slice(-RECENT_WINDOW),
    runIds: runIds.slice(-MAX_RUN_REFS),
    promoted: base.promoted
  };
}
function baselineFor(others) {
  const n = others.reduce((a, e) => a + e.weightedAttempts, 0);
  if (n <= 0) return DEFAULT_BASELINE;
  return others.reduce((a, e) => a + e.weightedSuccesses, 0) / n;
}
function decidePromotion(e, others, minAttempts = MIN_ATTEMPTS) {
  const baseline = baselineFor(others);
  const lowerBound = wilsonLowerBound(e.weightedSuccesses, e.weightedAttempts);
  const streak = e.recent.length >= DEMOTION_STREAK && e.recent.slice(-DEMOTION_STREAK).every((s) => !s);
  const promoted = e.attempts >= minAttempts && lowerBound > baseline && !streak;
  return { promoted, lowerBound: round$1(lowerBound), baseline: round$1(baseline), attempts: e.attempts };
}
const LEARNING_RATE = 0.3;
const PRIOR = 0.5;
const FAILED_PREFIX = "failed:";
const round = (n) => Math.round(n * 1e4) / 1e4;
function journalEntryFor(input) {
  const verbatim = typeof input.output === "string" ? input.output.slice(0, 500) : void 0;
  return {
    step: input.step,
    action_class: input.strategy,
    outcome: input.success ? "completed" : `${FAILED_PREFIX}${input.failureClass ?? ""}`,
    success: input.success,
    ...input.success && verbatim ? { verbatim } : {}
  };
}
function failureClassOf(entry) {
  return !entry.success && entry.outcome.startsWith(FAILED_PREFIX) ? entry.outcome.slice(FAILED_PREFIX.length) : null;
}
function recoveryAttempts(journal) {
  const strategies = DEFAULT_STRATEGY_ORDER;
  const attempts = [];
  const ordered = [...journal].sort((a, b) => a.step - b.step);
  for (let i = 1; i < ordered.length; i++) {
    const answered = failureClassOf(ordered[i - 1]);
    if (answered !== null && strategies.includes(ordered[i].action_class)) {
      attempts.push({ strategy: ordered[i].action_class, failureClass: answered, success: ordered[i].success });
    }
  }
  return attempts;
}
function learnFromJournal(journal, store, options = {}) {
  if (!store.available || journal.length === 0) return;
  const weights = store.getStrategyWeights();
  if (options.rule === "sample") {
    learnWithSampleRule(journal, store, weights, options);
  } else {
    for (const a of recoveryAttempts(journal)) {
      const key = (s) => `${s}:${a.failureClass}`;
      if (DEFAULT_STRATEGY_ORDER.every((s) => weights[key(s)] === void 0)) {
        for (const s of DEFAULT_STRATEGY_ORDER) {
          weights[key(s)] = PRIOR;
          store.setStrategyWeight(key(s), PRIOR);
        }
      }
      const next = round((weights[key(a.strategy)] ?? PRIOR) * (1 - LEARNING_RATE) + (a.success ? 1 : 0) * LEARNING_RATE);
      weights[key(a.strategy)] = next;
      store.setStrategyWeight(key(a.strategy), next);
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const e of journal) {
    const c = failureClassOf(e);
    if (c !== null && c !== "") seen.add(c);
  }
  const priors = store.getClassPriors();
  for (const c of /* @__PURE__ */ new Set([...Object.keys(priors), ...seen])) {
    store.setClassPrior(c, round((priors[c] ?? 0) * (1 - LEARNING_RATE) + (seen.has(c) ? 1 : 0) * LEARNING_RATE));
  }
}
function learnWithSampleRule(journal, store, weights, options) {
  var _a;
  const evidence = store.getStrategyEvidence();
  const touched = /* @__PURE__ */ new Set();
  const now = options.now ?? Date.now();
  for (const a of recoveryAttempts(journal)) {
    const key = `${a.strategy}:${a.failureClass}`;
    evidence[key] = recordAttempt(evidence[key], { success: a.success, runId: options.runId, now, context: options.context ?? "" });
    touched.add(key);
  }
  for (const key of touched) {
    const cls = key.slice(key.indexOf(":") + 1);
    const others = DEFAULT_STRATEGY_ORDER.filter((s) => `${s}:${cls}` !== key).map((s) => evidence[`${s}:${cls}`]).filter((e) => e !== void 0);
    const entry = evidence[key];
    const decision2 = decidePromotion(entry, others, options.minAttempts ?? MIN_ATTEMPTS);
    const wasPromoted = entry.promoted;
    entry.promoted = decision2.promoted;
    store.setStrategyEvidence(key, entry);
    if (decision2.promoted) {
      const weight = round(entry.weightedSuccesses / entry.weightedAttempts);
      weights[key] = weight;
      store.setStrategyWeight(key, weight);
    } else if (wasPromoted) {
      weights[key] = 0;
      store.setStrategyWeight(key, 0);
    }
    if (decision2.promoted !== wasPromoted) {
      (_a = options.onEvent) == null ? void 0 : _a.call(options, {
        type: decision2.promoted ? "strategy_promoted" : "strategy_demoted",
        key,
        attempts: entry.attempts,
        successes: entry.successes,
        lowerBound: decision2.lowerBound,
        baseline: decision2.baseline,
        ...options.runId ? { runId: options.runId } : {}
      });
    }
  }
}
const DECISION_ORDER = { off: 0, cheap: 1, full: 2 };
const FLOOR_LAYERS = [
  "control_state",
  "approval_staging",
  "tool_policy",
  "diagnostics",
  "hypothesis",
  "mandatory_verification"
];
const ESCALATION_LAYERS = [
  "semantic_contradiction",
  "failure_match",
  "criterion_coverage",
  "change_review",
  "injection_detection",
  "decomposition_reframe",
  "model_inferred_facts",
  "reviewer_adversarial"
];
const OPT_IN_LAYERS = ["source_reliability", "semantic_hypotheses", "reviewer_revision", "experience_learning", "semantic_compaction", "memory_reviewer"];
const EVENT_LAYERS = ["supervisor"];
const PRESENTATION_LAYERS = ["next_step_options", "goal_graph", "steering"];
const LAYER_CLASS = {
  control_state: "floor",
  approval_staging: "floor",
  tool_policy: "floor",
  diagnostics: "floor",
  hypothesis: "floor",
  mandatory_verification: "floor",
  semantic_contradiction: "escalation",
  failure_match: "escalation",
  criterion_coverage: "escalation",
  change_review: "escalation",
  injection_detection: "escalation",
  decomposition_reframe: "escalation",
  model_inferred_facts: "escalation",
  reviewer_adversarial: "escalation",
  source_reliability: "opt_in",
  semantic_hypotheses: "opt_in",
  reviewer_revision: "opt_in",
  experience_learning: "opt_in",
  semantic_compaction: "opt_in",
  memory_reviewer: "opt_in",
  supervisor: "event",
  next_step_options: "presentation",
  goal_graph: "presentation",
  steering: "presentation"
};
const HAS_CHEAP_FORM = {
  semantic_contradiction: false,
  failure_match: false,
  criterion_coverage: true,
  change_review: false,
  injection_detection: false,
  decomposition_reframe: false,
  model_inferred_facts: false,
  reviewer_adversarial: false
};
const OPT_IN_EVIDENCE = {
  source_reliability: "mechanism_verified",
  semantic_hypotheses: "suggestive",
  reviewer_revision: "untested_with_real_model",
  experience_learning: "untested_with_real_model",
  semantic_compaction: "mechanism_verified",
  memory_reviewer: "untested_with_real_model"
};
const OPT_IN_FLAG = {
  source_reliability: "AUDIT_SEMANTIC_SOURCE_RELIABILITY",
  semantic_hypotheses: "AUDIT_SEMANTIC_HYPOTHESES",
  reviewer_revision: "AUDIT_REVIEWER_REVISION",
  experience_learning: "AUDIT_EXPERIENCE_LEARNING",
  semantic_compaction: "AUDIT_SEMANTIC_COMPACTION",
  memory_reviewer: "AUDIT_MEMORY_REVIEWER"
};
const OPT_IN_CALL_COST = {
  source_reliability: 2,
  semantic_hypotheses: 2,
  reviewer_revision: 1,
  experience_learning: 0,
  semantic_compaction: 1,
  // The post-turn cross-turn memory reviewer: one reviewer call plus one bounded verifier call (runs off the critical path, only every N turns).
  memory_reviewer: 2
};
const OPT_IN_DISABLED_TRIGGER = "opt_in_disabled";
const DEFAULT_LAYER_PRIORITY = [
  "injection_detection",
  "semantic_contradiction",
  "criterion_coverage",
  "reviewer_adversarial",
  "change_review",
  "failure_match",
  "model_inferred_facts",
  "decomposition_reframe"
];
const LAYER_CALL_COST = {
  semantic_contradiction: 1,
  failure_match: 1,
  criterion_coverage: 1,
  change_review: 1,
  injection_detection: 1,
  decomposition_reframe: 1,
  model_inferred_facts: 1,
  reviewer_adversarial: 1
};
function orderedPriority(priority) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const l of [...priority ?? [], ...DEFAULT_LAYER_PRIORITY]) {
    if (!ESCALATION_LAYERS.includes(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}
const STATIC_TRIGGER = "static";
function injectionSkipProvenSafe(ctx) {
  const noUntrusted = ctx.state !== void 0 && ctx.state.untrustedContentInContext === false;
  const noToolCapableStep = ctx.signals.consequentialTools !== void 0 && ctx.signals.consequentialTools.size === 0;
  return noUntrusted || noToolCapableStep;
}
function isEnabledOptIn(enabled, layer) {
  if (enabled === void 0) return false;
  for (const l of enabled) if (l === layer) return true;
  return false;
}
function staticLayerPolicy(enabledOptIn) {
  const out = {};
  for (const layer of Object.keys(LAYER_CLASS)) {
    out[layer] = { decision: "full", trigger: STATIC_TRIGGER, reason: "static policy: today's behaviour" };
  }
  for (const layer of OPT_IN_LAYERS) {
    if (!isEnabledOptIn(enabledOptIn, layer)) {
      out[layer] = { decision: "off", trigger: OPT_IN_DISABLED_TRIGGER, reason: `opt-in layer, ${OPT_IN_FLAG[layer]} is not set` };
    }
  }
  return out;
}
function isDecision(v) {
  return v === "off" || v === "cheap" || v === "full";
}
function limitedCalls(b) {
  const n = b.remainingCalls;
  return n === null || typeof n !== "number" || Number.isNaN(n) || n === Infinity ? null : Math.max(0, n);
}
function resolveLayerPolicy(signals, state, budget, rules = {}, enabledOptIn) {
  try {
    const ctx = { signals, state, budget };
    const out = staticLayerPolicy(enabledOptIn);
    const proposedByLayer = /* @__PURE__ */ new Map();
    for (const layer of ESCALATION_LAYERS) {
      const rule = rules[layer];
      const proposed = rule ? rule(ctx) : null;
      if (proposed) {
        if (!isDecision(proposed.decision) || typeof proposed.trigger !== "string") return staticLayerPolicy(enabledOptIn);
        proposedByLayer.set(layer, { decision: proposed.decision, trigger: proposed.trigger, reason: proposed.reason ?? proposed.trigger });
      } else {
        proposedByLayer.set(layer, null);
      }
    }
    let remaining = limitedCalls(budget);
    for (const layer of orderedPriority(budget.priority)) {
      let next = proposedByLayer.get(layer) ?? null;
      const wantsFull = next === null || next.decision === "full";
      const cost = LAYER_CALL_COST[layer];
      if (remaining !== null && wantsFull && remaining < cost) {
        next = { decision: "cheap", trigger: "budget_exhausted", reason: "per-turn LLM-call budget exhausted" };
      }
      if (!next) {
        if (remaining !== null) remaining = Math.max(0, remaining - cost);
        continue;
      }
      if (next.decision === "cheap" && !HAS_CHEAP_FORM[layer]) next = { ...next, decision: "off" };
      if (next.decision !== "full" && layer === "injection_detection" && !injectionSkipProvenSafe(ctx)) {
        next = { decision: "full", trigger: "security_floor", reason: "AL-1: injection detection needs a non-linguistic proof to skip" };
      }
      if (remaining !== null && next.decision === "full") remaining = Math.max(0, remaining - cost);
      out[layer] = next;
    }
    for (const layer of OPT_IN_LAYERS) {
      if (!isEnabledOptIn(enabledOptIn, layer)) continue;
      const cost = OPT_IN_CALL_COST[layer];
      if (remaining !== null && remaining < cost) {
        out[layer] = { decision: "off", trigger: "budget_exhausted", reason: "per-turn LLM-call budget exhausted" };
      } else if (remaining !== null) {
        remaining = Math.max(0, remaining - cost);
      }
    }
    return out;
  } catch {
    return staticLayerPolicy(enabledOptIn);
  }
}
const AD_HOC_GATES = ["hypothesis_display", "evidence_escalation", "belief_trail", "reviewer_adversarial"];
function resolveGate(policy, gate, staticOutcome) {
  try {
    const d = policy == null ? void 0 : policy[gate];
    if (!d || d.trigger === STATIC_TRIGGER || !isDecision(d.decision)) return { on: staticOutcome };
    if (d.decision === "cheap") return { on: staticOutcome, decision: d.decision, trigger: d.trigger };
    return { on: d.decision === "full", decision: d.decision, trigger: d.trigger };
  } catch {
    return { on: staticOutcome };
  }
}
function reevaluateLayerPolicy(prev, signals, state, budget, rules) {
  if (prev === void 0) return prev;
  try {
    return resolveLayerPolicy(signals, state, budget, rules);
  } catch {
    return prev;
  }
}
const SUPERVISOR_ASK_USER_CAP_M = 2;
const BUDGET_WARNING_FLOOR = 0.5;
function hookOn(ctx, layer) {
  try {
    return ctx.hookEnabled ? ctx.hookEnabled(layer) !== false : true;
  } catch {
    return true;
  }
}
function summariseExecutionOutput(output) {
  var _a;
  if (typeof output === "string") return output.slice(0, 200);
  try {
    return ((_a = JSON.stringify(output)) == null ? void 0 : _a.slice(0, 200)) ?? String(output);
  } catch {
    return String(output);
  }
}
function completedTrailStatement(description2, output) {
  const produced = summariseExecutionOutput(output).trim();
  return produced ? `Completed: ${description2} — produced: ${produced}` : `Completed: ${description2}`;
}
function generateRunId() {
  var _a;
  const g = globalThis;
  if ((_a = g.crypto) == null ? void 0 : _a.randomUUID) return g.crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function buildInitialContext(objective, successCriteria, options, runId) {
  const initResult = initializeHarness(objective, { ...options, successCriteria });
  if (!initResult.valid) {
    throw new Error(`HarnessRuntime: init failed — ${initResult.errors.join("; ")}`);
  }
  const experienceStore = options.experienceStore ?? new UnavailableExperienceStore();
  const ctx = {
    runId,
    objective,
    successCriteria,
    maxSteps: initResult.maxSteps,
    depGraphBudget: initResult.depGraphBudget,
    processConceptId: initResult.processConceptId,
    worldModel: initResult.worldModel,
    callerState: initResult.callerState,
    controlState: initResult.controlState,
    taskGraph: initResult.taskGraph,
    diagnostics: initResult.diagnostics,
    hypothesisSet: initResult.hypothesisSet,
    evidenceStore: initResult.evidenceStore,
    memoryState: initResult.memoryState,
    strategyState: initResult.strategyState,
    failureDiagnostics: initResult.failureDiagnostics,
    outputContract: initResult.outputContract,
    beliefDepGraph: initResult.beliefDepGraph,
    stepsUsed: 0,
    nodeExecutionOrder: [],
    finalResult: null,
    consecutiveReviewFailures: /* @__PURE__ */ new Map(),
    propagationQueue: { reopenedTaskIds: [] },
    experienceStore,
    updateChannel: options.updateChannel ?? new NoOpUpdateChannel(),
    toolExecutors: options.toolExecutors ?? {},
    factExtractor: options.factExtractor,
    complexitySignal: options.complexitySignal,
    layerPolicy: options.layerPolicy,
    reevaluateLayerPolicy: options.reevaluateLayerPolicy,
    onLayerActivity: options.onLayerActivity,
    onVerification: options.onVerification,
    skipVerification: options.skipVerification,
    skipReviewerPass: options.skipReviewerPass,
    skipControlState: options.skipControlState,
    experienceLearning: options.experienceLearning,
    experienceLearningRule: options.experienceLearningRule,
    onStrategyEvent: options.onStrategyEvent,
    retryFailedTask: options.retryFailedTask,
    retryFailedSystemErrors: options.retryFailedSystemErrors,
    reviewerRevision: options.reviewerRevision,
    onReviewerRevision: options.onReviewerRevision,
    tokenBudget: options.tokenBudget,
    isCheckableCriterion: options.isCheckableCriterion,
    semanticHypotheses: options.semanticHypotheses,
    semanticHypothesisJudge: options.semanticHypothesisJudge,
    onSemanticHypothesis: options.onSemanticHypothesis,
    onGateDecision: options.onGateDecision,
    rollbackExecutors: options.rollbackExecutors,
    contradictionChecker: options.contradictionChecker,
    lastContradictionCheckCount: 0,
    semanticChangeReviewer: options.semanticChangeReviewer,
    semanticTaskCompletion: options.semanticTaskCompletion,
    semanticConstraintJudge: options.semanticConstraintJudge,
    onConstraintRevision: options.onConstraintRevision,
    onTaskNotAccomplished: options.onTaskNotAccomplished,
    changeReviewFacts: options.changeReviewFacts,
    onReviewConflict: options.onReviewConflict,
    onFailureModeSwitch: options.onFailureModeSwitch,
    onLearnedStrategySwitch: options.onLearnedStrategySwitch,
    semanticFailureMatcher: options.semanticFailureMatcher,
    semanticCriterionCoverage: options.semanticCriterionCoverage,
    hookEnabled: options.hookEnabled,
    supervisorDecider: options.supervisorDecider,
    onSupervisorDirective: options.onSupervisorDirective,
    runInvestigation: options.runInvestigation,
    askUser: options.askUser,
    askMode: options.askMode,
    supervisorAskUserCount: 0,
    lastFailureMatchSymptomCount: 0,
    failureMatchedTaskIds: /* @__PURE__ */ new Set(),
    pendingProposal: void 0,
    pendingReviewerVerdict: void 0
  };
  warmStart(experienceStore, ctx.strategyState, ctx.failureDiagnostics, ctx.depGraphBudget, ctx.taskGraph);
  return ctx;
}
function buildResumedContext(rawCheckpoint, options) {
  const checkpoint = assertCheckpointSchemaCurrent(rawCheckpoint);
  const hydrated = HarnessRunState.fromJSON(checkpoint.runState);
  return {
    runId: checkpoint.runId,
    objective: checkpoint.runConfig.objective,
    successCriteria: checkpoint.runConfig.successCriteria,
    maxSteps: checkpoint.runConfig.maxSteps,
    depGraphBudget: DepGraphBudget.fromJSON(checkpoint.runConfig.depGraphBudget),
    processConceptId: checkpoint.runConfig.processConceptId,
    worldModel: hydrated.worldModel,
    callerState: hydrated.callerState,
    controlState: hydrated.controlState,
    taskGraph: hydrated.taskGraph,
    diagnostics: hydrated.diagnostics,
    hypothesisSet: hydrated.hypothesisSet,
    evidenceStore: hydrated.evidenceStore,
    memoryState: hydrated.memoryState,
    strategyState: hydrated.strategyState,
    failureDiagnostics: hydrated.failureDiagnostics,
    outputContract: hydrated.outputContract,
    beliefDepGraph: hydrated.beliefDepGraph,
    stepsUsed: checkpoint.progress.stepsUsed,
    nodeExecutionOrder: [...checkpoint.progress.nodeExecutionOrder],
    finalResult: checkpoint.progress.finalResult,
    consecutiveReviewFailures: new Map(checkpoint.progress.consecutiveReviewFailures),
    propagationQueue: { reopenedTaskIds: [...checkpoint.progress.propagationQueue.reopenedTaskIds] },
    // Live objects are never serialized — the caller re-attaches them on resume,
    // same as Python's state_store expecting a fresh db_session_factory after load.
    experienceStore: options.experienceStore ?? new UnavailableExperienceStore(),
    updateChannel: options.updateChannel ?? new NoOpUpdateChannel(),
    toolExecutors: options.toolExecutors ?? {},
    factExtractor: options.factExtractor,
    complexitySignal: options.complexitySignal,
    layerPolicy: options.layerPolicy,
    reevaluateLayerPolicy: options.reevaluateLayerPolicy,
    onLayerActivity: options.onLayerActivity,
    onVerification: options.onVerification,
    skipVerification: options.skipVerification,
    skipReviewerPass: options.skipReviewerPass,
    skipControlState: options.skipControlState,
    experienceLearning: options.experienceLearning,
    experienceLearningRule: options.experienceLearningRule,
    onStrategyEvent: options.onStrategyEvent,
    retryFailedTask: options.retryFailedTask,
    retryFailedSystemErrors: options.retryFailedSystemErrors,
    reviewerRevision: options.reviewerRevision,
    onReviewerRevision: options.onReviewerRevision,
    tokenBudget: options.tokenBudget,
    isCheckableCriterion: options.isCheckableCriterion,
    semanticHypotheses: options.semanticHypotheses,
    semanticHypothesisJudge: options.semanticHypothesisJudge,
    onSemanticHypothesis: options.onSemanticHypothesis,
    onGateDecision: options.onGateDecision,
    rollbackExecutors: options.rollbackExecutors,
    contradictionChecker: options.contradictionChecker,
    // Not part of HarnessCheckpoint — resets to 0 on resume, so the first check after a
    // resume treats every current belief as "new" once. Harmless: recordExternalContradiction
    // already dedupes by involved_belief_ids, so re-covering old-but-already-cleared pairs
    // just costs one slightly larger delta on the first post-resume check, never a duplicate.
    lastContradictionCheckCount: 0,
    semanticChangeReviewer: options.semanticChangeReviewer,
    semanticTaskCompletion: options.semanticTaskCompletion,
    semanticConstraintJudge: options.semanticConstraintJudge,
    onConstraintRevision: options.onConstraintRevision,
    onTaskNotAccomplished: options.onTaskNotAccomplished,
    changeReviewFacts: options.changeReviewFacts,
    onReviewConflict: options.onReviewConflict,
    onFailureModeSwitch: options.onFailureModeSwitch,
    onLearnedStrategySwitch: options.onLearnedStrategySwitch,
    semanticFailureMatcher: options.semanticFailureMatcher,
    semanticCriterionCoverage: options.semanticCriterionCoverage,
    hookEnabled: options.hookEnabled,
    supervisorDecider: options.supervisorDecider,
    onSupervisorDirective: options.onSupervisorDirective,
    runInvestigation: options.runInvestigation,
    askUser: options.askUser,
    askMode: options.askMode,
    supervisorAskUserCount: checkpoint.progress.supervisorAskUserCount ?? 0,
    lastFailureMatchSymptomCount: 0,
    failureMatchedTaskIds: /* @__PURE__ */ new Set(),
    pendingProposal: checkpoint.progress.pendingProposal ?? void 0,
    pendingReviewerVerdict: checkpoint.progress.pendingReviewerVerdict ?? void 0
  };
}
function toCheckpoint(ctx) {
  const runState = new HarnessRunState({
    worldModel: ctx.worldModel,
    callerState: ctx.callerState,
    controlState: ctx.controlState,
    diagnostics: ctx.diagnostics,
    taskGraph: ctx.taskGraph,
    outputContract: ctx.outputContract,
    evidenceStore: ctx.evidenceStore,
    hypothesisSet: ctx.hypothesisSet,
    memoryState: ctx.memoryState,
    strategyState: ctx.strategyState,
    failureDiagnostics: ctx.failureDiagnostics,
    experienceStore: ctx.experienceStore,
    beliefDepGraph: ctx.beliefDepGraph
  }).toJSON();
  const runConfig = {
    objective: ctx.objective,
    successCriteria: ctx.successCriteria,
    maxSteps: ctx.maxSteps,
    depGraphBudget: ctx.depGraphBudget.toJSON(),
    processConceptId: ctx.processConceptId
  };
  const progress = {
    stepsUsed: ctx.stepsUsed,
    nodeExecutionOrder: [...ctx.nodeExecutionOrder],
    finalResult: ctx.finalResult,
    consecutiveReviewFailures: [...ctx.consecutiveReviewFailures.entries()],
    propagationQueue: { reopenedTaskIds: [...ctx.propagationQueue.reopenedTaskIds] },
    pendingProposal: ctx.pendingProposal ?? null,
    pendingReviewerVerdict: ctx.pendingReviewerVerdict ?? null,
    supervisorAskUserCount: ctx.supervisorAskUserCount
  };
  return { runId: ctx.runId, runState, runConfig, progress, schemaVersion: CHECKPOINT_SCHEMA_VERSION };
}
function toInitResultShape(ctx) {
  return {
    worldModel: ctx.worldModel,
    callerState: ctx.callerState,
    controlState: ctx.controlState,
    taskGraph: ctx.taskGraph,
    diagnostics: ctx.diagnostics,
    hypothesisSet: ctx.hypothesisSet,
    evidenceStore: ctx.evidenceStore,
    memoryState: ctx.memoryState,
    strategyState: ctx.strategyState,
    failureDiagnostics: ctx.failureDiagnostics,
    outputContract: ctx.outputContract,
    beliefDepGraph: ctx.beliefDepGraph,
    depGraphBudget: ctx.depGraphBudget,
    maxSteps: ctx.maxSteps,
    decompositionGate: ctx.controlState.permission !== "DENY",
    valid: true,
    errors: [],
    processConceptId: ctx.processConceptId
  };
}
function reevaluatePolicy(ctx) {
  if (!ctx.reevaluateLayerPolicy) return;
  try {
    const next = ctx.reevaluateLayerPolicy({ iteration: ctx.stepsUsed, diagnostics: ctx.diagnostics, failures: ctx.failureDiagnostics.failure_history.length });
    if (next) ctx.layerPolicy = next;
  } catch {
  }
}
function notifyHost(fn) {
  try {
    fn();
  } catch {
  }
}
function reportLayer(ctx, layer, fired, reason, gate) {
  notifyHost(() => {
    var _a;
    return (_a = ctx.onLayerActivity) == null ? void 0 : _a.call(ctx, (gate == null ? void 0 : gate.trigger) !== void 0 ? { layer, fired, reason, decision: gate.decision, trigger: gate.trigger } : { layer, fired, reason });
  });
}
const NOT_ACCOMPLISHED_REPLY_PREFIX = "I didn't complete this step — ";
function stalledTurnFallbackResult(ctx) {
  var _a;
  if (ctx.lastNotAccomplished) {
    const { taskDescription, reason } = ctx.lastNotAccomplished;
    return `${NOT_ACCOMPLISHED_REPLY_PREFIX}${taskDescription.slice(0, 200)}: ${reason.slice(0, 300)} Nothing after it has run. Tell me how you'd like to proceed, or rephrase what you need.`;
  }
  const lastFailure = ((_a = ctx.failureDiagnostics.failure_history.at(-1)) == null ? void 0 : _a.description) ?? "";
  const detail = lastFailure.replace(/^Task failed:\s*/i, "").trim();
  return detail ? `I couldn't complete this — I kept running into a problem (${detail.slice(0, 200)}). You may want to retry or rephrase what you need.` : `I couldn't complete this — I kept running into a problem and stopped before finishing. You may want to retry or rephrase what you need.`;
}
function anyDiagnosticSubDimensionCautious(diagnostics) {
  const healthy = [
    diagnostics.belief_health.freshness,
    diagnostics.belief_health.consistency,
    diagnostics.belief_health.support,
    diagnostics.coverage_health.symptom_coverage,
    diagnostics.coverage_health.explanation_coverage,
    diagnostics.verification_health.strength,
    diagnostics.verification_health.feasibility,
    diagnostics.execution_health.progress_rate
  ];
  const inverted = [diagnostics.execution_health.failure_recurrence, diagnostics.execution_health.oscillation_score];
  return healthy.some((v) => v < CAUTION_THRESHOLD) || inverted.some((v) => v > 1 - CAUTION_THRESHOLD);
}
function pinnedNormalControlState(worldModel) {
  const cs = new ControlState();
  cs.generation_id = worldModel.generation_id;
  return cs;
}
function controlStateResolverFor(ctx) {
  return ctx.skipControlState ? (_diagnostics, worldModel) => pinnedNormalControlState(worldModel) : resolveControlState;
}
const SEMANTIC_SOURCE = "semantic";
function hasSemanticHypotheses(ctx) {
  return ctx.hypothesisSet.active.some((h) => h.generation_sources.includes(SEMANTIC_SOURCE));
}
function emitSemanticHypothesis(ctx, event) {
  var _a;
  try {
    (_a = ctx.onSemanticHypothesis) == null ? void 0 : _a.call(ctx, event);
  } catch {
  }
}
async function generateSemanticHypotheses(ctx) {
  if (!ctx.semanticHypotheses || hasSemanticHypotheses(ctx) || ctx.semanticHypothesesAsked) return;
  ctx.semanticHypothesesAsked = true;
  let proposals = null;
  try {
    proposals = await ctx.semanticHypotheses({
      objective: ctx.objective,
      observations: ctx.evidenceStore.observations.map((o) => o.obs),
      beliefs: ctx.worldModel.beliefs.map((b) => b.statement)
    });
  } catch {
    return;
  }
  const usable = (proposals ?? []).filter((p) => typeof (p == null ? void 0 : p.explanation) === "string" && p.explanation.trim() !== "");
  if (usable.length === 0) return;
  const created = usable.map((p, i) => ({
    id: `sem_${[...ctx.hypothesisSet.active, ...ctx.hypothesisSet.eliminated].filter((h) => h.generation_sources.includes(SEMANTIC_SOURCE)).length + i}`,
    explanation: p.explanation.trim(),
    confidence: typeof p.confidence === "number" && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : 1 / usable.length,
    predicted_observations: (p.predicted_observations ?? []).filter((x) => typeof x === "string" && x.trim() !== ""),
    discriminating_evidence: [],
    generation_sources: [SEMANTIC_SOURCE],
    diversity_score: 0,
    ...typeof p.separating_check === "string" && p.separating_check.trim() ? { separating_check: p.separating_check.trim() } : {}
  }));
  ctx.hypothesisSet.active.push(...created);
  emitSemanticHypothesis(ctx, {
    kind: "generated",
    hypotheses: created.map((h) => ({ id: h.id, explanation: h.explanation, predicted_observations: h.predicted_observations, ...h.separating_check ? { separating_check: h.separating_check } : {} }))
  });
}
async function judgeSemanticHypotheses(ctx) {
  if (!ctx.semanticHypothesisJudge || !hasSemanticHypotheses(ctx)) return;
  const observations = ctx.evidenceStore.observations;
  const from = ctx.lastJudgedObservationCount ?? 0;
  const fresh = observations.slice(from);
  ctx.lastJudgedObservationCount = observations.length;
  if (fresh.length === 0) return;
  const live = ctx.hypothesisSet.active.filter((h) => h.generation_sources.includes(SEMANTIC_SOURCE));
  let verdict = null;
  try {
    verdict = await ctx.semanticHypothesisJudge({
      hypotheses: live.map((h) => ({ id: h.id, explanation: h.explanation, predicted_observations: h.predicted_observations })),
      observations: fresh.map((o) => o.obs)
    });
  } catch {
    return;
  }
  for (const c of (verdict == null ? void 0 : verdict.contradicted) ?? []) {
    const h = live.find((x) => x.id === (c == null ? void 0 : c.id));
    if (!h) continue;
    ctx.hypothesisSet.eliminate(h);
    emitSemanticHypothesis(ctx, { kind: "eliminated", id: h.id, explanation: h.explanation, ...c.reason ? { reason: c.reason } : {} });
  }
}
function maybeReopenForReviewerRevision(ctx, result) {
  var _a;
  if (!ctx.reviewerRevision || ctx.reviewerRevisionDone || !result.pending_verdict || result.reopened_task_ids.length > 0) return void 0;
  if (!ctx.taskGraph.tasks.every((t) => t.status === "COMPLETE")) return void 0;
  const taskId = ctx.lastCompletedTaskId;
  if (!taskId || !ctx.taskGraph.getTask(taskId)) return void 0;
  let note = null;
  try {
    note = ctx.reviewerRevision(result.pending_verdict);
  } catch {
    return void 0;
  }
  if (!note || !note.trim()) return void 0;
  ctx.reviewerRevisionDone = true;
  try {
    (_a = ctx.onReviewerRevision) == null ? void 0 : _a.call(ctx, { taskId, note });
  } catch {
  }
  return taskId;
}
function retrySystemErrorOnce(ctx, taskId, execResult) {
  if (ctx.retryFailedSystemErrors !== true || execResult.success || execResult.failure_kind !== "system_error") return false;
  const retried = ctx.systemErrorRetried ?? (ctx.systemErrorRetried = /* @__PURE__ */ new Set());
  if (retried.has(taskId)) return false;
  retried.add(taskId);
  return true;
}
async function judgeConstraints(ctx, judge) {
  if (!judge || ctx.callerState.current_constraints.length === 0) return [];
  const reply = typeof ctx.finalResult === "string" ? ctx.finalResult : ctx.finalResult == null ? "" : JSON.stringify(ctx.finalResult);
  if (reply.trim() === "") return [];
  if (reply === ctx.stalledFallbackText) return [];
  try {
    return (await judge({ constraints: [...ctx.callerState.current_constraints], reply })).violated ?? [];
  } catch {
    return [];
  }
}
function maybeReopenForConstraintRevision(ctx, violated) {
  if (!ctx.onConstraintRevision || ctx.constraintRevisionDone) return void 0;
  if (!ctx.taskGraph.tasks.every((t) => t.status === "COMPLETE")) return void 0;
  const taskId = ctx.lastCompletedTaskId;
  if (!taskId || !ctx.taskGraph.getTask(taskId)) return void 0;
  ctx.constraintRevisionDone = true;
  const note = violated.map((v) => `Your answer violates the constraint "${v.constraint}"${v.reason ? ` (${v.reason})` : ""}.`).join(" ");
  try {
    ctx.onConstraintRevision({ taskId, note, violated });
  } catch {
  }
  return taskId;
}
function reportDiagnosticsHealth(ctx, onlyOnChange = false) {
  const cautious = anyDiagnosticSubDimensionCautious(ctx.diagnostics);
  if (onlyOnChange && ctx.lastReportedDiagnosticsCautious === cautious) return;
  ctx.lastReportedDiagnosticsCautious = cautious;
  reportLayer(ctx, "diagnostics", true, cautious ? "a sub-dimension crossed the caution threshold" : "Health: nominal");
}
function resolveAndStamp(ctx) {
  const verdict = ctx.pendingReviewerVerdict;
  ctx.pendingReviewerVerdict = void 0;
  const newCS = ctx.skipControlState ? pinnedNormalControlState(ctx.worldModel) : resolveControlState(ctx.diagnostics, ctx.worldModel, ctx.failureDiagnostics, void 0, verdict);
  ctx.controlState.generation_id = newCS.generation_id;
  ctx.controlState.permission = newCS.permission;
  ctx.controlState.execution_mode = newCS.execution_mode;
  ctx.controlState.escalation = newCS.escalation;
  ctx.controlState.risk_estimate = newCS.risk_estimate;
  ctx.controlState.confidence_estimate = newCS.confidence_estimate;
  ctx.controlState.escalation_reason = newCS.escalation_reason;
  ctx.controlState.block_mask = [...newCS.block_mask];
  ctx.controlState.notes = [...newCS.notes];
}
async function* driveMainLoop(ctx) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  while (true) {
    let currentTask;
    let concurrentTask = null;
    let gateResult;
    let shouldGatherEvidence = false;
    const sig = ctx.complexitySignal;
    if (ctx.pendingProposal) {
      const p = ctx.pendingProposal;
      ctx.pendingProposal = void 0;
      const resumed = ctx.taskGraph.tasks.find((t) => t.id === p.taskId);
      if (!resumed) continue;
      currentTask = resumed;
      gateResult = p.gateResult;
      shouldGatherEvidence = p.shouldGatherEvidence;
      ctx.nodeExecutionOrder.push(p.kind === "continuation" ? "action_gate_replay_continuation" : "action_gate_replay");
      if (p.kind === "continuation") {
        ctx.stepsUsed++;
        if (ctx.stepsUsed > ctx.maxSteps) {
          const exhaust = escalateBudgetExhausted(ctx.stepsUsed, ctx.maxSteps);
          if (resolveAskMode({ globalEnabled: ctx.askMode === "enabled" })) {
            askQuestion([buildBudgetExhaustedQuestion(ctx.stepsUsed)], {
              reason: "budget_exhausted",
              missingInfo: exhaust.missing_info,
              currentTaskSummary: `Exhausted at step ${ctx.stepsUsed} (no iteration reached completion)`,
              globalEnabled: ctx.askMode === "enabled"
            });
          }
          throw new EscalationHalt({
            reason: "budget_exhausted",
            missing_info: exhaust.missing_info,
            current_task_summary: `Exhausted at step ${ctx.stepsUsed} (no iteration reached completion)`,
            escalated_at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
    } else {
      ctx.stepsUsed++;
      if (ctx.stepsUsed > ctx.maxSteps && !nothingLeftToRun(ctx)) {
        const exhaust = escalateBudgetExhausted(ctx.stepsUsed, ctx.maxSteps);
        if (resolveAskMode({ globalEnabled: ctx.askMode === "enabled" })) {
          askQuestion([buildBudgetExhaustedQuestion(ctx.stepsUsed)], {
            reason: "budget_exhausted",
            missingInfo: exhaust.missing_info,
            currentTaskSummary: `Exhausted at step ${ctx.stepsUsed} (no iteration reached completion)`,
            globalEnabled: ctx.askMode === "enabled"
          });
        }
        throw new EscalationHalt({
          reason: "budget_exhausted",
          missing_info: exhaust.missing_info,
          current_task_summary: `Exhausted at step ${ctx.stepsUsed} (no iteration reached completion)`,
          escalated_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      ctx.nodeExecutionOrder.push("context_compression");
      if (ctx.tokenBudget) {
        let used = 0;
        try {
          used = Math.floor(ctx.tokenBudget.used());
        } catch {
        }
        ctx.memoryState.token_budget = { total: Math.max(1, Math.floor(ctx.tokenBudget.total)), used: Number.isFinite(used) && used > 0 ? used : 0 };
      }
      contextCompression(
        ctx.memoryState,
        ctx.worldModel,
        ctx.beliefDepGraph,
        ctx.depGraphBudget,
        ctx.hypothesisSet,
        ctx.taskGraph,
        ctx.diagnostics,
        ctx.controlState,
        ctx.callerState
      );
      ctx.nodeExecutionOrder.push("check_caller_updates");
      const updateResult = await pollCallerUpdates(ctx);
      if (updateResult === RESTART_ITERATION) {
        resolveAndStamp(ctx);
        continue;
      }
      ctx.nodeExecutionOrder.push("detect_contradictions");
      const contradictionsBefore = ctx.worldModel.contradictions.length;
      detectContradictions(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, void 0, ctx.beliefDepGraph);
      if (ctx.contradictionChecker && hookOn(ctx, "semantic_contradiction")) {
        let skipCoverageMark = false;
        const newBeliefs = ctx.worldModel.beliefs.slice(ctx.lastContradictionCheckCount);
        const existingBeliefs = ctx.worldModel.beliefs.slice(0, ctx.lastContradictionCheckCount);
        if (newBeliefs.length > 0 && (existingBeliefs.length > 0 || newBeliefs.length >= 2)) {
          let found = null;
          try {
            found = await ctx.contradictionChecker(
              newBeliefs.map((b) => ({ id: b.id, statement: b.statement })),
              existingBeliefs.map((b) => ({ id: b.id, statement: b.statement }))
            );
          } catch {
            found = null;
          }
          if (found === null) skipCoverageMark = true;
          for (const input of found ?? []) {
            recordExternalContradiction(ctx.worldModel, input, ctx.beliefDepGraph);
          }
        }
        if (!skipCoverageMark) ctx.lastContradictionCheckCount = ctx.worldModel.beliefs.length;
      }
      if (ctx.worldModel.contradictions.length > contradictionsBefore) {
        reportLayer(ctx, "contradiction", true, `Heads up — this seems to conflict with something you told me earlier: ${((_a = ctx.worldModel.contradictions.at(-1)) == null ? void 0 : _a.description) ?? ""}`);
      } else {
        reportLayer(ctx, "contradiction", false, ctx.worldModel.beliefs.length >= 2 ? "checked — no conflicts found" : "fewer than 2 beliefs — nothing to compare");
      }
      const hypothesisGate = resolveGate(
        ctx.layerPolicy,
        "hypothesis_display",
        ((sig == null ? void 0 : sig.taskCount) ?? 1) > 1 || ((sig == null ? void 0 : sig.riskLevel) ?? "LOW") !== "LOW" || ctx.failureDiagnostics.failure_history.length > 0
      );
      const hypothesisNotable = hypothesisGate.on;
      ctx.nodeExecutionOrder.push("generate_update_hypotheses");
      generateUpdateHypotheses(ctx.worldModel, ctx.evidenceStore, ctx.hypothesisSet, ctx.failureDiagnostics, ctx.memoryState);
      await generateSemanticHypotheses(ctx);
      const semanticActive = ctx.hypothesisSet.active.filter((h) => h.generation_sources.includes(SEMANTIC_SOURCE)).length;
      if (semanticActive > 0) {
        reportLayer(ctx, "hypothesis", true, `Weighing ${semanticActive} competing explanation${semanticActive === 1 ? "" : "s"} for this request`, hypothesisGate);
      } else {
        reportLayer(
          ctx,
          "hypothesis",
          hypothesisNotable && ctx.hypothesisSet.active.length > 1,
          hypothesisNotable && ctx.hypothesisSet.active.length > 1 ? `Considered ${ctx.hypothesisSet.active.length} ways this request could be understood; going with the most direct one` : "single clear LOW-risk task — no competing explanation worth surfacing",
          hypothesisGate
        );
      }
      ctx.nodeExecutionOrder.push("update_diagnostics");
      updateDiagnostics(ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph, ctx.failureDiagnostics, ctx.beliefDepGraph, ctx.diagnostics);
      reevaluatePolicy(ctx);
      reportDiagnosticsHealth(ctx);
      ctx.worldModel.incrementGenerationId();
      ctx.nodeExecutionOrder.push("resolve_control_state");
      resolveAndStamp(ctx);
      reportLayer(ctx, "control_state", riskSummary(ctx.controlState) !== "NORMAL", ctx.controlState.permission === "DENY" ? `Pausing — ${ctx.controlState.escalation_reason ?? "blocked"}` : ctx.controlState.execution_mode === "CAUTIOUS" ? `Proceeding carefully — ${ctx.controlState.escalation_reason ?? "elevated risk"}` : "NORMAL");
      const allComplete = ctx.taskGraph.tasks.length > 0 && ctx.taskGraph.tasks.every((t) => t.status === "COMPLETE");
      if (allComplete) return;
      ctx.nodeExecutionOrder.push("update_task_graph");
      updateTaskGraph(ctx.objective, ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph);
      ctx.nodeExecutionOrder.push("select_task");
      const selectResult = selectTask(ctx.taskGraph, ctx.controlState);
      if (selectResult.escalate) {
        throw new EscalationHalt({
          reason: "cannot_make_progress",
          missing_info: ["HUMAN_REQUIRED escalation from select_task"],
          current_task_summary: "task selection triggered escalation",
          escalated_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      if (selectResult.task === null) {
        const noUsableResult = typeof ctx.finalResult !== "string" || ctx.finalResult.trim() === "";
        if (noUsableResult && ctx.taskGraph.tasks.some((t) => t.status === "FAILED")) {
          const fallback = stalledTurnFallbackResult(ctx);
          ctx.finalResult = fallback;
          ctx.stalledFallbackText = typeof fallback === "string" ? fallback : void 0;
          reportLayer(ctx, "recovery", true, "turn stalled with no answer — returning an explicit could-not-complete reply");
        }
        return;
      }
      currentTask = selectResult.task;
      concurrentTask = selectResult.concurrentTask;
      applyTaskOutcome(ctx.taskGraph, currentTask.id, { status: "RUNNING" });
      ctx.nodeExecutionOrder.push("estimate_risk");
      const riskAction = {
        module_type: ((_b = ctx.complexitySignal) == null ? void 0 : _b.riskLevel) === "HIGH" ? "infrastructure" : "business_logic"
      };
      estimateRisk(riskAction, ctx.taskGraph, ctx.worldModel);
      reportLayer(ctx, "execution", true, `module_type=${riskAction.module_type}`);
      ctx.nodeExecutionOrder.push("estimate_voi");
      const voiResult = estimateVOI(ctx.diagnostics, ctx.worldModel, ctx.hypothesisSet, ctx.evidenceStore.tool_availability_manifest);
      shouldGatherEvidence = voiResult.should_gather_evidence;
      ctx.nodeExecutionOrder.push("review_proposed_change");
      let reviewResult = reviewProposedChange(
        { description: currentTask.description },
        currentTask,
        ctx.worldModel,
        ctx.outputContract,
        ctx.hypothesisSet,
        ctx.evidenceStore,
        ctx.consecutiveReviewFailures
      );
      if (reviewResult.passed && ctx.semanticChangeReviewer && hookOn(ctx, "change_review")) {
        const highConfidenceBeliefs = ctx.worldModel.beliefs.filter((b) => b.confidence >= 0.8).map((b) => ({ id: b.id, statement: b.statement }));
        const known = new Set(highConfidenceBeliefs.map((b) => b.statement));
        (((_c = ctx.changeReviewFacts) == null ? void 0 : _c.call(ctx)) ?? []).forEach((f, i) => {
          if (known.has(f.statement)) return;
          known.add(f.statement);
          highConfidenceBeliefs.push({ id: `known-fact-${i}`, statement: f.statement });
        });
        const hypothesisPredictions = ctx.hypothesisSet.active.flatMap((h) => h.predicted_observations);
        if (highConfidenceBeliefs.length > 0 || hypothesisPredictions.length > 0) {
          let semanticResult = { conflict: false };
          try {
            semanticResult = await ctx.semanticChangeReviewer({
              changeDescription: currentTask.description,
              highConfidenceBeliefs,
              hypothesisPredictions
            });
          } catch {
          }
          if (semanticResult == null ? void 0 : semanticResult.conflict) {
            notifyHost(() => {
              var _a2;
              return (_a2 = ctx.onReviewConflict) == null ? void 0 : _a2.call(ctx, {
                taskId: currentTask.id,
                reason: semanticResult.reason ?? "Semantic review found a conflict with known context"
              });
            });
          }
        }
      }
      if (!reviewResult.passed) {
        applyTaskOutcome(ctx.taskGraph, currentTask.id, { status: "PENDING", fromExecutionLayer: false });
        if (reviewResult.escalation_triggered) {
          const fixOptions = resolveAskMode({ globalEnabled: ctx.askMode === "enabled" }) ? diagnoseReviewFailureOptions(reviewResult.failed_dimensions) : void 0;
          if (fixOptions) {
            askQuestion([buildReviewFailureQuestion(fixOptions)], {
              reason: "review_failure",
              missingInfo: reviewResult.failed_dimensions.map((d) => d.reason),
              currentTaskSummary: currentTask.description,
              globalEnabled: ctx.askMode === "enabled"
            });
          }
          throw new EscalationHalt({
            reason: "review_failure",
            missing_info: reviewResult.failed_dimensions.map((d) => d.reason),
            current_task_summary: currentTask.description,
            escalated_at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        continue;
      }
      ctx.nodeExecutionOrder.push("action_gate");
      gateResult = actionGate(
        { required_resources: [] },
        ctx.controlState,
        ctx.worldModel,
        ctx.diagnostics,
        ctx.failureDiagnostics,
        controlStateResolverFor(ctx)
      );
      ctx.pendingProposal = { taskId: currentTask.id, gateResult, shouldGatherEvidence, kind: "proposal" };
      yield toCheckpoint(ctx);
      ctx.pendingProposal = void 0;
    }
    if (gateResult === "ESCALATE" || gateResult === "BLOCK") {
      applyTaskOutcome(ctx.taskGraph, currentTask.id, { status: "PENDING", fromExecutionLayer: false });
      const stalled = cannotMakeProgress(ctx.strategyState, ctx.failureDiagnostics);
      notifyHost(() => {
        var _a2;
        return (_a2 = ctx.onGateDecision) == null ? void 0 : _a2.call(ctx, {
          taskId: currentTask.id,
          result: gateResult,
          reason: ctx.controlState.escalation_reason,
          haltedRun: stalled
        });
      });
      if (stalled) {
        throw new EscalationHalt({
          reason: "cannot_make_progress",
          missing_info: [ctx.strategyState.stall_reason ?? "unknown"],
          current_task_summary: currentTask.description,
          escalated_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      continue;
    }
    ctx.nodeExecutionOrder.push("execute");
    const proposedChange = {
      description: currentTask.description,
      change_type: "file_mutation"
    };
    const toolFn = ctx.toolExecutors[currentTask.id] ?? ctx.toolExecutors["default"] ?? (() => ({ completed: true }));
    const execResult = await execute(proposedChange, toolFn, {
      worldModel: ctx.worldModel,
      evidenceStore: ctx.evidenceStore,
      taskGraph: ctx.taskGraph,
      currentTask,
      memoryState: ctx.memoryState,
      beliefDepGraph: ctx.beliefDepGraph,
      controlState: ctx.controlState,
      diagnostics: ctx.diagnostics,
      failureDiagnostics: ctx.failureDiagnostics
    });
    if (execResult.status === "continue") {
      ctx.pendingProposal = { taskId: currentTask.id, gateResult, shouldGatherEvidence, kind: "continuation" };
      yield toCheckpoint(ctx);
      continue;
    }
    let taskAccomplished = true;
    if (execResult.success && ctx.semanticTaskCompletion) {
      let verdict = { done: true };
      try {
        verdict = await ctx.semanticTaskCompletion({ taskDescription: currentTask.description, output: execResult.output });
      } catch {
      }
      if (!verdict.done) {
        taskAccomplished = false;
        const why = verdict.reason ?? "the output did not do what the task asked";
        ctx.lastNotAccomplished = { taskDescription: currentTask.description, reason: why };
        ctx.worldModel.observations.push({
          id: `not-done-${currentTask.id}-${ctx.stepsUsed}`,
          content: `TASK_NOT_ACCOMPLISHED: ${why}`,
          source: "task_completion_check",
          recorded_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        try {
          applyTaskOutcome(ctx.taskGraph, currentTask.id, { status: "FAILED", fromExecutionLayer: true });
        } catch {
        }
        try {
          (_d = ctx.onTaskNotAccomplished) == null ? void 0 : _d.call(ctx, { taskId: currentTask.id, reason: why });
        } catch {
        }
        reportLayer(ctx, "verification", true, `task not accomplished — ${why}`);
      }
    }
    const parallelEligible = concurrentTask !== null && currentTask.risk_level !== "HIGH" && concurrentTask.risk_level !== "HIGH";
    reportLayer(ctx, "planning", parallelEligible, parallelEligible && concurrentTask ? `Reading "${currentTask.description}" and "${concurrentTask.description}" at once` : concurrentTask ? "candidate found but too risky to run in parallel — serial execution" : "one eligible task — serial execution");
    let branchWorldModel = null;
    let branchExecSucceeded = false;
    if (parallelEligible && concurrentTask) {
      applyTaskOutcome(ctx.taskGraph, concurrentTask.id, { status: "RUNNING" });
      branchWorldModel = WorldModel.fromJSON(ctx.worldModel.toJSON());
      const branchToolFn = ctx.toolExecutors[concurrentTask.id] ?? ctx.toolExecutors["default"] ?? (() => ({ completed: true }));
      const branchExecResult = await execute(
        { description: concurrentTask.description, change_type: "read-only" },
        branchToolFn,
        {
          worldModel: branchWorldModel,
          evidenceStore: ctx.evidenceStore,
          taskGraph: ctx.taskGraph,
          currentTask: concurrentTask,
          memoryState: ctx.memoryState,
          beliefDepGraph: ctx.beliefDepGraph,
          controlState: ctx.controlState,
          diagnostics: ctx.diagnostics,
          failureDiagnostics: ctx.failureDiagnostics
        }
      );
      branchExecSucceeded = branchExecResult.success;
      if (branchExecSucceeded) {
        const branchEvidence = gatherEvidence(
          {
            id: `exec-${concurrentTask.id}-${ctx.stepsUsed}`,
            obs: `Task executed: ${concurrentTask.description}`,
            source: "execution_engine",
            evidence_type: "OBSERVATION",
            reliability: "HIGH"
          },
          ctx.evidenceStore
        );
        if (branchEvidence) {
          updateWorldModel(applyToolReliability(branchEvidence, ctx.evidenceStore, ctx.diagnostics), branchWorldModel, ctx.diagnostics);
        }
      }
    }
    ctx.worldModel.incrementGenerationId();
    ctx.nodeExecutionOrder.push("gather_evidence");
    ctx.nodeExecutionOrder.push("apply_tool_reliability");
    ctx.nodeExecutionOrder.push("update_world_model_post_exec");
    if (execResult.success) {
      const executed = gatherEvidence(
        {
          id: `exec-${currentTask.id}-${ctx.stepsUsed}`,
          obs: `Task executed: ${currentTask.description}`,
          source: "execution_engine",
          evidence_type: "OBSERVATION",
          reliability: "HIGH"
        },
        ctx.evidenceStore
      );
      if (executed) {
        const capped = applyToolReliability(executed, ctx.evidenceStore, ctx.diagnostics);
        updateWorldModel(capped, ctx.worldModel, ctx.diagnostics);
      }
      const outcome = gatherEvidence(
        {
          id: `result-${currentTask.id}-${ctx.stepsUsed}`,
          obs: `Result: ${summariseExecutionOutput(execResult.output)}`,
          source: "result_inspection",
          evidence_type: "OBSERVATION",
          reliability: "MEDIUM"
        },
        ctx.evidenceStore
      );
      if (outcome) {
        const cappedOutcome = applyToolReliability(outcome, ctx.evidenceStore, ctx.diagnostics);
        updateWorldModel(cappedOutcome, ctx.worldModel, ctx.diagnostics);
      }
      const gateTools = (sig == null ? void 0 : sig.exercisedTools) ?? (sig == null ? void 0 : sig.consequentialTools);
      const evidenceShouldEscalate = resolveGate(ctx.layerPolicy, "evidence_escalation", ((gateTools == null ? void 0 : gateTools.size) ?? 0) > 0 || shouldGatherEvidence).on;
      if (evidenceShouldEscalate) {
        for (const tool of gateTools ?? []) {
          if (!ctx.evidenceStore.tool_reliability_envelopes[tool]) {
            ctx.evidenceStore.tool_reliability_envelopes[tool] = {
              tool,
              max_observation_reliability: "MEDIUM",
              max_conclusion_reliability: "MEDIUM"
            };
          }
        }
        reportLayer(ctx, "evidence_reasoning", true, `Cross-checking with ${Math.max(1, (gateTools == null ? void 0 : gateTools.size) ?? 0)} source(s) before answering.`);
      } else {
        reportLayer(ctx, "evidence_reasoning", false, "single low-stakes observation is sufficient");
      }
      const facts = ((_e = ctx.factExtractor) == null ? void 0 : _e.call(ctx, ctx.objective)) ?? [];
      const worldModelShouldFire = facts.length > 0 || ((sig == null ? void 0 : sig.taskCount) ?? 1) > 1 || ((sig == null ? void 0 : sig.riskLevel) ?? "LOW") !== "LOW";
      if (worldModelShouldFire) {
        facts.forEach((fact, i) => {
          const factEvidence = gatherEvidence(
            {
              id: `fact-${currentTask.id}-${ctx.stepsUsed}-${i}`,
              obs: fact.statement,
              source: "fact_extraction",
              evidence_type: "INFERENCE",
              reliability: "MEDIUM"
            },
            ctx.evidenceStore
          );
          if (factEvidence) {
            const cappedFact = applyToolReliability(factEvidence, ctx.evidenceStore, ctx.diagnostics);
            updateWorldModel(cappedFact, ctx.worldModel, ctx.diagnostics, {
              statement: fact.statement,
              derived_from: [factEvidence.id]
            });
          }
        });
        const trailGate = resolveGate(ctx.layerPolicy, "belief_trail", true);
        if (facts.length === 0 && trailGate.on) {
          const trailSource = executed ?? outcome;
          if (trailSource && taskAccomplished) {
            const trailEvidence = gatherEvidence(
              {
                id: `belief-${currentTask.id}-${ctx.stepsUsed}`,
                obs: completedTrailStatement(currentTask.description, execResult.output),
                source: "world_model_trail",
                evidence_type: "INFERENCE",
                reliability: "MEDIUM"
              },
              ctx.evidenceStore
            );
            if (trailEvidence) {
              updateWorldModel(trailEvidence, ctx.worldModel, ctx.diagnostics, {
                statement: completedTrailStatement(currentTask.description, execResult.output),
                derived_from: outcome ? [trailSource.id, outcome.id] : [trailSource.id]
              });
            }
          }
        }
        const newFact = facts.find((f) => f.isNew);
        if (newFact) {
          reportLayer(ctx, "world_model", true, `Remembered: ${newFact.statement}`);
        } else if (facts.length > 0) {
          reportLayer(ctx, "world_model", false, `no new fact this turn — ${facts.length} known fact(s) carried forward`);
        } else if (!trailGate.on) {
          reportLayer(ctx, "world_model", false, "belief trail skipped by layer policy", trailGate);
        } else {
          reportLayer(ctx, "world_model", true, "recorded a belief trail for a multi-step/consequential turn", trailGate);
        }
      } else {
        reportLayer(ctx, "world_model", false, "single LOW-risk task, no durable fact stated — observation only");
      }
    }
    for (const tool of ["pytest", "integration_runner", "consistency_checker", "assumption_checker", "goal_checker"]) {
      if (!(tool in ctx.evidenceStore.tool_availability_manifest)) {
        ctx.evidenceStore.tool_availability_manifest[tool] = { available: false, fallback_tool: null };
      }
    }
    await judgeSemanticHypotheses(ctx);
    ctx.nodeExecutionOrder.push("update_diagnostics_post_exec");
    updateDiagnostics(ctx.worldModel, ctx.hypothesisSet, ctx.taskGraph, ctx.failureDiagnostics, ctx.beliefDepGraph, ctx.diagnostics);
    reevaluatePolicy(ctx);
    reportDiagnosticsHealth(ctx, true);
    const thisTaskFailed = !execResult.success || ctx.failureDiagnostics.failure_history.some((f) => {
      var _a2;
      return ((_a2 = f.context) == null ? void 0 : _a2["task_id"]) === currentTask.id;
    });
    if (ctx.semanticFailureMatcher && hookOn(ctx, "failure_match") && ctx.failureDiagnostics.matched_pattern === null && thisTaskFailed && !ctx.failureMatchedTaskIds.has(currentTask.id)) {
      const libraryEntries = ctx.failureDiagnostics.failure_mode_library.getEntries();
      const symptoms = ctx.worldModel.observations.map((o) => o.content);
      if (symptoms.length > 0 && libraryEntries.length > 0 && symptoms.length !== ctx.lastFailureMatchSymptomCount) {
        ctx.lastFailureMatchSymptomCount = symptoms.length;
        let semanticMatch = null;
        try {
          semanticMatch = await ctx.semanticFailureMatcher(symptoms, libraryEntries);
        } catch {
        }
        if (semanticMatch) {
          ctx.failureMatchedTaskIds.add(currentTask.id);
          ctx.failureDiagnostics.matched_pattern = {
            ...semanticMatch,
            confidence: normalise(semanticMatch.confidence, DimensionType.match_confidence),
            strategy_affinity: resolveSemanticMatchStrategy(semanticMatch, libraryEntries)
          };
        }
      }
    }
    ctx.nodeExecutionOrder.push("resolve_control_state_b");
    resolveAndStamp(ctx);
    ctx.nodeExecutionOrder.push("verify");
    const verifyResult = ctx.skipVerification ? { layer_results: [], has_critical_failure: false, adversarial_passed: null, critical_failure_tiers: [] } : verify(
      execResult.output,
      ctx.successCriteria,
      ctx.worldModel.assumptions,
      ctx.evidenceStore,
      currentTask.risk_level,
      ctx.evidenceStore,
      ctx.worldModel,
      ctx.outputContract,
      ctx.hypothesisSet
    );
    if (ctx.skipVerification) {
      reportLayer(ctx, "verification", false, "verification skipped (eval ablation)");
    } else {
      reportLayer(ctx, "verification", true, verifyResult.has_critical_failure ? `verification failed: ${((_f = verifyResult.layer_results.find((lr) => lr.status === "FAIL")) == null ? void 0 : _f.detail) ?? "unknown"}` : "all applicable layers passed");
      notifyHost(() => {
        var _a2;
        return (_a2 = ctx.onVerification) == null ? void 0 : _a2.call(ctx, verifyResult);
      });
    }
    ctx.nodeExecutionOrder.push("post_exec_gate");
    const postGatePassed = postExecGate(
      execResult.output,
      verifyResult,
      ctx.controlState,
      ctx.worldModel,
      ctx.diagnostics,
      ctx.failureDiagnostics,
      ctx.outputContract,
      controlStateResolverFor(ctx)
    );
    ctx.nodeExecutionOrder.push("update_task_state");
    if (ctx.experienceLearning) {
      const taskSucceeded = postGatePassed && execResult.success && taskAccomplished;
      ctx.memoryState.journal.push(journalEntryFor({
        step: ctx.stepsUsed,
        strategy: ctx.strategyState.current_strategy,
        success: taskSucceeded,
        // '' for an unmatched failure — the same class buildStrategyOrdering looks up for it.
        failureClass: taskSucceeded ? void 0 : ((_g = ctx.failureDiagnostics.matched_pattern) == null ? void 0 : _g.failure_class) ?? "",
        output: execResult.output
      }));
    }
    if (postGatePassed && execResult.success && taskAccomplished) {
      applyTaskOutcome(ctx.taskGraph, currentTask.id, { status: "COMPLETE", fromExecutionLayer: true });
      ctx.lastCompletedTaskId = currentTask.id;
      ctx.finalResult = execResult.output;
      if (ctx.experienceStore.available) {
        ctx.experienceStore.updateExperienceStore(
          `${currentTask.id}-step-${ctx.stepsUsed}`,
          { task_id: currentTask.id, outcome: "COMPLETE", step: ctx.stepsUsed }
        );
      }
      reportLayer(ctx, "recovery", false, "task completed — nothing to recover from");
    } else {
      if (taskAccomplished) ctx.lastNotAccomplished = void 0;
      ctx.nodeExecutionOrder.push("rollback_replan");
      const rollbackFn = ((_h = ctx.rollbackExecutors) == null ? void 0 : _h[currentTask.id]) ?? ((_i = ctx.rollbackExecutors) == null ? void 0 : _i["default"]);
      let supervisorDirective = null;
      let supervisorOriginalAction = null;
      if (ctx.supervisorDecider && cannotMakeProgress(ctx.strategyState, ctx.failureDiagnostics)) {
        const digest = buildDigest(ctx.strategyState, ctx.failureDiagnostics, ctx.taskGraph, ctx.worldModel, {
          successCriteria: ctx.successCriteria
        });
        supervisorDirective = await resolveSupervisorDirective(
          ctx.supervisorDecider,
          digest.toJSON(),
          ctx.onSupervisorDirective
        );
        supervisorOriginalAction = supervisorDirective.action;
        if (supervisorDirective.action === "GATHER_EVIDENCE") {
          supervisorDirective = await resolveGatherEvidence(ctx.worldModel, supervisorDirective, ctx.runInvestigation);
        }
        if (supervisorDirective.action === "ABORT") {
          ctx.strategyState.switch_triggers.push(
            `supervisor:ABORT ${supervisorDirective.rationale}`.trim().slice(0, 200)
          );
          throw new EscalationHalt({
            reason: "cannot_make_progress",
            missing_info: ["clarification on how to proceed", "revised success criteria"],
            current_task_summary: `${currentTask.description} | supervisor ABORT: ${supervisorDirective.rationale}`.trim().slice(0, 500),
            escalated_at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        if (supervisorDirective.action === "ASK_USER" && supervisorDirective.question) {
          const q = supervisorDirective.question;
          const withinCap = !!ctx.askUser && ctx.supervisorAskUserCount < SUPERVISOR_ASK_USER_CAP_M;
          ctx.strategyState.switch_triggers.push(
            `supervisor:ASK_USER${withinCap ? "" : "->escalate"} ${supervisorDirective.rationale}`.trim().slice(0, 200)
          );
          if (withinCap) {
            ctx.supervisorAskUserCount += 1;
            try {
              ctx.askUser(q.toJSON());
            } catch {
            }
            const options = q.options.length >= MIN_OPTIONS_PER_QUESTION && q.options.length <= MAX_OPTIONS_PER_QUESTION ? q.options.map((label) => ({ label })) : void 0;
            const askQuestionBatch = [{ id: "supervisor-ask", question: q.question, options }];
            askQuestion(askQuestionBatch, {
              reason: "supervisor_question",
              missingInfo: ["answer to the supervisor question"],
              currentTaskSummary: `${currentTask.description} | supervisor question: ${q.question}`.trim().slice(0, 500),
              globalEnabled: ctx.askMode === "enabled"
            });
          }
          throw new EscalationHalt({
            reason: "cannot_make_progress",
            missing_info: ["clarification on how to proceed", "revised success criteria"],
            current_task_summary: `${currentTask.description} | supervisor ASK_USER (no host): ${supervisorDirective.rationale}`.trim().slice(0, 500),
            escalated_at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
      const requeueLeafOnLocal = supervisorOriginalAction === "REDIRECT_STRATEGY" || supervisorOriginalAction === "GATHER_EVIDENCE" && ((_j = supervisorDirective == null ? void 0 : supervisorDirective.rationale) == null ? void 0 : _j.startsWith(INVESTIGATION_DONE_PREFIX)) === true;
      const rollbackResult = rollbackAndReplan(
        currentTask,
        ctx.strategyState,
        ctx.failureDiagnostics,
        ctx.taskGraph,
        ctx.worldModel,
        ctx.callerState,
        ctx.experienceStore.available ? ctx.experienceStore : null,
        rollbackFn,
        supervisorDirective,
        requeueLeafOnLocal,
        ctx.experienceLearning === true,
        // Everything (retryFailedTask), or just this iteration's failure when the executor itself broke (retryFailedSystemErrors).
        ctx.retryFailedTask === true || retrySystemErrorOnce(ctx, currentTask.id, execResult)
      );
      ctx.strategyState = rollbackResult.newStrategyState;
      if (rollbackResult.replanScope === "GLOBAL") ctx.taskGraph = rollbackResult.newTaskGraph;
      reportLayer(ctx, "recovery", true, `Trying a different approach — switched to "${rollbackResult.newStrategyState.current_strategy}" (${rollbackResult.replanScope ?? "local"} replan)`);
      if (rollbackResult.failureModeSwitch) {
        const sw = rollbackResult.failureModeSwitch;
        notifyHost(() => {
          var _a2;
          return (_a2 = ctx.onFailureModeSwitch) == null ? void 0 : _a2.call(ctx, { taskId: currentTask.id, ...sw });
        });
      }
      if (rollbackResult.learnedSwitch) {
        const sw = rollbackResult.learnedSwitch;
        notifyHost(() => {
          var _a2;
          return (_a2 = ctx.onLearnedStrategySwitch) == null ? void 0 : _a2.call(ctx, { taskId: currentTask.id, ...sw });
        });
      }
    }
    if (branchWorldModel && concurrentTask) {
      const reconciled = reconcileParallelBranches(
        [
          { worldModel: ctx.worldModel, controlState: ctx.controlState },
          { worldModel: branchWorldModel, controlState: ctx.controlState }
        ],
        ctx.taskGraph,
        ctx.diagnostics,
        ctx.failureDiagnostics,
        ctx.evidenceStore,
        ctx.hypothesisSet,
        controlStateResolverFor(ctx),
        currentTask.parallel_write_domains.flatMap(
          (da) => concurrentTask.parallel_write_domains.map((db) => [da, db])
        )
      );
      ctx.worldModel = reconciled.worldModel;
      ctx.controlState.generation_id = reconciled.controlState.generation_id;
      ctx.controlState.permission = reconciled.controlState.permission;
      ctx.controlState.execution_mode = reconciled.controlState.execution_mode;
      ctx.controlState.escalation = reconciled.controlState.escalation;
      ctx.controlState.risk_estimate = reconciled.controlState.risk_estimate;
      ctx.controlState.confidence_estimate = reconciled.controlState.confidence_estimate;
      ctx.controlState.escalation_reason = reconciled.controlState.escalation_reason;
      ctx.controlState.block_mask = [...reconciled.controlState.block_mask];
      ctx.controlState.notes = [...reconciled.controlState.notes];
      if (branchExecSucceeded && concurrentTask.status !== "COMPLETE") {
        applyTaskOutcome(ctx.taskGraph, concurrentTask.id, { status: "COMPLETE", fromExecutionLayer: true });
      } else if (concurrentTask.status === "RUNNING") {
        applyTaskOutcome(ctx.taskGraph, concurrentTask.id, { status: "PENDING", fromExecutionLayer: false });
      }
    }
    ctx.strategyState.completion_history.push(
      ctx.taskGraph.tasks.filter((t) => t.status === "COMPLETE").length
    );
    ctx.strategyState.risk_state_history.push(riskSummary(ctx.controlState));
    if (ctx.stepsUsed >= Math.floor(0.8 * ctx.maxSteps)) {
      ctx.diagnostics.verification_health.feasibility = Math.min(
        ctx.diagnostics.verification_health.feasibility,
        BUDGET_WARNING_FLOOR
      );
    }
    if (ctx.stepsUsed >= ctx.maxSteps && !nothingLeftToRun(ctx)) {
      const late = await pollCallerUpdates(ctx);
      if (late === RESTART_ITERATION) {
        resolveAndStamp(ctx);
        continue;
      }
    }
    if (ctx.stepsUsed >= ctx.maxSteps && !nothingLeftToRun(ctx)) {
      const exhaust = escalateBudgetExhausted(ctx.stepsUsed, ctx.maxSteps);
      if (resolveAskMode({ globalEnabled: ctx.askMode === "enabled" })) {
        askQuestion([buildBudgetExhaustedQuestion(ctx.stepsUsed)], {
          reason: "budget_exhausted",
          missingInfo: exhaust.missing_info,
          currentTaskSummary: `Exhausted at step ${ctx.stepsUsed}`,
          globalEnabled: ctx.askMode === "enabled"
        });
      }
      throw new EscalationHalt({
        reason: "budget_exhausted",
        missing_info: exhaust.missing_info,
        current_task_summary: `Exhausted at step ${ctx.stepsUsed}`,
        escalated_at: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    yield toCheckpoint(ctx);
  }
}
function nothingLeftToRun(ctx) {
  const tasks = ctx.taskGraph.tasks;
  return tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "BLOCKED" && t.block_reason === "goal_cancelled");
}
async function pollCallerUpdates(ctx) {
  const channel = {
    poll: async () => {
      const update = await ctx.updateChannel.poll();
      return update ? takeBudgetAnswers(ctx, update) : update;
    }
  };
  return checkCallerUpdates(ctx.callerState, channel, {
    worldModel: ctx.worldModel,
    hypothesisSet: ctx.hypothesisSet,
    taskGraph: ctx.taskGraph,
    diagnostics: ctx.diagnostics,
    failureDiagnostics: ctx.failureDiagnostics,
    evidenceStore: ctx.evidenceStore,
    outputContract: ctx.outputContract
  });
}
function takeBudgetAnswers(ctx, update) {
  var _a, _b, _c, _d;
  const answers = update.pending_update.clarification_answers;
  if (!Array.isArray(answers)) return update;
  const template = buildBudgetExhaustedQuestion(0);
  const continueLabel = (_b = (_a = template.options) == null ? void 0 : _a[0]) == null ? void 0 : _b.label;
  const stopLabel = (_d = (_c = template.options) == null ? void 0 : _c[1]) == null ? void 0 : _d.label;
  const isBudget = (a) => a.questionId === template.id;
  const budget = answers.filter(isBudget);
  if (budget.length === 0) return update;
  for (const answer of budget) {
    if (!Array.isArray(answer.selectedLabels)) continue;
    if (continueLabel !== void 0 && answer.selectedLabels.includes(continueLabel)) ctx.maxSteps += DEFAULT_BUDGET_EXTENSION;
    else if (stopLabel !== void 0 && answer.selectedLabels.includes(stopLabel)) cancelTaskGraph(ctx.taskGraph);
  }
  const rest = answers.filter((a) => !isBudget(a));
  if (rest.length === 0) return null;
  return { ...update, pending_update: { ...update.pending_update, clarification_answers: rest } };
}
async function runMainLoopWithCheckpoints(ctx, options) {
  var _a;
  const gen = driveMainLoop(ctx);
  while (true) {
    const { value: checkpoint, done } = await gen.next();
    if (done) return { status: "completed" };
    if (options.onCheckpoint) await options.onCheckpoint(checkpoint);
    if ((_a = options.shouldPause) == null ? void 0 : _a.call(options, checkpoint)) return { status: "paused", checkpoint };
  }
}
async function drive(ctx, options) {
  let outcome;
  try {
    outcome = await driveToCompletion(ctx, options);
  } catch (err) {
    learnFromRun(ctx);
    throw err;
  }
  if (outcome.status !== "paused") learnFromRun(ctx);
  return outcome;
}
function learnFromRun(ctx) {
  if (!ctx.experienceLearning || !ctx.experienceStore.available) return;
  try {
    learnFromJournal(ctx.memoryState.journal, ctx.experienceStore, {
      rule: ctx.experienceLearningRule,
      runId: ctx.runId,
      onEvent: ctx.onStrategyEvent
    });
  } catch {
  }
}
async function driveToCompletion(ctx, options) {
  const first = await runMainLoopWithCheckpoints(ctx, options);
  if (first.status === "paused") return first;
  const sigForReview = ctx.complexitySignal;
  const adversarialGate = resolveGate(
    ctx.layerPolicy,
    "reviewer_adversarial",
    ((sigForReview == null ? void 0 : sigForReview.riskLevel) ?? "LOW") !== "LOW" || ((sigForReview == null ? void 0 : sigForReview.taskCount) ?? 1) >= 3
  );
  const runAdversarialLens = adversarialGate.on;
  if (!ctx.skipReviewerPass) {
    ctx.nodeExecutionOrder.push("reviewer_pass");
    const reviewPassResult = await reviewerPass(
      ctx.worldModel,
      ctx.successCriteria,
      ctx.failureDiagnostics,
      ctx.beliefDepGraph,
      ctx.depGraphBudget,
      ctx.hypothesisSet,
      ctx.taskGraph,
      ctx.diagnostics,
      ctx.evidenceStore,
      ctx.propagationQueue,
      runAdversarialLens,
      hookOn(ctx, "criterion_coverage") ? ctx.semanticCriterionCoverage : void 0,
      ctx.isCheckableCriterion
    );
    const allFindings = [...reviewPassResult.implementer_findings, ...reviewPassResult.reviewer_findings, ...reviewPassResult.adversarial_findings];
    reportLayer(ctx, "reviewer_pass", allFindings.length > 0, allFindings.length > 0 ? allFindings[0] : "self-review found nothing to flag");
    ctx.pendingReviewerVerdict = reviewPassResult.pending_verdict;
    const revisionReopened = maybeReopenForReviewerRevision(ctx, reviewPassResult);
    if (revisionReopened) reviewPassResult.reopened_task_ids.push(revisionReopened);
    if (reviewPassResult.reopened_task_ids.length > 0) {
      for (const taskId of reviewPassResult.reopened_task_ids) {
        const task = ctx.taskGraph.getTask(taskId);
        if (task) {
          task.status = "PENDING";
          ctx.taskGraph.changed = true;
        }
      }
      const second = await runMainLoopWithCheckpoints(ctx, options);
      if (second.status === "paused") return second;
      ctx.nodeExecutionOrder.push("reviewer_pass_2");
      const reviewPassResult2 = await reviewerPass(
        ctx.worldModel,
        ctx.successCriteria,
        ctx.failureDiagnostics,
        ctx.beliefDepGraph,
        ctx.depGraphBudget,
        ctx.hypothesisSet,
        ctx.taskGraph,
        ctx.diagnostics,
        ctx.evidenceStore,
        ctx.propagationQueue,
        runAdversarialLens,
        hookOn(ctx, "criterion_coverage") ? ctx.semanticCriterionCoverage : void 0,
        ctx.isCheckableCriterion
      );
      ctx.pendingReviewerVerdict = reviewPassResult2.pending_verdict;
    }
  } else {
    reportLayer(ctx, "reviewer_pass", false, "reviewer pass skipped (eval ablation)");
  }
  ctx.nodeExecutionOrder.push("output_validation");
  const judge = ctx.semanticConstraintJudge;
  let validationResult = outputValidation(ctx.finalResult, ctx.outputContract, ctx.callerState, { skipCallerConstraints: judge !== void 0 || ctx.stalledFallbackText !== void 0 && ctx.finalResult === ctx.stalledFallbackText });
  let violated = await judgeConstraints(ctx, judge);
  if (violated.length > 0) {
    const reopened = maybeReopenForConstraintRevision(ctx, violated);
    if (reopened) {
      const task = ctx.taskGraph.getTask(reopened);
      if (task) {
        task.status = "PENDING";
        ctx.taskGraph.changed = true;
      }
      const again = await runMainLoopWithCheckpoints(ctx, options);
      if (again.status === "paused") return again;
      ctx.nodeExecutionOrder.push("output_validation_2");
      validationResult = outputValidation(ctx.finalResult, ctx.outputContract, ctx.callerState, { skipCallerConstraints: judge !== void 0 || ctx.stalledFallbackText !== void 0 && ctx.finalResult === ctx.stalledFallbackText });
      violated = await judgeConstraints(ctx, judge);
    }
  }
  const unresolved = violated.length > 0 && ctx.onConstraintRevision ? violated : void 0;
  if (violated.length > 0 && !unresolved) {
    throw new OutputContractError(
      "caller_specific_constraints",
      violated.map((v) => `caller_specific_constraints: constraint violated: "${v.constraint}"${v.reason ? ` (${v.reason})` : ""}`)
    );
  }
  const result = {
    finalResult: ctx.finalResult,
    outputValidation: validationResult,
    stepsUsed: ctx.stepsUsed,
    initResult: toInitResultShape(ctx),
    nodeExecutionOrder: ctx.nodeExecutionOrder,
    ...unresolved ? { unresolvedConstraintViolations: unresolved } : {}
  };
  if (options.onCheckpoint) await options.onCheckpoint(toCheckpoint(ctx));
  return { status: "complete", result };
}
class HarnessRuntime {
  async run(objective, successCriteria, options = {}) {
    const runId = options.runId ?? generateRunId();
    const ctx = buildInitialContext(objective, successCriteria, options, runId);
    return drive(ctx, options);
  }
  async resume(checkpoint, options = {}) {
    const ctx = buildResumedContext(checkpoint, options);
    return drive(ctx, options);
  }
}
const CONSEQUENTIAL_EFFECTS = /* @__PURE__ */ new Set(["write", "execute"]);
function deriveConsequentialTools(toolNames, manifest) {
  const out = /* @__PURE__ */ new Set();
  for (const name2 of toolNames) {
    const effect = manifest[name2];
    if (effect === void 0 || CONSEQUENTIAL_EFFECTS.has(effect)) out.add(name2);
  }
  return out;
}
function computeTrend(series, lowerIsBetter = false, epsilon = 0.05) {
  if (series.length < 2) return "unknown";
  const mid = Math.floor(series.length / 2);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = mean(series.slice(mid)) - mean(series.slice(0, mid));
  if (Math.abs(delta) <= epsilon) return "flat";
  return delta > 0 !== lowerIsBetter ? "improving" : "degrading";
}
function computeRunState(input = {}) {
  let consecutiveFailures = 0;
  const outcomes = input.outcomes ?? [];
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i]; i--) consecutiveFailures++;
  return {
    consecutiveFailures,
    turnDepth: input.turnDepth ?? 0,
    cumulativeSpend: input.cumulativeSpend ?? 0,
    sessionBudget: input.sessionBudget ?? null,
    diagnosticsTrend: computeTrend(input.diagnosticsScores ?? []),
    verificationTrend: computeTrend(input.verificationScores ?? []),
    toolReliability: { ...input.toolReliability ?? {} },
    untrustedContentInContext: input.untrustedContentInContext ?? false
  };
}
const LAYER_POLICY_MODES = ["static", "shadow", "adaptive"];
const DEFAULT_LAYER_POLICY_MODE = "static";
function resolveTurnTier(signals, state, mode = DEFAULT_LAYER_POLICY_MODE) {
  if (signals.isTrivial === true) return "T0";
  if (mode !== "adaptive") return "T2";
  try {
    const routine = signals.riskLevel === "LOW" && signals.consequentialTools !== void 0 && signals.consequentialTools.size === 0 && signals.taskCount <= 1 && signals.hasDurablePlan === false && signals.pushbackOnPriorTurn === false && signals.statesConstraint === false && signals.ambiguity === "none" && state !== void 0 && state.untrustedContentInContext === false && state.consecutiveFailures === 0 && state.diagnosticsTrend !== "degrading" && state.verificationTrend !== "degrading";
    return routine ? "T1" : "T2";
  } catch {
    return "T2";
  }
}
function resolveModedLayerPolicy(mode, signals, state, budget, rules = {}, enabledOptIn) {
  const staticTier = resolveTurnTier(signals, state, "static");
  if (mode === "adaptive") {
    return {
      mode,
      executed: resolveLayerPolicy(signals, state, budget, rules, enabledOptIn),
      executedTier: resolveTurnTier(signals, state, "adaptive")
    };
  }
  const out = { mode: mode === "shadow" ? "shadow" : "static", executed: staticLayerPolicy(enabledOptIn), executedTier: staticTier };
  if (mode === "shadow") {
    try {
      out.shadow = {
        policy: resolveLayerPolicy(signals, state, budget, rules, enabledOptIn),
        tier: resolveTurnTier(signals, state, "adaptive")
      };
    } catch {
    }
  }
  return out;
}
const RULE_EVIDENCE = {
  criterion_coverage: "hypothesis",
  semantic_contradiction: "hypothesis",
  failure_match: "hypothesis",
  change_review: "hypothesis",
  injection_detection: "hypothesis",
  decomposition_reframe: "hypothesis",
  model_inferred_facts: "hypothesis",
  reviewer_adversarial: "hypothesis"
};
const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };
function riskAtLeastMedium(ctx) {
  const r = ctx.signals.riskLevel;
  return r in RISK_ORDER ? RISK_ORDER[r] >= RISK_ORDER.MEDIUM : void 0;
}
function isCalmTurn(ctx) {
  const s = ctx.signals;
  if (s.riskLevel !== "LOW" || s.taskCount > 1 || s.hasDurablePlan) return false;
  if (s.pushbackOnPriorTurn === true || s.statesConstraint === true || s.userPosture === "corrective") return false;
  if (s.ambiguity === "some" || s.ambiguity === "high") return false;
  const st = ctx.state;
  if (st && (st.consecutiveFailures > 0 || st.verificationTrend === "degrading" || st.diagnosticsTrend === "degrading")) return false;
  return true;
}
const calm = (trigger) => (ctx) => isCalmTurn(ctx) ? { decision: "off", trigger, reason: "routine LOW-risk single-task turn: no regime for this layer" } : null;
const ADAPTIVE_RULES_V1 = {
  // Change review: escalate when the user states a constraint or corrects the assistant (a belief
  // conflict is likely); skip on a calm turn; otherwise static.
  change_review: (ctx) => {
    const s = ctx.signals;
    if (s.statesConstraint === true || s.pushbackOnPriorTurn === true) {
      return { decision: "full", trigger: "constraint_or_correction", reason: "stated constraint / pushback: a belief conflict is plausible" };
    }
    return calm("calm_no_constraint")(ctx);
  },
  // Adversarial reviewer lens: only at riskLevel ≥ MEDIUM or after a soft verification failure.
  reviewer_adversarial: (ctx) => {
    const hi = riskAtLeastMedium(ctx);
    if (hi === void 0) return null;
    const st = ctx.state;
    const softFail = st !== void 0 && (st.verificationTrend === "degrading" || st.consecutiveFailures > 0);
    if (hi) return { decision: "full", trigger: "risk_medium_plus", reason: "riskLevel ≥ MEDIUM" };
    if (softFail) return { decision: "full", trigger: "soft_verification_failure", reason: "verification degrading or a tool failed this turn" };
    return { decision: "off", trigger: "low_risk_no_failure", reason: "LOW risk and no verification failure" };
  },
  // Injection detection: needed only when untrusted content could reach a tool-capable next step.
  // The resolver clamps any skip back to `full` without a non-linguistic proof (AL-1).
  injection_detection: (ctx) => {
    var _a;
    const untrusted = (_a = ctx.state) == null ? void 0 : _a.untrustedContentInContext;
    const tools = ctx.signals.consequentialTools;
    if (untrusted === void 0 || tools === void 0) return null;
    if (untrusted && tools.size > 0) return { decision: "full", trigger: "untrusted_reaches_tools", reason: "untrusted content and a tool-capable next step" };
    return { decision: "off", trigger: !untrusted ? "no_untrusted_content" : "no_tool_capable_step", reason: "non-linguistic proof: nothing untrusted can reach a consequential tool" };
  },
  // Decomposition reframe: only when the turn needs a multi-step plan.
  decomposition_reframe: (ctx) => {
    const s = ctx.signals;
    if (s.taskCount > 1 || s.hasDurablePlan) return { decision: "full", trigger: "needs_multi_step_plan", reason: "multi-task or durable-plan turn" };
    return { decision: "off", trigger: "single_step", reason: "single-task turn needs no reframe" };
  },
  // Model-inferred facts: worth the call on a multi-turn session or a directive/exploratory turn
  // that is not routine; skipped on a calm informational one.
  model_inferred_facts: (ctx) => {
    var _a;
    const s = ctx.signals;
    if ((((_a = ctx.state) == null ? void 0 : _a.turnDepth) ?? 0) > 0) return { decision: "full", trigger: "multi_turn_session", reason: "turnDepth > 0" };
    if (isCalmTurn(ctx) && s.userPosture === "informational") return { decision: "off", trigger: "calm_informational", reason: "routine informational turn" };
    return null;
  },
  // Everything else is off for LOW-risk single-task work and static otherwise; criterion coverage
  // has a cheap (substring) form to fall back to.
  semantic_contradiction: calm("calm_low_risk"),
  failure_match: calm("calm_low_risk"),
  criterion_coverage: (ctx) => isCalmTurn(ctx) ? { decision: "cheap", trigger: "calm_low_risk", reason: "routine turn: substring coverage check only" } : null
};
const BASE_CALLS_BY_RISK = { LOW: 3, MEDIUM: 5, HIGH: 8, UNKNOWN: 8 };
const POSTURE_CALL_BONUS = {
  corrective: 2,
  directive: 0,
  exploratory: 0,
  informational: 0,
  unknown: 0
};
function computeTurnCallBudget(input) {
  const risk = input.riskLevel && input.riskLevel in BASE_CALLS_BY_RISK ? input.riskLevel : "UNKNOWN";
  const bonus = input.userPosture ? POSTURE_CALL_BONUS[input.userPosture] ?? 0 : 0;
  return new Budget({ maxCalls: BASE_CALLS_BY_RISK[risk] + bonus });
}
function toPolicyBudget(budget, priority) {
  const remaining = budget.remaining("calls");
  return { remainingCalls: Number.isFinite(remaining) ? remaining : null, priority };
}
const ID_RE = /^[A-Za-z0-9_.:-]{1,96}$/;
const DECISIONS = ["off", "cheap", "full"];
const id = (v) => typeof v === "string" && ID_RE.test(v) ? v : void 0;
const count = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
const flag = (v) => v === true;
const decision = (v) => typeof v === "string" && DECISIONS.includes(v) ? v : void 0;
function buildLayerOutcomeRow(input) {
  const runId = id(input.runId);
  if (runId === void 0) return void 0;
  const changedSet = new Set((input.changedLayers ?? []).filter((l) => id(l) !== void 0));
  const byLayer = /* @__PURE__ */ new Map();
  for (const ev of input.activity) {
    const layer = id(ev.layer);
    if (layer === void 0) continue;
    const prior = byLayer.get(layer) ?? { layer, fired: false, calls: 0, tokens: 0, changed: false, actedOn: false };
    prior.fired = prior.fired || flag(ev.fired);
    prior.calls += count(ev.llmCalls);
    prior.tokens += count(ev.tokens);
    byLayer.set(layer, prior);
  }
  for (const o of byLayer.values()) {
    o.changed = o.fired && changedSet.has(o.layer);
    o.actedOn = o.changed && input.completed;
  }
  for (const [layer, use] of Object.entries(input.layerUse ?? {})) {
    const lid = id(layer);
    if (lid === void 0 || byLayer.has(lid)) continue;
    const calls = count(use == null ? void 0 : use.calls);
    byLayer.set(lid, { layer: lid, fired: calls > 0, calls, tokens: count(use == null ? void 0 : use.tokens), changed: false, actedOn: false });
  }
  return {
    kind: "layer_outcome",
    runId,
    mode: id(input.mode) ?? "unknown",
    tier: id(input.tier) ?? "unknown",
    layers: [...byLayer.values()],
    nextTurnCorrection: null
  };
}
function buildFeedbackRow(runId, correction) {
  const rid = id(runId);
  return rid === void 0 ? void 0 : { kind: "layer_outcome_feedback", runId: rid, nextTurnCorrection: correction === true };
}
const costOf = (policy, costs) => {
  let total = 0;
  for (const [layer, d] of Object.entries(policy)) if (d.decision === "full") total += costs[layer] ?? 0;
  return total;
};
function sanitizeObserved(by) {
  const out = {};
  for (const [layer, n] of Object.entries(by)) {
    const lid = id(layer);
    const c = count(n);
    if (lid !== void 0 && c > 0) out[lid] = c;
  }
  return out;
}
function buildShadowRow(input) {
  var _a, _b, _c;
  const runId = id(input.runId);
  if (runId === void 0) return void 0;
  const disagreements = [];
  for (const layer of Object.keys(input.executed)) {
    const e = decision((_a = input.executed[layer]) == null ? void 0 : _a.decision);
    const s = decision((_b = input.shadow.policy[layer]) == null ? void 0 : _b.decision);
    if (e === void 0 || s === void 0 || e === s) continue;
    disagreements.push({ layer, executed: e, shadow: s, trigger: id((_c = input.shadow.policy[layer]) == null ? void 0 : _c.trigger) ?? "unknown" });
  }
  return {
    kind: "shadow_turn",
    runId,
    executedTier: id(input.executedTier) ?? "unknown",
    shadowTier: id(input.shadow.tier) ?? "unknown",
    disagreements,
    executedCalls: costOf(input.executed, input.layerCosts),
    shadowCalls: costOf(input.shadow.policy, input.layerCosts),
    observedCalls: count(input.observedCalls),
    ...input.observedByLayer ? { observedByLayer: sanitizeObserved(input.observedByLayer) } : {},
    verificationFailed: flag(input.verificationFailed),
    nextTurnCorrection: null
  };
}
function withFeedback(rows, kind) {
  const fb = /* @__PURE__ */ new Map();
  for (const r of rows) if (r.kind === "layer_outcome_feedback") fb.set(r.runId, r.nextTurnCorrection);
  return rows.filter((r) => r.kind === kind).map((r) => fb.has(r.runId) ? { ...r, nextTurnCorrection: fb.get(r.runId) } : r);
}
function summarizeLayerYield(rows) {
  const acc = /* @__PURE__ */ new Map();
  for (const row of withFeedback(rows, "layer_outcome")) {
    for (const o of row.layers) {
      const y = acc.get(o.layer) ?? { layer: o.layer, turns: 0, fired: 0, calls: 0, tokens: 0, changed: 0, actedOn: 0, correctedNext: 0, knownNext: 0, changesPerCall: null };
      y.turns++;
      if (o.fired) y.fired++;
      y.calls += o.calls;
      y.tokens += o.tokens;
      if (o.changed) y.changed++;
      if (o.actedOn) y.actedOn++;
      if (row.nextTurnCorrection !== null) {
        y.knownNext++;
        if (row.nextTurnCorrection) y.correctedNext++;
      }
      acc.set(o.layer, y);
    }
  }
  return [...acc.values()].map((y) => ({ ...y, changesPerCall: y.calls > 0 ? y.changed / y.calls : null })).sort((a, b) => a.layer.localeCompare(b.layer));
}
const RANK = { off: 0, cheap: 1, full: 2 };
function summarizeShadow(rows) {
  var _a;
  const shadows = withFeedback(rows, "shadow_turn");
  const acc = /* @__PURE__ */ new Map();
  const touch = (layer) => {
    let r = acc.get(layer);
    if (!r) acc.set(layer, r = { layer, turns: 0, disagreements: 0, disagreementRate: 0, wouldSkip: 0, skipCoincidedWithCorrection: 0, skipKnown: 0, observedCallsSkipped: 0 });
    return r;
  };
  let callsSaved = 0, executedCalls = 0, shadowCalls = 0, observedCalls = 0, observedCallsSkipped = 0;
  for (const row of shadows) {
    executedCalls += row.executedCalls;
    shadowCalls += row.shadowCalls;
    callsSaved += Math.max(0, row.executedCalls - row.shadowCalls);
    observedCalls += row.observedCalls;
    for (const d of row.disagreements) {
      const r = touch(d.layer);
      r.disagreements++;
      if (RANK[d.shadow] < RANK[d.executed]) {
        r.wouldSkip++;
        const measured = ((_a = row.observedByLayer) == null ? void 0 : _a[d.layer]) ?? 0;
        r.observedCallsSkipped += measured;
        observedCallsSkipped += measured;
        if (row.nextTurnCorrection !== null) {
          r.skipKnown++;
          if (row.nextTurnCorrection || row.verificationFailed) r.skipCoincidedWithCorrection++;
        } else if (row.verificationFailed) {
          r.skipKnown++;
          r.skipCoincidedWithCorrection++;
        }
      }
    }
  }
  for (const r of acc.values()) {
    r.turns = shadows.length;
    r.disagreementRate = shadows.length > 0 ? r.disagreements / shadows.length : 0;
  }
  return { turns: shadows.length, callsSaved, executedCalls, shadowCalls, observedCalls, observedCallsSkipped, layers: [...acc.values()].sort((a, b) => a.layer.localeCompare(b.layer)) };
}
function parseTelemetryLog(text) {
  const trimmed = text.trim();
  const items = [];
  if (trimmed.startsWith("[")) {
    try {
      items.push(...JSON.parse(trimmed));
    } catch {
    }
  } else {
    for (const line of trimmed.split("\n")) {
      try {
        items.push(JSON.parse(line));
      } catch {
      }
    }
  }
  return items.filter((r) => {
    const k = r == null ? void 0 : r.kind;
    return k === "layer_outcome" || k === "layer_outcome_feedback" || k === "shadow_turn";
  });
}
export {
  ADAPTIVE_RULES_V1,
  AD_HOC_GATES,
  AsyncFnUpdateChannel,
  BASE_CALLS_BY_RISK,
  BUDGET_WARNING_FLOOR,
  BeliefDepGraph,
  BeliefDepGraphSchema,
  BeliefHealthSchema,
  BeliefNodeSchema,
  BeliefSchema,
  BlockEntrySchema,
  Budget,
  BudgetSchema,
  CAUTION_THRESHOLD,
  CHECKPOINT_MIGRATIONS,
  CHECKPOINT_SCHEMA_VERSION,
  CRITICAL_THRESHOLD,
  CallerState,
  CallerStateSchema,
  CheckpointSchemaError,
  CompressionRiskSchema,
  ContradictionSchema,
  ControlState,
  ControlStateSchema,
  CoverageHealthSchema,
  DECAY,
  DECISION_ORDER,
  DEFAULT_BASELINE,
  DEFAULT_BUDGET_EXTENSION,
  DEFAULT_FAILURE_MODE_ENTRIES,
  DEFAULT_HARNESS_LEXICAL_MODE,
  DEFAULT_LAYER_POLICY_MODE,
  DEFAULT_LAYER_PRIORITY,
  DEFAULT_REGISTRY,
  DEFAULT_STRATEGY_ORDER,
  DEMOTION_STREAK,
  DepEdgeSchema,
  DepGraphBudget,
  DepGraphBudgetSchema,
  Diagnostics,
  DiagnosticsSchema,
  DimensionProvenanceSchema,
  DimensionType,
  ESCALATION_LAYERS,
  EVENT_LAYERS,
  EXPERIENCE_STORE_SCHEMA_VERSION,
  EliminationPolicySchema,
  EnvironmentChangeSchema,
  EscalationHalt,
  EvidenceSchema,
  EvidenceStore,
  EvidenceStoreSchema,
  EvidenceTypeSchema,
  ExecutionHealthSchema,
  FLOOR_LAYERS,
  FailureDiagnostics,
  FailureDiagnosticsSchema,
  FailureModeEntrySchema,
  FailureModeLibrary,
  FailureRecordSchema,
  GraphCycleError,
  HARNESS_LEXICAL_CHECKS,
  HAS_CHEAP_FORM,
  HarnessRunState,
  HarnessRuntime,
  HypothesisSchema,
  HypothesisSet,
  HypothesisSetSchema,
  INVESTIGATION_CAP_K,
  INVESTIGATION_DONE_PREFIX,
  INVESTIGATION_FORBIDDEN_TOOLS,
  INVESTIGATION_READ_ONLY_TOOLS,
  InMemoryExperienceStore,
  InvalidTaskGraphError,
  InvestigationDepthExceededError,
  InvestigationRequest,
  JournalEntrySchema,
  JournalRetentionPolicySchema,
  LAYER_CALL_COST,
  LAYER_CLASS,
  LAYER_POLICY_MODES,
  LAYER_TIER,
  LEARNING_RATE,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_BATCH,
  MAX_RUN_REFS,
  MAX_SWITCHES,
  MIN_ATTEMPTS,
  MIN_OPTIONS_PER_QUESTION,
  MatchResultSchema,
  MemoryState,
  MemoryStateSchema,
  NOT_ACCOMPLISHED_REPLY_PREFIX,
  NoOpUpdateChannel,
  NormalisationError,
  OPT_IN_CALL_COST,
  OPT_IN_DISABLED_TRIGGER,
  OPT_IN_EVIDENCE,
  OPT_IN_FLAG,
  OPT_IN_LAYERS,
  OSCILLATION_WINDOW,
  ObservationSchema,
  OutputContract,
  OutputContractError,
  OutputContractSchema,
  PESSIMISTIC_THRESHOLD,
  POSTURE_CALL_BONUS,
  PRESENTATION_LAYERS,
  PRIOR,
  ProcessConcept,
  ProcessConceptNotFoundError,
  ProcessConceptValidationError,
  ProcessRegistry,
  PropagationTaskSchema,
  PrunedRegionSchema,
  RECENT_WINDOW,
  RECOVERY_ACTION_DEPENDENCIES,
  RECURRENCE_THRESHOLD,
  RESTART_ITERATION,
  RULE_EVIDENCE,
  ReliabilitySchema,
  RollbackPointSchema,
  STALL_WINDOW,
  STATIC_TRIGGER,
  SUPERVISOR_ACTIONS,
  SelfReferentialDependencyError,
  StalenessError,
  StrategyState,
  StrategyStateSchema,
  StrategyTypeSchema,
  StructureSchema,
  SupervisorDirective,
  TaskGraph,
  TaskGraphSchema,
  TaskSchema,
  TaxonomyClassifier,
  TokenBudgetSchema,
  ToolAvailabilitySchema,
  ToolReliabilityEnvelopeSchema,
  TrajectoryDigest,
  UnavailableExperienceStore,
  UserQuestion,
  VerificationHealthSchema,
  WorldModel,
  WorldModelSchema,
  _maybeResolve,
  actionGate,
  applyConstraintChangePropagation,
  applyReviewOutcome,
  applyTaskOutcome,
  applyToolReliability,
  askQuestion,
  assertCheckpointSchemaCurrent,
  assertNormalised,
  awaitClarification,
  baselineFor,
  batchQuestions,
  buildAskBlocker,
  buildBudgetExhaustedQuestion,
  buildDigest,
  buildFeedbackRow,
  buildLayerOutcomeRow,
  buildReviewFailureQuestion,
  buildShadowRow,
  buildStrategyOrdering,
  cancelTaskGraph,
  cannotMakeProgress,
  checkAbstractionAlignment,
  checkCallerUpdates,
  classifyRecovery,
  coerceForWiredActions,
  computeElevationFactor,
  computeRunState,
  computeSourceEntropy,
  computeTrend,
  computeTurnCallBudget,
  containsCJK,
  contextCompression,
  contractShadowCheck,
  countInvestigations,
  decidePromotion,
  deleteHarnessCheckpoint,
  deriveConsequentialTools,
  describeAskAnswer,
  detectContradictions,
  diagnoseReviewFailureOptions,
  drainPropagationQueue,
  emptyEvidence,
  escalate,
  escalateBudgetExhausted,
  estimateRisk,
  estimateVOI,
  execute,
  failureClassOf,
  gatherEvidence,
  generateUpdateHypotheses,
  handleEscalationResponse,
  harnessLexicalActive,
  initializeHarness,
  injectionSkipProvenSafe,
  isCalmTurn,
  isHarnessPauseSignal,
  jaccardSimilarity,
  journalEntryFor,
  learnFromJournal,
  loadHarnessCheckpoint,
  makeBlendAdjuster,
  makeConflictKey,
  makeMultiSourceReducer,
  makePreferenceExtractor,
  makeQuestionsBatch,
  makeSurfaceBlocker,
  makeTurnInitializer,
  mergeInvestigationFindings,
  mergeWorldModels,
  normalise,
  normalizeBlend,
  orderedPriority,
  outputValidation,
  parseTelemetryLog,
  pickLearnedStrategy,
  postExecGate,
  propagateBeliefs,
  recomputeBeliefHealth,
  reconcileParallelBranches,
  recordAttempt,
  recordExternalContradiction,
  recoveryAttempts,
  reevaluateLayerPolicy,
  refineDeferredBatch,
  registerAll,
  requeueFailedLeaves,
  requeueFailedTask,
  requeueFailedTasks,
  resolveAskMode,
  resolveControlState,
  resolveGate,
  resolveGatherEvidence,
  resolveHarnessLexicalMode,
  resolveHarnessLexicalOff,
  resolveLayerPolicy,
  resolveModedLayerPolicy,
  resolveSemanticMatchStrategy,
  resolveSupervisorDirective,
  resolveTurnTier,
  revalidateTaskGraph,
  reviewProposedChange,
  reviewerPass,
  riskSummary,
  rollbackAndReplan,
  runInvestigation,
  saveHarnessCheckpoint,
  selectTask,
  setHarnessLexicalMode,
  sharedTokens,
  softmaxStrategyPolicy,
  splitClauses,
  staticLayerPolicy,
  summarizeLayerYield,
  summarizeShadow,
  supervisorEnabled,
  toPolicyBudget,
  tokenCount,
  tokenize$1 as tokenize,
  updateDiagnostics,
  updateOutputContract,
  updateSuccessCriteria,
  updateTaskGraph,
  updateWorldModel,
  validateAskAnswer,
  validateAskQuestion,
  validateAskResponse,
  validateInvestigationTools,
  validateRecoveryActionDependencies,
  validateTaskGraph,
  verify,
  warmStart,
  wilsonLowerBound
};
//# sourceMappingURL=index.js.map
