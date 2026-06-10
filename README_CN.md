<div align="center">

# Its Harness 中文版

**在画布上构建完整的 AI 智能体线束。编译到任何编排器。通过 Langfuse 观测。**

[![License](https://img.shields.io/badge/许可证-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/版本-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/itsharness/releases)
[![Status](https://img.shields.io/badge/状态-公开测试版-orange.svg)](https://github.com/3IVIS/itsharness)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/itsharness?style=social)](https://github.com/3IVIS/itsharness/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/3IVIS/itsharness)](https://github.com/3IVIS/itsharness/issues)
[![PRs Welcome](https://img.shields.io/badge/欢迎-PR贡献-brightgreen.svg)](CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | [中文](README_CN.md)

</div>

---

工作流将提示从节点路由到节点。**线束**管理智能体*相信*什么、它*被允许*做什么、如何捕获自身错误，以及学到什么。Its Harness 提供完整的 11 层线束架构 — 在画布上绘制，编译到任意框架，通过 Langfuse 追踪一切。

<table width="100%" cellpadding="0" cellspacing="0">
<tr valign="top">
<td width="44%" style="border:1px solid #d1d5db;border-radius:8px;padding:18px;background:#f9fafb">
<div align="center" style="font-family:monospace;font-size:11px;letter-spacing:0.1em;color:#6b7280;text-transform:uppercase;padding-bottom:14px">简单智能体循环</div>
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#0891b2">⬤</span>&nbsp;输入 / 调用者</td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#7c3aed">⬤</span>&nbsp;LLM 调用</td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#d97706">⬤</span>&nbsp;工具调用 &nbsp;<span style="color:#9ca3af;font-size:10px">↺ 循环</span></td></tr>
<tr><td align="center" style="color:#d1d5db;padding:3px 0;font-size:13px">↓</td></tr>
<tr><td style="border:1px solid #e5e7eb;border-radius:5px;padding:8px 12px;background:#fff;font-family:monospace;font-size:12px"><span style="color:#059669">⬤</span>&nbsp;输出</td></tr>
</table>
<div align="center" style="margin-top:14px;font-family:monospace;font-size:10px;color:#9ca3af">提示输入 → 答案输出<br>无世界模型 · 无控制状态 · 无验证</div>
</td>
<td width="12%" align="center" valign="middle" style="font-size:20px;color:#d1d5db;font-weight:500;font-family:monospace;padding:0 8px">vs</td>
<td width="44%" style="border:1px solid #a5b4fc;border-radius:8px;padding:18px;background:#fafbff">
<div align="center" style="font-family:monospace;font-size:11px;letter-spacing:0.1em;color:#4f46e5;text-transform:uppercase;padding-bottom:14px">完整线束 — 已实现</div>
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #0891b2;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>调用者状态</b><span style="color:#9ca3af;font-size:10px"> — 约束 · 澄清</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #7c3aed;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>世界模型</b><span style="color:#9ca3af;font-size:10px"> — 信念 · 矛盾 · generation_id</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #16a34a;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>推理</b><span style="color:#9ca3af;font-size:10px"> — 证据 · 假设（4 种来源）· VOI</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #a5b4fc;border-left:4px solid #a21caf;border-radius:4px;padding:6px 10px;background:#eef2ff;font-family:monospace;font-size:11px"><b>控制</b> <span style="background:#e0e7ff;color:#4f46e5;border:1px solid #a5b4fc;border-radius:3px;padding:1px 5px;font-size:9px">核心</span><span style="color:#9ca3af;font-size:10px"> — 5 层解析器 · NORMAL/CAUTIOUS/BLOCKED</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>规划</b><span style="color:#9ca3af;font-size:10px"> — 任务图（6 状态）· 并行并发</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #d97706;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>执行</b><span style="color:#9ca3af;font-size:10px"> — VOI · 审查门</span></td>
    <td width="2%"></td>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #dc2626;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>验证</b><span style="color:#9ca3af;font-size:10px"> — 9 层</span></td>
  </tr></table>
</td></tr>
<tr><td height="3"></td></tr>
<tr><td style="padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #ea580c;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>恢复</b><span style="color:#9ca3af;font-size:10px"> — 6 种策略</span></td>
    <td width="2%"></td>
    <td width="49%" style="border:1px solid #e5e7eb;border-left:3px solid #65a30d;border-radius:4px;padding:6px 8px;background:#fff;font-family:monospace;font-size:11px"><b>内存</b><span style="color:#9ca3af;font-size:10px"> — 压缩 · 日志</span></td>
  </tr></table>
</td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px dashed #e5e7eb;border-left:3px solid #94a3b8;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px;color:#9ca3af"><b>学习</b><span style="font-size:10px"> — 经验存储 · 热启动（可选）</span></td></tr>
<tr><td height="3"></td></tr>
<tr><td style="border:1px solid #e5e7eb;border-left:3px solid #059669;border-radius:4px;padding:6px 10px;background:#fff;font-family:monospace;font-size:11px"><b>输出 &amp; 审查员通过</b><span style="color:#9ca3af;font-size:10px"> — 合同 · 三镜头审查</span></td></tr>
</table>
<div align="center" style="margin-top:14px;font-family:monospace;font-size:10px;color:#9ca3af">22 个节点 · 11 层 · 241 个测试通过</div>
</td>
</tr>
</table>

> 规格是合约。画布是编辑器。适配器是编译器。

```
画布  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

**v0.8.0** — 画布、四个框架适配器、完整 11 层线束架构、Langfuse 可观测性。

---

## 节点面板

线束由 **14 个核心节点**和 **13 个线束层节点**构建 — 每个节点均可编译到全部四个运行时。悬停节点名称可查看说明。

<table>
<thead><tr><th colspan="7" align="left">核心节点</th></tr></thead>
<tbody>
<tr>
<td><abbr title="流程入口点 — 接收初始请求和状态">⤵ <code>input</code></abbr></td>
<td><abbr title="流程出口点 — 将最终结果返回给调用者">⤴ <code>output</code></abbr></td>
<td><abbr title="LLM 调用 — 结构化输出、验证器、fail_branch、Langfuse 托管提示">✨ <code>llm_call</code></abbr></td>
<td><abbr title="从流程的 tools[] 注册表中调用命名工具">🔧 <code>tool_invoke</code></abbr></td>
<td><abbr title="分支 — JSONPath 或 fn_ref 表达式计算为命名分支目标">⎇ <code>condition</code></abbr></td>
<td><abbr title="扇出到 N 个并发分支">⑂ <code>parallel_fork</code></abbr></td>
<td><abbr title="扇入 — merge / append / fn_ref 归约器，等待所有分支完成">⊖ <code>parallel_join</code></abbr></td>
</tr>
<tr>
<td><abbr title="暂停并等待类型化的人工恢复载荷 — 所有运行时均支持顺序 HITL">⏸ <code>hitl_breakpoint</code></abbr></td>
<td><abbr title="从键值或语义内存存储中读取">📖 <code>memory_read</code></abbr></td>
<td><abbr title="写入命名内存存储">🔖 <code>memory_write</code></abbr></td>
<td><abbr title="将另一个流程嵌入为可复用节点 — LangGraph/Mastra：完整支持；CrewAI：部分支持">📦 <code>subgraph</code></abbr></td>
<td><abbr title="状态转换 — 字段映射或应用于流程状态的 fn_ref 函数">⇌ <code>transform</code></abbr></td>
<td><abbr title="从流程的 agents[] 注册表执行智能体角色 — CrewAI 中原生，其他框架中合成">🤖 <code>agent_role</code></abbr></td>
<td><abbr title="具有可配置终止条件的多智能体循环 — MS Agent Framework 中原生，其他框架中合成">👥 <code>agent_debate</code></abbr></td>
</tr>
</tbody>
</table>

<table>
<thead><tr><th colspan="7" align="left">线束节点 — 实现 11 层控制架构</th></tr></thead>
<tbody>
<tr>
<td><abbr title="观察、信念、假设、矛盾 — generation_id 跟踪每次重要更新">🧠 <code>world_model</code></abbr></td>
<td><abbr title="四种生成来源；多样性执行（阈值 0.7）；带 K 保留的消除策略">💡 <code>hypothesis_set</code></abbr></td>
<td><abbr title="收集类型化 Evidence(obs, reliability, source, type, freshness) — 观察从不自动提升为结论">🗄️ <code>gather_evidence</code></abbr></td>
<td><abbr title="在已知范围限制下限制每个工具的最大结论可靠性；更新 verification_health.feasibility">🔧 <code>apply_tool_rel</code></abbr></td>
<td><abbr title="可靠性加权信念整合；belief_dep_graph 传播；更新 completeness_flags">🧠 <code>update_wm</code></abbr></td>
<td><abbr title="五层解析器 → NORMAL / CAUTIOUS / BLOCKED；死锁检测；generation_id 门断言">🛡️ <code>control_state</code></abbr></td>
<td><abbr title="6 状态任务分解；循环检测；变化时重新计算 abstraction_fit；并行写域冲突检测">🕸️ <code>task_graph</code></abbr></td>
</tr>
<tr>
<td><abbr title="9 个验证层（由 tool_availability_manifest 修剪）；高风险时对抗性通过；contract_shadow_check">✅ <code>verify_gate</code></abbr></td>
<td><abbr title="rollback() → record_failure() → 策略切换；六种策略：DIRECT_EDIT、TRACE_EXEC、BROADER_SEARCH、REIMPLEMENT、MINIMAL_FIX、ESCALATE">🔄 <code>recovery</code></abbr></td>
<td><abbr title="具有 tool_reliability_envelopes 和 tool_availability_manifest 的证据存储 — 用于修剪不可用验证检查">🗄️ <code>evidence_store</code></abbr></td>
<td><abbr title="跨运行结构复用：分解、工具工作流、验证计划、恢复序列（可选）">📊 <code>exp_store</code></abbr></td>
<td><abbr title="三镜头审查：实施者 · 审查员 · 对抗性 — 基于成功标准因果邻近度的对抗性先验">👁️ <code>reviewer_pass</code></abbr></td>
<td><abbr title="为常见任务模式预置的概念性流程脚手架">🧭 <code>process_concept</code></abbr></td>
<td></td>
</tr>
</tbody>
</table>

完整 22 节点循环、11 层架构、伪代码和状态模型：[plan/harness_architecture.html](plan/harness_architecture.html)

---

## 框架适配器

全部四个运行时完整支持 — 同一份规格编译一次，在任意框架运行。

| 运行时 | 语言 | HITL | 关键集成 |
|---|---|---|---|
| **LangGraph** | Python | `interrupt()` | `@observe` · 线束子跨度 |
| **CrewAI** | Python | — | `context_from → Task.context` · 层级感知内存 |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js 侧车 |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` 原生 · OTel → Langfuse |

编译：`POST /compile?runtime=langgraph` — 同一份 `flow.json`，任意运行时。  
一键部署为 **REST 端点**、**MCP 工具**或 **A2A 智能体**。

---

## 可观测性

自托管 **Langfuse** 随 `docker compose up` 一同启动 — 无需额外配置。

- 跨全部四个运行时的每节点子跨度（世界模型、控制状态、验证、恢复）
- 通过 LiteLLM 获取每节点的 token 计数、延迟和成本
- 每次运行后画布中的实时 **查看追踪 →** 链接
- 通过 Langfuse 提示 API 管理提示（任意 `llm_call` 节点上的 `prompt_ref`）

---

## 快速开始

```bash
./scripts/setup-env.sh   # 生成密钥，写入 .env
docker compose up        # 启动全部 9 个服务
```

| 服务 | URL |
|---|---|
| 画布 | http://localhost:3000 |
| 适配器 API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

**无 Docker 方式：**
```bash
./scripts/setup-env.sh && source adapter/.venv/bin/activate
npm install && npm run dev       # 画布 → localhost:3000
cd adapter && python main.py     # 适配器 → localhost:8000
```

**测试：**
```bash
npm test                                         # Vitest — 验证 5 个参考流程
pytest adapter/tests/ -v                        # 适配器单元 + 集成测试
pytest adapter/tests/test_maf_adapter.py -v    # MAF 套件（742 个测试）
```

> 启动错误？请参阅 [docs/troubleshooting.md](docs/troubleshooting.md)。  
> 实时协作：[docs/collab.md](docs/collab.md) · 本地部署 / Kubernetes：[docs/deployment.md](docs/deployment.md)

---

## AI 模型支持

所有调用通过 **LiteLLM** 路由 — 在 `.env` 中添加密钥：

| 提供商 | 环境变量 | 示例模型 |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet`, `claude-opus` |
| Ollama（本地）| — | `mistral`, `qwen3`, `qwen2.5-coder` |

完整设置说明（包括自定义模型）：[docs/llm-setup.md](docs/llm-setup.md)

---

## 嵌入画布

```bash
npm install @itsharness/canvas
```

```tsx
import { ItsHarnessCanvas } from '@itsharness/canvas'
import '@itsharness/canvas/styles.css'

<ItsHarnessCanvas
  initialSpec={mySpec}
  onSpecChange={(updated) => save(updated)}
  execStats={runState.nodeStats}
  theme="dark"
/>
```

完整属性参考：[`packages/canvas/README.md`](packages/canvas/README.md)

---

## 文档

| | |
|---|---|
| [plan/harness_architecture.html](plan/harness_architecture.html) | 完整线束 — 伪代码、22 个节点、11 层、状态模型、深度解析 |
| [plan/canvas_plan.html](plan/canvas_plan.html) | 画布路线图 — 4 个阶段、240 个已交付项 |
| [docs/architecture.md](docs/architecture.md) | 系统设计、服务交互、数据流 |
| [docs/api.md](docs/api.md) | REST API 参考 — 编译、执行、部署、HITL 恢复 |
| [docs/llm-setup.md](docs/llm-setup.md) | LLM 提供商设置 — OpenAI、Anthropic、Ollama、自定义 |
| [docs/collab.md](docs/collab.md) | 实时协作 — Yjs 设置与内部原理 |
| [docs/deployment.md](docs/deployment.md) | Docker、Helm、SSO/OIDC、完整环境变量参考 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见启动错误 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 如何贡献 |

---

## 许可证

Apache 2.0 — 请参阅 [LICENSE](LICENSE)。
