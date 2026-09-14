# DriveGuard Tech Stack

标记说明：**Core** 表示核心业务/安全路径；**Used directly** 表示项目代码直接使用；**Infrastructure/support** 表示部署、验证或运维支撑。这里不列未实际使用的候选技术。

## Agent / Backend

| Technology                                | Level                  | Actual use                                                           |
| ----------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| TypeScript 5.9 / Node.js 22               | Core                   | 严格类型的 Agent Runtime、domain、Policy、executor、API 与 simulator |
| `@earendil-works/pi-agent-core` / `pi-ai` | Core                   | 模型运行、stream event 与 Tool Calling 适配                          |
| Fastify 5                                 | Used directly          | API、health/readiness、SSE 与 vehicle simulator HTTP 服务            |
| TypeBox                                   | Used directly          | Tool、context 和外部输入边界 schema 校验                             |
| npm workspaces                            | Infrastructure/support | 单 lockfile 的 apps/packages/services monorepo                       |

## Data / Messaging

| Technology     | Level         | Actual use                                                                                         |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| PostgreSQL 17  | Core          | session、action、authorization、execution、idempotency、urgent event 与 append-only audit 权威存储 |
| Drizzle ORM    | Used directly | schema、migration 与 PostgreSQL repository 实现                                                    |
| Redis          | Used directly | TTL 会话缓存、session lease 与短期协调；不作为安全权威源                                           |
| NATS JetStream | Used directly | durable urgent-event 投递与 consumer recovery                                                      |

## Safety / Reliability

| Technology / mechanism                              | Level | Actual use                                                                         |
| --------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| Deterministic Policy Engine                         | Core  | R0/R1/R2/R3 决策、default deny、context/authorization rule                         |
| Confirmation action state machine                   | Core  | fingerprint、TTL、合法迁移、identity/context 重新验证                              |
| Reliable Executor                                   | Core  | authorization consumption、timeout、bounded retry、circuit breaker、reconciliation |
| Durable idempotency + PostgreSQL transactions       | Core  | key/fingerprint 冲突、single owner、receipt replay 与跨重启恢复                    |
| Bounded admission / LRU / per-vehicle serialization | Core  | backpressure、heap 控制、同车写顺序与跨车并行                                      |

## Observability

| Technology                     | Level                  | Actual use                                         |
| ------------------------------ | ---------------------- | -------------------------------------------------- |
| OpenTelemetry                  | Used directly          | trace API、Node SDK 与 OTLP HTTP export            |
| Prometheus client / Prometheus | Used directly          | 有界基数的 Agent、安全、可靠性与资源指标           |
| Grafana                        | Infrastructure/support | 预置 datasource 与 DriveGuard dashboard            |
| Pino structured logging        | Used directly          | 结构化、secret-safe 运行日志                       |
| Alert rules                    | Infrastructure/support | 12 个 API、dependency、backpressure 与 safety 规则 |

## Infrastructure

| Technology                | Level                  | Actual use                                                                            |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| Docker multi-stage builds | Infrastructure/support | API、HMI、simulator 的 SHA-tagged non-root images                                     |
| Docker Compose            | Infrastructure/support | 开发/生产拓扑、internal networks、named volumes、health checks                        |
| Git worktree              | Infrastructure/support | 隔离阶段 source/evidence，主分支只集成正式源码与文档                                  |
| GitHub Actions            | Infrastructure/support | install、quality gates、safety/full regression、audit、image build、Compose、Gitleaks |

## Security

| Technology / control      | Level                  | Actual use                                                                                  |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| JWT/JWKS + Node WebCrypto | Core                   | RS256/ES256 signature、issuer/audience/time/sub 与 vehicle-scope 校验                       |
| Gitleaks                  | Infrastructure/support | controlled source、reachable history 与 exact-source CI secret scan                         |
| Trivy                     | Infrastructure/support | candidate image vulnerability、secret 与 misconfiguration scan                              |
| SPDX 2.3 SBOM             | Infrastructure/support | 三个 candidate image 的组件清单                                                             |
| Linux container hardening | Used directly          | non-root、read-only rootfs、no-new-privileges、`cap_drop: ALL`、最小 capability initializer |

## Testing / Evaluation

| Technology                           | Level                  | Actual use                                                          |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------- |
| Vitest / V8 coverage                 | Used directly          | unit、contract、integration、安全边界和 coverage gate               |
| DriveGuard Native Eval / Scorer V2.1 | Core                   | 冻结 600-case Development/Holdout、硬安全指标与 failure attribution |
| CAR-bench adapter                    | Infrastructure/support | 外部 125-task benchmark 与 raw/valid failure accounting             |
| k6                                   | Infrastructure/support | baseline、ascending load、saturation 与 soak                        |
| Toxiproxy                            | Infrastructure/support | PostgreSQL、Redis、NATS、simulator 的 fault-under-load 注入         |
| Compose smoke scripts                | Infrastructure/support | auth、确认、重启、恢复、备份/恢复、HMI 端到端验证                   |

## Frontend

| Technology                              | Level         | Actual use                                            |
| --------------------------------------- | ------------- | ----------------------------------------------------- |
| HTML / CSS / browser JavaScript modules | Used directly | 响应式 cockpit HMI，无前端框架依赖                    |
| Server-Sent Events                      | Used directly | Agent lifecycle 与执行反馈流                          |
| Fastify/HMI gateway proxy               | Used directly | Bearer token 转发、API 隔离与唯一 host-published edge |
