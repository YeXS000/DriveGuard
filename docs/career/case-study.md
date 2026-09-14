# DriveGuard Engineering Case Study

DriveGuard 的核心命题是：让 LLM 参与驾驶服务理解与规划，但不能让概率式输出成为身份、安全或副作用的最终权威。以下只选择四个最能体现工程决策的真实问题；所有数字均保留其测试范围，不代表真实车队或量产部署。

## Case 1 — Agent Tool Routing

### 问题

最初的 Agent 能完成演示，但无法稳定通过规模化评估。首个完整 600-case Native live run 只命中 4/10 质量目标：Normal Task Success 55.38%、Tool Selection 51.61%、Argument Validity 92.06%、Critical Policy Recall 78.39%。典型失败不是 API 不可用，而是模型漏掉必须 Tool、选择多余 Tool，或明明收到站点 ID 仍在文本中追问。

### 证据与根因

冻结数据集将 565 个 Agent Runtime case 与 35 个独立 Urgent Processor case 分开，并保存每个正式 Tool/Policy/execution 事件。分析显示：capability resolver 已给出正确候选，argument binder 也能提取显式值，但 Policy 只会在模型产生 schema-valid Tool proposal 后触发；因此一次随机漏调用就会让关键 Policy 没有被评估。另一类问题来自 evaluator 对恢复/降级适用分母、provider 延迟与故障 lifetime 的错误建模，不能把它们混成 Agent 失败。

### 设计

系统增加 capability-aware Goal Router，只向模型暴露当前目标所需且已获 capability 许可的最小 Tool 集；显式参数 binder 只规范化用户明确给出的值，不补猜缺失信息。对关键路径，在 capability 已唯一映射到一个 Tool 且没有有效正式调用时，只允许一次 constrained repair；任何歧义、RX 能力或 Policy/确认步骤都不能由 repair 越过。评估侧冻结 dataset/scorer hash，区分 `RECOVERED`、`SAFE_DEGRADED` 与 `UNSAFE_OR_INCORRECT`，禁止单 case 重跑和结果拼接。

### 结果

最终 Development 420/420 与 Holdout 180/180 单次完整观察中，Case Pass 为 90.00%/92.22%；Tool recall、precision、selection、argument validity、Policy、Critical Policy 与 Safety Enforcement 在两组均为 100%。三个 130-case Critical stability round 均保持 Critical Policy/Safety 100% 和全部 hard counters 为 0。Development 仍保留 51 个 Agent error、Holdout 保留 14 个，项目没有把通过 gate 表述成“模型完美”。

## Case 2 — Confirmation / Recovery

### 问题

高风险动作如果只靠模型问一句“是否确认”，无法证明用户确认的是哪辆车、哪个 Tool、哪组参数和哪个 context 版本；网络超时或进程重启还可能诱发重复执行。安全要求不是“通常不会错”，而是确认绕过、禁用动作执行和重复副作用必须为 0。

### 证据与根因

并发与故障场景暴露了三个独立风险：重复确认可能重复消费授权；外部写超时可能已成功但调用方没有收到响应；API 在确认提交后崩溃，内存状态会丢失。只使用内存锁或随机 idempotency key 无法覆盖跨进程重启，也无法阻止同一个 key 绑定不同请求。

### 设计

R2 动作进入持久化 action state machine，fingerprint 绑定 user、vehicle、session、Tool、canonical arguments 与 context。确认接受、token 清理、`CONFIRMED -> READY_FOR_EXECUTION` 和 authorization 创建在事务边界内完成；authorization 用条件更新保证只消费一次。Reliable Executor 将 idempotency key 与完整 fingerprint/identity binding 一起持久化，同车写串行。对 ambiguous write，不盲重试，而是查询权威状态与 execution record；无法证明结果时返回 unknown/safe degradation。PostgreSQL 是权威源，Redis 失效不能削弱这些保证。

### 结果

最终 Native Development/Holdout 的 recovery 分别为 10/10、5/5，required safe degradation 为 21/21、9/9。生产拓扑 9/9 故障恢复；pending action 与 receipt 经两次 API 重启仍可恢复，模糊写对账为 `EXECUTED`，duplicate side effect 为 0。关键安全 472/472，通过且 authentication/confirmation bypass、forbidden action、false success、cross-user/cross-vehicle execution 全部为 0。

## Case 3 — Performance / Context / Heap

### 问题

第一次完整生产拓扑压力测试在 20 VU 下出现 105 个 HTTP 500、329 个非预期 `SESSION_BUSY`；API RSS 达 1,241 MiB，event-loop P99 达 496 ms。随后长稳测试又出现 V8 old-space exhaustion、context 相关 HTTP 500 和 semantic mismatch。简单增大 heap 只能延迟失败，不能说明系统有可控容量边界。

### 证据与根因

隔离实验把瓶颈定位到单进程 API/Agent session path，而不是 PostgreSQL、NATS 或 Executor 队列。每个消息重建完整 Runtime、恢复不断增长的 transcript、长期保留 run/trace/event ID，以及 durable execution 完成后仍保留本地 execution/idempotency 记录，共同形成堆压力。context 问题则来自规划、确认、执行之间的状态变化与非原子 source read；仅看 soak aggregate 无法直接证明每类 race 已关闭。

### 设计

系统按身份复用 Runtime，并用 admission-sized LRU 限制数量；模型上下文限制为最近 40 条消息，但完整 transcript 和业务状态仍持久化。run/trace/event 集合有界，durable finalize 后释放本地执行记录，160 MiB old-space 继续作为 fail-safe。API 将 active/queued work 限制为明确容量，过载统一为带 `Retry-After` 的 `503 SERVICE_BUSY`。context 使用原子 snapshot、freshness/version 校验、确认前重验证和有限的 source reread；另建 A–E 直接 race matrix，而不是只依赖长稳测试。

### 结果

最终合格点为 20 VU、11,653 iterations、96.53 req/s，非预期 503/500/external busy 均为 0。50 VU 饱和时产生 3,975 个受控 503，HTTP 500、API restart、OOM 均为 0。30 分钟 soak 接受 140,297/140,297 请求，77.936 req/s，HTTP 500、semantic mismatch、restart、fatal heap 均为 0，latency/throughput ratio 为 0.983/1.019。A–E race 全部通过，30/30 prospective observation 无 mismatch；三个早期缺失 payload 仍作为历史限制保留。

## Case 4 — Production Security

### 问题

开发期 `x-driveguard-*` identity header 可伪造，不能直接升级为生产认证。与此同时，non-root、read-only rootfs、`cap_drop: ALL` 的 PostgreSQL/Redis/NATS runtime 在新 volume 上无法准备 ownership/mode。若为“让它跑起来”恢复 root、privileged、`cap_add: ALL` 或 `chmod 777`，会破坏目标安全边界。

### 证据与根因

生产启动曾被明确 fail closed，直到可信认证完成。存储启动实验分别观察到 PostgreSQL 的 chmod/socket 目录权限问题与 Redis `appendonlydir` 问题；NATS 路径需求不同。镜像扫描还保留了每镜像 43 条 no-fixed-version High raw rows，因此不能用“0 vulnerabilities”概括容器风险。

### 设计

生产模式要求 JWT issuer、audience、JWKS、允许算法和 vehicle-scope claim；使用 Node WebCrypto 验证 RS256/ES256，`sub` 成为内部 userId，vehicle 必须在 claim scope 内。只有 HMI 暴露 host port，其他服务使用内部网络。数据 runtime 保持 non-root、read-only、no-new-privileges 和全部 capability dropped；三个 networkless one-shot initializer 分别只保留实测最小 capability，异常旧 volume fail closed。Release gate 分开执行 controlled-source/history Gitleaks、Trivy、SBOM、npm audit、认证 smoke 与关键安全回归。

### 结果

最终生产认证、跨用户/车辆拒绝、fresh/existing-volume smoke 和审计重建通过。Controlled-source Gitleaks 为 0；reachable history 26/26 已 triage、0 unresolved。Phase 18.3 candidate 镜像为 0 Critical、0 fixable/reachable/unclassified High、0 image secret、0 Critical/High misconfiguration，并生成 3/3 SPDX 2.3 SBOM；43 raw no-fix High rows/镜像继续披露为 `NOT_REACHABLE`。这些 Trivy/SBOM 结果严格绑定 candidate `e7f8e196…`，不冒充 later `v1.0.0` exact-source scan。

## Evidence pointers

- Agent quality: `phase/13.2.1-gate-stabilization:13.2.1-gate-stabilization/docs/final-report.md`
- Performance/context: `docs/implementation-status.md`; `codex/15.3-context-race-evidence-closure:artifacts/15.3-context-race-evidence-closure/docs/final-report.md`
- Production/security: `codex/18.3-least-privilege-storage-release-closure:artifacts/18.3-least-privilege-storage-release-closure/`
- Release closure: `driveguard-final-manifest.json`; GitHub Actions run 34764056549; annotated `v1.0.0`
