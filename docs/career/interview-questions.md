# DriveGuard 面试深挖问题

## Agent 与 Tool Calling

### 1. 为什么不让 LLM 直接调用车辆服务 API？

模型输出具有概率性，不能承担身份、风险和副作用授权。DriveGuard 只允许模型提出已注册能力请求，实际执行必须经过 schema、Policy、确认状态机、一次性授权和 Reliable Executor。

### 2. Agent Runtime 在系统里承担什么职责？

它加载有界会话和实时 context、过滤可见 Tool、调用模型、收集生命周期事件，并把正式 Tool proposal 交给确定性控制面；它不是安全决策者，也不能绕过执行器。

### 3. Tool Routing 为什么不能只靠一个更强的 Prompt？

Prompt 无法提供稳定、可回归的完整性保证。系统先按已解析 capability 缩小候选集，再进行显式参数绑定和正式 schema 校验，把随机空间压缩在安全边界之内。

### 4. 多意图请求怎样避免漏 Tool 或多调 Tool？

Goal Router 为每个已识别目标生成候选集，多目标取所需能力并集；完成计划后校验正式执行证据。模型仍可规划顺序，但不能看到 capability 层已排除的 Tool。

### 5. 什么是“受约束的关键路径补全”？会不会替模型偷偷做决定？

仅当关键 capability 已由确定性逻辑唯一解析为一个 Tool、且模型没有产生有效正式调用时，系统允许一次补全。它不能在歧义候选中选择，不能增加 RX Tool，也不能跳过后续 Policy 和确认。

### 6. 如何保证模型生成的参数没有被悄悄改写？

Binder 只规范化用户本轮明确给出的目的地、站点、温度等值；缺失值不会猜测。绑定后的参数再次通过 TypeBox schema，并以同一 canonical fingerprint 进入 Policy、确认和执行。

### 7. 为什么要区分 Tool request 事件和有效 Tool execution evidence？

模型可能发出格式错误或 schema 不合法的 request。只有通过适配器和校验的正式调用才能证明计划完整，否则错误事件会造成“看似调用、实际未执行”的漏检。

### 8. RX capability 为什么不是“Policy DENY”，而是根本不注册？

注册即扩大模型可表达的攻击面。转向、油门、制动、AEB、ESC 等 RX 能力永久不进入 LLM Tool Registry，Policy 是第二层防线，不是暴露危险能力的理由。

## Policy 与确认

### 9. Policy Engine 为什么必须是确定性的？

相同的 capability、参数、身份和 context 应得到可重复、可审计的决定。把风险判断写进 Prompt 会随模型和措辞漂移，也难以覆盖 10,000-case 规则矩阵。

### 10. Policy 的 default deny 如何落地？

外部输入先验证，Tool 必须有已注册的 Policy profile；缺 capability、过期 context、授权不匹配或无匹配允许规则时，不进入执行路径，而是拒绝或要求重规划。

### 11. 为什么“你确定吗？”对话不等于安全确认？

自然语言无法可靠绑定具体用户、车辆、session、Tool、参数、context 版本和 TTL。DriveGuard 保存冻结的 action fingerprint，并只允许合法状态迁移和可信确认通道恢复该动作。

### 12. 确认后 context 变了怎么办？

执行授权签发前重新验证当前 context。状态陈旧、目标变化或不再满足 Policy 时转为重规划/拒绝，不把旧确认解释成对新状态的授权。

### 13. 重复点击确认会不会执行两次？

不会。确认状态迁移和授权创建是事务性的，authorization 只能被条件更新消费一次；重复请求复用稳定幂等键并返回已有 receipt 或受控状态。

### 14. 怎样防止用户 A 确认用户 B 的 action？

PendingAction、authorization 和 execution 都绑定 user、vehicle、session 与 action。生产 user 来自已验证 JWT `sub`，所有读取和迁移在进入服务层前后都检查完整身份绑定。

## Idempotency、Recovery 与持久化

### 15. 只有 idempotency key 为什么还不够？

同一个 key 可能被错误地用于不同请求。系统同时保存 canonical fingerprint 和完整身份绑定；key 相同但 fingerprint 不同返回 `IDEMPOTENCY_CONFLICT`，不能复用所有权。

### 16. 超时后为什么不能直接重试写操作？

超时只说明调用方不知道结果，不说明下游没执行。对模糊写，DriveGuard 先查询权威状态或持久化 execution record；无法确认时返回未知/安全降级，而不是制造第二次副作用。

### 17. 哪些操作允许重试？

仅对明确分类为 retry-safe 的读或受控故障执行有界重试，并受 timeout、capacity 和 circuit breaker 限制。非幂等写及未知结果不会盲重试。

### 18. 为什么还需要同车串行？

两个不同 session 可能同时修改同一辆车。单靠 session 锁无法保护车辆状态；同车写串行化保证状态迁移顺序，不同车辆仍可并发。

### 19. PostgreSQL 为什么是安全权威源？

它持久化 session、action、authorization、execution、idempotency 和 append-only audit，并用事务、行锁、约束和单次条件更新保证跨进程/重启语义。

### 20. Redis 挂了会发生什么？

Redis 只用于有界会话缓存、lease 和短期协调。故障可能降低性能，但会话可回源 PostgreSQL，授权单次消费、持久化幂等和审计不能依赖 Redis 才成立。

### 21. NATS JetStream 在系统中解决什么问题？

它承载持久化紧急事件投递和 durable consumer 恢复，而不是替代 PostgreSQL 的业务状态。处理结果、确认和审计仍回到权威存储边界。

### 22. API 崩溃后如何恢复 pending action？

action 与确认状态已在 PostgreSQL 事务提交。重启后按身份恢复 session 和 pending action；若已到 `READY_FOR_EXECUTION`，稳定的 `confirmed:<actionId>` 幂等键使执行恢复仍只产生一个结果。

## 并发、Context 与性能

### 23. Backpressure 为什么比扩大线程池更重要？

无限接收只会把延迟、内存和依赖队列变成不可控故障。DriveGuard 限制 active/queued admission，容量耗尽返回带 `Retry-After` 的 `503 SERVICE_BUSY`，确保过载是可观测的受控拒绝。

### 24. 最初的 V8 heap 问题根因是什么？

主要不是单一“内存配置太小”，而是每请求重建 Runtime、恢复增长的 transcript、无界保留 run/trace/event ID，以及执行完成后仍保留本地 execution/idempotency 对象。

### 25. 为什么没有简单提高 V8 old-space？

提高上限只会推迟崩溃。最终保留 160 MiB fail-safe，通过 admission-sized Runtime LRU、40 条模型消息窗口、有界诊断集合和 durable finalize 后释放本地记录消除无界增长。

### 26. 截断模型 context 会不会丢业务状态？

只裁剪送入模型的最近会话窗口，并在 user turn 边界截断。完整 transcript、action、authorization、execution receipt、幂等和 audit 仍保存在结构化持久层。

### 27. Context race 是什么？

模型规划、确认和执行之间车辆状态可能变化，或者并发请求读取到不一致快照。系统使用原子 snapshot、freshness/version 校验、确认前重验证和受控重规划；重复未来时间戳仍 fail closed。

### 28. 怎样证明 race 修复不是偶然？

除 soak 外还执行 A–E 直接 race 矩阵，要求无逃逸 `CONTEXT_INVALID`、无 HTTP 500，并做 30/30 prospective semantic observation；历史缺失 payload 继续披露，未事后重构。

### 29. 20 VU 的 96.53 req/s 能当线上 QPS 吗？

不能。它来自测试单机、生产 Compose 拓扑和 deterministic faux provider，是工程资格点；外部模型延迟、目标硬件、网络和配额必须单独重测。

### 30. 50 VU 出现 3,975 个 503 为什么仍算通过？

因为这是刻意测出的饱和边界：拒绝是受控 `SERVICE_BUSY`，HTTP 500、外部 busy 泄漏、API restart 和 OOM 都为 0。通过的是可控退化，不是 50 VU 全部成功。

## Evaluation 与可观测性

### 31. Agent 评估怎样避免“刷分”？

冻结数据集与 scorer hash，完整运行 Development/Holdout，禁止单 case 重跑、结果拼接和 post-result 选择；失败记录全部保留，Policy/Safety 硬指标与一般质量指标分开。

### 32. 为什么 CAR-bench 同时报告 raw 和 valid-only Pass@1？

125 个任务中有 47 个上游基础设施失败。Raw 41.60% 保留所有失败，valid-only 66.67% 只解释可执行样本；两者必须并列，不能把基础设施失败改算通过。

### 33. 如何区分 Agent 错误、Evaluator 错误和 Infrastructure 错误？

runner 保存正式 Tool/Policy/execution 事件、provider/bridge 错误和评分适用性，再按类型归因。归因不会改变 raw 分母，修正 evaluator 后也必须完整重跑适用 gate。

### 34. 可观测性如何避免高基数反噬？

Prometheus label 不使用 user/session/action 等高基数身份；细粒度关联放到受控 trace 和结构化日志。系统还监控队列、连接、heap、retained IDs、依赖和安全计数器。

### 35. 审计如何兼顾可追溯和保密？

审计绑定 user、vehicle、session、action、trace、Policy、确认和 execution，但持久化前拒绝 token、cookie、credential、header、reasoning/chain-of-thought 等字段；审计表禁止更新和删除。

## Authentication、Container Security 与 CI/CD

### 36. JWT/JWKS 具体校验什么？

生产模式只接受配置允许的 RS256/ES256，校验 JWKS key、`iss`、`aud`、`exp`、`nbf` 和安全 `sub`；未知 `kid` 允许一次强制刷新，错误以受控 401/403 fail closed。

### 37. 车辆授权为什么不能只放在前端？

前端输入可伪造。车辆 scope 来自已验证 JWT claim，服务端校验所选 vehicle，之后 session、action、confirmation 和 execution 继续绑定同一 vehicle。

### 38. 数据容器为什么需要 initializer？

非 root、只读 rootfs、`cap_drop: ALL` 的 runtime 无法在新 volume 上准备 ownership/mode。网络隔离的一次性 initializer 仅保留实测最小 capability；异常旧 volume 直接失败，不递归宽松修复。

### 39. Gitleaks、Trivy、SBOM 和 npm audit 各自覆盖什么？

Gitleaks 检查源代码/历史秘密，npm audit 检查 Node 依赖，Trivy 检查镜像漏洞/secret/misconfiguration，SBOM 提供组件清单。结果必须绑定具体 source/image digest；一个工具的 PASS 不能替代另一个范围。

### 40. 为什么 load、soak、CAR-bench 不放进每次 PR CI？

这些任务耗时、依赖外部环境或模型，并且可重复性边界不同。PR CI 跑安装、格式、类型、构建、安全选择、全回归、audit、layout、Gitleaks、镜像构建和 Compose；昂贵资格化以冻结 evidence 单独管理。
