# DriveGuard 五分钟面试讲解

## 1. 项目背景

DriveGuard 是一个驾驶服务编排 Agent Runtime。它解决的不是让模型“开车”，而是让模型在车辆服务场景中理解用户意图、选择能力，同时把身份、风险判断、确认、副作用执行和审计牢牢留在确定性系统中。项目以车辆模拟器验证，不宣称真实车辆或商业生产部署。

## 2. 最初遇到的问题

原型阶段有三类核心问题。第一，LLM 的 Tool 选择、参数和多步规划具有随机性，单靠 Prompt 无法稳定达到工程门槛。第二，高风险动作如果依赖模型主动询问“是否确认”，就无法可靠绑定用户、车辆、参数、上下文版本和有效期。第三，系统进入并发和故障场景后，会出现重复请求、模糊写、context race、进程重启、依赖中断、背压失控和 V8 堆压力，编译通过远远不等于可发布。

## 3. 整体架构

请求从 HMI 进入，生产模式先做 JWT/JWKS 验证和车辆授权，再经过 API 校验与有界准入。Agent Runtime 只能看到 capability 过滤后的非 RX Tools；Tool Routing 和 schema 校验之后，由确定性 Policy Engine 决策。R2 动作进入身份绑定的确认状态机，授权成功后由 Reliable Executor 负责幂等、同车串行、超时、重试和对账，再调用模拟器或外部服务。执行后必须刷新权威状态并读取 receipt，最终响应不能仅依据模型文本。PostgreSQL 保存权威业务状态和审计，Redis 只做有界记忆与协调，NATS JetStream 承载持久化紧急事件；Prometheus、Grafana、Tracing 和结构化日志负责可观测性。

## 4. 最关键的 3 个工程难点

第一个难点是 Tool Routing/Planning 不稳定。早期 600-case live 结果只有 4/10 质量目标命中，Tool Selection 为 51.61%。第二个难点是安全动作不能依赖 LLM 自觉，高风险操作必须在模型之外实现可验证的授权闭环。第三个难点是生产级正确性：并发下不能重复执行，超时后不能盲目重试，context 变化不能产生旧状态动作，过载也不能退化成 HTTP 500 或堆崩溃。

## 5. 如何解决

对 Agent 质量，我先建立冻结数据集和 Scorer，保留每次失败，不做单 case 重跑或结果拼接；再加入 capability-aware 候选 Tool 缩减、显式参数绑定，以及只对“已唯一解析的关键能力”允许一次受约束补全。对安全动作，我把确认做成持久化状态机，用 action fingerprint 绑定 user、vehicle、session、Tool、arguments 和 context，确认后签发一次性 execution authorization。对可靠性，我用 PostgreSQL 保存幂等所有权和 receipt，对模糊写先查权威状态再决定；Redis 失效不能削弱安全；同时使用有界准入、Runtime LRU、40 条模型上下文上限、同车串行与有界诊断集合解决堆和竞争问题。

## 6. 最终指标

最终 Native Development/Holdout Case Pass 为 90.00%/92.22%，Tool recall、precision、selection、argument validity、Policy、Critical Policy 和 Safety Enforcement 在两组均为 100%。关键安全回归 472/472，确认绕过、禁用动作执行、重复副作用、错误成功、跨用户和跨车辆执行均为 0。确定性 provider 的合格点为 20 VU、96.53 req/s；50 VU 饱和产生 3,975 个受控 503，HTTP 500 为 0。30 分钟 soak 接受 140,297/140,297 请求。最终回归 2,319/2,319，npm audit 0，发布 SHA 的 Hosted CI 为 GREEN。

## 7. 项目收获

最大的收获是：Agent 系统的核心不只是“模型能不能调用 Tool”，而是如何把概率式规划嵌入可验证、可恢复、可审计的确定性控制面。评估、失败证据和边界声明与代码同样重要；尤其在安全场景中，宁可受控拒绝或安全降级，也不能把未知结果包装成成功。
