# 项目名称

DriveGuard — 企业级智能驾驶 Agent 系统

## 项目描述

面向驾驶服务编排的安全感知 Agent Runtime：LLM 负责理解与规划，确定性软件负责策略、确认、执行、恢复、持久化与审计。项目以车辆模拟器完成端到端验证，不涉及真实车辆执行或量产部署。

## 技术栈

TypeScript、Node.js、Pi Agent Core、Fastify、TypeBox、PostgreSQL、Drizzle ORM、Redis、NATS JetStream、OpenTelemetry、Prometheus、Grafana、Docker Compose、GitHub Actions、Vitest、k6、Toxiproxy。

## 项目亮点

- 设计 capability-aware Tool Routing、显式参数绑定与受约束的关键路径补全，并以冻结的 600-case 数据集评估；最终 Development/Holdout Case Pass 达 90.00%/92.22%，Tool 选择、参数、Policy 与关键 Policy 指标均为 100%。
- 将高风险副作用固化为“Tool Contract → Policy → 身份绑定确认 → Reliable Executor”链路，RX 执行器永久不注册为 LLM Tool；关键安全回归 472/472，通过且确认绕过、禁用动作执行、重复副作用、错误成功均为 0。
- 实现 PostgreSQL 持久化幂等、授权单次消费、同车串行、模糊写对账和重启恢复；生产拓扑 9/9 故障恢复，通过 pending action/receipt 跨重启与跨用户、跨车辆隔离验证。
- 通过有界上下文、Runtime LRU、准入/背压和资源诊断完成性能收口：20 VU 达 96.53 req/s，50 VU 饱和转化为 3,975 个受控 503 且 HTTP 500 为 0；发布前 2,319/2,319 回归、npm audit 0、精确 SHA Hosted CI 全绿。
