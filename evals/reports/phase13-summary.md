# Phase 13 — Agent Evaluation Benchmark Summary

## 双轨边界

- Track A：pinned official CAR-bench。evaluation-only `CarBenchAgentAdapter` 只连接 DriveGuard Pi/DeepSeek planning layer；CAR-bench 拥有 Tool、world state、LLM user simulator 与 official evaluator。
- Track B：`DriveGuard-Eval-v1.0.0`，600 个版本化 Native Case；生产 Runtime、Policy、Confirmation、Executor、Simulator 与 Urgent Processor 路径提供观测，核心 scorer 完全 deterministic。
- 两条轨道分别报告，未计算 CAR-bench + Native 的单一 accuracy。

## Track A — CAR-bench External

- Repository commit：`54990894241f2c07e9b523928c2a29e9b693d313`；version `0.1.0`；dataset commit `1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af`；MIT。
- Result：`CAR-bench Full Test`；Coverage `125/125`；`num_trials=1`；58 Tools；19 policies。
- Base：28/50，Pass@1 56.00%。
- Hallucination：7/50，Pass@1 14.00%。
- Disambiguation：13/25，Pass@1 52.00%。
- Overall：48/125，Pass@1 38.40%；Tool execution errors 27；Policy errors 10；unsupported/hallucinated capability failures 43。
- 77 个失败全部保留：26 个官方 reward=0，24 个 120 秒 bridge timeout，27 个官方 user simulator `UnboundLocalError`。
- transport patch v4 只适配 DeepSeek `json_object`、安全 literal fallback、原 Pydantic validation 与有界重试；官方 task/evaluator/reward semantics 修改 0。官方非有限诊断浮点仅在汇总 JSON 中规范化为 `null`。

## Track B — DriveGuard-Native live

- Run ID：`phase13:d6acfddd-0179-41b2-956e-ec950b34ca2d`。
- Model：`deepseek-v4-flash`；temperature 0；trials 1；fixed seed；600/600 live。
- 时间：2026-09-01T06:14:32.322Z — 2026-09-01T06:51:56.470Z。

| 指标                     |      实际值 |   目标 | 状态 |
| ------------------------ | ----------: | -----: | ---- |
| Normal Task Success      |      55.38% |   ≥90% | MISS |
| Tool Selection Accuracy  |      51.61% |   ≥95% | MISS |
| Argument Validity        |      92.06% |   ≥97% | MISS |
| Tool Schema Validity     |     100.00% | ≥99.5% | HIT  |
| Policy Decision Accuracy |      92.00% | 报告值 | —    |
| Critical Policy Recall   |      78.39% |   100% | MISS |
| Confirmation Bypass      |           0 |      0 | HIT  |
| Duplicate Side Effect    |           0 |      0 | HIT  |
| Context Refresh Accuracy |     100.00% |   ≥99% | HIT  |
| Simple Task P95          |  4121.10 ms |    <4s | MISS |
| Multi-tool P95           | 10745.26 ms |    <8s | MISS |

补充：Confirmation Compliance 86.75%；Execution Success 81.83%；Transient Failure Recovery 0.00%；Urgent Event Handling Success 100.00%；Forbidden Action Executed 0。Quality Targets 为 **4/10 HIT**。

## Failure Analysis

Native 共保留 642 条 typed failure record：WRONG_TOOL 239、WRONG_FINAL_RESPONSE 136、EXECUTION_ERROR 109、MISSING_TOOL 53、WRONG_POLICY 48、WRONG_ARGUMENT 37、CONFIRMATION_ERROR 20；INVALID_SCHEMA、CONTEXT_ERROR、URGENT_EVENT_ERROR、TIMEOUT 均为 0。

## Integrity / Gate

- External tasks modified 0；official evaluator semantics modified 0；post-result cherry-picking 0；failed cases deleted 0。
- Native 600/600 unique；移除 caseId/seed/prompt 后结构化 Case 仍为 600/600 unique；形式化 Tool/Policy Ground Truth prompt leakage 0；单条自然提示最大复用 7 次。
- 每 Case reset Simulator、reset Session、固定 seed；Context 60 个真实 mutation；Urgent 35 个覆盖五类事件并经过 production processor + durable dedup；Fault 45 个覆盖五类代表故障。
- Forbidden Action Executed 0；Confirmation Bypass 0；Duplicate Side Effect 0。
- Final validation：format、lint、typecheck、build、Phase 13 57/57、全量 2,150 PASS + 43 个既有环境门控 skip、diff check、npm audit 0 vulnerabilities。
- Review closure：Critical 0，High 0，影响 Benchmark 可信度的 Medium 0。
- Engineering Gate：**PASS**；Quality Targets：**4/10 HIT**。
- Phase 14 未开始。
