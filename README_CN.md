<div align="center">

# Build A Harness 中文版

**一个会先思考再行动、发送前会先停下来的开源 AI 助手。**

[![License](https://img.shields.io/badge/许可证-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/版本-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/buildaharness/releases)
[![Status](https://img.shields.io/badge/状态-公开测试版-orange.svg)](https://github.com/3IVIS/buildaharness)
[![Tests](https://img.shields.io/badge/测试-2%2C860%20通过-brightgreen.svg)](#)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/buildaharness?style=social)](https://github.com/3IVIS/buildaharness/stargazers)
[![PRs Welcome](https://img.shields.io/badge/欢迎-PR贡献-brightgreen.svg)](CONTRIBUTING.md)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

[English](README.md) · [中文](README_CN.md)

</div>

---

大多数 AI 助手在模型一决定调用工具时就立刻执行。**Aielia** —— Build A Harness 的个人助手 —— 会让每一轮对话都经过一套 11 层*线束*：一个控制架构，管理智能体相信什么、被允许做什么、如何捕获自身错误，以及学到什么。一次简单的事实查询保持轻量。发送邮件、支付账单、执行 shell 命令或删除文件，则会**先停下来等待你的批准** —— 而且当分类器出错时，会要求批准，而不是当作安全操作放行。

助手是入口。它下面是一整套可视化的**线束构建器** —— 在画布上绘制同样的 11 层，编译到 LangGraph / CrewAI / Mastra / MS Agent Framework，并在 Langfuse 中追踪每一个决策。

---

## 1 · 助手 —— Aielia

```bash
npx @buildaharness/personal-assistant
```

首次运行会引导你选择一个模型 —— 复用已登录的 `claude` CLI（无需 API 密钥），或粘贴一个 Anthropic / OpenAI / OpenRouter 密钥。然后直接和它对话即可。

```ts
import { LLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from '@buildaharness/personal-assistant'

const aielia = new PersonalAssistant({ llmClient: new LLMClient({ proxyUrl, authToken }) })

await aielia.turn('东京在哪个时区？')
// { status: 'ok', reply: '…', riskLevel: 'LOW', stepsUsed: 1 }

await aielia.turn('给我老板发一封邮件说我辞职了。')
// { status: 'needs_approval', reason: '…', riskLevel: 'HIGH' }  —— 未发起任何 LLM 调用

await aielia.turn('给我老板发一封邮件说我辞职了。', { approved: true })
// 已批准 —— 继续执行，正常走完线束
```

**[在浏览器中试用 → buildaharness.com/try](https://buildaharness.com/try)** —— 使用你自己的密钥（只保存在你的浏览器里），或在添加密钥之前先看看审批门是如何触发的。

一套核心，三种前端：终端 CLI、浏览器（`@buildaharness/chat-ui`）、原生桌面应用（`@buildaharness/desktop`）。

---

## 2 · 它有何不同

[`/harness-comparison`](https://buildaharness.com/harness-comparison) 页面将三款最常用的开源智能体（Hermes Agent、Kilo Code、OpenClaw）对照这套架构进行了映射。三者都没有同时提供分层的 Control State 解析器 *和* 一个审查员/输出门。Aielia 提供：

- **实时的逐工具调用 ControlState 门** —— 每一次只读工具调用在执行*之前*都会依据本轮的 `ControlState` 进行检查（确定性的 ALLOW / DENY / REQUIRE_APPROVAL，而非仅供参考），因此本轮中逐渐显现的失败模式也能真正触发拒绝。
- **故障安全风险分类** —— 分类器出错或响应无法解析时返回 `UNKNOWN → 要求批准`，绝不会静默降级为低风险。
- **审查员通过（Reviewer Pass）** —— 三镜头审查（一致性、对抗性、抽象层级契合度）与输出合约验证会在回复发出前执行。
- **类型化事实溯源** —— 只有你亲口陈述的事实才会默认提升为持久记忆；模型推断的事实在得到确认前仅限本次会话。
- **AnswerClaim** —— 回复会区分"有证据支持并已验证"与"找到了但无法独立确认"，并显示在聊天的"Why?"面板中。
- **崩溃安全的轮内恢复** —— 一轮对话中途崩溃时会从最后一个检查点恢复，而非静默重来；一个在重放中反复崩溃的检查点会在两次尝试后被自动丢弃。
- **不可信内容边界** —— 网页结果和 shell 输出会被包裹为数据，模型被明确要求绝不将其当作指令执行。

完整说明：[`packages/personal-assistant/README.md`](packages/personal-assistant/README.md)。

---

## 3 · 构建你自己的线束

工作流将提示从节点路由到节点。**线束**管理信念、权限、自我纠错和学习。Build A Harness 以可视化构建器的形式提供完整的 11 层架构。

```
画布  →  flow.json  →  LangGraph · CrewAI · Mastra · MS Agent Framework  →  Langfuse
```

> 规格是合约。画布是编辑器。适配器是编译器。

| 简单智能体循环 | 完整线束 — 已实现 |
|:--|:--|
| 输入 / 调用者 | **调用者状态** — 约束 · 澄清 |
| ↓ | **世界模型** — 信念 · 矛盾 · generation_id |
| LLM 调用 | **推理** — 证据 · 假设（4 种来源）· VOI |
| ↓ | **控制** ← *核心* — 5 层解析器 · ALLOW/DENY 权限 · NORMAL/CAUTIOUS/RECOVERY 模式 |
| 工具调用 ↺ 循环 | **规划** — 任务图（6 状态）· 并行并发 |
| ↓ | **执行** + **验证** — VOI 门 · 9 层 |
| 输出 | **恢复** + **内存** — 6 种策略 · 压缩 |
| | **学习** — 经验存储 · 热启动 *（可选）* |
| | **输出 & 审查员通过** — 合约 · 三镜头审查 |
| *提示输入 → 答案输出* | *27 个节点 · 11 层 · 759 个线束层测试* |

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

完整节点面板与 schema 同步机制见 [docs/nodes.md](docs/nodes.md)；字段级 FlowSpec 参考见 [docs/flowspec.md](docs/flowspec.md)。

### 框架适配器

全部四个运行时从同一份 `flow.json` 编译 — 无需重写。`/compile` 会先检查目标运行时的实际能力：若 FlowSpec 需要运行时不支持的功能（持久检查点、token 流式传输），会立即以清晰的错误失败，而非静默降级。

| 运行时 | 语言 | HITL | 关键集成 |
|:--|:--|:--|:--|
| **LangGraph** | Python | `interrupt()` | `@observe` · 线束子跨度 |
| **CrewAI** | Python | — | `context_from → Task.context` · 层级感知内存 |
| **Mastra** | TypeScript | `suspend()/resume()` | Node.js 侧车 |
| **MS Agent Framework** | Python | `_HitlPause` | `AgentGroupChat` 原生 · OTel → Langfuse |

编译：`POST /compile?runtime=langgraph`。一键部署为 **REST 端点**、**MCP 工具**或 **A2A 智能体**。

### 可观测性

自托管 **Langfuse** 随 `docker compose up` 一同启动 — 无需额外配置。跨全部四个运行时的每节点子跨度、通过 LiteLLM 获取每节点的 token/延迟/成本、每次运行后画布中的实时 **查看追踪 →** 链接，以及通过 Langfuse 提示 API 管理提示（任意 `llm_call` 节点上的 `prompt_ref`）。

---

## 快速开始

**只想要助手？** 无需克隆：

```bash
npx @buildaharness/personal-assistant          # 终端
# 或打开 https://buildaharness.com/try           # 浏览器，使用你自己的密钥
```

**构建和编译线束**则需要完整技术栈（画布 + 适配器 API + Langfuse）：

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

> **新手？** 请从 [docs/getting-started.md](docs/getting-started.md) 开始 · **启动错误？** [docs/troubleshooting.md](docs/troubleshooting.md) · 实时协作：[docs/collab.md](docs/collab.md) · 本地部署 / Kubernetes：[docs/deployment.md](docs/deployment.md)

---

## AI 模型支持

助手直接连接模型（Anthropic、OpenAI、OpenRouter，或一个 `claude` CLI 登录）。完整技术栈的所有调用则通过 **LiteLLM** 路由 — 在 `.env` 中添加密钥：

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
| [docs/getting-started.md](docs/getting-started.md) | 从全新克隆到密钥、LLM、首次运行 |
| [docs/nodes.md](docs/nodes.md) | 27 个节点的面板 + schema 同步机制 |
| [docs/flowspec.md](docs/flowspec.md) | FlowSpec v1.0.0 — 全部 27 种节点类型、边、字段 |
| [docs/architecture.md](docs/architecture.md) | 系统设计、服务交互、数据流 |
| [docs/api.md](docs/api.md) | REST API 参考 — 编译、执行、部署、HITL 恢复 |
| [docs/llm-setup.md](docs/llm-setup.md) | LLM 提供商设置 — OpenAI、Anthropic、Ollama、自定义 |
| [docs/qdrant.md](docs/qdrant.md) | Qdrant 向量存储 — 播种、集合、生产环境 |
| [docs/env-vars.md](docs/env-vars.md) | 所有服务的全部环境变量 |
| [docs/collab.md](docs/collab.md) | 实时协作 — Yjs 设置与内部原理 |
| [docs/deployment.md](docs/deployment.md) | Docker、Helm、SSO/OIDC |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见启动错误 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 如何贡献 |

---

<div align="center">

Apache 2.0 — 请参阅 [LICENSE](LICENSE)。

</div>
