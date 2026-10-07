var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { bi as parseModelJson, a0 as classifyRiskLexical } from "./provider-setup-ecltIdus.js";
import { A, a, b, C, c, D, e, f, g, h, i, j, k, l, m, o, F, p, I, L, q, r, s, t, u, v, w, x, M, P, y, z, B, R, G, S, H, J, W, K, N, O, Q, T, U, V, X, Y, Z, _, $, a1, a2, a3, a4, a5, a6, a7, a8, a9, aa, ac, ad, ae, ag, ah, ai, aj, ak, al, am, an, ap, aq, ar, as, au, av, ax, ay, aA, aB, aD, aE, aH, aJ, aK, aL, aM, aO, aP, aQ, aR, aS, aT, aV, aW, aX, aY, aZ, a_, a$, b0, b1, b3, b4, b5, b6, b7, b8, b9, ba, bb, bc, bd, be, bg, bj, bk, bl, bn, bo, bp, bq, br, bs, bt, bu, bv, bw, bx, by, bz, bA, bB, bC, bD, bF, bG, bI, bJ, bK, bL, bM, bN, bO, bP } from "./provider-setup-ecltIdus.js";
import { DEFAULT_LAYER_POLICY_MODE, MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_BATCH, MIN_OPTIONS_PER_QUESTION, validateAskResponse } from "@buildaharness/harness";
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } }
        },
        required: ["id", "description", "depends_on"]
      }
    }
  },
  required: ["tasks"]
};
function buildSystemPrompt(template) {
  const skeleton = template.tasks.map((t2) => `- id: ${t2.id}; title: ${t2.title}; depends_on: [${t2.depends_on.join(", ")}]`).join("\n");
  return `You are adapting a "${template.name}" plan template to a specific user request. Here is the template's task skeleton — keep the exact same ids and depends_on structure, one output task per skeleton task, but personalize each description to the actual request:
${skeleton}

Success criteria for this kind of plan: ${template.success_criteria}

Phrase each \`description\` starting with the concrete subject or object it acts on (e.g. "the login tests: rerun after the config fix" rather than "rerun the login tests after the config fix"), so later comparisons against this task's completion/failure beliefs share matching vocabulary. Respond with JSON only, no prose: {"tasks":[{"id": string, "description": string, "depends_on": string[]}]}. \`id\` and \`depends_on\` values must exactly match the skeleton above.`;
}
function isRawPlanTask(value) {
  if (typeof value !== "object" || value === null) return false;
  const v2 = value;
  return typeof v2.id === "string" && typeof v2.description === "string" && Array.isArray(v2.depends_on) && v2.depends_on.every((d) => typeof d === "string");
}
async function buildPlanFromTemplate(llmClient, message, template, model, onUsage) {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: "system", content: buildSystemPrompt(template) },
        { role: "user", content: message }
      ],
      void 0,
      { model, onUsage, structuredOutput: { schema: PLAN_SCHEMA } }
    );
    const parsed = parseModelJson(response.content);
    if (!Array.isArray(parsed.tasks)) return null;
    const rawTasks = parsed.tasks.filter(isRawPlanTask);
    if (rawTasks.length <= 1) return null;
    const riskByTemplateId = new Map(template.tasks.map((t2) => [t2.id, t2.risk_level]));
    const tasks = rawTasks.map((t2) => ({ ...t2, riskLevel: riskByTemplateId.get(t2.id) ?? "LOW" }));
    return { templateName: template.name, successCriteria: template.success_criteria, tasks };
  } catch {
    return null;
  }
}
const SIDE_CALL_MARKERS = [
  ["You check whether a proposed action genuinely conflicts", '{"conflict":false}'],
  ["You match a set of observed symptoms against a curated library", "null"],
  ["You are a security classifier analyzing untrusted external content", '{"flagged":false}'],
  ["You check whether an assistant's reply is faithful to the raw results", '{"verdict":"grounded"}'],
  ["You judge whether an assistant actually accomplished a task", '{"done":true}'],
  ["You condense the earlier part of a conversation", '{"summary":""}'],
  ["You judge whether an assistant's reply violates constraints", '{"violations":[]}'],
  ["You weigh the reliability of the sources an assistant read", '{"assessments":[],"weighed":true}'],
  ["You propose competing explanations for an underdetermined request", '{"hypotheses":[]}'],
  ["You decide which explanations a set of new observations rules out", '{"contradicted":[]}'],
  ["You write a session handoff digest", '{"digest":null}'],
  ["You consolidate a small store of remembered facts about a user", '{"proposals":[]}'],
  ["You review what a user said across several turns", '{"ops":[]}'],
  ["You check proposed memory entries against what a user actually said", '{"verdicts":[]}']
];
const TURN_INTENT_MARKER = " independent judgments";
function isTurnIntentRequest(messages) {
  return messages.some((m2) => m2.role === "system" && m2.content.includes(TURN_INTENT_MARKER));
}
function deriveTurnIntentJSON(messages, override) {
  var _a;
  const userContent = ((_a = messages.find((m2) => m2.role === "user")) == null ? void 0 : _a.content) ?? "";
  const risk = classifyRiskLexical(userContent);
  const isReminderRequest = risk.reason.includes("reminder");
  const base = {
    riskLevel: risk.riskLevel,
    riskReason: risk.reason,
    isTrivial: false,
    decomposedTasks: [],
    isReminderRequest,
    isBulkReminderRequest: isReminderRequest && risk.requiresApproval,
    isAbandonRequest: false,
    isPlanQuestion: false,
    isUnderdetermined: false,
    matchedPlanTemplate: null,
    needsMultiStepPlan: false,
    statesDurableFacts: []
  };
  return JSON.stringify({ ...base, ...override });
}
class ScriptedLLMClient {
  constructor(script) {
    /** Non-classifier `callChatStructured` calls made so far — the index into `responses`. */
    __publicField(this, "toolCalls", 0);
    __publicField(this, "responseIndex", 0);
    this.script = script;
  }
  get streamChunks() {
    return this.script.streamChunks && this.script.streamChunks.length > 0 ? this.script.streamChunks : [""];
  }
  async *callChat(_messages, _options) {
    for (const chunk of this.streamChunks) yield chunk;
  }
  async callChatSync(messages, options) {
    const chunks = [];
    for await (const chunk of this.callChat(messages, options)) chunks.push(chunk);
    return chunks.join("");
  }
  async callChatStructured(messages, _tools, _options) {
    var _a, _b, _c, _d;
    if (isTurnIntentRequest(messages)) {
      const userContent = ((_a = messages.find((m2) => m2.role === "user")) == null ? void 0 : _a.content) ?? "";
      return { content: deriveTurnIntentJSON(messages, (_c = (_b = this.script).classify) == null ? void 0 : _c.call(_b, userContent)) };
    }
    const system = ((_d = messages.find((m2) => m2.role === "system")) == null ? void 0 : _d.content) ?? "";
    const side = [...this.script.sideResponses ?? [], ...SIDE_CALL_MARKERS].find(([marker]) => system.includes(marker));
    if (side) return { content: side[1] };
    this.toolCalls++;
    const responses = this.script.responses ?? [];
    if (this.responseIndex >= responses.length) {
      throw new Error(
        `createScriptedLLMClient: no scripted response for tool-loop call #${this.responseIndex + 1} (scripted ${responses.length})`
      );
    }
    const next = responses[this.responseIndex++];
    return typeof next === "string" ? { content: next } : next;
  }
}
function createScriptedLLMClient(script = {}) {
  return new ScriptedLLMClient(script);
}
export {
  A as ACTION_TOOLS,
  a as ALREADY_STAGED_ACTION_TOOL,
  b as AskClarificationService,
  C as CONFIG_KEYS,
  c as ConfigValidationError,
  D as DEFAULT_AMBIGUITY_GUARD_MODE,
  e as DEFAULT_ASK_MODE,
  f as DEFAULT_CONFIG,
  g as DEFAULT_GOAL_GRAPH_MODE,
  h as DEFAULT_GOAL_GRAPH_SUGGEST_MODE,
  DEFAULT_LAYER_POLICY_MODE,
  i as DEFAULT_LEXICAL_MODE,
  j as DEFAULT_MEMORY_WRITE_MODE,
  k as DEFAULT_ONE_LOOP_MODE,
  l as DEFAULT_PLAN_GRAPH_MODE,
  m as DEFAULT_PLAN_MODE,
  o as EmailDeliveryError,
  F as FETCH_URL_TOOL,
  p as FILE_TOOLS,
  I as InvalidEmailArgsError,
  L as LAYER_DISPLAY_NAME,
  q as LAYER_ORDER,
  r as LAYER_SETTINGS,
  s as LAYER_SHORT_CODE,
  t as LEXICAL_CHECK_FAMILIES,
  u as LEXICAL_FAMILIES,
  v as LIST_DIRECTORY_TOOL,
  w as LayerSettingError,
  x as LiveSteeringChannel,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_BATCH,
  M as MEMORY_WRITE_MODES,
  MIN_OPTIONS_PER_QUESTION,
  P as PROVIDER_SETUP,
  y as PathOutsideWorkspaceError,
  z as PersonalAssistant,
  B as PrivateNetworkTargetError,
  R as READ_FILE_TOOL,
  G as RUN_SHELL_COMMAND_TOOL,
  S as SEMANTIC_ESCALATIONS,
  H as SEND_EMAIL_TOOL,
  J as SHELL_TOOLS,
  W as WEB_SEARCH_TOOL,
  K as WEB_TOOLS,
  N as WRITE_FILE_TOOL,
  O as abandonPlan,
  Q as applyLayerSettings,
  T as applyPendingAction,
  U as assertPublicHttpUrl,
  V as braveSearch,
  X as buildClaudePrompt,
  buildPlanFromTemplate,
  Y as buildWhyChain,
  Z as checkApiKeyFormat,
  _ as classifyError,
  $ as classifyRisk,
  a1 as classifyToolYield,
  a2 as classifyTurnIntent,
  a3 as cleanApiKey,
  a4 as computePlanPosition,
  a5 as createPlanRecord,
  a6 as createResendSender,
  createScriptedLLMClient,
  a7 as createSmtpSender,
  a8 as decisionNote,
  a9 as decompositionReframeEnabled,
  aa as defaultExportFilename,
  ac as detectHomogeneousBatchList,
  ad as discardPendingAction,
  ae as effectiveState,
  ag as escalationEnabled,
  ah as estimateCostUsd,
  ai as executeActionTool,
  aj as executeFileTool,
  ak as executeShellTool,
  al as executeWebTool,
  am as explicitEnvOverride,
  an as findLayer,
  ap as formatCostSummary,
  aq as formatDoctorReport,
  ar as formatEmailApprovalReason,
  as as formatGoalGraphState,
  au as formatLayerListing,
  av as formatMemoryArchive,
  ax as formatMemoryHistory,
  ay as formatMemoryInjection,
  aA as formatMemoryStatus,
  aB as formatMemorySummary,
  aD as formatPlanProgress,
  aE as formatSearchResults,
  aH as formatTranscriptMarkdown,
  aJ as getProviderSetup,
  aK as harnessGatePolicy,
  aL as injectionDetectionEnabled,
  aM as isAdaptivePolicyEnabled,
  aO as isGoalGraphEnabled,
  aP as isGoalGraphSuggestEnabled,
  aQ as isLayerPolicyMode,
  aR as isLikelyEmailAddress,
  aS as isPlanGraphEnabled,
  aT as isPolicyRecordingEnabled,
  aV as isToggleable,
  aW as lexicalActive,
  aX as lexicalOffEnvValue,
  aY as listTemplateNames,
  aZ as loadActivePlan,
  a_ as loadPendingAction,
  a$ as loadTemplate,
  b0 as lowerConfidenceSourceLines,
  b1 as matchTemplateIfConfident,
  b3 as memoryStatusChecks,
  b4 as nextPendingTask,
  b5 as nodeDisplayName,
  b6 as nodeToLayer,
  b7 as normalizeAmbiguityGuardMode,
  b8 as normalizeAskMode,
  b9 as normalizeGoalGraphMode,
  ba as normalizeGoalGraphSuggestMode,
  bb as normalizeLayerPolicyMode,
  bc as normalizeOneLoopMode,
  bd as normalizePlanGraphMode,
  be as normalizePlanMode,
  bg as parseClaudeCliOutput,
  bj as pickTemplateForTask,
  bk as planCompletionPct,
  bl as planToSnapshot,
  bn as resolveAmbiguityGuardMode,
  bo as resolveAskMode,
  bp as resolveConfig,
  bq as resolveEscalationPlan,
  br as resolveGoalGraphMode,
  bs as resolveGoalGraphSuggestMode,
  bt as resolveInWorkspace,
  bu as resolveLayerPolicyMode,
  bv as resolveLayerPolicyModeFromConfig,
  bw as resolveLexicalMode,
  bx as resolveLexicalOff,
  by as resolveMemoryWriteMode,
  bz as resolveOneLoopMode,
  bA as resolvePlanGraphMode,
  bB as resolvePlanMode,
  bC as sanitizeLayerChoices,
  bD as savePlan,
  bF as stagePendingAction,
  bG as stagedActionInput,
  bI as stripMcpToolPrefix,
  bJ as summarizeToolStep,
  bK as syncHarnessLexicalEnv,
  bL as testApiKey,
  bM as turnPolicyBudget,
  bN as updatePlanFromRun,
  validateAskResponse,
  bO as validateConfig,
  bP as withLayerChoice
};
//# sourceMappingURL=index.js.map
