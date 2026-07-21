<div align="center">

# Build A Harness 中文版

**在画布上构建完整的 AI 智能体线束。编译到任何编排器。通过 Langfuse 观测。**

[![License](https://img.shields.io/badge/许可证-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/版本-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/buildaharness/releases)
[![Status](https://img.shields.io/badge/状态-公开测试版-orange.svg)](https://github.com/3IVIS/buildaharness)
[![Tests](https://img.shields.io/badge/测试-2%2C498%20通过-brightgreen.svg)](#)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/buildaharness?style=social)](https://github.com/3IVIS/buildaharness/stargazers)
[![PRs Welcome](https://img.shields.io/badge/欢迎-PR贡献-brightgreen.svg)](CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) · [中文](README_CN.md)

</div>

---

工作流将提示从节点路由到节点。**线束**管理智能体*相信*什么、它*被允许*做什么、如何捕获自身错误，以及学到什么。Build A Harness 提供完整的 11 层架构 — 在画布上绘制，编译到任意框架，追踪每一个决策。

```
画布  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

> 规格是合约。画布是编辑器。适配器是编译器。

---

## 为什么需要线束，而不仅仅是工作流

| 简单智能体循环 | 完整线束 — 已实现 |
|:--|:--|
| 输入 / 调用者 | **调用者状态** — 约束 · 澄清 |
| ↓ | **世界模型** — 信念 · 矛盾 · generation_id |
| LLM 调用 | **推理** — 证据 · 假设（4 种来源）· VOI |
| ↓ | **控制** ← *核心* — 5 层解析器 · NORMAL / CAUTIOUS / BLOCKED |
| 工具调用 ↺ 循环 | **规划** — 任务图（6 状态）· 并行并发 |
| ↓ | **执行** + **验证** — VOI 门 · 9 层 |
| 输出 | **恢复** + **内存** — 6 种策略 · 压缩 |
| | **学习** — 经验存储 · 热启动 *（可选）* |
| | **输出 & 审查员通过** — 合约 · 三镜头审查 |
| *提示输入 → 答案输出* | *27 个节点 · 11 层 · 759 个线束层测试* |

---

## 已实现功能

<table>
<tr valign="top">
<td width="50%">

**画布与执行层**
- ✅ 画布，含 27 种节点类型（14 个执行节点 + 13 个线束节点）
- ✅ 4 个框架适配器 — LangGraph、CrewAI、Mastra、MAF
- ✅ Langfuse 可观测性 — 线束追踪覆盖所有运行时
- ✅ HITL 暂停/恢复 · REST / MCP / A2A 部署
- ✅ FlowSpec v1.0.0 — 开放、可移植的 JSON 格式
- ✅ 流程概念 — 预置任务图脚手架

</td>
<td width="50%">

**推理与控制层**
- ✅ 世界模型 · 类型化信念 · 矛盾检测
- ✅ 5 层控制状态解析器 · 死锁检测
- ✅ 执行前审查门 · 9 层验证
- ✅ 6 种命名恢复策略 · 类型化故障库
- ✅ 经验存储 — 跨运行结构复用
- ✅ 对抗性审查员通过 · 输出合约验证

</td>
</tr>
</table>

---

## 节点面板

线束由 **14 个核心节点**和 **13 个线束层节点**构建 — 每个节点均可编译到全部四个运行时。悬停节点名称可查看说明。

<table>
<thead><tr><th colspan="4" align="left">核心节点</th></tr></thead>
<tbody>
<tr>
<td nowrap><abbr title="流程入口点 — 接收初始请求和状态">⤵ <code>input</code></abbr></td>
<td nowrap><abbr title="流程出口点 — 将最终结果返回给调用者">⤴ <code>output</code></abbr></td>
<td nowrap><abbr title="LLM 调用 — 结构化输出、验证器、fail_branch、Langfuse 托管提示">✨ <code>llm_call</code></abbr></td>
<td nowrap><abbr title="从流程的 tools[] 注册表中调用命名工具">🔧 <code>tool_invoke</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="分支 — JSONPath 或 fn_ref 表达式计算为命名分支目标">⎇ <code>condition</code></abbr></td>
<td nowrap><abbr title="扇出到 N 个并发分支">⑂ <code>parallel_fork</code></abbr></td>
<td nowrap><abbr title="扇入 — merge / append / fn_ref 归约器，等待所有分支完成">⊖ <code>parallel_join</code></abbr></td>
<td nowrap><abbr title="暂停并等待类型化的人工恢复载荷 — 所有运行时均支持顺序 HITL">⏸ <code>hitl_breakpoint</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="从键值或语义内存存储中读取">📖 <code>memory_read</code></abbr></td>
<td nowrap><abbr title="写入命名内存存储">🔖 <code>memory_write</code></abbr></td>
<td nowrap><abbr title="将另一个流程嵌入为可复用节点 — LangGraph/Mastra：完整支持；CrewAI：部分支持">📦 <code>subgraph</code></abbr></td>
<td nowrap><abbr title="状态转换 — 字段映射或应用于流程状态的 fn_ref 函数">⇌ <code>transform</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="从流程的 agents[] 注册表执行智能体角色 — CrewAI 中原生，其他框架中合成">🤖 <code>agent_role</code></abbr></td>
<td nowrap><abbr title="具有可配置终止条件的多智能体循环 — MS Agent Framework 中原生，其他框架中合成">👥 <code>agent_debate</code></abbr></td>
<td></td><td></td>
</tr>
</tbody>
</table>

<table>
<thead><tr><th colspan="4" align="left">线束节点 — 实现 11 层控制架构</th></tr></thead>
<tbody>
<tr>
<td nowrap><abbr title="观察、信念、假设、矛盾 — generation_id 跟踪每次重要更新">🧠 <code>world_model</code></abbr></td>
<td nowrap><abbr title="四种生成来源；多样性执行（阈值 0.7）；带 K 保留的消除策略">💡 <code>hypothesis_set</code></abbr></td>
<td nowrap><abbr title="收集类型化 Evidence(obs, reliability, source, type, freshness) — 观察从不自动提升为结论">🗄️ <code>gather_evidence</code></abbr></td>
<td nowrap><abbr title="在已知范围限制下限制每个工具的最大结论可靠性；更新 verification_health.feasibility">⚙️ <code>apply_tool_rel</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="可靠性加权信念整合；belief_dep_graph 传播；更新 completeness_flags">🔄 <code>update_wm</code></abbr></td>
<td nowrap><abbr title="五层解析器 → NORMAL / CAUTIOUS / BLOCKED；死锁检测；generation_id 门断言">🛡️ <code>control_state</code></abbr></td>
<td nowrap><abbr title="6 状态任务分解；循环检测；变化时重新计算 abstraction_fit">🕸️ <code>task_graph</code></abbr></td>
<td nowrap><abbr title="9 个验证层（由 tool_availability_manifest 修剪）；高风险时对抗性通过">✅ <code>verify_gate</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="rollback() → record_failure() → 策略切换：DIRECT_EDIT、TRACE_EXEC、BROADER_SEARCH、REIMPLEMENT、MINIMAL_FIX、ESCALATE">♻️ <code>recovery</code></abbr></td>
<td nowrap><abbr title="具有 tool_reliability_envelopes 和 tool_availability_manifest 的证据存储">📋 <code>evidence_store</code></abbr></td>
<td nowrap><abbr title="跨运行结构复用：分解、工具工作流、验证计划、恢复序列（可选）">📊 <code>exp_store</code></abbr></td>
<td nowrap><abbr title="三镜头审查：实施者 · 审查员 · 对抗性 — 基于成功标准因果邻近度的对抗性先验">👁️ <code>reviewer_pass</code></abbr></td>
</tr>
<tr>
<td nowrap><abbr title="为常见任务模式预置的概念性流程脚手架">🧭 <code>process_concept</code></abbr></td>
<td></td><td></td><td></td>
</tr>
</tbody>
</table>

更深入的伪代码 / 状态模型架构详解仅在内部私有维护，并非本公开仓库的一部分 — 本仓库随附的架构说明见 [docs/architecture.md](docs/architecture.md)。

---

## 框架适配器

全部四个运行时从同一份 `flow.json` 编译 — 无需重写。

| 运行时 | 语言 | HITL | 关键集成 |
|:--|:--|:--|:--|
| **LangGraph** | Python | `interrupt()` | `@observe` · 线束子跨度 |
| **CrewAI** | Python | — | `context_from → Task.context` · 层级感知内存 |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js 侧车 |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` 原生 · OTel → Langfuse |

编译：`POST /compile?runtime=langgraph` — 同一份规格，任意运行时。  
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
docker compose up        # 启动全部 12 个服务
```

| 服务 | URL |
|:--|:--|
| 画布 | http://localhost:3000 |
| 适配器 API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

<details>
<summary>无 Docker 方式</summary>

```bash
./scripts/setup-env.sh && source adapter/.venv/bin/activate
npm install && npm run dev        # 画布 → localhost:3000
cd adapter && python main.py      # 适配器 → localhost:8000
```

</details>

<details>
<summary>运行测试</summary>

```bash
npm test                                         # Vitest — 验证 5 个参考流程
pytest adapter/tests/ -v                         # 适配器单元 + 集成测试
pytest adapter/tests/test_maf_adapter.py -v     # MAF 套件（42 个测试）
```

</details>

> **启动错误？** 请参阅 [docs/troubleshooting.md](docs/troubleshooting.md) · 实时协作：[docs/collab.md](docs/collab.md) · 本地部署 / Kubernetes：[docs/deployment.md](docs/deployment.md)

---

## AI 模型支持

所有调用通过 **LiteLLM** 路由 — 在 `.env` 中添加密钥。

| 提供商 | 环境变量 | 示例模型 |
|:--|:--|:--|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet`, `claude-opus` |
| Ollama（本地）| — | `mistral`, `qwen3`, `qwen2.5-coder` |

> **没有 API 密钥？** 安装 [Ollama](https://ollama.com)，运行 `ollama pull mistral`，然后执行 `./scripts/setup-ollama.sh` — 无需付费账户即可测试全部四个框架。

完整设置：[docs/llm-setup.md](docs/llm-setup.md)

---

## 嵌入画布

```bash
npm install @buildaharness/canvas
```

```tsx
import { BuildAHarnessCanvas } from '@buildaharness/canvas'
import '@buildaharness/canvas/styles.css'

<BuildAHarnessCanvas
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
|:--|:--|
| [docs/architecture.md](docs/architecture.md) | 系统设计、服务交互、数据流 |
| [docs/api.md](docs/api.md) | REST API 参考 — 编译、执行、部署、HITL 恢复 |
| [docs/llm-setup.md](docs/llm-setup.md) | LLM 提供商设置 — OpenAI、Anthropic、Ollama、自定义 |
| [docs/collab.md](docs/collab.md) | 实时协作 — Yjs 设置与内部原理 |
| [docs/deployment.md](docs/deployment.md) | Docker、Helm、SSO/OIDC、完整环境变量参考 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见启动错误 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 如何贡献 |

---

<div align="center">

Apache 2.0 — 请参阅 [LICENSE](LICENSE)。

</div>
