<div align="center">

# Its Harness 中文版

**AI 智能体线束的可视化画布**

[![License](https://img.shields.io/badge/许可证-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/版本-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/itsharness/releases)
[![Status](https://img.shields.io/badge/状态-公开测试版-orange.svg)](https://github.com/3IVIS/itsharness)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/itsharness?style=social)](https://github.com/3IVIS/itsharness/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/3IVIS/itsharness)](https://github.com/3IVIS/itsharness/issues)
[![PRs Welcome](https://img.shields.io/badge/欢迎-PR贡献-brightgreen.svg)](https://github.com/3IVIS/itsharness/blob/main/CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | [中文](README_CN.md)

</div>

---

在画布上绘制流程 → 导出与运行时无关的规格文件 → 编译到您的框架 → 运行、追踪、调试和部署 — 一套工具完成所有工作。

```
flow.json  →  [ langgraph 适配器 ]  →  Python / LangGraph
           →  [ crewai 适配器 ]     →  Python / CrewAI
           →  [ mastra 适配器 ]     →  TypeScript / Mastra
           →  [ maf 适配器 ]        →  Python / MS Agent Framework
           →  [ REST 端点 ]          →  POST /flows/{id}/invoke
           →  [ MCP 工具 ]           →  Claude Desktop + 任何 MCP 客户端
           →  [ A2A 智能体 ]         →  任何 A2A 兼容运行时
```

**当前版本：** v0.8.0 — 画布、四个框架适配器、Langfuse 可观测性以及完整的 11 层线束架构已全部实现。241 个线束测试通过。

---

## 更宏观的视角 — 完整线束是什么

工作流告诉你的 AI 该做什么。线束确保它真正做到。

这不仅仅是程度上的差异 — 而是架构上的根本差异。工作流将提示从一个节点路由到另一个节点。线束管理智能体*相信*什么、它*被允许*做什么、如何捕获自身错误，以及下次学到什么。Its Harness 实现了这一完整架构：在画布上绘制，在任何框架上运行，即可获得完整的 11 层控制系统。

### 已实现的线束架构

完整的 11 层、22 节点线束已实现并集成到全部四个框架适配器中：

| 层 | 已实现内容 |
|---|---|
| **画布** | 14 种节点类型 · 可视化编辑器 · 实时多用户协作 · `@itsharness/canvas` 嵌入包 |
| **框架** | LangGraph · CrewAI · Mastra · MS Agent Framework — 全部四个，含完整线束层适配器支持 |
| **可观测性** | Langfuse 追踪 + 线束跨度（世界模型、控制状态、验证、恢复）覆盖所有 4 个运行时 |
| **推理** | 证据存储 · 工具可靠性包络 · VOI 门控证据收集 · 假设系统（4 种来源 · 多样性执行 · 消除策略）|
| **世界模型** | 信念依赖图 · `generation_id` 陈旧性跟踪 · 类型化矛盾 · 陈旧性扫描 · `completeness_flags` |
| **控制** | 5 层 `resolve_control_state()` · `NORMAL`/`CAUTIOUS`/`BLOCKED` · 死锁检测 · generation_id 门断言 |
| **规划** | 任务图（6 状态）· 并行写域冲突检测 · `conflict_probability_cache` · 悲观/乐观并发 |
| **验证** | 9 层验证 · 对抗性审查员通过 · 预执行审查门控 · `contract_shadow_check` · `tool_availability_manifest` |
| **恢复** | 6 种命名恢复策略 · 类型化故障库 · `cannot_make_progress()`（4 个可测代理）· 局部/全局重规划 |
| **内存** | Token 预算跟踪 · 日志保留策略 · 结构化压缩风险（`compressed_structures[]` + `pruned_regions[]`）|
| **学习** | 经验存储（可选）— 跨运行结构复用：分解、工具工作流、验证计划、恢复序列 |

### 11 个架构层

完整线束组织为 11 个层，每个层有明确的职责：

| 层 | 职责 |
|---|---|
| **调用者状态** | 需求、约束、澄清 — 运行中可变的一等对象 |
| **世界模型** | 观察、信念、假设、矛盾 — `generation_id` 跟踪每次重要更新 |
| **推理** | 证据处理、四来源假设生成、VOI 门控证据收集 |
| **规划** | 任务分解、调度、带写域冲突检测的并行并发 |
| **控制** | 风险状态管理 — 五层解析器输出 `NORMAL` / `CAUTIOUS` / `BLOCKED` |
| **执行** | 动作选择和变异 — 控制状态是唯一控制输入 |
| **验证** | 9 层验证 · 对抗性审查员通过 · 预执行审查门控 |
| **策略** | 分解、动作选择和执行后的门控执行 |
| **恢复** | 回滚和重规划 — 六种命名策略 · 类型化故障库 |
| **内存** | 上下文压缩 · 日志保留策略 · 预算跟踪 |
| **学习（可选）** | 经验存储 — 跨运行结构复用，不仅仅是概率先验 |

### 22 个节点

完整线束执行一个 22 节点的循环：

| # | 节点 | 功能 |
|---|---|---|
| 1 | **初始化** | 设置所有持久状态：世界模型、信念依赖图、假设集、任务图、诊断、控制状态、内存预算 |
| 2 | **热启动** | 从经验存储加载可复用结构（策略先验、故障基础率、结构模式）— 不可用时为空操作 |
| 3 | **检查调用者更新** | 对运行中约束变化的非阻塞轮询；约束变化时完整传播到任务图和输出合同 |
| 4 | **上下文压缩** | `compress_memory()` — 分别跟踪压缩结构和修剪区域；更新 `completeness_flags` |
| 5 | **收集证据** | 收集 `Evidence(obs, reliability, source, type, freshness)` — 观察从不自动提升为结论 |
| 6 | **应用工具可靠性** | 在已知范围限制下限制每个工具可导出结论的最大可靠性 |
| 7 | **更新世界模型** | 可靠性加权信念整合；`belief_dep_graph` 传播；更新 `completeness_flags` |
| 8 | **检测矛盾** | 类型化检测：成对 · 集合级 · 时间 · 抽象 — 四个严重级别，三个范围 |
| 9 | **生成/更新假设** | 四个结构不同的来源；多样性执行（阈值 0.7）；带 K 保留的消除策略 |
| 10 | **更新诊断** | 重新计算所有四个健康向量；`failure_mode_library.match()`；`dep_class_gap` 建议注释 |
| 11 | **解析控制状态** | 严格顺序的五个隐式层 → `NORMAL` / `CAUTIOUS` / `BLOCKED`；死锁检测；`generation_id` 戳记 |
| 12 | **更新任务图** | 反映新世界模型状态；循环检测；变化时重新计算 `abstraction_fit` |
| 13 | **选择任务** | `depends_on` 解析；来自 `conflict_probability_cache` 的悲观或乐观并发；连接处的并行分支合并 |
| 14 | **估计风险** | `LOW` / `MEDIUM` / `HIGH` — 基于文件中心性、变更范围、模块类型 |
| 15 | **估计 VOI** | `VOI = 预期不确定性减少 × 决策影响`；验证充分性批评器修剪不可用的 9 层检查 |
| 16 | **审查建议变更** | 五维度预执行门控 — 任务对齐、世界模型一致性、输出合同、代码质量、开放假设 |
| 17 | **执行** | 每动作可逆性策略；工具工作流；工具错误成为 `Evidence(HIGH, SYSTEM_ERROR)` |
| 18 | **验证** | 9 个验证层（由 `tool_availability_manifest` 修剪）；高风险时对抗性通过；`contract_shadow_check` |
| 19 | **回滚 + 重规划** | `rollback()` → `record_failure()` → 策略切换；六种命名策略：`DIRECT_EDIT` · `TRACE_EXEC` · `BROADER_SEARCH` · `REIMPLEMENT` · `MINIMAL_FIX` · `ESCALATE` |
| 20 | **上报** | 当 `BLOCKED` 或 `cannot_make_progress()` 时触发；呈现最少所需信息；人工响应后完整约束传播 |
| 21 | **审查员通过** | 三个镜头（实施者 · 审查员 · 对抗性）；基于成功标准因果邻近度的对抗性先验 |
| 22 | **输出验证** | 针对当前调用者约束的完整输出合同检查 — 返回前的权威通过 |

完整架构参考（伪代码、所有 22 个节点、所有 11 层、状态模型和深度解析）请参阅 [plan/full_harness_architecture.html](https://github.com/3IVIS/itsharness/blob/main/plan/full_harness_architecture.html)。服务交互与数据流参见 [docs/architecture.md](https://github.com/3IVIS/itsharness/blob/main/docs/architecture.md)。

---

## 快速开始

### 1. 运行配置

```bash
./scripts/setup-env.sh
```

生成密钥，写入 `.env`，可选创建 Python venv 并启动服务栈。可安全重复运行 — 现有真实值不会被覆盖。

### 2. 启动服务栈

```bash
docker compose up
```

| 服务 | URL |
|---|---|
| 画布 | http://localhost:3000 |
| 适配器 API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

九个服务启动：canvas、adapter、mastra-runner、postgres、redis、clickhouse、litellm、langfuse-web、langfuse-worker。

> **启动错误？** 请参阅 [docs/troubleshooting.md](https://github.com/3IVIS/itsharness/blob/main/docs/troubleshooting.md)。最常见原因是陈旧的 Postgres 卷（`./scripts/reset-volumes.sh`）或错误长度的密钥（`bash scripts/check-env.sh`）。

**实时协作**为可选功能 — 请参阅 [docs/collab.md](https://github.com/3IVIS/itsharness/blob/main/docs/collab.md)。  
**本地部署 / Kubernetes** — 请参阅 [docs/deployment.md](https://github.com/3IVIS/itsharness/blob/main/docs/deployment.md)。

### 无 Docker 方式

```bash
./scripts/setup-env.sh
source adapter/.venv/bin/activate
npm install && npm run dev       # 画布 → http://localhost:3000
cd adapter && python main.py     # 适配器 → http://localhost:8000
```

### 测试

```bash
npm test                                          # Vitest — 验证所有 5 个参考流程
pytest adapter/tests/ -v                         # 适配器单元 + 集成套件
pytest adapter/tests/test_maf_adapter.py -v     # MAF 适配器套件（742 个测试）
```

### 诊断

| 脚本 | 检查内容 |
|---|---|
| `bash scripts/verify_services.sh` | 所有容器运行 · 健康检查 · HTTP 端点 · Redis / Postgres / Langfuse 认证 |
| `bash scripts/verify_llm.sh` | Ollama → LiteLLM → 适配器 LLM 路径（3 个独立层）|
| `bash scripts/verify_hitl.sh` | LangGraph、Mastra、MAF 的 HITL 暂停 → 恢复 → 完成 |
| `bash scripts/verify_observability.sh` | 所有 4 个运行时的 Langfuse 追踪确认 |
| `bash scripts/verify_prompts.sh` | Langfuse 提示 API · 适配器 HTTP 代理 · SDK 解析 |

设置 `TEST_EMAIL=... TEST_PASSWORD=...` 可跳过交互式凭据提示。

---

## AI 模型支持

所有 LLM 调用通过 **LiteLLM** 路由。在 `.env` 中添加相关密钥：

| 提供商 | 密钥 | 流程规格中的模型名称 |
|---|---|---|
| OpenAI | `OPENAI_API_KEY=sk-...` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY=sk-ant-...` | `claude-sonnet`, `claude-haiku`, `claude-opus` |
| Ollama（本地）| 无 | `mistral`, `qwen3`, `qwen2.5-coder` |

完整设置说明（包括 Ollama 和自定义模型）请参阅 [docs/llm-setup.md](https://github.com/3IVIS/itsharness/blob/main/docs/llm-setup.md)。

---

## 功能概述

- **绘制** — 可视化画布上的 14 种节点类型。每个规格字段均可直接编辑。
- **掌控规格** — 画布输出您控制的版本化、与运行时无关的 JSON 规格。
- **编译** — 一次 API 调用将规格转换为您选择的框架的可运行代码。
- **运行与观察** — 实时节点覆盖、每节点 token 计数、Langfuse 追踪链接、HITL 暂停/恢复。
- **部署** — 一键同时将流程发布为 REST 端点、MCP 工具和 A2A 智能体。
- **协作** — 使用 Yjs CRDT 的实时多用户编辑、实时光标和离线持久化。
- **嵌入** — 使用 `@itsharness/canvas` npm 包将画布嵌入您自己的门户。

**规格是合约。画布是编辑器。适配器是编译器。**

---

## 框架适配器支持

| 运行时 | 状态 | 关键说明 |
|---|---|---|
| **LangGraph** · Python | ✅ 完整 | `@observe` 追踪 + 子跨度 · 通过 `interrupt()` 的 HITL |
| **CrewAI** · Python | ✅ 完整 | `context_from → Task.context` · 层级感知 `Crew()` 内存 |
| **Mastra** · TypeScript | ✅ 完整 | Node.js 侧车 · `suspend()/resume()` HITL |
| **MS Agent Framework** · Python | ✅ 完整 | `AgentGroupChat` 原生 · `_HitlPause` HITL · OTel → Langfuse |

---

## 延伸阅读

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](https://github.com/3IVIS/itsharness/blob/main/docs/architecture.md) | 系统设计、服务交互、数据流、关键决策 |
| [docs/api.md](https://github.com/3IVIS/itsharness/blob/main/docs/api.md) | 完整 API 参考 — 所有端点、认证、错误代码 |
| [docs/llm-setup.md](https://github.com/3IVIS/itsharness/blob/main/docs/llm-setup.md) | LLM 提供商设置 — OpenAI、Anthropic、Ollama、自定义模型 |
| [docs/collab.md](https://github.com/3IVIS/itsharness/blob/main/docs/collab.md) | 实时协作 — 设置、Yjs 内部原理、环境变量 |
| [docs/deployment.md](https://github.com/3IVIS/itsharness/blob/main/docs/deployment.md) | Docker、Helm、SSO/OIDC 配置、完整环境变量参考 |
| [docs/troubleshooting.md](https://github.com/3IVIS/itsharness/blob/main/docs/troubleshooting.md) | 常见启动错误及修复 |
| [plan/full_harness_architecture.html](https://github.com/3IVIS/itsharness/blob/main/plan/full_harness_architecture.html) | 完整线束架构 — 伪代码、所有 22 个节点、所有 11 层、状态模型、深度解析、范围 |
| [CONTRIBUTING.md](https://github.com/3IVIS/itsharness/blob/main/CONTRIBUTING.md) | 如何贡献 — 适配器、规格、画布、迁移 |
| [spec/CHANGELOG.md](https://github.com/3IVIS/itsharness/blob/main/spec/CHANGELOG.md) | 规格版本历史 |

---

## 贡献

欢迎贡献！请参阅 [CONTRIBUTING.md](https://github.com/3IVIS/itsharness/blob/main/CONTRIBUTING.md) 了解如何贡献适配器、规格更改、画布节点和迁移。

- **报告 Bug** → [打开 Bug 报告](https://github.com/3IVIS/itsharness/issues/new?template=bug_report.md)
- **请求功能** → [打开功能请求](https://github.com/3IVIS/itsharness/issues/new?template=feature_request.md)
- **阅读规格** → [spec/](https://github.com/3IVIS/itsharness/tree/main/spec)
- **架构参考** → [plan/full_harness_architecture.html](https://github.com/3IVIS/itsharness/blob/main/plan/full_harness_architecture.html)

---

## 许可证

Apache 2.0 — 请参阅 [LICENSE](https://github.com/3IVIS/itsharness/blob/main/LICENSE)。
